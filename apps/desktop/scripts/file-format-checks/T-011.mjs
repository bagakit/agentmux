export const tests = ['apps/desktop/test/drawio-preview.test.ts']
export const sources = ['apps/desktop/src/renderer/src/lib/file-formats/drawio-engine.ts', 'apps/desktop/src/renderer/src/lib/file-formats/diagram-script.ts', 'apps/desktop/src/renderer/src/components/file-preview/DrawioFilePreview.tsx']
export const mutations = [{ label: 'drawio-page-disconnected', file: sources[0], before: 'viewer.selectPage?.(page)', after: 'viewer.selectPage?.(0)' }]
