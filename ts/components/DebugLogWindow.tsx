// Copyright 2015 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { MouseEvent } from 'react';
import React, { useEffect, useState } from 'react';
import copyText from 'copy-text-to-clipboard';
import * as log from '../logging/log';
import { Button, ButtonVariant } from './Button';
import type { LocalizerType } from '../types/Util';
import { Spinner } from './Spinner';
import { ToastDebugLogError } from './ToastDebugLogError';
import { ToastLinkCopied } from './ToastLinkCopied';
import { TitleBarContainer } from './TitleBarContainer';
import type { ExecuteMenuRoleType } from './TitleBarContainer';
import { ToastLoadingFullLogs } from './ToastLoadingFullLogs';
import { openLinkInWebBrowser } from '../util/openLinkInWebBrowser';
import { createSupportUrl } from '../util/createSupportUrl';
import * as Errors from '../types/errors';
import { useEscapeHandling } from '../hooks/useEscapeHandling';
import { useTheme } from '../hooks/useTheme';

enum LoadState {
  NotStarted,
  Started,
  Loaded,
  Submitting,
}

export type PropsType = {
  closeWindow: () => unknown;
  downloadLog: (text: string) => unknown;
  i18n: LocalizerType;
  fetchLogs: () => Promise<string>;
  uploadLogs: (logs: string) => Promise<string>;
  hasCustomTitleBar: boolean;
  executeMenuRole: ExecuteMenuRoleType;
};

enum ToastType {
  Copied,
  Error,
  Loading,
}

export function DebugLogWindow({
  closeWindow,
  downloadLog,
  i18n,
  fetchLogs,
  uploadLogs,
  hasCustomTitleBar,
  executeMenuRole,
}: PropsType): JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>(LoadState.NotStarted);
  const [logText, setLogText] = useState<string | undefined>();
  const [publicLogURL, setPublicLogURL] = useState<string | undefined>();
  const [textAreaValue, setTextAreaValue] = useState<string>(
    i18n('icu:loading')
  );
  const [toastType, setToastType] = useState<ToastType | undefined>();

  const theme = useTheme();

  useEscapeHandling(closeWindow);

  useEffect(() => {
    setLoadState(LoadState.Started);

    let shouldCancel = false;

    async function doFetchLogs() {
      const fetchedLogText = await fetchLogs();

      if (shouldCancel) {
        return;
      }

      setToastType(ToastType.Loading);
      setLogText(fetchedLogText);
      setLoadState(LoadState.Loaded);

      // This number is somewhat arbitrary; we want to show enough that it's
      // clear that we need to scroll, but not so many that things get slow.
      const linesToShow = Math.ceil(Math.min(window.innerHeight, 2000) / 5);
      const value = fetchedLogText.split(/\n/g, linesToShow).join('\n');

      setTextAreaValue(`${value}\n\n\n${i18n('icu:debugLogLogIsIncomplete')}`);
      setToastType(undefined);
    }

    void doFetchLogs();

    return () => {
      shouldCancel = true;
    };
  }, [fetchLogs, i18n]);

  const handleSubmit = async (ev: MouseEvent) => {
    ev.preventDefault();

    const text = logText;

    if (!text || text.length === 0) {
      return;
    }

    setLoadState(LoadState.Submitting);

    try {
      const publishedLogURL = await uploadLogs(text);
      setPublicLogURL(publishedLogURL);
    } catch (error) {
      log.error('DebugLogWindow error:', Errors.toLogFormat(error));
      setLoadState(LoadState.Loaded);
      setToastType(ToastType.Error);
    }
  };

  function closeToast() {
    setToastType(undefined);
  }

  let toastElement: JSX.Element | undefined;
  if (toastType === ToastType.Loading) {
    toastElement = <ToastLoadingFullLogs i18n={i18n} onClose={closeToast} />;
  } else if (toastType === ToastType.Copied) {
    toastElement = <ToastLinkCopied i18n={i18n} onClose={closeToast} />;
  } else if (toastType === ToastType.Error) {
    toastElement = <ToastDebugLogError i18n={i18n} onClose={closeToast} />;
  }

  if (publicLogURL) {
    const copyLog = (ev: MouseEvent) => {
      ev.preventDefault();
      copyText(publicLogURL);
      setToastType(ToastType.Copied);
    };

    const supportURL = createSupportUrl({
      locale: i18n.getLocale(),
      query: {
        debugLog: publicLogURL,
      },
    });

    return (
      <TitleBarContainer
        hasCustomTitleBar={hasCustomTitleBar}
        theme={theme}
        executeMenuRole={executeMenuRole}
      >
        <div className="DebugLogWindow">
          <div>
            <div className="DebugLogWindow__title">
              {i18n('icu:debugLogSuccess')}
            </div>
            <p className="DebugLogWindow__subtitle">
              {i18n('icu:debugLogSuccessNextSteps')}
            </p>
          </div>
          <div className="DebugLogWindow__container">
            <input
              className="DebugLogWindow__link"
              readOnly
              type="text"
              dir="auto"
              value={publicLogURL}
            />
          </div>
          <div className="DebugLogWindow__footer">
            <Button
              onClick={() => openLinkInWebBrowser(supportURL)}
              variant={ButtonVariant.Secondary}
            >
              {i18n('icu:reportIssue')}
            </Button>
            <Button onClick={copyLog}>{i18n('icu:debugLogCopy')}</Button>
          </div>
          {toastElement}
        </div>
      </TitleBarContainer>
    );
  }

  const canSubmit = Boolean(logText) && loadState !== LoadState.Submitting;
  const canSave = Boolean(logText);
  const isLoading =
    loadState === LoadState.Started || loadState === LoadState.Submitting;

  return (
    <TitleBarContainer
      hasCustomTitleBar={hasCustomTitleBar}
      theme={theme}
      executeMenuRole={executeMenuRole}
    >
      <div className="DebugLogWindow">
        <div>
          <div className="DebugLogWindow__title">
            {i18n('icu:submitDebugLog')}
          </div>
          <p className="DebugLogWindow__subtitle">
            {i18n('icu:debugLogExplanation')}
          </p>
        </div>
        {isLoading ? (
          <div className="DebugLogWindow__container">
            <Spinner svgSize="normal" />
          </div>
        ) : (
          <div className="DebugLogWindow__scroll_area">
            <pre className="DebugLogWindow__scroll_area__text">
              {textAreaValue}
            </pre>
          </div>
        )}
        <div className="DebugLogWindow__footer">
          <Button
            disabled={!canSave}
            onClick={() => {
              if (logText) {
                downloadLog(logText);
              }
            }}
            variant={ButtonVariant.Secondary}
          >
            {i18n('icu:debugLogSave')}
          </Button>
          <Button disabled={!canSubmit} onClick={handleSubmit}>
            {i18n('icu:submit')}
          </Button>
        </div>
        {toastElement}
      </div>
    </TitleBarContainer>
  );
}
