export const tests = ['apps/desktop/test/pdf-content.test.tsx', 'apps/desktop/test/pdf-engine.test.ts', 'apps/desktop/test/pdf-search-outline-engine.test.ts']
export const owningConfig = 'apps/desktop/test/pdf-file-formats.config.mts'
export const sources = ['apps/desktop/src/renderer/src/components/PdfContent.tsx', 'apps/desktop/src/renderer/src/components/FilePreviewState.tsx', 'apps/desktop/src/renderer/src/styles/pdf-content.css', 'apps/desktop/test/helpers/pdf-reader-fixture.ts']
export const mutations = [
  { label: 'pdf-find-consumer-disconnected', file: 'apps/desktop/src/renderer/src/components/PdfContent.tsx', before: 'eventBus, linkService, findController,', after: 'eventBus, linkService,' },
  { label: 'pdf-outline-read-disconnected', file: 'apps/desktop/src/renderer/src/components/PdfContent.tsx', before: 'outlineEntries(items ?? [])', after: 'outlineEntries([])' },
  { label: 'pdf-stale-outline-publishes', file: 'apps/desktop/src/renderer/src/components/PdfContent.tsx', before: "if (!disposed) setOutline({ owner: data, phase: 'ready'", after: "if (true) setOutline({ owner: data, phase: 'ready'" }
]
