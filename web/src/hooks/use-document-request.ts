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

import { useHandleFilterSubmit } from '@/components/list-filter-bar/use-handle-filter-submit';

import message from '@/components/ui/message';
import { RunningStatus } from '@/constants/knowledge';
import { ResponseType } from '@/interfaces/database/base';
import { IReferenceChunk } from '@/interfaces/database/chat';
import { IChunk } from '@/interfaces/database/dataset';
import {
  IDocumentInfo,
  IDocumentInfoFilter,
} from '@/interfaces/database/document';
import { IStructureGraphResponse } from '@/interfaces/database/document-structure';
import {
  IChangeParserConfigRequestBody,
  IDocumentMetaRequestBody,
} from '@/interfaces/request/document';
import i18n from '@/locales/config';
import { EMPTY_METADATA_FIELD } from '@/pages/dataset/dataset/use-select-filters';
import documentStructureService from '@/services/document-structure-service';
import kbService, {
  changeDocumentParser,
  changeDocumentsStatus,
  createDocument,
  deleteDocument,
  documentFilter,
  listDocument,
  renameDocument,
  uploadDocument,
} from '@/services/knowledge-service';
import { restAPIv1 } from '@/utils/api';
import { buildChunkHighlights } from '@/utils/document-util';
import {
  chunkUploadFiles,
  createBatchUploadTracker,
  UploadSpeedProgress,
} from '@/utils/upload-batching';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useDebounce } from 'ahooks';
import dayjs from 'dayjs';
import { get } from 'lodash';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IHighlight } from 'react-pdf-highlighter';
import { useParams } from 'react-router';
import {
  useGetPaginationWithRouter,
  useHandleSearchChange,
} from './logic-hooks';
import {
  extractParserConfigExt,
  isPipelineParserConfig,
} from './parser-config-utils';
import {
  useGetKnowledgeSearchParams,
  useSetPaginationParams,
} from './route-hook';
import { KnowledgeApiAction } from './use-knowledge-request';
import { DocumentApiAction, DocumentKeys } from './document-query-keys';

export { DocumentApiAction, DocumentKeys } from './document-query-keys';

export const enum DocumentStructureApiAction {
  FetchDocumentStructureGraph = 'fetchDocumentStructureGraph',
  DeleteDocumentStructureGraph = 'deleteDocumentStructureGraph',
}

const documentIngestInFlight = new Map<string, Promise<unknown>>();

export const DocumentStructureKeys = {
  graph: (datasetId: string, documentId: string) =>
    [
      DocumentStructureApiAction.FetchDocumentStructureGraph,
      datasetId,
      documentId,
    ] as const,
  graphWithKeywords: (
    datasetId: string,
    documentId: string,
    keywords: string,
  ) =>
    [
      DocumentStructureApiAction.FetchDocumentStructureGraph,
      datasetId,
      documentId,
      keywords,
    ] as const,
};

export interface IUploadBatchProgress extends UploadSpeedProgress {
  current: number;
  total: number;
  stalled?: boolean;
}

const UPLOAD_CHECKPOINT_KEY = 'ragflow_upload_checkpoint';
const UPLOAD_CRASH_LOG_KEY = 'ragflow_upload_crash_log';

function saveUploadCrashLog(reason: string, details: any) {
  try {
    const entry = {
      time: new Date().toISOString(),
      reason,
      details: typeof details === 'object' ? (details?.stack || details?.message || JSON.stringify(details)) : String(details),
    };
    const raw = localStorage.getItem(UPLOAD_CRASH_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    localStorage.setItem(UPLOAD_CRASH_LOG_KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    // Ignore localStorage write failure
  }
}

function saveUploadCheckpoint(checkpoint: {
  datasetId: string;
  batchIndex: number;
  totalBatches: number;
  uploadedCount: number;
  totalFiles: number;
  status: 'uploading' | 'completed' | 'failed';
  lastBatchNames?: string[];
} | null) {
  try {
    if (!checkpoint) {
      localStorage.removeItem(UPLOAD_CHECKPOINT_KEY);
    } else {
      localStorage.setItem(UPLOAD_CHECKPOINT_KEY, JSON.stringify({ ...checkpoint, updatedAt: Date.now() }));
    }
  } catch {
    // Ignore
  }
}

/**
 * Isolated batch execution helper.
 * Extracted as a standalone function outside the generator loop to prevent Terser /
 * esbuild identifier collisions (e.g. `s` and `p` reuse across yield points) in
 * production transpiled bundles.
 */
async function uploadSingleDatasetBatch(
  datasetId: string,
  batchFiles: File[],
  batchIndex: number,
  totalBatches: number,
  parserConfig: Record<string, any> | undefined,
  onProgress: (info: UploadSpeedProgress) => void,
): Promise<{
  ok: boolean;
  data: IDocumentInfo[];
  message?: string;
}> {
  const batchBytes = batchFiles.reduce((acc, f: any) => acc + (f.size || 0), 0);
  const batchBytesMb = (batchBytes / 1024 / 1024).toFixed(2);
  const tracker = createBatchUploadTracker(batchFiles);
  const startTime = performance.now();

  console.info(
    `[UploadDocument] [Batch ${batchIndex}/${totalBatches}] Sending ${batchFiles.length} files (${batchBytesMb} MB)...`,
    batchFiles.map((f: any) => ({ name: f.name, size: f.size })),
  );

  const formData = new FormData();
  batchFiles.forEach((file: any) => {
    formData.append('file', file);
  });
  if (parserConfig) {
    formData.append('parser_config', JSON.stringify(parserConfig));
  }

  let lastLoggedPercent = 0;
  try {
    const ret = await uploadDocument(datasetId, formData, {
      onUploadProgress: (progressEvent) => {
        const loaded = progressEvent.loaded || 0;
        const total = progressEvent.total || 0;
        const trackInfo = tracker(loaded, total);
        onProgress(trackInfo);

        if (trackInfo.percent >= lastLoggedPercent + 25 || trackInfo.percent === 100) {
          lastLoggedPercent = trackInfo.percent;
          console.info(
            `[UploadDocument] [Batch ${batchIndex}/${totalBatches}] Progress: ${trackInfo.percent}% (${(trackInfo.loadedBytes / 1024 / 1024).toFixed(1)} / ${(trackInfo.totalBytes / 1024 / 1024).toFixed(1)} MB, ${trackInfo.speedKbps} kB/s, current: ${trackInfo.currentFileName})`,
          );
        }
      },
    });

    const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(1);
    const code = get(ret, 'code');
    const batchNames = batchFiles.map((f: any) => f.name);
    const respData = get(ret, 'data');
    const respItems: IDocumentInfo[] = Array.isArray(respData) ? respData : [];

    if (respItems.length === 0 && batchNames.length > 0 && code === 0) {
      console.error(
        `[UploadDocument] [Batch ${batchIndex}/${totalBatches}] SUSPICIOUS: server returned code 0 but 0 items for ${batchNames.length} files. Did not ingest this batch.`,
      );
      return {
        ok: false,
        data: [],
        message: `[Batch ${batchIndex}/${totalBatches}] Server returned 0 items for ${batchNames.length} files`,
      };
    }

    if (code !== 0) {
      const errMsg = get(ret, 'message');
      console.error(
        `[UploadDocument] [Batch ${batchIndex}/${totalBatches}] FAILED with code ${code} after ${elapsedSec}s: ${errMsg}`,
      );
      return {
        ok: false,
        data: respItems,
        message: errMsg || `[Batch ${batchIndex}/${totalBatches}] Error code ${code}`,
      };
    }

    console.info(
      `[UploadDocument] [Batch ${batchIndex}/${totalBatches}] SUCCESS in ${elapsedSec}s. Response items: ${respItems.length}`,
    );
    return {
      ok: true,
      data: respItems,
      message: get(ret, 'message'),
    };
  } catch (batchErr) {
    const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(1);
    console.error(
      `[UploadDocument] [Batch ${batchIndex}/${totalBatches}] REJECTED after ${elapsedSec}s, continuing with remaining batches:`,
      batchErr,
    );
    const errMsg =
      batchErr && typeof batchErr === 'object' && 'message' in batchErr
        ? (batchErr as any).message
        : String(batchErr);
    return {
      ok: false,
      data: [],
      message: `[Batch ${batchIndex}/${totalBatches}] ${errMsg}`,
    };
  }
}

export const useUploadDocument = () => {
  const queryClient = useQueryClient();
  const { id } = useParams();
  const [batchProgress, setBatchProgress] = useState<IUploadBatchProgress | null>(null);
  const crashShield = useRef<{ errorHandler?: (e: ErrorEvent) => void; rejectionHandler?: (e: PromiseRejectionEvent) => void }>({});

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation<
    ResponseType<IDocumentInfo[]>,
    Error,
    { fileList: File[]; parserConfig?: Record<string, any> }
  >({
    mutationKey: [DocumentApiAction.UploadDocument],
    mutationFn: async ({ fileList, parserConfig }) => {
      if (!id) {
        return {
          code: 500,
          message: 'Dataset ID is required',
        } as ResponseType<IDocumentInfo[]>;
      }

      // Send the selection as sequential sub-requests, each kept under the
      // server's per-request body cap, so a large folder still uploads
      // instead of being rejected with 413.
      const batches = chunkUploadFiles(fileList);
      const totalBytesAll = fileList.reduce((acc, f: any) => acc + (f.size || 0), 0);
      console.info(
        `[UploadDocument] Start uploading ${fileList.length} files (${(totalBytesAll / 1024 / 1024).toFixed(2)} MB) to dataset ${id} in ${batches.length} batches.`,
      );

      let allOk = true;
      const uploaded: IDocumentInfo[] = [];
      const messages: string[] = [];

      // Crash & unhandled rejection safety net
      const errorHandler = (e: ErrorEvent) => {
        saveUploadCrashLog('window.error', {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          error: e.error,
        });
      };
      const rejectionHandler = (e: PromiseRejectionEvent) => {
        saveUploadCrashLog('window.unhandledrejection', {
          reason: e.reason,
        });
      };
      window.addEventListener('error', errorHandler);
      window.addEventListener('unhandledrejection', rejectionHandler);
      crashShield.current = { errorHandler, rejectionHandler };

      saveUploadCheckpoint({
        datasetId: id,
        batchIndex: 0,
        totalBatches: batches.length,
        uploadedCount: 0,
        totalFiles: fileList.length,
        status: 'uploading',
      });

      try {
        for (let i = 0; i < batches.length; i++) {
          const currentBatchFiles = batches[i];
          const batchIndex = i + 1;
          const currentBatchBytes = currentBatchFiles.reduce(
            (acc, f: any) => acc + (f.size || 0),
            0,
          );

          setBatchProgress({
            current: batchIndex,
            total: batches.length,
            speedKbps: 0,
            currentFileName: currentBatchFiles[0]?.name || '',
            loadedBytes: 0,
            totalBytes: currentBatchBytes,
            percent: 0,
            isServerProcessing: false,
          });

          // Stall watchdog: if a batch stays at 0 progress for > 20s, flag stalled in UI
          let progressReceived = false;
          const watchdogTimer = setTimeout(() => {
            if (!progressReceived) {
              console.warn(
                `[UploadDocument] [Batch ${batchIndex}/${batches.length}] Watchdog: no progress event after 20s. Batch might be stalled or browser network throttled.`,
              );
              setBatchProgress((prev) =>
                prev ? { ...prev, stalled: true } : prev,
              );
              saveUploadCrashLog('batch.stalled.20s', {
                batchIndex,
                totalBatches: batches.length,
                files: currentBatchFiles.map((f: any) => ({ name: f.name, size: f.size })),
              });
            }
          }, 20000);

          let result;
          try {
            result = await uploadSingleDatasetBatch(
              id,
              currentBatchFiles,
              batchIndex,
              batches.length,
              parserConfig,
              (trackInfo) => {
                progressReceived = true;
                setBatchProgress({
                  current: batchIndex,
                  total: batches.length,
                  stalled: false,
                  ...trackInfo,
                });
              },
            );
          } finally {
            clearTimeout(watchdogTimer);
          }

          if (!result.ok) {
            allOk = false;
          }
          if (result.data.length > 0) {
            uploaded.push(...result.data);
          }
          if (result.message) {
            messages.push(result.message);
          }

          saveUploadCheckpoint({
            datasetId: id,
            batchIndex,
            totalBatches: batches.length,
            uploadedCount: uploaded.length,
            totalFiles: fileList.length,
            status: 'uploading',
            lastBatchNames: currentBatchFiles.map((f: any) => f.name),
          });

          // Yield to the event loop between batches so the browser can drain
          // queued XHR progress/load events, run GC on the File objects of the
          // batch just sent, and repaint the progress text. Without this, heavy
          // DOM + GC churn from the 2900-file list can starve the main thread
          // and the next `onload` resolution never fires (the Batch-1 hang).
          await new Promise((r) => setTimeout(r, 50));
        }

        saveUploadCheckpoint({
          datasetId: id,
          batchIndex: batches.length,
          totalBatches: batches.length,
          uploadedCount: uploaded.length,
          totalFiles: fileList.length,
          status: 'completed',
        });

        // Await the refetch so the fresh list (including the just-uploaded
        // documents) reaches the cache before callers optimistically mark
        // them RUNNING. Otherwise the late refetch lands after the
        // optimistic update, overwrites it, and polling never starts.
        if (uploaded.length > 0) {
          await queryClient.invalidateQueries({
            queryKey: DocumentKeys.all(),
          });
        }

        return {
          code: allOk ? 0 : 500,
          message: messages.join('\n'),
          data: uploaded,
        } as ResponseType<IDocumentInfo[]>;
      } catch (error) {
        console.warn(error);
        saveUploadCrashLog('mutation.catch', error);
        saveUploadCheckpoint({
          datasetId: id,
          batchIndex: 0,
          totalBatches: batches.length,
          uploadedCount: uploaded.length,
          totalFiles: fileList.length,
          status: 'failed',
        });
        return {
          code: 500,
          message: error + '',
        } as ResponseType<IDocumentInfo[]>;
      } finally {
        if (crashShield.current.errorHandler) {
          window.removeEventListener('error', crashShield.current.errorHandler);
        }
        if (crashShield.current.rejectionHandler) {
          window.removeEventListener(
            'unhandledrejection',
            crashShield.current.rejectionHandler,
          );
        }
        setBatchProgress(null);
      }
    },
  });

  const upload = useCallback(
    (fileList: File[], parserConfig?: Record<string, any>) =>
      mutateAsync({ fileList, parserConfig }),
    [mutateAsync],
  );

  // Mount-time recovery notice if previous upload was interrupted
  useEffect(() => {
    try {
      const raw = localStorage.getItem(UPLOAD_CHECKPOINT_KEY);
      if (!raw) return;
      const cp = JSON.parse(raw);
      if (cp && cp.status === 'uploading' && cp.datasetId === id) {
        console.warn('[UploadDocument] Detected interrupted upload checkpoint:', cp);
        message.warning(
          `偵測到上次上傳中斷於第 ${cp.batchIndex}/${cp.totalBatches} 批（已傳送 ${cp.uploadedCount} 個檔案），本次上傳將重新同步。`,
        );
      }
    } catch {
      // Ignore
    }
  }, [id]);

  return { uploadDocument: upload, loading, data, batchProgress };
};

export const useFetchDocumentList = (loop = true) => {
  const { knowledgeId } = useGetKnowledgeSearchParams();
  const { searchString, handleInputChange } = useHandleSearchChange();
  const { pagination, setPagination } = useGetPaginationWithRouter();
  const { id } = useParams();
  const queryClient = useQueryClient();
  const debouncedSearchString = useDebounce(searchString, { wait: 500 });
  const { filterValue, handleFilterSubmit, checkValue } =
    useHandleFilterSubmit();

  const { data, isFetching: loading } = useQuery<{
    docs: IDocumentInfo[];
    total: number;
  }>({
    queryKey: DocumentKeys.list(debouncedSearchString, pagination, filterValue),
    initialData: { docs: [], total: 0 },
    refetchInterval: (query) =>
      loop &&
      query.state.data?.docs.some((doc) => doc.run === RunningStatus.RUNNING)
        ? 5000
        : false,
    enabled: !!knowledgeId || !!id,
    queryFn: async () => {
      let run = [] as any;
      let returnEmptyMetadata = false;
      if (filterValue.run && Array.isArray(filterValue.run)) {
        run = [...(filterValue.run as string[])];
        const returnEmptyMetadataIndex = run.findIndex(
          (r: string) => r === EMPTY_METADATA_FIELD,
        );
        if (returnEmptyMetadataIndex > -1) {
          returnEmptyMetadata = true;
          run.splice(returnEmptyMetadataIndex, 1);
        }
      } else {
        run = filterValue.run;
      }
      const ret = await listDocument(
        {
          id: knowledgeId || id,
          ext: { keywords: debouncedSearchString },
          page_size: pagination.pageSize,
          page: pagination.current,
        },
        {
          suffix: filterValue.type as string[],
          run_status: run as string[],
          return_empty_metadata: returnEmptyMetadata,
          metadata: filterValue.metadata as Record<string, string[]>,
        },
      );
      if (ret.data.code === 0) {
        queryClient.invalidateQueries({
          queryKey: DocumentKeys.allFilters(),
        });
        return ret.data.data;
      }

      return {
        docs: [],
        total: 0,
      };
    },
  });
  const onInputChange: React.ChangeEventHandler<HTMLInputElement> = useCallback(
    (e) => {
      setPagination({ page: 1 });
      handleInputChange(e);
    },
    [handleInputChange, setPagination],
  );

  useEffect(() => {
    queryClient.invalidateQueries({
      queryKey: [KnowledgeApiAction.FetchKnowledgeDetail],
    });
  }, [data.docs, queryClient]);

  return {
    loading,
    searchString,
    documents: data.docs,
    pagination: { ...pagination, total: data?.total },
    handleInputChange: onInputChange,
    setPagination,
    filterValue,
    handleFilterSubmit,
    checkValue,
  };
};

export const useFetchDocumentsByIds = (
  ids: string[],
  options?: { enabled?: boolean; refetchInterval?: number | false },
) => {
  const { id: datasetId } = useParams();
  const { enabled, refetchInterval } = options ?? {};

  const { data, isFetching: loading } = useQuery<{
    docs: IDocumentInfo[];
    total: number;
  }>({
    queryKey: DocumentKeys.byIds(ids),
    enabled: (enabled ?? true) && ids.length > 0 && !!datasetId,
    refetchInterval,
    initialData: { docs: [], total: 0 },
    queryFn: async () => {
      const ret = await listDocument(
        {
          id: datasetId,
          page: 1,
          page_size: ids.length,
        },
        {
          ids,
        },
      );
      if (ret.data.code === 0) {
        return ret.data.data;
      }
      return { docs: [], total: 0 };
    },
  });

  return { documents: data.docs, loading };
};

// get document filter
export const useGetDocumentFilter = (): {
  filter: IDocumentInfoFilter;
  onOpenChange: (open: boolean) => void;
} => {
  const { knowledgeId } = useGetKnowledgeSearchParams();
  const { searchString } = useHandleSearchChange();
  const { id } = useParams();
  const debouncedSearchString = useDebounce(searchString, { wait: 500 });
  const [open, setOpen] = useState<number>(0);
  const datasetId = knowledgeId || id;
  const { data } = useQuery({
    queryKey: DocumentKeys.filter(debouncedSearchString, knowledgeId),
    queryFn: async () => {
      if (!datasetId) {
        return;
      }
      const { data } = await documentFilter(datasetId);
      if (data.code === 0) {
        return data.data;
      }
    },
  });
  const handleOpenChange = (e: boolean) => {
    if (e) {
      const currentOpen = open + 1;
      setOpen(currentOpen);
    }
  };
  return {
    filter: data?.filter || {
      run_status: {},
      suffix: {},
      metadata: {},
    },
    onOpenChange: handleOpenChange,
  };
};
// update document status
export const useSetDocumentStatus = () => {
  const queryClient = useQueryClient();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation<
    any,
    Error,
    {
      status: boolean;
      documentId: string | string[];
      datasetId: string;
    }
  >({
    mutationKey: [DocumentApiAction.UpdateDocumentStatus],
    mutationFn: async ({ status, documentId, datasetId }) => {
      const ids = Array.isArray(documentId) ? documentId : [documentId];
      const { data } = await changeDocumentsStatus({
        kb_id: datasetId,
        doc_ids: ids,
        status: Number(status),
      });

      if (data.code === 0) {
        message.success(i18n.t('message.modified'));
        queryClient.invalidateQueries({
          queryKey: DocumentKeys.all(),
        });
      }
      return data;
    },
  });

  return { setDocumentStatus: mutateAsync, data, loading };
};

// This hook is used to run a document by its IDs
export const useRunDocument = () => {
  const queryClient = useQueryClient();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [DocumentApiAction.RunDocumentByIds],
    mutationFn: async ({
      documentIds,
      run,
      option,
    }: {
      documentIds: string[];
      run: number;
      option?: { delete: boolean; apply_kb: boolean };
    }) => {
      if (run === 1) {
        const documentIdSet = new Set(documentIds);
        queryClient.setQueriesData<{
          docs: IDocumentInfo[];
          total: number;
        }>({ queryKey: DocumentKeys.all() }, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            docs: current.docs.map((doc) =>
              documentIdSet.has(doc.id)
                ? {
                    ...doc,
                    run: RunningStatus.RUNNING,
                    progress: 0,
                    process_duration: 0,
                    process_begin_at: dayjs().format('YYYY-MM-DD HH:mm:ss'),
                    progress_msg: '',
                  }
                : doc,
            ),
          };
        });
      }
      if (run !== 1) {
        queryClient.invalidateQueries({
          queryKey: DocumentKeys.all(),
        });
      }
      const ret = await kbService.documentIngest({
        doc_ids: documentIds,
        run,
        ...(option || {}),
      });
      const code = get(ret, 'data.code');
      if (code === 0) {
        // For a start request, keep the optimistic running state until the
        // polling query observes the worker's state. Invalidating here can
        // immediately fetch the pre-worker "not started" row and disable
        // polling again.
        if (run !== 1) {
          queryClient.invalidateQueries({
            queryKey: DocumentKeys.all(),
          });
        }
        message.success(i18n.t('message.operated'));
      } else {
        queryClient.invalidateQueries({
          queryKey: DocumentKeys.all(),
        });
      }

      return code;
    },
    onError: () => {
      queryClient.invalidateQueries({
        queryKey: DocumentKeys.all(),
      });
    },
  });

  const runDocumentByIds = useCallback(
    (params: {
      documentIds: string[];
      run: number;
      option?: { delete: boolean; apply_kb: boolean };
    }) => {
      const key = JSON.stringify({
        documentIds: [...params.documentIds].sort(),
        run: params.run,
        option: params.option || null,
      });
      const existingRequest = documentIngestInFlight.get(key);
      if (existingRequest) {
        return existingRequest;
      }

      const request = mutateAsync(params);
      documentIngestInFlight.set(key, request);
      const clearRequest = () => {
        if (documentIngestInFlight.get(key) === request) {
          documentIngestInFlight.delete(key);
        }
      };
      void request.then(clearRequest, clearRequest);
      return request;
    },
    [mutateAsync],
  );

  return { runDocumentByIds, loading, data };
};

export const useRemoveDocument = () => {
  const queryClient = useQueryClient();
  const { id: datasetId } = useParams();
  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [DocumentApiAction.RemoveDocument],
    mutationFn: async (documentIds: string | string[]) => {
      const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
      const { data } = await deleteDocument(datasetId!, ids);
      if (data.code === 0) {
        message.success(i18n.t('message.deleted'));
        queryClient.invalidateQueries({
          queryKey: DocumentKeys.all(),
        });
      }
      return data.code;
    },
  });

  return { data, loading, removeDocument: mutateAsync };
};

export const useSaveDocumentName = () => {
  const queryClient = useQueryClient();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [DocumentApiAction.SaveDocumentName],
    mutationFn: async ({
      name,
      documentId,
      kbId,
    }: {
      name: string;
      documentId: string;
      kbId: string;
    }) => {
      const { data } = await renameDocument(kbId, documentId, {
        name: name,
      });
      if (data.code === 0) {
        message.success(i18n.t('message.renamed'));
        queryClient.invalidateQueries({
          queryKey: DocumentKeys.all(),
        });
      }
      return data.code;
    },
  });

  return { loading, saveName: mutateAsync, data };
};

export const useSetDocumentParser = () => {
  const queryClient = useQueryClient();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [DocumentApiAction.SetDocumentParser],
    mutationFn: async ({
      parserId,
      pipelineId,
      documentId,
      datasetId,
      parserConfig,
    }: {
      parserId: string;
      pipelineId: string;
      documentId: string;
      datasetId: string;
      parserConfig?: IChangeParserConfigRequestBody;
    }) => {
      // Build update payload
      const updateData: Record<string, unknown> = {};
      if (pipelineId) {
        updateData.pipeline_id = pipelineId;
      } else if (parserId) {
        updateData.chunk_method = parserId;
      }

      if (parserConfig) {
        updateData.parser_config = extractParserConfigExt(parserConfig);
      }

      const { data } = await changeDocumentParser(
        datasetId,
        documentId,
        updateData,
      );
      if (data.code === 0) {
        queryClient.invalidateQueries({
          queryKey: DocumentKeys.all(),
        });

        message.success(i18n.t('message.modified'));
      }
      return data.code;
    },
  });

  return { setDocumentParser: mutateAsync, data, loading };
};

/**
 * Go-backend variant of useSetDocumentParser. The Go document endpoint takes
 * `parser_id` (instead of the legacy `chunk_method`) and expects the
 * pipeline-shaped parser_config (keyed by operator id) to be sent as-is.
 * Keep it parallel to the Python version — the original hook stays untouched
 * and can be dropped once the Python backend is retired.
 */
export const useSetDocumentPipelineParser = () => {
  const queryClient = useQueryClient();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [DocumentApiAction.SetDocumentParser, 'pipeline'],
    mutationFn: async ({
      parserId,
      pipelineId,
      parseType,
      documentId,
      datasetId,
      parserConfig,
    }: {
      parserId: string;
      pipelineId: string;
      parseType?: number;
      documentId: string;
      datasetId: string;
      parserConfig?: IChangeParserConfigRequestBody;
    }) => {
      const updateData: Record<string, unknown> = {
        parser_id: parserId,
        pipeline_id: pipelineId,
      };

      if (parseType !== undefined) {
        updateData.parse_type = parseType;
      }

      if (parserConfig) {
        updateData.parser_config = isPipelineParserConfig(parserConfig)
          ? parserConfig
          : extractParserConfigExt(parserConfig);
      }

      const { data } = await changeDocumentParser(
        datasetId,
        documentId,
        updateData,
      );
      if (data.code === 0) {
        queryClient.invalidateQueries({
          queryKey: DocumentKeys.all(),
        });

        message.success(i18n.t('message.modified'));
      }
      return data.code;
    },
  });

  return { setDocumentPipelineParser: mutateAsync, data, loading };
};

export const useSetDocumentMeta = () => {
  const queryClient = useQueryClient();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [DocumentApiAction.SetDocumentMeta],
    mutationFn: async (params: IDocumentMetaRequestBody) => {
      try {
        const { data } = await kbService.setMeta({
          meta: params.meta,
          doc_id: params.documentId,
        });

        if (data?.code === 0) {
          queryClient.invalidateQueries({
            queryKey: DocumentKeys.all(),
          });

          message.success(i18n.t('message.modified'));
        }
        return data?.code;
      } catch (error) {
        message.error('error:' + error);
      }
    },
  });

  return { setDocumentMeta: mutateAsync, data, loading };
};

export const useCreateDocument = () => {
  const { id } = useParams();
  const { setPaginationParams, page } = useSetPaginationParams();
  const queryClient = useQueryClient();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [DocumentApiAction.CreateDocument],
    mutationFn: async (name: string) => {
      if (!id) {
        return 500;
      }
      const data = await createDocument(id, name);
      if (data.code === 0) {
        if (page === 1) {
          queryClient.invalidateQueries({
            queryKey: DocumentKeys.all(),
          });
        } else {
          setPaginationParams(); // fetch document list
        }

        message.success(i18n.t('message.created'));
      }
      return data.code;
    },
  });

  return { createDocument: mutateAsync, loading, data };
};

export const useGetDocumentUrl = (documentId?: string) => {
  const getDocumentUrl = useCallback(
    (id?: string) => {
      return `${restAPIv1}/documents/${id || documentId}/preview`;
    },
    [documentId],
  );

  return getDocumentUrl;
};

export const useGetChunkHighlights = (
  selectedChunk: IChunk | IReferenceChunk,
) => {
  const [size, setSize] = useState({ width: 849, height: 1200 });

  const highlights: IHighlight[] = useMemo(() => {
    return buildChunkHighlights(selectedChunk, size);
  }, [selectedChunk, size]);

  const setWidthAndHeight = (width: number, height: number) => {
    setSize((pre) => {
      if (pre.height !== height || pre.width !== width) {
        return { height, width };
      }
      return pre;
    });
  };

  return { highlights, setWidthAndHeight };
};

export const useFetchDocumentThumbnailsByIds = () => {
  const [ids, setDocumentIds] = useState<string[]>([]);
  const { data } = useQuery<Record<string, string>>({
    queryKey: DocumentKeys.thumbnails(ids),
    enabled: ids.length > 0,
    initialData: {},
    queryFn: async () => {
      const { data } = await kbService.documentThumbnails({ doc_ids: ids });
      if (data.code === 0) {
        return data.data;
      }
      return {};
    },
  });

  return { data, setDocumentIds };
};

export function useFetchDocumentStructureGraphById(
  datasetId: string,
  documentId: string,
  keywords?: string,
) {
  const enabled = !!datasetId && !!documentId;
  const trimmedKeywords = keywords?.trim();

  const {
    data,
    isFetching: loading,
    isPlaceholderData,
  } = useQuery<IStructureGraphResponse | null>({
    queryKey: trimmedKeywords
      ? DocumentStructureKeys.graphWithKeywords(
          datasetId,
          documentId,
          trimmedKeywords,
        )
      : DocumentStructureKeys.graph(datasetId, documentId),
    enabled,
    initialData: null,
    gcTime: 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await documentStructureService.getDocumentStructureGraph(
        datasetId,
        documentId,
        trimmedKeywords,
      );
      return data?.data ?? null;
    },
  });

  return { data, loading, isPlaceholderData };
}

export function useFetchDocumentStructureGraph(keywords?: string) {
  const { knowledgeId: datasetId, documentId } = useGetKnowledgeSearchParams();
  const { data, loading } = useFetchDocumentStructureGraphById(
    datasetId,
    documentId,
    keywords,
  );

  return { data, loading };
}

export function useDeleteDocumentStructureGraph() {
  const { knowledgeId: datasetId, documentId } = useGetKnowledgeSearchParams();
  const queryClient = useQueryClient();

  const {
    data,
    isPending: loading,
    mutateAsync,
  } = useMutation({
    mutationKey: [DocumentStructureApiAction.DeleteDocumentStructureGraph],
    mutationFn: async (templateId: string) => {
      const { data } =
        await documentStructureService.deleteDocumentStructureGraph(
          datasetId,
          documentId,
          templateId,
        );
      if (data.code === 0) {
        message.success(i18n.t('message.deleted'));
        queryClient.invalidateQueries({
          queryKey: DocumentStructureKeys.graph(datasetId, documentId),
        });
      }
      return data;
    },
  });

  return { deleteDocumentStructureGraph: mutateAsync, loading, data };
}
