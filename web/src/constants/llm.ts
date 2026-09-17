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

export enum ModelStatus {
  Active = 'active',
  Inactive = 'inactive',
}

export enum LLMFactory {
  OpenAiAPICompatible = 'OpenAI-API-Compatible',
}

// Please lowercase the file name
export const IconMap = {
  [LLMFactory.OpenAiAPICompatible]: 'openai-api',
};

export const ModelTypeToField: Record<string, string> = {
  chat: 'llm_id',
  embedding: 'embd_id',
  vision: 'img2txt_id',
  asr: 'asr_id',
  rerank: 'rerank_id',
  tts: 'tts_id',
};

export const FieldToModelType: Record<string, string> = {
  llm_id: 'chat',
  embd_id: 'embedding',
  img2txt_id: 'vision',
  asr_id: 'asr',
  rerank_id: 'rerank',
  tts_id: 'tts',
};

export const APIMapUrl = {};
