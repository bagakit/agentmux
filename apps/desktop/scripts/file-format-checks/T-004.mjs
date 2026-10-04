export const tests = ['apps/desktop/test/data-notebook-preview.test.ts', 'apps/desktop/test/notebook-file-preview-component.test.tsx']
export const owningConfig = 'apps/desktop/test/data-file-formats.config.mts'
export const sources = [
  'apps/desktop/src/shared/workspace-file-bytes.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-notebook.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-notebook.worker.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/data-model.ts',
  'apps/desktop/src/renderer/src/components/file-preview/NotebookFilePreview.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/NotebookFilePreview.css',
  'apps/desktop/src/renderer/src/components/file-preview/StaticMarkupPreview.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/StructuredDataPreview.tsx',
  'packages/client-ui/src/components/AgentMarkdown.tsx',
  'packages/client-ui/src/components/MarkdownCodeBlock.tsx',
  'packages/client-ui/src/lib/use-visible-work.ts'
]
export const mutations = [
  { label: 'notebook-static-output-offscreen-not-released', file: 'apps/desktop/src/renderer/src/components/file-preview/StaticMarkupPreview.tsx', before: '{inView && <PreparedMarkup', after: '{true && <PreparedMarkup' },
  { label: 'notebook-static-dom-budget-removed', file: 'apps/desktop/src/renderer/src/components/file-preview/StaticMarkupPreview.tsx', before: 'const STATIC_MARKUP_MAX_ELEMENTS = 3000', after: 'const STATIC_MARKUP_MAX_ELEMENTS = 3000000' },
  { label: 'notebook-source-newlines-injected', file: 'apps/desktop/src/renderer/src/lib/file-formats/data-notebook.ts', before: "value.join('')", after: "value.join('\\n')" },
  { label: 'notebook-worker-not-terminated', file: 'apps/desktop/src/renderer/src/components/file-preview/NotebookFilePreview.tsx', before: 'return () => { cancelled = true; clearTimeout(timer); worker?.terminate();', after: 'return () => { cancelled = true; clearTimeout(timer);' },
  { label: 'notebook-late-result-publishes', file: 'apps/desktop/src/renderer/src/components/file-preview/NotebookFilePreview.tsx', before: 'if (cancelled || event.data.job !== job) return', after: 'if (event.data.job !== job) return' },
  { label: 'notebook-plain-mime-injects-markup', file: 'apps/desktop/src/renderer/src/components/file-preview/NotebookFilePreview.tsx', before: ': item.text ? <pre>{item.text}</pre> : null}', after: ': item.text ? <pre dangerouslySetInnerHTML={{ __html: item.text }} /> : null}' }
]
