export const tests = ['apps/desktop/test/drawio-preview.test.ts']
export const sources = ['packages/editor-extensions/src/engines/drawio-engine.ts', 'packages/editor-extensions/src/engines/diagram-script.ts', 'packages/editor-extensions/src/ui/DrawioFilePreview.tsx']
export const mutations = [{ label: 'drawio-page-disconnected', file: sources[0], before: 'viewer.selectPage?.(page)', after: 'viewer.selectPage?.(0)' }]
