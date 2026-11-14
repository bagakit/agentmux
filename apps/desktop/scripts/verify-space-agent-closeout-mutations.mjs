import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const relations = 'apps/desktop/src/renderer/src/lib/workspace-agent-relations.ts'
const order = 'apps/desktop/src/renderer/src/lib/workspace-agent-order.ts'
const arrangement = 'apps/desktop/src/renderer/src/lib/workspace-agent-arrangement.ts'
await verifyRendererSourceMutations({ name: 'closeout-mutations', evidenceRoot: resolve(process.env.AGENTMUX_RELATIONS_EVIDENCE ?? '.local/space-agent-relations'),
  tests: ['apps/desktop/test/space-agent-relations.test.tsx', 'apps/desktop/test/space-agent-list-performance.test.tsx'],
  sources: [relations, order, arrangement, 'apps/desktop/src/renderer/src/lib/workspace-agent-key.ts',
    'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx', 'apps/desktop/src/renderer/src/components/WorkspaceAgentRow.tsx',
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/scripts/lib/fixture-values.mjs', 'test/fixture-values.mjs'],
  mutations: [
    { label: 'manual-sort-cannot-wait-for-communication', file: order, before: 'if (request.order === undefined) {', after: 'if (true) {' },
    { label: 'new-members-must-not-reread-old-members', file: relations, before: 'for (const key of all ? subjects.keys() : added) refresh(key)', after: 'for (const key of subjects.keys()) refresh(key)' },
    { label: 'relationship-readers-share-a-bounded-pool', file: relations, before: 'running < 4', after: 'running < Infinity' },
    { label: 'delivery-churn-cannot-trigger-relationship-reads', file: relations, before: "if (event.type !== 'agent-message-changed' || event.recordKind !== 'message' && event.recordKind !== 'message-peer-inbox') return", after: "if (event.type !== 'agent-message-changed') return" },
    { label: 'old-retirement-cannot-hide-new-healthy-session', file: arrangement, before: 'session.agentSessionUpdatedAt <= source.retiredAt', after: 'true' }
  ] })
