import { UploadFormSchemaType } from '@/components/file-upload-dialog';
import { useSetModalState } from '@/hooks/common-hooks';
import { useUploadFile } from '@/hooks/use-file-request';
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useGetFolderId } from './hooks';

export const useHandleUploadFile = () => {
  const { t } = useTranslation();
  const {
    visible: fileUploadVisible,
    hideModal: hideFileUploadModal,
    showModal: showFileUploadModal,
  } = useSetModalState();
  const { uploadFile, loading, batchProgress } = useUploadFile();
  const id = useGetFolderId();

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
    } else {
      const speed = t('fileManager.uploadSpeed', { speed: batchProgress.speedKbps });
      const currentFile = t('fileManager.uploadingFile', { filename: batchProgress.currentFileName });
      uploadProgressText = `${batchHeader} (${batchProgress.percent}%, ${speed}) - ${currentFile}`;
    }
  }

  const onFileUploadOk = useCallback(
    async ({ fileList }: UploadFormSchemaType): Promise<number | undefined> => {
      if (fileList.length > 0) {
        const ret: number | undefined = await uploadFile({
          fileList: fileList as File[],
          parentId: id,
        });
        if (ret === 0) {
          hideFileUploadModal();
        }
        return ret;
      }
    },
    [uploadFile, hideFileUploadModal, id],
  );

  return {
    fileUploadLoading: loading,
    uploadProgressText,
    onFileUploadOk,
    fileUploadVisible,
    hideFileUploadModal,
    showFileUploadModal,
  };
};
