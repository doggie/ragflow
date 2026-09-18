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

import { useIsDarkTheme } from '@/components/theme-provider';
import message from '@/components/ui/message';
import { Spin } from '@/components/ui/spin';
import request from '@/utils/request';
import classNames from 'classnames';
import React, { memo, useCallback, useEffect, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import {
  oneDark,
  oneLight,
} from 'react-syntax-highlighter/dist/esm/styles/prism';

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  dockerfile: 'docker',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  php: 'php',
  pl: 'perl',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  vim: 'vim',
  ini: 'ini',
  cfg: 'ini',
};

export const getLanguageFromExtension = (ext?: string): string => {
  if (!ext) return 'text';
  const cleanExt = ext.toLowerCase().replace(/^\./, '');
  return EXT_LANG[cleanExt] || cleanExt || 'text';
};

interface CodePreviewerProps {
  className?: string;
  url: string;
  ext?: string;
}

export const CodePreviewer: React.FC<CodePreviewerProps> = ({
  className,
  url,
  ext,
}) => {
  const isDarkTheme = useIsDarkTheme();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<string>('');

  const language = getLanguageFromExtension(ext);

  const fetchCode = useCallback(async () => {
    setLoading(true);
    try {
      const res = await request(url, {
        method: 'GET',
        responseType: 'blob',
        onError: (err: any) => {
          message.error('Failed to load file');
          console.error('Error loading file:', err);
        },
      });
      const reader = new FileReader();
      reader.readAsText(res.data);
      reader.onload = () => {
        setData(reader.result as string);
        setLoading(false);
      };
      reader.onerror = () => {
        setLoading(false);
        message.error('Failed to read file content');
      };
    } catch {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (url) {
      fetchCode();
    } else {
      setLoading(false);
      setData('');
    }
  }, [url, fetchCode]);

  return (
    <div
      className={classNames(
        'relative w-full h-full overflow-auto bg-bg-base border border-border-normal rounded-md',
        className,
      )}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-base/60 z-10">
          <Spin />
        </div>
      )}

      {!loading && (
        <SyntaxHighlighter
          language={language}
          style={isDarkTheme ? oneDark : oneLight}
          showLineNumbers
          lineNumberStyle={{ minWidth: 40, paddingRight: 16 }}
          customStyle={{
            margin: 0,
            padding: '16px',
            fontSize: 13,
            lineHeight: 1.6,
            backgroundColor: 'transparent',
          }}
        >
          {data || ''}
        </SyntaxHighlighter>
      )}
    </div>
  );
};

export default memo(CodePreviewer);
