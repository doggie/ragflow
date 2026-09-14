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

/**
 * Splits a large file selection into sub-batches that each fit under the
 * server's per-request body cap, so the frontend can upload them as several
 * sequential requests instead of one request that the server would reject
 * with 413.
 *
 * The server caps a single request at `MAX_CONTENT_LENGTH` (1 GiB by default,
 * see `api/apps/__init__.py`). A request's multipart body is slightly larger
 * than the sum of its file sizes (one boundary + Content-Disposition per part),
 * so batches are kept well under the cap.
 */
export const MAX_UPLOAD_BATCH_BYTES = 50 * 1024 * 1024; // 50 MiB
export const MAX_FILES_PER_BATCH = 16;

// A file picker entry is either a bare File, or a `{ file, path }` wrapper
// carrying the folder-relative path (see file-upload-dialog schema).
export type UploadFileEntry = File | { file: File; path?: string };

export const sizeOfUploadEntry = (entry: UploadFileEntry): number =>
  entry instanceof File ? entry.size : entry.file.size;

export const nameOfUploadEntry = (entry: UploadFileEntry): string => {
  if (entry instanceof File) {
    return entry.name;
  }
  return entry.path || entry.file.name;
};

/**
 * Creates a tracker for an in-flight batch of upload entries that calculates
 * current bandwidth (<kB/s>) and estimates which file is actively being uploaded
 * based on loaded bytes.
 */
export interface UploadSpeedProgress {
  speedKbps: number;
  currentFileName: string;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  isServerProcessing: boolean;
}

export function createBatchUploadTracker<T extends UploadFileEntry>(entries: T[]) {
  const fileNames = entries.map(nameOfUploadEntry);
  const fileSizes = entries.map(sizeOfUploadEntry);
  const cumSizes: number[] = [];
  let runningTotal = 0;
  for (const s of fileSizes) {
    runningTotal += s;
    cumSizes.push(runningTotal);
  }

  let initialTime = performance.now();
  let lastLoaded = 0;
  let lastTime = initialTime;
  let currentSpeedKbps = 0;

  return (loaded: number, total: number): UploadSpeedProgress => {
    const now = performance.now();
    const elapsedSec = (now - lastTime) / 1000;
    const batchTotal = total || runningTotal;

    if (elapsedSec >= 0.25) {
      const deltaBytes = Math.max(0, loaded - lastLoaded);
      const instantSpeed = deltaBytes / elapsedSec / 1024; // kB/s
      // Smooth with EMA: 70% current, 30% new
      currentSpeedKbps = currentSpeedKbps === 0
        ? instantSpeed
        : currentSpeedKbps * 0.7 + instantSpeed * 0.3;
      lastLoaded = loaded;
      lastTime = now;
    } else if (currentSpeedKbps === 0 && loaded > 0) {
      // Fallback for fast LAN transfers where elapsedSec < 0.25s:
      // compute speed from start of batch so UI does not show 0 kB/s
      const totalElapsedSec = (now - initialTime) / 1000;
      if (totalElapsedSec > 0.05) {
        currentSpeedKbps = loaded / totalElapsedSec / 1024;
      }
    }

    // Determine current file by cumulative byte thresholds
    let activeIndex = 0;
    for (let i = 0; i < cumSizes.length; i++) {
      if (loaded < cumSizes[i]) {
        activeIndex = i;
        break;
      }
      activeIndex = i;
    }
    const currentFileName = fileNames[activeIndex] || fileNames[fileNames.length - 1] || '';
    const percent = batchTotal > 0 ? Math.min(100, Math.round((loaded / batchTotal) * 100)) : 0;
    const isServerProcessing = batchTotal > 0 && loaded >= batchTotal;

    return {
      speedKbps: Math.round(currentSpeedKbps * 10) / 10,
      currentFileName,
      loadedBytes: loaded,
      totalBytes: batchTotal,
      percent,
      isServerProcessing,
    };
  };
}

/**
 * Greedily pack entries into batches. A batch closes when adding the next
 * entry would push it past `maxBytes`, or once it already holds `maxCount`
 * entries. An entry whose own size is >= `maxBytes` gets a batch of its own
 * (it cannot be split further and will fail server-side; the rest still uploads).
 */
export function chunkUploadFiles<T extends UploadFileEntry>(
  entries: T[],
  maxBytes: number = MAX_UPLOAD_BATCH_BYTES,
  maxCount: number = MAX_FILES_PER_BATCH,
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;

  for (const entry of entries) {
    const size = sizeOfUploadEntry(entry);
    const overSize = batch.length > 0 && bytes + size > maxBytes;
    const overCount = batch.length >= maxCount;
    const alone = size >= maxBytes;

    if (alone || overSize || overCount) {
      if (batch.length) {
        batches.push(batch);
      }
      batch = [entry];
      bytes = size;
      continue;
    }

    batch.push(entry);
    bytes += size;
  }

  if (batch.length) {
    batches.push(batch);
  }

  return batches;
}
