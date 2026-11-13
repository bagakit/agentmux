export const tests = ['apps/desktop/test/pdf-content.test.tsx', 'apps/desktop/test/pdf-engine.test.ts', 'apps/desktop/test/pdf-search-outline-engine.test.ts']
export const owningConfig = 'apps/desktop/test/pdf-file-formats.config.mts'
export const sources = ['packages/editor-extensions/src/pdf/PdfReader.tsx', 'packages/editor-extensions/src/bytes.ts', 'packages/editor-extensions/src/ui/FilePreviewState.tsx', 'packages/editor-extensions/src/styles/pdf-content.css', 'apps/desktop/test/helpers/pdf-reader-fixture.ts']
export const mutations = [
  { label: 'pdf-viewer-import-races-engine-global', file: sources[0], before: "return import('pdfjs-dist').then(async engine => {\n    if (signal?.aborted) return null\n    const components = await import('pdfjs-dist/web/pdf_viewer.mjs')", after: "return Promise.all([import('pdfjs-dist'), import('pdfjs-dist/web/pdf_viewer.mjs')]).then(([engine, components]) => {" },
  { label: 'pdf-find-consumer-disconnected', file: 'packages/editor-extensions/src/pdf/PdfReader.tsx', before: 'eventBus, linkService, findController,', after: 'eventBus, linkService,' },
  { label: 'pdf-outline-read-disconnected', file: 'packages/editor-extensions/src/pdf/PdfReader.tsx', before: 'outlineEntries(items ?? [])', after: 'outlineEntries([])' },
  { label: 'pdf-stale-outline-publishes', file: 'packages/editor-extensions/src/pdf/PdfReader.tsx', before: "if (!disposed) setOutline({ owner: source, phase: 'ready'", after: "if (true) setOutline({ owner: source, phase: 'ready'" }
]
