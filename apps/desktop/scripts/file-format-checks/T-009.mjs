export const owningConfig = 'apps/desktop/test/file-format-readers.config.mts'
export const tests = ['apps/desktop/test/file-delimited-dialects.test.tsx']
export const sources = ['packages/editor-extensions/src/engines/file-data-preview.ts', 'packages/editor-extensions/src/engines/file-delimited-preview.ts', 'apps/desktop/src/renderer/src/lib/monaco-languages/register-file-formats.ts', 'packages/editor-extensions/src/ui/FileDataPreview.tsx', 'apps/desktop/src/renderer/src/components/FilePreviewState.tsx', 'packages/editor-extensions/src/engines/file-json-preview.ts', 'apps/desktop/src/renderer/src/styles/file-data-preview.css']
export const mutations = [
  { label: 'csv-auto-disconnected', file: sources[1], before: "dialect === 'auto' ? '' : dialect", after: "dialect === 'auto' ? ',' : dialect" },
  { label: 'csv-multiline-column-lost', file: sources[2], before: 'quoted ? column : 0', after: '0' },
  { label: 'csv-dialect-control-disconnected', file: sources[3], before: 'readDelimitedPreview(content, dialect)', after: 'readDelimitedPreview(content, delimiter)' }
]
