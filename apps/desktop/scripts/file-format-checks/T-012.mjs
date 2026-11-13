export const tests = ['apps/desktop/test/plantuml-preview.test.tsx']
export const sources = ['packages/editor-extensions/src/ui/PlantUmlFilePreview.tsx', 'packages/editor-extensions/src/engines/plantuml-engine.ts', 'packages/editor-extensions/src/engines/diagram-script.ts']
export const mutations = [{ label: 'plantuml-kind-disconnected', file: sources[0], before: 'kind="plantuml"', after: 'kind="drawio"' }]
