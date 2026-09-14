import { UploadFormSchemaType } from '@/components/file-upload-dialog';
import { useSetModalState } from '@/hooks/common-hooks';
import {
  useRunDocument,
  useUploadDocument,
} from '@/hooks/use-document-request';
import { getUnSupportedFilesCount } from '@/utils/document-util';
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

export const useHandleUploadDocument = () => {
  const { t } = useTranslation();
  const {
    visible: documentUploadVisible,
    hideModal: hideDocumentUploadModal,
    showModal: showDocumentUploadModal,
  } = useSetModalState();
  const { uploadDocument, loading, batchProgress } = useUploadDocument();
  const { runDocumentByIds } = useRunDocument();

  // Prevent user from accidentally closing/refreshing tab while uploading
  useEffect(() => {
    if (!loading) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [loading]);

  let uploadProgressText: string | undefined;
  if (batchProgress) {
    const batchHeader = t('fileManager.uploadingBatch', {
      current: batchProgress.current,
      total: batchProgress.total,
    });
    if (batchProgress.isServerProcessing) {
      uploadProgressText = `${batchHeader} (${batchProgress.percent}%) - ${t('fileManager.uploadServerProcessing')}`;
    } else if (batchProgress.stalled) {
      uploadProgressText = `${batchHeader} (等待網路連線 / 傳輸中斷重試中…) - ${t('fileManager.uploadingFile', { filename: batchProgress.currentFileName })}`;
    } else {
      const speed = t('fileManager.uploadSpeed', { speed: batchProgress.speedKbps });
      const currentFile = t('fileManager.uploadingFile', { filename: batchProgress.currentFileName });
      uploadProgressText = `${batchHeader} (${batchProgress.percent}%, ${speed}) - ${currentFile}`;
    }
  }

  const onDocumentUploadOk = useCallback(
    async ({
      fileList,
      parseOnCreation,
      tableColumnMode,
      tableColumnRoles,
    }: UploadFormSchemaType) => {
      if (fileList.length > 0) {
        // Build parser_config if column roles are configured
        let parserConfig: Record<string, any> | undefined;
        if (
          tableColumnMode === 'manual' &&
          tableColumnRoles &&
          Object.keys(tableColumnRoles).length > 0
        ) {
          parserConfig = {
            table_column_mode: 'manual',
            table_column_roles: tableColumnRoles,
          };
        }

        const ret = await uploadDocument(fileList as File[], parserConfig);

        // Check for success (code === 0) or partial success (code === 500 with some files)
        const isSuccess = ret?.code === 0;
        const isPartialSuccess = ret?.code === 500 && ret?.message;

        if (!isSuccess && !isPartialSuccess) {
          return;
        }

        // Trigger parsing for both full and partial success when parseOnCreation is enabled
        if (
          (isSuccess || isPartialSuccess) &&
          parseOnCreation &&
          ret.data?.length > 0
        ) {
          runDocumentByIds({
            documentIds: ret.data.map((x: any) => x.id),
            run: 1,
          });
        }

        if (isSuccess) {
          hideDocumentUploadModal();
          return 0;
        }

        // For partial success (code 500), check if any files were uploaded
        const count = getUnSupportedFilesCount(ret?.message);
        if (count !== fileList.length) {
          hideDocumentUploadModal();
          return 0;
        }

        return ret?.code;
      }
    },
    [uploadDocument, runDocumentByIds, hideDocumentUploadModal],
  );

  return {
    documentUploadLoading: loading,
    uploadProgressText,
    onDocumentUploadOk,
    documentUploadVisible,
    hideDocumentUploadModal,
    showDocumentUploadModal,
  };
};
