import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const appearance = 'apps/desktop/src/main/project-appearance.ts'

await verifyRendererSourceMutations({
  name: `project-icon-discovery-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/project-appearance.test.ts'],
  sources: [appearance],
  mutations: [
    { label: 'hidden-tool-data-consumes-budget', file: appearance,
      before: "!entry.name.startsWith('.') && ", after: '' },
    { label: 'filesystem-icon-disconnected', file: appearance,
      before: 'icon: hit?.icon ?? null', after: 'icon: null' }
  ]
})
