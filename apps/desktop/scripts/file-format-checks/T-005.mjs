export const owningConfig = 'apps/desktop/test/diagram-format.config.mts'
export const tests = ['apps/desktop/test/file-diagram-renderer.test.ts', 'apps/desktop/test/diagram-file-preview.test.tsx']
export const sources = [
  'apps/desktop/src/shared/file-diagram.ts', 'apps/desktop/src/main/file-diagram-renderer.ts',
  'apps/desktop/src/renderer/file-diagram/index.html', 'apps/desktop/src/renderer/file-diagram/entry.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/mermaid-engine.ts',
  'apps/desktop/src/renderer/src/components/file-preview/DiagramFilePreview.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/DotFilePreview.tsx',
  'packages/client-ui/src/lib/use-visible-work.ts', 'packages/client-ui/src/platform.tsx',
  'apps/desktop/src/renderer/src/lib/theme-contract.ts'
]
export const mutations = [
  { label: 'diagram-owner-keeps-webcontents', file: sources[1], before: 'if (!window.isDestroyed()) window.destroy()', after: 'if (!window.isDestroyed()) void 0' },
  { label: 'diagram-starts-hidden', file: sources[5], before: 'if (!inView) return\n    let current', after: 'if (false) return\n    let current' },
  { label: 'diagram-late-source-paints', file: sources[5], before: 'if (!current || value.id !== id) return', after: 'if (false) return' },
  { label: 'diagram-unbounded-native-windows', file: sources[1], before: 'this.active < 2', after: 'this.active < 20' },
  { label: 'diagram-queue-reverses-fifo', file: sources[1], before: 'this.queue.shift()!', after: 'this.queue.pop()!' },
  { label: 'diagram-queued-cancel-is-ignored', file: sources[1], before: "cancel(id: string): void { this.jobs.get(id)?.finish", after: "cancel(id: string): void { if (!this.jobs.get(id)?.window) return; this.jobs.get(id)?.finish" },
  { label: 'diagram-cancel-all-starts-queued-work', file: sources[1], before: 'this.cancellingAll = true', after: 'this.cancellingAll = false' },
  { label: 'diagram-reads-wrong-appearance', file: sources[5], before: 'dataset[APP_APPEARANCE_DATASET_KEY]', after: 'dataset.theme' },
  { label: 'diagram-ignores-appearance-change', file: sources[5], before: 'new MutationObserver(() => setAppearanceRevision(value => value + 1))', after: 'new MutationObserver(() => {})' }
]
