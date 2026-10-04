export const tests = ['apps/desktop/test/plantuml-preview.test.tsx']
export const sources = ['apps/desktop/src/renderer/src/components/file-preview/PlantUmlFilePreview.tsx', 'apps/desktop/src/renderer/src/lib/file-formats/plantuml-engine.ts', 'apps/desktop/src/renderer/src/lib/file-formats/diagram-script.ts']
export const mutations = [{ label: 'plantuml-kind-disconnected', file: sources[0], before: 'kind="plantuml"', after: 'kind="drawio"' }]
