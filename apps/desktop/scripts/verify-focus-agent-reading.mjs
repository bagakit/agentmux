import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const evidence = process.argv.indexOf('--evidence')
await verifyRendererSourceMutations({ name: 'focus-agent-reading',
  evidenceRoot: evidence < 0 ? undefined : resolve(process.argv[evidence + 1]),
  owningConfig: 'apps/desktop/test/vitest.focus-agent-menu.config.mts',
  tests: ['apps/desktop/test/focus-agent-reading.test.tsx', 'apps/desktop/test/focus-stop-agent.test.tsx'],
  sources: ['vitest.config.ts', 'test/fixture-values.mjs', 'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx', 'apps/desktop/src/renderer/src/components/AgentSessionReadingSurface.tsx',
    'apps/desktop/src/renderer/src/components/FocusAgentWorkspaceMenu.tsx', 'apps/desktop/src/renderer/src/lib/focus-agent-menu-location.ts'],
  mutations: [
    { label: 'wrong-reader-subject', file: 'apps/desktop/src/renderer/src/components/AgentSessionReadingSurface.tsx',
      before: 'reference: source, identity: JSON.stringify([source.hostId, source.agentSessionId])',
      after: "reference: { ...source, agentSessionId: 'wrong-reader-subject' }, identity: JSON.stringify([source.hostId, source.agentSessionId])" },
    { label: 'guess-first-occurrence', file: 'apps/desktop/src/renderer/src/lib/focus-agent-menu-location.ts',
      before: 'reference: presentation.projection?.selection[0]', after: 'reference: presentation.references[0]' },
    { label: 'closed-card-observer', file: 'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx',
      before: 'open ? useAppStore.subscribe(listener) : () => {}', after: 'useAppStore.subscribe(listener)' },
    { label: 'missing-tab-keeps-menu-readable', file: 'apps/desktop/src/renderer/src/components/FocusAgentWorkspaceMenu.tsx',
      before: 'if (!tab) return <ContextMenu.Label', after: 'if (false) return <ContextMenu.Label' }
  ] })
