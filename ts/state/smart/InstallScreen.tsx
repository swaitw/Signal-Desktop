// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ComponentProps } from 'react';
import React, { memo, useCallback, useState, useEffect } from 'react';
import { useSelector } from 'react-redux';

import { getIntl } from '../selectors/user';
import { getUpdatesState } from '../selectors/updates';
import { getInstallerState } from '../selectors/installer';
import { useInstallerActions } from '../ducks/installer';
import { useUpdatesActions } from '../ducks/updates';
import { hasExpired as hasExpiredSelector } from '../selectors/expiration';
import { missingCaseError } from '../../util/missingCaseError';
import { backupsService } from '../../services/backups';
import { InstallScreen } from '../../components/InstallScreen';
import { WidthBreakpoint } from '../../components/_util';
import { InstallScreenStep } from '../../types/InstallScreen';
import OS from '../../util/os/osMain';
import { fileToBytes } from '../../util/fileToBytes';
import { isStagingServer } from '../../util/isStagingServer';
import * as log from '../../logging/log';
import { SmartToastManager } from './ToastManager';

type PropsType = ComponentProps<typeof InstallScreen>;

export const SmartInstallScreen = memo(function SmartInstallScreen() {
  const i18n = useSelector(getIntl);
  const installerState = useSelector(getInstallerState);
  const updates = useSelector(getUpdatesState);
  const { startInstaller, finishInstall, retryBackupImport } =
    useInstallerActions();
  const { startUpdate, forceUpdate } = useUpdatesActions();
  const hasExpired = useSelector(hasExpiredSelector);

  const [deviceName, setDeviceName] = useState<string>('');
  const [backupFile, setBackupFile] = useState<File | undefined>();

  const onSubmitDeviceName = useCallback(async () => {
    if (backupFile != null) {
      // This is only for testing so don't bother catching errors
      finishInstall({
        deviceName,
        backupFile: await fileToBytes(backupFile),
        isLinkAndSync: false,
      });
    } else {
      finishInstall({
        deviceName,
        backupFile: undefined,
        isLinkAndSync: false,
      });
    }
  }, [backupFile, deviceName, finishInstall]);

  const onCancelBackupImport = useCallback((): void => {
    backupsService.cancelDownloadAndImport();
  }, []);

  const suggestedDeviceName =
    installerState.step === InstallScreenStep.ChoosingDeviceName
      ? installerState.deviceName
      : undefined;

  useEffect(() => {
    setDeviceName(suggestedDeviceName ?? '');
  }, [suggestedDeviceName]);

  let props: PropsType;

  switch (installerState.step) {
    case InstallScreenStep.NotStarted:
      log.error('InstallScreen: Installer not started');
      return null;

    case InstallScreenStep.QrCodeNotScanned:
      props = {
        step: InstallScreenStep.QrCodeNotScanned,
        screenSpecificProps: {
          i18n,
          provisioningUrl: installerState.provisioningUrl,
          hasExpired,
          updates,
          currentVersion: window.getVersion(),
          startUpdate,
          forceUpdate,
          retryGetQrCode: startInstaller,
          OS: OS.getName(),
          isStaging: isStagingServer(),
        },
      };
      break;
    case InstallScreenStep.ChoosingDeviceName:
      props = {
        step: InstallScreenStep.ChoosingDeviceName,
        screenSpecificProps: {
          i18n,
          deviceName,
          setDeviceName,
          setBackupFile,
          onSubmit: onSubmitDeviceName,
        },
      };
      break;
    case InstallScreenStep.LinkInProgress:
      props = {
        step: InstallScreenStep.LinkInProgress,
        screenSpecificProps: { i18n },
      };
      break;
    case InstallScreenStep.BackupImport:
      props = {
        step: InstallScreenStep.BackupImport,
        screenSpecificProps: {
          i18n,
          ...installerState,
          onCancel: onCancelBackupImport,
          onRetry: retryBackupImport,
          onRestartLink: startInstaller,
          updates,
          currentVersion: window.getVersion(),
          forceUpdate,
          startUpdate,
          OS: OS.getName(),
        },
      };
      break;
    case InstallScreenStep.Error:
      props = {
        step: InstallScreenStep.Error,
        screenSpecificProps: {
          i18n,
          error: installerState.error,
          quit: () => window.IPC.shutdown(),
          tryAgain: startInstaller,
        },
      };
      break;
    default:
      throw missingCaseError(installerState);
  }

  return (
    <>
      <InstallScreen {...props} />
      <SmartToastManager
        disableMegaphone
        containerWidthBreakpoint={WidthBreakpoint.Narrow}
      />
    </>
  );
});
