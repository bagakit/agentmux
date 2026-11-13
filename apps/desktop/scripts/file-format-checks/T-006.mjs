export const owningConfig = 'apps/desktop/test/diagram-format.config.mts'
export const tests = ['apps/desktop/test/dot-engine.test.ts', 'apps/desktop/test/diagram-file-preview.test.tsx']
export const sources = [
  'packages/editor-extensions/src/engines/dot-engine.ts', 'packages/editor-extensions/src/engines/dot-worker.ts',
  'packages/editor-extensions/src/ui/DotFilePreview.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/DiagramFilePreview.tsx',
  'packages/client-ui/src/lib/use-visible-work.ts', 'apps/desktop/src/renderer/src/lib/theme-contract.ts'
]
export const mutations = [
  { label: 'dot-engine-disconnected', file: sources[0], before: "viz.render(content, { format: 'svg', engine: 'dot' })", after: "viz.render('digraph { Disconnected }', { format: 'svg', engine: 'dot' })" },
  { label: 'dot-worker-survives-hidden', file: sources[2], before: 'current = false; worker.terminate();', after: 'current = false; void 0;' },
  { label: 'dot-starts-hidden', file: sources[2], before: 'if (!inView) return', after: 'if (false) return' }
]
