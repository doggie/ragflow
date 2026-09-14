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

// The upload dialog offers exactly the file types the backend accepts. Keep the
// extension lists in sync with api/utils/file_utils.py::filename_type(), which is
// the authoritative classifier — the backend rejects anything that does not fall
// into one of these groups.
export type UploadFileCategoryValue = 'pdf' | 'doc' | 'aural' | 'visual';

export const UPLOAD_FILE_CATEGORIES: {
  value: UploadFileCategoryValue;
  extensions: string[];
}[] = [
  { value: 'pdf', extensions: ['pdf'] },
  {
    value: 'doc',
    extensions: [
      'msg',
      'eml',
      'doc',
      'docx',
      'ppt',
      'pptx',
      'yml',
      'xml',
      'htm',
      'html',
      'json',
      'jsonl',
      'ldjson',
      'csv',
      'txt',
      'ini',
      'xls',
      'xlsx',
      'wps',
      'rtf',
      'hlp',
      'pages',
      'numbers',
      'key',
      'md',
      'mdx',
      'py',
      'js',
      'java',
      'c',
      'cpp',
      'h',
      'php',
      'go',
      'ts',
      'sh',
      'cs',
      'kt',
      'sql',
      'epub',
    ],
  },
  {
    value: 'aural',
    extensions: [
      'wav',
      'flac',
      'ape',
      'alac',
      'wavpack',
      'wv',
      'mp3',
      'aac',
      'ogg',
      'vorbis',
      'opus',
    ],
  },
  {
    value: 'visual',
    extensions: [
      'jpg',
      'jpeg',
      'png',
      'tif',
      'gif',
      'bmp',
      'pcx',
      'tga',
      'exif',
      'fpx',
      'svg',
      'psd',
      'cdr',
      'pcd',
      'dxf',
      'ufo',
      'eps',
      'ai',
      'raw',
      'wmf',
      'webp',
      'avif',
      'apng',
      'icon',
      'ico',
      'mpg',
      'mpeg',
      'avi',
      'rm',
      'rmvb',
      'mov',
      'wmv',
      'asf',
      'dat',
      'asx',
      'wvx',
      'mpe',
      'mpa',
      'mp4',
      'mkv',
    ],
  },
];

// MIME type for each supported extension. react-dropzone requires the keys of
// its `accept` object to be valid MIME types (see isMIMEType() in
// react-dropzone/src/utils), otherwise it warns "Skipped ".xyz" because it is
// not a valid MIME type" and drops the entry — which disables the browser
// file-picker type filter. Unknown/rare extensions fall back to
// application/octet-stream so they still show up in the picker; the actual
// filtering against selected categories is done by filterFilesByCategories().
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  msg: 'application/vnd.ms-outlook',
  eml: 'message/rfc822',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  ini: 'text/plain',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ldjson: 'application/x-ndjson',
  xml: 'application/xml',
  yml: 'text/yaml',
  htm: 'text/html',
  html: 'text/html',
  md: 'text/markdown',
  mdx: 'text/mdx',
  py: 'text/x-python',
  js: 'application/javascript',
  java: 'text/x-java-source',
  c: 'text/x-c',
  cpp: 'text/x-c',
  h: 'text/x-c',
  php: 'application/x-httpd-php',
  go: 'text/x-go',
  ts: 'video/mp2t',
  sh: 'application/x-sh',
  cs: 'text/x-csharp',
  kt: 'text/x-kotlin',
  sql: 'application/x-sql',
  epub: 'application/epub+zip',
  wps: 'application/vnd.ms-works',
  rtf: 'application/rtf',
  hlp: 'application/winhlp',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  key: 'application/vnd.apple.keynote',
  wav: 'audio/wave',
  flac: 'audio/x-flac',
  ape: 'application/octet-stream',
  alac: 'application/octet-stream',
  wavpack: 'application/octet-stream',
  wv: 'application/octet-stream',
  mp3: 'audio/mpeg',
  aac: 'audio/x-aac',
  ogg: 'audio/ogg',
  vorbis: 'audio/ogg',
  opus: 'audio/ogg',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  gif: 'image/gif',
  bmp: 'image/bmp',
  pcx: 'image/vnd.zbrush.pcx',
  tga: 'image/x-tga',
  exif: 'image/jpeg',
  fpx: 'image/vnd.fpx',
  svg: 'image/svg+xml',
  psd: 'image/vnd.adobe.photoshop',
  cdr: 'application/octet-stream',
  pcd: 'application/octet-stream',
  dxf: 'image/vnd.dxf',
  ufo: 'application/octet-stream',
  eps: 'application/postscript',
  ai: 'application/postscript',
  raw: 'application/octet-stream',
  wmf: 'image/wmf',
  webp: 'image/webp',
  avif: 'image/avif',
  apng: 'image/apng',
  icon: 'image/vnd.microsoft.icon',
  ico: 'image/vnd.microsoft.icon',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  avi: 'video/x-msvideo',
  rm: 'application/vnd.rn-realmedia',
  rmvb: 'application/vnd.rn-realmedia-vbr',
  mov: 'video/quicktime',
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  dat: 'application/octet-stream',
  asx: 'video/x-ms-asf',
  wvx: 'video/x-ms-wvx',
  mpe: 'video/mpeg',
  mpa: 'audio/mpeg',
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
};

// Build a react-dropzone `accept` object from the selected category values.
// Keys must be valid MIME types (not bare extensions) — react-dropzone filters
// out invalid keys with a console warning, silently disabling the browser
// file-picker type filter. An empty selection returns {} — "accept all",
// matching the previous accept={{}} behaviour.
export function buildAcceptFromCategories(
  values: UploadFileCategoryValue[],
): Record<string, string[]> {
  const accept: Record<string, string[]> = {};
  for (const category of UPLOAD_FILE_CATEGORIES) {
    if (!values.includes(category.value)) {
      continue;
    }
    for (const ext of category.extensions) {
      const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
      if (!accept[mime]) {
        accept[mime] = [];
      }
      accept[mime].push(`.${ext}`);
    }
  }
  return accept;
}

// A filename's extension, lower-cased, without the leading dot. Returns '' when
// the name has no usable extension — the backend classifies those as OTHER and
// rejects them, so they are never "allowed" here either.
function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) {
    return '';
  }
  return name.slice(idx + 1).toLowerCase();
}

// Split files into those whose extension belongs to a selected category and the
// rest. This is the enforcement that react-dropzone's `accept` cannot do for the
// folder tab (which bypasses `accept`) or for files already in the list. An
// empty selection allows every file, mirroring buildAcceptFromCategories' {}
// ("accept all") for the dropzone.
export function filterFilesByCategories(
  files: File[],
  values: UploadFileCategoryValue[],
): { allowed: File[]; rejected: File[] } {
  if (values.length === 0) {
    return { allowed: files, rejected: [] };
  }
  const allowedExts = new Set<string>();
  for (const category of UPLOAD_FILE_CATEGORIES) {
    if (values.includes(category.value)) {
      for (const ext of category.extensions) {
        allowedExts.add(ext);
      }
    }
  }
  const allowed: File[] = [];
  const rejected: File[] = [];
  for (const file of files) {
    if (allowedExts.has(fileExtension(file.name))) {
      allowed.push(file);
    } else {
      rejected.push(file);
    }
  }
  return { allowed, rejected };
}
