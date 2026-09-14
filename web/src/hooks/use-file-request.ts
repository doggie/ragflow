/*
 *  Copyright 2026 The InfiniFlow Authors. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

import message from '@/components/ui/message';
import { PaginationProps } from '@/interfaces/antd-compat';
import {
  IFetchFileListResult,
  IFile,
  IFolder,
} from '@/interfaces/database/file-manager';
import {
  ConnectFileToKnowledgeMode,
  IConnectRequestBody,
} from '@/interfaces/request/file-manager';
import fileManagerService, {
  uploadFileManagerFile,
} from '@/services/file-manager-service';
import api from '@/utils/api';
import { downloadFileFromBlob } from '@/utils/file-util';
import request from '@/utils/request';
import {
  chunkUploadFiles,
  createBatchUploadTracker,
  UploadSpeedProgress,
} from '@/utils/upload-batching';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useDebounce } from 'ahooks';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import {
  useGetPaginationWithRouter,
  useHandleSearchChange,
} from './logic-hooks';
import { useSetPaginationParams } from './route-hook';

export const enum FileApiAction {
  UploadFile = 'uploadFile',
  FetchFileList = 'fetchFileList',
  MoveFile = 'moveFile',
  CreateFolder = 'createFolder',
  FetchParentFolderList = 'fetchParentFolderList',
  DeleteFile = 'deleteFile',
  DownloadFile = 'downloadFile',
  RenameFile = 'renameFile',
  ConnectFileToKnowledge = 'connectFileToKnowledge',
  FetchPureFileList = 'fetchPureFileList',
}

export const useGetFolderId = () => {
  const [searchParams] = useSearchParams();
  const id = searchParams.get('folderId') as string;

  return id ?? '';
};

export interface IFileUploadBatchProgress extends UploadSpeedProgress {
  current: number;
  total: number;
}

export const useUploadFile = () => {
  const { setPaginationParams } = useSetPaginationParams();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [batchProgress, setBatchProgress] = useState<IFileUploadBatchProgress | null>(null);

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [FileApiAction.UploadFile],
    mutationFn: async (params: { fileList: File[]; parentId: string }) => {
      // Carry each file's folder-relative path alongside it so batching keeps
      // the file→path pairing intact.
      const entries = params.fileList.map((file: any) => ({
        file,
        path: file.webkitRelativePath,
      }));

      // Send the selection as sequential sub-requests, each kept under the
      // server's per-request body cap, so a large folder still uploads
      // instead of being rejected with 413.
      const batches = chunkUploadFiles(entries);

      let allOk = true;
      let anySucceeded = false;
      let lastCode: number | undefined;
      const totalBytesAll = params.fileList.reduce((acc, f: any) => acc + (f.file ? f.file.size : f.size || 0), 0);
      console.info(
        `[UploadFileManager] Start uploading ${params.fileList.length} files (${(totalBytesAll / 1024 / 1024).toFixed(2)} MB) to folder ${params.parentId} in ${batches.length} batches.`,
      );

      try {
        for (let i = 0; i < batches.length; i++) {
          const currentBatchFiles = batches[i];
          const batchIndex = i + 1;
          const batchBytes = currentBatchFiles.reduce((acc, f: any) => acc + (f.file ? f.file.size : f.size || 0), 0);
          const batchBytesMb = (batchBytes / 1024 / 1024).toFixed(2);
          const tracker = createBatchUploadTracker(currentBatchFiles);
          const startTime = performance.now();

          console.info(
            `[UploadFileManager] [Batch ${batchIndex}/${batches.length}] Sending ${currentBatchFiles.length} files (${batchBytesMb} MB)...`,
          );

          setBatchProgress({
            current: batchIndex,
            total: batches.length,
            speedKbps: 0,
            currentFileName: currentBatchFiles[0]?.path || currentBatchFiles[0]?.file?.name || '',
            loadedBytes: 0,
            totalBytes: batchBytes,
            percent: 0,
            isServerProcessing: false,
          });

          const formData = new FormData();
          formData.append('parent_id', params.parentId);
          currentBatchFiles.forEach(({ file, path }) => {
            // Explicitly set filename to file.name (base name) to prevent the
            // browser from using webkitRelativePath (e.g. "folder/file.txt")
            // which would cause the backend to create an extra folder.
            formData.append('file', file, file.name);
            formData.append('path', path);
          });

          let lastLoggedPercent = 0;
          try {
            const ret = await uploadFileManagerFile(formData, {
              onUploadProgress: (progressEvent) => {
                const loaded = progressEvent.loaded || 0;
                const total = progressEvent.total || 0;
                const trackInfo = tracker(loaded, total);
                setBatchProgress({
                  current: batchIndex,
                  total: batches.length,
                  ...trackInfo,
                });

                if (trackInfo.percent >= lastLoggedPercent + 25 || trackInfo.percent === 100) {
                  lastLoggedPercent = trackInfo.percent;
                  console.info(
                    `[UploadFileManager] [Batch ${batchIndex}/${batches.length}] Progress: ${trackInfo.percent}% (${(trackInfo.loadedBytes / 1024 / 1024).toFixed(1)} / ${(trackInfo.totalBytes / 1024 / 1024).toFixed(1)} MB, ${trackInfo.speedKbps} kB/s, current: ${trackInfo.currentFileName})`,
                  );
                }
              },
            });
            const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(1);
            const code = ret?.data?.code;
            if (code === 0) {
              anySucceeded = true;
              console.info(
                `[UploadFileManager] [Batch ${batchIndex}/${batches.length}] SUCCESS in ${elapsedSec}s.`,
              );
            } else {
              allOk = false;
              lastCode = code;
              console.error(
                `[UploadFileManager] [Batch ${batchIndex}/${batches.length}] FAILED with code ${code} after ${elapsedSec}s: ${ret?.data?.message}`,
              );
            }
          } catch (batchErr) {
            // Best effort: a failed batch is recorded and the rest continue.
            const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(1);
            allOk = false;
            console.error(
              `[UploadFileManager] [Batch ${batchIndex}/${batches.length}] ERROR after ${elapsedSec}s:`,
              batchErr,
            );
          }
        }

        // Run the success side-effects once (not per batch) so the user sees a
        // single toast and one list refresh.
        if (anySucceeded) {
          message.success(t('message.uploaded'));
          setPaginationParams(1);
          queryClient.invalidateQueries({
            queryKey: [FileApiAction.FetchFileList],
          });
        }

        return allOk ? 0 : lastCode;
      } finally {
        setBatchProgress(null);
      }
    },
  });

  return { data, loading, uploadFile: mutateAsync, batchProgress };
};

export interface IMoveFileBody {
  src_file_ids: string[];
  dest_file_id?: string;
  new_name?: string;
}

export const useMoveFile = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [FileApiAction.MoveFile],
    mutationFn: async (params: IMoveFileBody) => {
      const { data } = await fileManagerService.moveFile(params);
      if (data.code === 0) {
        message.success(t('message.operated'));
        queryClient.invalidateQueries({
          queryKey: [FileApiAction.FetchFileList],
        });
      }
      return data.code;
    },
  });

  return { data, loading, moveFile: mutateAsync };
};

export const useCreateFolder = () => {
  const { setPaginationParams } = useSetPaginationParams();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [FileApiAction.CreateFolder],
    mutationFn: async (params: { parentId: string; name: string }) => {
      const { data } = await fileManagerService.createFolder({
        name: params.name,
        parent_id: params.parentId,
        type: 'folder',
      });
      if (data.code === 0) {
        message.success(t('message.created'));
        setPaginationParams(1);
        queryClient.invalidateQueries({
          queryKey: [FileApiAction.FetchFileList],
        });
      }
      return data.code;
    },
  });

  return { data, loading, createFolder: mutateAsync };
};

export const useFetchParentFolderList = () => {
  const id = useGetFolderId();
  const { data } = useQuery<IFolder[]>({
    queryKey: [FileApiAction.FetchParentFolderList, id],
    initialData: [],
    enabled: !!id,
    queryFn: async () => {
      const { data } = await fileManagerService.getAllParentFolder(
        {},
        `${id}/ancestors`,
      );

      return data?.data?.parent_folders?.toReversed() ?? [];
    },
  });

  return data;
};

export interface IListResult {
  searchString: string;
  handleInputChange: React.ChangeEventHandler<HTMLInputElement>;
  pagination: PaginationProps;
  setPagination: (pagination: { page: number; pageSize: number }) => void;
  loading: boolean;
}

export const useFetchFileList = () => {
  const { searchString, handleInputChange } = useHandleSearchChange();
  const { pagination, setPagination } = useGetPaginationWithRouter();
  const id = useGetFolderId();
  const debouncedSearchString = useDebounce(searchString, { wait: 500 });

  const { data, isFetching: loading } = useQuery<IFetchFileListResult>({
    queryKey: [
      FileApiAction.FetchFileList,
      {
        id,
        debouncedSearchString,
        ...pagination,
      },
    ],
    initialData: { files: [], parent_folder: {} as IFolder, total: 0 },
    gcTime: 0,
    queryFn: async () => {
      const { data } = await fileManagerService.listFile({
        parent_id: id,
        keywords: debouncedSearchString,
        page_size: pagination.pageSize,
        page: pagination.current,
      });

      return data?.data;
    },
  });

  const onInputChange: React.ChangeEventHandler<HTMLInputElement> = useCallback(
    (e) => {
      setPagination({ page: 1 });
      handleInputChange(e);
    },
    [handleInputChange, setPagination],
  );

  return {
    ...data,
    searchString,
    handleInputChange: onInputChange,
    pagination: { ...pagination, total: data?.total },
    setPagination,
    loading,
  };
};

export const useDeleteFile = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [FileApiAction.DeleteFile],
    mutationFn: async (params: { fileIds: string[]; parentId: string }) => {
      try {
        const { data } = await fileManagerService.removeFile({
          ids: params.fileIds,
        });
        if (data.code === 0) {
          message.success(t('message.deleted'));
        }
        queryClient.invalidateQueries({
          queryKey: [FileApiAction.FetchFileList],
        });
        return data.code;
      } catch {
        // Swallow request failures so callers awaiting the mutation never
        // produce an unhandled rejection; a failed delete simply returns no
        // code and the selection state stays untouched.
        return;
      }
    },
  });

  return { data, loading, deleteFile: mutateAsync };
};

export const useDownloadFile = () => {
  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [FileApiAction.DownloadFile],
    mutationFn: async (params: { id: string; filename?: string }) => {
      const response = await fileManagerService.getFile({}, params.id);
      const blob = new Blob([response.data], { type: response.data.type });
      downloadFileFromBlob(blob, params.filename);
    },
  });
  return { data, loading, downloadFile: mutateAsync };
};

export const useRenameFile = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [FileApiAction.RenameFile],
    mutationFn: async (params: { fileId: string; name: string }) => {
      const { data } = await fileManagerService.moveFile({
        src_file_ids: [params.fileId],
        new_name: params.name,
      });
      if (data.code === 0) {
        message.success(t('message.renamed'));
        queryClient.invalidateQueries({
          queryKey: [FileApiAction.FetchFileList],
        });
      }
      return data.code;
    },
  });

  return { data, loading, renameFile: mutateAsync };
};

const LinkedDatasetsPollIntervalMs = 500;
const LinkedDatasetsPollMaxAttempts = 6;

// Returns true when every affected file row on the current page carries all the
// newly linked datasets. Rows that are not on the current page, or folder rows
// (which never carry kbs_info), cannot be verified and are treated as done.
const areDatasetsLinked = (
  queryClient: QueryClient,
  fileIds: string[],
  kbIds: string[],
) => {
  const cached =
    queryClient.getQueriesData<IFetchFileListResult>({
      queryKey: [FileApiAction.FetchFileList],
    })[0]?.[1] ?? { files: [] };
  const verifiableFiles = (cached.files ?? []).filter(
    (file) => fileIds.includes(file.id) && file.type !== 'folder',
  );
  if (verifiableFiles.length === 0) return true;
  return verifiableFiles.every((file) =>
    kbIds.every((kbId) => file.kbs_info?.some((kb) => kb.kb_id === kbId)),
  );
};

// Both backends respond to link-to-datasets before the file↔dataset mappings
// are written (the conversion runs in the background), so the refetch right
// after success can still see stale kbs_info. Poll until the newly linked
// datasets show up in the list data; give up after a bounded window.
const waitUntilDatasetsLinked = async (
  queryClient: QueryClient,
  fileIds: string[],
  kbIds: string[],
) => {
  for (let attempt = 0; attempt < LinkedDatasetsPollMaxAttempts; attempt++) {
    if (areDatasetsLinked(queryClient, fileIds, kbIds)) return;
    await new Promise((resolve) =>
      setTimeout(resolve, LinkedDatasetsPollIntervalMs),
    );
    await queryClient.refetchQueries({
      queryKey: [FileApiAction.FetchFileList],
    });
  }
};

export const useConnectToKnowledge = () => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [FileApiAction.ConnectFileToKnowledge],
    mutationFn: async (
      params: IConnectRequestBody & {
        mode: ConnectFileToKnowledgeMode;
        kbsInfo: IFile['kbs_info'];
      },
    ) => {
      const { data } = await request.post(api.connectFileToKnowledge, {
        data: { fileIds: params.fileIds, kbIds: params.kbIds },
        params: { mode: params.mode },
      });
      if (data.code === 0) {
        message.success(t('message.operated'));
        await queryClient.invalidateQueries({
          queryKey: [FileApiAction.FetchFileList],
        });
        await waitUntilDatasetsLinked(
          queryClient,
          params.fileIds,
          params.kbIds,
        );
      }
      return data.code;
    },
  });

  return { data, loading, connectFileToKnowledge: mutateAsync };
};

export const useFetchPureFileList = () => {
  const { mutateAsync, isPending: loading } = useMutation({
    mutationKey: [FileApiAction.FetchPureFileList],
    gcTime: 0,

    mutationFn: async (parentId: string) => {
      const { data } = await fileManagerService.listFile({
        parent_id: parentId,
        page_size: 100,
        page: 1,
      });

      return data;
    },
  });

  return { loading, fetchList: mutateAsync };
};
