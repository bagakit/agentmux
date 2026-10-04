export const owningConfig = 'apps/desktop/test/file-format-readers.config.mts'
export const tests = ['apps/desktop/test/file-delimited-dialects.test.tsx']
export const sources = ['apps/desktop/src/renderer/src/lib/file-data-preview.ts', 'apps/desktop/src/renderer/src/lib/file-delimited-preview.ts', 'apps/desktop/src/renderer/src/lib/monaco-languages/register-file-formats.ts', 'apps/desktop/src/renderer/src/components/FileDataPreview.tsx', 'apps/desktop/src/renderer/src/components/FilePreviewState.tsx', 'apps/desktop/src/renderer/src/lib/file-json-preview.ts', 'apps/desktop/src/renderer/src/styles/file-data-preview.css']
export const mutations = [
  { label: 'csv-auto-disconnected', file: sources[1], before: "dialect === 'auto' ? '' : dialect", after: "dialect === 'auto' ? ',' : dialect" },
  { label: 'csv-multiline-column-lost', file: sources[2], before: 'quoted ? column : 0', after: '0' },
  { label: 'csv-dialect-control-disconnected', file: sources[3], before: 'readDelimitedPreview(content, dialect)', after: 'readDelimitedPreview(content, delimiter)' }
]
