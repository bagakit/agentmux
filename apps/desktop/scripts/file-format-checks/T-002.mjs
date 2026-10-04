export const tests = ['apps/desktop/test/data-structured-preview.test.ts', 'apps/desktop/test/data-structured-worker.test.ts', 'apps/desktop/test/structured-data-preview-component.test.tsx']
export const owningConfig = 'apps/desktop/test/data-file-formats.config.mts'
export const sources = [
  'apps/desktop/src/renderer/src/lib/file-data-preview.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-model.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-jsonl.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-config.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-parse.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-structured-request.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-structured.worker.ts',
  'apps/desktop/src/renderer/src/components/FilePreviewState.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/StructuredDataPreview.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/StructuredDataPreview.css',
  'apps/desktop/src/renderer/src/styles/file-data-preview.css'
]
export const mutations = [
  { label: 'jsonl-neighbours-lost', file: 'apps/desktop/src/renderer/src/lib/file-formats/data-jsonl.ts', before: 'records.length < DATA_PREVIEW_MAX_ROWS', after: 'records.length < 2' },
  { label: 'jsonl-trailing-comma-accepted', file: 'apps/desktop/src/renderer/src/lib/file-formats/data-jsonl.ts', before: 'allowTrailingComma: false', after: 'allowTrailingComma: true' },
  { label: 'late-structured-result-publishes', file: 'apps/desktop/src/renderer/src/components/file-preview/StructuredDataPreview.tsx', before: 'if (!cancelled) setResult({ request, parsed })', after: 'setResult({ request, parsed })' },
  { label: 'structured-worker-not-terminated', file: 'apps/desktop/src/renderer/src/lib/file-formats/data-structured-request.ts', before: 'worker.terminate();', after: 'void worker;' }
]
