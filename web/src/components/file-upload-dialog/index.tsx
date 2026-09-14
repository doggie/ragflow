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

import { ButtonLoading } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MultiSelect } from '@/components/ui/multi-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  UPLOAD_FILE_CATEGORIES,
  UploadFileCategoryValue,
  buildAcceptFromCategories,
  filterFilesByCategories,
} from '@/constants/upload-file-categories';
import { toast } from 'sonner';
import { IModalProps } from '@/interfaces/common';
import { extractTableColumns, isTableFile } from '@/utils/table-column-extract';
import { zodResolver } from '@hookform/resolvers/zod';
import { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { FileUploader } from '../file-uploader';
import { RAGFlowFormItem } from '../ragflow-form';
import { Form } from '../ui/form';
import { Label } from '../ui/label';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { Switch } from '../ui/switch';

const ROLE_OPTIONS = [
  { value: 'both', labelKey: 'knowledgeConfiguration.tableColumnRoleBoth' },
  {
    value: 'indexing',
    labelKey: 'knowledgeConfiguration.tableColumnRoleIndexing',
  },
  {
    value: 'metadata',
    labelKey: 'knowledgeConfiguration.tableColumnRoleMetadata',
  },
] as const;

const CATEGORY_LABEL_KEYS: Record<UploadFileCategoryValue, string> = {
  pdf: 'fileManager.fileCategoryPdf',
  doc: 'fileManager.fileCategoryDocument',
  aural: 'fileManager.fileCategoryAudio',
  visual: 'fileManager.fileCategoryMedia',
};

export type TableColumnRoles = Record<string, 'indexing' | 'metadata' | 'both'>;

function buildUploadFormSchema(t: TFunction) {
  const FormSchema = z.object({
    parseOnCreation: z.boolean().optional(),
    // Update schema to allow files with path property to handle folder uploads
    fileList: z
      .array(
        z.instanceof(File).or(
          z.object({
            file: z.instanceof(File),
            path: z.string(), // Store the relative path for files in folders
          }),
        ),
      )
      .min(1, { message: t('fileManager.pleaseUploadAtLeastOneFile') }),
    tableColumnMode: z.enum(['auto', 'manual']).optional(),
    tableColumnRoles: z
      .record(z.enum(['indexing', 'metadata', 'both']))
      .optional(),
    fileCategories: z.array(z.enum(['pdf', 'doc', 'aural', 'visual'])),
  });

  return FormSchema;
}

export type UploadFormSchemaType = z.infer<
  ReturnType<typeof buildUploadFormSchema>
>;

const UploadFormId = 'UploadFormId';

type UploadFormProps = {
  submit: (values?: UploadFormSchemaType) => void;
  showParseOnCreation?: boolean;
  isTableParser?: boolean;
  /** When true the heavy form fields (category picker, file list cards) are
   *  unmounted so per-batch progress ticks only re-render the small progress
   *  text instead of diffing up to 50 FileCard rows on every progress event.
   *  This is what kept the main thread starved across 254 batches. */
  loading?: boolean;
  loadingText?: string;
};
function UploadForm({
  submit,
  showParseOnCreation,
  isTableParser,
  loading,
  loadingText,
}: UploadFormProps) {
  const { t } = useTranslation();
  const FormSchema = buildUploadFormSchema(t);

  type UploadFormSchemaType = z.infer<typeof FormSchema>;
  const form = useForm<UploadFormSchemaType>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      parseOnCreation: false,
      fileList: [],
      tableColumnMode: 'auto',
      tableColumnRoles: {},
      fileCategories: UPLOAD_FILE_CATEGORIES.map((c) => c.value),
    },
  });

  const [extractedColumns, setExtractedColumns] = useState<string[]>([]);
  const [columnMode, setColumnMode] = useState<'auto' | 'manual'>('auto');
  const [columnRoles, setColumnRoles] = useState<TableColumnRoles>({});

  const fileCategories = useWatch({
    control: form.control,
    name: 'fileCategories',
  });
  const categoryOptions = UPLOAD_FILE_CATEGORIES.map((c) => ({
    value: c.value,
    label: t(CATEGORY_LABEL_KEYS[c.value]),
    suffix: (
      <span className="ml-2 text-xs text-text-secondary">
        {c.extensions.slice(0, 4).map((ext) => `.${ext}`).join(' ')}
        {c.extensions.length > 4 ? ' …' : ''}
      </span>
    ),
  }));

  const handleFilesChange = useCallback(
    async (files: any[]) => {
      if (!isTableParser || !files || files.length === 0) {
        setExtractedColumns([]);
        return;
      }

      // Extract columns from the first table file
      const allColumns = new Set<string>();
      for (const f of files) {
        const file = f instanceof File ? f : f.file;
        if (file && isTableFile(file)) {
          const cols = await extractTableColumns(file);
          cols.forEach((c) => allColumns.add(c));
        }
      }
      setExtractedColumns(Array.from(allColumns));
    },
    [isTableParser],
  );

  const handleModeChange = (value: 'auto' | 'manual') => {
    setColumnMode(value);
    form.setValue('tableColumnMode', value);
  };

  const handleRoleChange = (col: string, role: string) => {
    const updated = {
      ...columnRoles,
      [col]: role as 'indexing' | 'metadata' | 'both',
    };
    setColumnRoles(updated);
    form.setValue('tableColumnRoles', updated);
  };

  // Sync column roles to form when columns are extracted
  useEffect(() => {
    if (columnMode === 'manual' && extractedColumns.length > 0) {
      const roles: TableColumnRoles = {};
      extractedColumns.forEach((col) => {
        roles[col] = columnRoles[col] || 'both';
      });
      setColumnRoles(roles);
      form.setValue('tableColumnRoles', roles);
    }
  }, [extractedColumns, columnMode]); // oxlint-disable-line react/exhaustive-deps

  // If the selected categories shrink, drop files whose type is no longer
  // allowed. This catches files picked before a category was deselected, which
  // the dropzone `accept` (and the folder tab, which bypasses it) can't.
  useEffect(() => {
    const list = form.getValues('fileList');
    if (!list || list.length === 0) {
      return;
    }
    const { allowed, rejected } = filterFilesByCategories(
      list as File[],
      fileCategories,
    );
    if (rejected.length > 0) {
      form.setValue('fileList', allowed);
      rejected.forEach((f) =>
        toast.error(t('fileManager.fileTypeRejected', { name: f.name })),
      );
    }
  }, [fileCategories]); // oxlint-disable-line react/exhaustive-deps

  const showColumnConfig = isTableParser && extractedColumns.length > 0;

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(submit)}
        id={UploadFormId}
        className="space-y-4"
      >
        {loading ? (
          <div className="py-8 space-y-4 text-center">
            <div className="flex justify-center">
              <div className="size-8 animate-spin rounded-full border-4 border-accent-primary border-t-transparent" />
            </div>
            {loadingText && (
              <div className="rounded border border-border-default bg-bg-card p-4">
                <p className="text-sm font-medium text-text-primary break-all">{loadingText}</p>
              </div>
            )}
          </div>
        ) : (
          <>
            {showParseOnCreation && (
              <RAGFlowFormItem
                name="parseOnCreation"
                label={t('fileManager.parseOnCreation')}
              >
                {(field) => (
                  <Switch
                    data-testid="parse-on-creation-toggle"
                    onCheckedChange={field.onChange}
                    checked={field.value}
                  />
                )}
              </RAGFlowFormItem>
            )}
            <RAGFlowFormItem
              name="fileCategories"
              label={t('fileManager.fileTypeFilter')}
              tooltip={t('fileManager.fileTypeFilterTip')}
            >
              {(field) => (
                <MultiSelect
                  options={categoryOptions}
                  defaultValue={field.value}
                  onValueChange={(values) =>
                    field.onChange(values as UploadFileCategoryValue[])
                  }
                  showSelectAll
                  maxCount={UPLOAD_FILE_CATEGORIES.length}
                />
              )}
            </RAGFlowFormItem>
            <RAGFlowFormItem name="fileList" label={''}>
              {(field) => (
                <FileUploader
                  value={field.value}
                  onValueChange={(files) => {
                    // Enforce the selected categories at the single choke point both
                    // the Files drop and the Folder selection flow through, since the
                    // dropzone `accept` does not filter folder uploads or files already
                    // in the list.
                    const { allowed, rejected } = filterFilesByCategories(
                      files,
                      fileCategories,
                    );
                    if (rejected.length > 0) {
                      rejected.forEach((f) =>
                        toast.error(
                          t('fileManager.fileTypeRejected', { name: f.name }),
                        ),
                      );
                    }
                    field.onChange(allowed);
                    handleFilesChange(allowed);
                  }}
                  accept={buildAcceptFromCategories(fileCategories)}
                  data-testid="dataset-upload-dropzone"
                />
              )}
            </RAGFlowFormItem>

            {showColumnConfig && (
              <div className="space-y-3 border rounded-md p-3">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">
                    {t('knowledgeConfiguration.tableColumnMode')}
                  </Label>
                  <RadioGroup
                    value={columnMode}
                    onValueChange={handleModeChange}
                    className="flex gap-4"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="auto" id="upload-mode-auto" />
                      <label
                        htmlFor="upload-mode-auto"
                        className="text-sm font-normal cursor-pointer"
                      >
                        {t('knowledgeConfiguration.tableColumnModeAuto')}
                      </label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="manual" id="upload-mode-manual" />
                      <label
                        htmlFor="upload-mode-manual"
                        className="text-sm font-normal cursor-pointer"
                      >
                        {t('knowledgeConfiguration.tableColumnModeManual')}
                      </label>
                    </div>
                  </RadioGroup>
                </div>

                {columnMode === 'auto' && (
                  <p className="text-sm text-muted-foreground">
                    {t('knowledgeConfiguration.tableColumnModeAutoDescription')}
                  </p>
                )}

                {columnMode === 'manual' && (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {t('knowledgeConfiguration.tableColumnRolesTip')}
                    </p>
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      {extractedColumns.map((col) => (
                        <div key={col} className="flex items-center gap-3">
                          <Label className="min-w-[120px] shrink-0 text-sm font-normal truncate">
                            {col}
                          </Label>
                          <Select
                            value={columnRoles[col] || 'both'}
                            onValueChange={(value) => handleRoleChange(col, value)}
                          >
                            <SelectTrigger className="w-[140px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLE_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {t(opt.labelKey)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {loadingText && (
              <div className="rounded border border-border-default bg-bg-card p-3 space-y-1">
                <p className="text-sm font-medium text-text-primary break-all">{loadingText}</p>
              </div>
            )}
          </>
        )}
      </form>
    </Form>
  );
}

type FileUploadDialogProps = IModalProps<UploadFormSchemaType> &
  Pick<UploadFormProps, 'showParseOnCreation' | 'isTableParser' | 'loadingText'>;
export function FileUploadDialog({
  hideModal,
  onOk,
  loading,
  showParseOnCreation = false,
  isTableParser = false,
  loadingText,
}: FileUploadDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open onOpenChange={hideModal}>
      <DialogContent
        data-testid="dataset-upload-modal"
        className="max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{t('fileManager.uploadFile')}</DialogTitle>
        </DialogHeader>
        <UploadForm
          submit={onOk!}
          showParseOnCreation={showParseOnCreation}
          isTableParser={isTableParser}
          loading={loading}
          loadingText={loadingText}
        />
        <DialogFooter>
          <ButtonLoading type="submit" loading={loading} form={UploadFormId}>
            {t('common.save')}
          </ButtonLoading>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
