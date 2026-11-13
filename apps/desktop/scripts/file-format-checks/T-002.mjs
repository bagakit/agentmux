export const tests = ['apps/desktop/test/data-structured-preview.test.ts', 'apps/desktop/test/data-structured-worker.test.ts', 'apps/desktop/test/structured-data-preview-component.test.tsx']
export const owningConfig = 'apps/desktop/test/data-file-formats.config.mts'
export const sources = [
  'packages/editor-extensions/src/engines/file-data-preview.ts',
  'packages/editor-extensions/src/engines/data-model.ts',
  'packages/editor-extensions/src/engines/data-jsonl.ts',
  'packages/editor-extensions/src/engines/data-config.ts',
  'packages/editor-extensions/src/engines/data-parse.ts',
  'packages/editor-extensions/src/engines/data-structured-request.ts',
  'packages/editor-extensions/src/engines/data-structured.worker.ts',
  'apps/desktop/src/renderer/src/components/FilePreviewState.tsx',
  'packages/editor-extensions/src/ui/StructuredDataPreview.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/StructuredDataPreview.css',
  'apps/desktop/src/renderer/src/styles/file-data-preview.css'
]
export const mutations = [
  { label: 'jsonl-neighbours-lost', file: 'packages/editor-extensions/src/engines/data-jsonl.ts', before: 'records.length < DATA_PREVIEW_MAX_ROWS', after: 'records.length < 2' },
  { label: 'jsonl-trailing-comma-accepted', file: 'packages/editor-extensions/src/engines/data-jsonl.ts', before: 'allowTrailingComma: false', after: 'allowTrailingComma: true' },
  { label: 'late-structured-result-publishes', file: 'packages/editor-extensions/src/ui/StructuredDataPreview.tsx', before: 'if (!cancelled) setResult({ request, parsed })', after: 'setResult({ request, parsed })' },
  { label: 'structured-worker-not-terminated', file: 'packages/editor-extensions/src/engines/data-structured-request.ts', before: 'worker.terminate();', after: 'void worker;' }
]
