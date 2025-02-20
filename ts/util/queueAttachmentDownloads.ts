// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { partition } from 'lodash';
import * as logger from '../logging/log';
import { isLongMessage } from '../types/MIME';
import { getMessageIdForLogging } from './idForLogging';
import {
  copyStickerToAttachments,
  savePackMetadata,
  getStickerPackStatus,
} from '../types/Stickers';
import { DataWriter } from '../sql/Client';

import type { AttachmentType, ThumbnailType } from '../types/Attachment';
import type { EmbeddedContactType } from '../types/EmbeddedContact';
import type {
  EditHistoryType,
  MessageAttributesType,
  QuotedMessageType,
} from '../model-types.d';
import * as Errors from '../types/errors';
import {
  getAttachmentSignatureSafe,
  isDownloading,
  isDownloaded,
} from '../types/Attachment';
import type { StickerType } from '../types/Stickers';
import type { LinkPreviewType } from '../types/message/LinkPreviews';
import { isNotNil } from './isNotNil';
import {
  AttachmentDownloadManager,
  AttachmentDownloadUrgency,
} from '../jobs/AttachmentDownloadManager';
import { AttachmentDownloadSource } from '../sql/Interface';
import type { MessageModel } from '../models/messages';
import type { ConversationModel } from '../models/conversations';
import { isOutgoing, isStory } from '../messages/helpers';
import { shouldDownloadStory } from './shouldDownloadStory';
import { hasAttachmentDownloads } from './hasAttachmentDownloads';
import {
  addToAttachmentDownloadQueue,
  shouldUseAttachmentDownloadQueue,
} from './attachmentDownloadQueue';
import { queueUpdateMessage } from './messageBatcher';

export type MessageAttachmentsDownloadedType = {
  bodyAttachment?: AttachmentType;
  attachments: ReadonlyArray<AttachmentType>;
  editHistory?: ReadonlyArray<EditHistoryType>;
  preview: ReadonlyArray<LinkPreviewType>;
  contact: ReadonlyArray<EmbeddedContactType>;
  quote?: QuotedMessageType;
  sticker?: StickerType;
};

function getLogger(source: AttachmentDownloadSource) {
  const verbose = source !== AttachmentDownloadSource.BACKUP_IMPORT;
  const log = verbose ? logger : { ...logger, info: () => null };
  return log;
}

export async function handleAttachmentDownloadsForNewMessage(
  message: MessageModel,
  conversation: ConversationModel
): Promise<void> {
  const idLog = `handleAttachmentDownloadsForNewMessage/${conversation.idForLogging()} ${getMessageIdForLogging(message.attributes)}`;

  // Only queue attachments for downloads if this is a story (with additional logic), or
  // if it's either an outgoing message or we've accepted the conversation
  let shouldQueueForDownload = false;
  if (isStory(message.attributes)) {
    shouldQueueForDownload = await shouldDownloadStory(conversation.attributes);
  } else {
    shouldQueueForDownload =
      hasAttachmentDownloads(message.attributes) &&
      (conversation.getAccepted() || isOutgoing(message.attributes));
  }

  if (shouldQueueForDownload) {
    if (shouldUseAttachmentDownloadQueue()) {
      addToAttachmentDownloadQueue(idLog, message);
    } else {
      await queueAttachmentDownloadsForMessage(message);
    }
  }
}

export async function queueAttachmentDownloadsForMessage(
  message: MessageModel,
  urgency?: AttachmentDownloadUrgency
): Promise<boolean> {
  const updated = await queueAttachmentDownloads(message, {
    urgency,
  });
  if (!updated) {
    return false;
  }

  queueUpdateMessage(message.attributes);

  return true;
}

// Receive logic
// NOTE: If you're changing any logic in this function that deals with the
// count then you'll also have to modify ./hasAttachmentsDownloads
export async function queueAttachmentDownloads(
  message: MessageModel,
  {
    urgency = AttachmentDownloadUrgency.STANDARD,
    source = AttachmentDownloadSource.STANDARD,
    attachmentDigestForImmediate,
  }: {
    urgency?: AttachmentDownloadUrgency;
    source?: AttachmentDownloadSource;
    attachmentDigestForImmediate?: string;
  } = {}
): Promise<boolean> {
  const attachmentsToQueue = message.get('attachments') || [];
  const messageId = message.id;
  const idForLogging = getMessageIdForLogging(message.attributes);

  let count = 0;

  const idLog = `queueAttachmentDownloads(${idForLogging}})`;
  const log = getLogger(source);

  const [longMessageAttachments, normalAttachments] = partition(
    attachmentsToQueue,
    attachment => isLongMessage(attachment.contentType)
  );

  if (longMessageAttachments.length > 1) {
    log.error(`${idLog}: Received more than one long message attachment`);
  }

  if (longMessageAttachments.length > 0) {
    message.set({ bodyAttachment: longMessageAttachments[0] });
  }

  const bodyAttachmentsToDownload = [
    message.get('bodyAttachment'),
    ...(message
      .get('editHistory')
      ?.slice(1) // first entry is the same as the root level message!
      .map(editHistory => editHistory.bodyAttachment) ?? []),
  ]
    .filter(isNotNil)
    .filter(attachment => !isDownloaded(attachment));

  if (bodyAttachmentsToDownload.length) {
    log.info(
      `${idLog}: Queueing ${bodyAttachmentsToDownload.length} long message attachment download`
    );
    await Promise.all(
      bodyAttachmentsToDownload.map(attachment =>
        AttachmentDownloadManager.addJob({
          attachment,
          messageId,
          attachmentType: 'long-message',
          receivedAt: message.get('received_at'),
          sentAt: message.get('sent_at'),
          urgency,
          source,
        })
      )
    );
    count += bodyAttachmentsToDownload.length;
  }

  if (normalAttachments.length > 0) {
    log.info(
      `${idLog}: Queueing ${normalAttachments.length} normal attachment downloads`
    );
  }
  const { attachments, count: attachmentsCount } = await queueNormalAttachments(
    {
      idLog,
      messageId,
      attachments: normalAttachments,
      otherAttachments: message
        .get('editHistory')
        ?.flatMap(x => x.attachments ?? []),
      receivedAt: message.get('received_at'),
      sentAt: message.get('sent_at'),
      urgency,
      source,
      attachmentDigestForImmediate,
    }
  );
  if (attachmentsCount > 0) {
    message.set({ attachments });
  }
  count += attachmentsCount;

  const previewsToQueue = message.get('preview') || [];
  if (previewsToQueue.length > 0) {
    log.info(
      `${idLog}: Queueing ${previewsToQueue.length} preview attachment downloads`
    );
  }
  const { preview, count: previewCount } = await queuePreviews({
    idLog,
    messageId,
    previews: previewsToQueue,
    otherPreviews: message.get('editHistory')?.flatMap(x => x.preview ?? []),
    receivedAt: message.get('received_at'),
    sentAt: message.get('sent_at'),
    urgency,
    source,
  });
  if (previewCount > 0) {
    message.set({ preview });
  }
  count += previewCount;

  const numQuoteAttachments = message.get('quote')?.attachments?.length ?? 0;
  if (numQuoteAttachments > 0) {
    log.info(
      `${idLog}: Queueing ${numQuoteAttachments} ` +
        'quote attachment downloads'
    );
  }
  const { quote, count: thumbnailCount } = await queueQuoteAttachments({
    idLog,
    messageId,
    quote: message.get('quote'),
    otherQuotes:
      message
        .get('editHistory')
        ?.map(x => x.quote)
        .filter(isNotNil) ?? [],
    receivedAt: message.get('received_at'),
    sentAt: message.get('sent_at'),
    urgency,
    source,
  });
  if (thumbnailCount > 0) {
    message.set({ quote });
  }
  count += thumbnailCount;

  const contactsToQueue = message.get('contact') || [];
  if (contactsToQueue.length > 0) {
    log.info(
      `${idLog}: Queueing ${contactsToQueue.length} contact attachment downloads`
    );
  }
  const contact = await Promise.all(
    contactsToQueue.map(async item => {
      if (!item.avatar || !item.avatar.avatar) {
        return item;
      }
      // We've already downloaded this!
      if (item.avatar.avatar.path) {
        log.info(`${idLog}: Contact attachment already downloaded`);
        return item;
      }

      count += 1;
      return {
        ...item,
        avatar: {
          ...item.avatar,
          avatar: await AttachmentDownloadManager.addJob({
            attachment: item.avatar.avatar,
            messageId,
            attachmentType: 'contact',
            receivedAt: message.get('received_at'),
            sentAt: message.get('sent_at'),
            urgency,
            source,
          }),
        },
      };
    })
  );
  message.set({ contact });

  let sticker = message.get('sticker');
  if (sticker && sticker.data && sticker.data.path) {
    log.info(`${idLog}: Sticker attachment already downloaded`);
  } else if (sticker) {
    log.info(`${idLog}: Queueing sticker download`);
    count += 1;
    const { packId, stickerId, packKey } = sticker;

    const status = getStickerPackStatus(packId);
    let data: AttachmentType | undefined;

    if (status && (status === 'downloaded' || status === 'installed')) {
      try {
        data = await copyStickerToAttachments(packId, stickerId);
      } catch (error) {
        log.error(
          `${idLog}: Problem copying sticker (${packId}, ${stickerId}) to attachments:`,
          Errors.toLogFormat(error)
        );
      }
    }
    if (!data) {
      if (sticker.data) {
        data = await AttachmentDownloadManager.addJob({
          attachment: sticker.data,
          messageId,
          attachmentType: 'sticker',
          receivedAt: message.get('received_at'),
          sentAt: message.get('sent_at'),
          urgency,
          source,
        });
      } else {
        log.error(`${idLog}: Sticker data was missing`);
      }
    }
    const stickerRef = {
      messageId,
      packId,
      stickerId,
      isUnresolved: sticker.data?.error === true,
    };
    if (!status) {
      // Save the packId/packKey for future download/install
      void savePackMetadata(packId, packKey, stickerRef);
    } else {
      await DataWriter.addStickerPackReference(stickerRef);
    }

    if (!data) {
      throw new Error('queueAttachmentDownloads: Failed to fetch sticker data');
    }

    sticker = {
      ...sticker,
      packId,
      data,
    };
  }
  message.set({ sticker });

  let editHistory = message.get('editHistory');
  if (editHistory) {
    log.info(`${idLog}: Looping through ${editHistory.length} edits`);
    editHistory = await Promise.all(
      editHistory.map(async edit => {
        const { attachments: editAttachments, count: editAttachmentsCount } =
          await queueNormalAttachments({
            idLog,
            messageId,
            attachments: edit.attachments,
            otherAttachments: attachments,
            receivedAt: message.get('received_at'),
            sentAt: message.get('sent_at'),
            urgency,
            source,
          });
        count += editAttachmentsCount;
        if (editAttachmentsCount !== 0) {
          log.info(
            `${idLog}: Queueing ${editAttachmentsCount} normal attachment ` +
              `downloads (edited:${edit.timestamp})`
          );
        }

        const { preview: editPreview, count: editPreviewCount } =
          await queuePreviews({
            idLog,
            messageId,
            previews: edit.preview,
            otherPreviews: preview,
            receivedAt: message.get('received_at'),
            sentAt: message.get('sent_at'),
            urgency,
            source,
          });
        count += editPreviewCount;
        if (editPreviewCount !== 0) {
          log.info(
            `${idLog}: Queueing ${editPreviewCount} preview attachment ` +
              `downloads (edited:${edit.timestamp})`
          );
        }

        return {
          ...edit,
          attachments: editAttachments,
          preview: editPreview,
        };
      })
    );
  }
  message.set({ editHistory });

  if (count <= 0) {
    return false;
  }

  log.info(`${idLog}: Queued ${count} total attachment downloads`);

  return true;
}

export async function queueNormalAttachments({
  idLog,
  messageId,
  attachments = [],
  otherAttachments,
  receivedAt,
  sentAt,
  urgency,
  source,
  attachmentDigestForImmediate,
}: {
  idLog: string;
  messageId: string;
  attachments: MessageAttributesType['attachments'];
  otherAttachments: MessageAttributesType['attachments'];
  receivedAt: number;
  sentAt: number;
  urgency: AttachmentDownloadUrgency;
  source: AttachmentDownloadSource;
  attachmentDigestForImmediate?: string;
}): Promise<{
  attachments: Array<AttachmentType>;
  count: number;
}> {
  const log = getLogger(source);
  // Look through "otherAttachments" which can either be attachments in the
  // edit history or the message's attachments and see if any of the attachments
  // are the same. If they are let's replace it so that we don't download more
  // than once.
  // We don't also register the signatures for "attachments" because they would
  // then not be added to the AttachmentDownloads job.
  const attachmentSignatures: Map<string, AttachmentType> = new Map();
  otherAttachments?.forEach(attachment => {
    const signature = getAttachmentSignatureSafe(attachment);
    if (signature) {
      attachmentSignatures.set(signature, attachment);
    }
  });

  let count = 0;
  const nextAttachments = await Promise.all(
    attachments.map(attachment => {
      if (!attachment) {
        return attachment;
      }
      // We've already downloaded this!
      if (isDownloaded(attachment)) {
        log.info(`${idLog}: Normal attachment already downloaded`);
        return attachment;
      }

      const signature = getAttachmentSignatureSafe(attachment);
      const existingAttachment = signature
        ? attachmentSignatures.get(signature)
        : undefined;

      // We've already downloaded this elsewhere!
      if (
        existingAttachment &&
        (isDownloading(existingAttachment) || isDownloaded(existingAttachment))
      ) {
        log.info(
          `${idLog}: Normal attachment already downloaded in other attachments. Replacing`
        );
        // Incrementing count so that we update the message's fields downstream
        count += 1;
        return existingAttachment;
      }

      count += 1;

      const urgencyForAttachment =
        attachmentDigestForImmediate &&
        attachmentDigestForImmediate === attachment.digest
          ? AttachmentDownloadUrgency.IMMEDIATE
          : urgency;
      return AttachmentDownloadManager.addJob({
        attachment,
        messageId,
        attachmentType: 'attachment',
        receivedAt,
        sentAt,
        urgency: urgencyForAttachment,
        source,
      });
    })
  );

  return {
    attachments: nextAttachments,
    count,
  };
}

function getLinkPreviewSignature(preview: LinkPreviewType): string | undefined {
  const { image, url } = preview;

  if (!image) {
    return;
  }

  const signature = getAttachmentSignatureSafe(image);
  if (!signature) {
    return;
  }

  return `<${url}>${signature}`;
}

async function queuePreviews({
  idLog,
  messageId,
  previews = [],
  otherPreviews,
  receivedAt,
  sentAt,
  urgency,
  source,
}: {
  idLog: string;
  messageId: string;
  previews: MessageAttributesType['preview'];
  otherPreviews: MessageAttributesType['preview'];
  receivedAt: number;
  sentAt: number;
  urgency: AttachmentDownloadUrgency;
  source: AttachmentDownloadSource;
}): Promise<{ preview: Array<LinkPreviewType>; count: number }> {
  const log = getLogger(source);
  // Similar to queueNormalAttachments' logic for detecting same attachments
  // except here we also pick by link preview URL.
  const previewSignatures: Map<string, LinkPreviewType> = new Map();
  otherPreviews?.forEach(preview => {
    const signature = getLinkPreviewSignature(preview);
    if (!signature) {
      return;
    }
    previewSignatures.set(signature, preview);
  });

  let count = 0;

  const preview = await Promise.all(
    previews.map(async item => {
      if (!item.image) {
        return item;
      }
      // We've already downloaded this!
      if (isDownloaded(item.image)) {
        log.info(`${idLog}: Preview attachment already downloaded`);
        return item;
      }
      const signature = getLinkPreviewSignature(item);
      const existingPreview = signature
        ? previewSignatures.get(signature)
        : undefined;

      // We've already downloaded this elsewhere!
      if (
        existingPreview &&
        (isDownloading(existingPreview.image) ||
          isDownloaded(existingPreview.image))
      ) {
        log.info(`${idLog}: Preview already downloaded elsewhere. Replacing`);
        // Incrementing count so that we update the message's fields downstream
        count += 1;
        return existingPreview;
      }

      count += 1;
      return {
        ...item,
        image: await AttachmentDownloadManager.addJob({
          attachment: item.image,
          messageId,
          attachmentType: 'preview',
          receivedAt,
          sentAt,
          urgency,
          source,
        }),
      };
    })
  );

  return {
    preview,
    count,
  };
}

function getQuoteThumbnailSignature(
  quote: QuotedMessageType,
  thumbnail?: AttachmentType
): string | undefined {
  if (!thumbnail) {
    return undefined;
  }
  const signature = getAttachmentSignatureSafe(thumbnail);
  if (!signature) {
    return;
  }
  return `<${quote.id}>${signature}`;
}

async function queueQuoteAttachments({
  idLog,
  messageId,
  quote,
  otherQuotes,
  receivedAt,
  sentAt,
  urgency,
  source,
}: {
  idLog: string;
  messageId: string;
  quote: QuotedMessageType | undefined;
  otherQuotes: ReadonlyArray<QuotedMessageType>;
  receivedAt: number;
  sentAt: number;
  urgency: AttachmentDownloadUrgency;
  source: AttachmentDownloadSource;
}): Promise<{ quote?: QuotedMessageType; count: number }> {
  const log = getLogger(source);
  let count = 0;
  if (!quote) {
    return { quote, count };
  }

  const quoteAttachmentsToQueue =
    quote && quote.attachments ? quote.attachments : [];
  if (quoteAttachmentsToQueue.length === 0) {
    return { quote, count };
  }

  // Similar to queueNormalAttachments' logic for detecting same attachments
  // except here we also pick by quote sent timestamp.
  const thumbnailSignatures: Map<string, ThumbnailType> = new Map();
  otherQuotes.forEach(otherQuote => {
    for (const attachment of otherQuote.attachments) {
      const signature = getQuoteThumbnailSignature(
        otherQuote,
        attachment.thumbnail
      );
      if (!signature || !attachment.thumbnail) {
        continue;
      }
      thumbnailSignatures.set(signature, attachment.thumbnail);
    }
  });

  return {
    quote: {
      ...quote,
      attachments: await Promise.all(
        quote.attachments.map(async item => {
          if (!item.thumbnail) {
            return item;
          }
          // We've already downloaded this!
          if (isDownloaded(item.thumbnail)) {
            log.info(`${idLog}: Quote attachment already downloaded`);
            return item;
          }

          const signature = getQuoteThumbnailSignature(quote, item.thumbnail);
          const existingThumbnail = signature
            ? thumbnailSignatures.get(signature)
            : undefined;

          // We've already downloaded this elsewhere!
          if (
            existingThumbnail &&
            (isDownloading(existingThumbnail) ||
              isDownloaded(existingThumbnail))
          ) {
            log.info(
              `${idLog}: Preview already downloaded elsewhere. Replacing`
            );
            // Incrementing count so that we update the message's fields downstream
            count += 1;
            return {
              ...item,
              thumbnail: existingThumbnail,
            };
          }

          count += 1;
          return {
            ...item,
            thumbnail: await AttachmentDownloadManager.addJob({
              attachment: item.thumbnail,
              messageId,
              attachmentType: 'quote',
              receivedAt,
              sentAt,
              urgency,
              source,
            }),
          };
        })
      ),
    },
    count,
  };
}
