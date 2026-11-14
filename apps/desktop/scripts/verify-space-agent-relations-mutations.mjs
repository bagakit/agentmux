import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
import { resolve } from 'node:path'
const component = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
const row = 'apps/desktop/src/renderer/src/components/WorkspaceAgentRow.tsx'
const arrangement = 'apps/desktop/src/renderer/src/lib/workspace-agent-arrangement.ts'
const order = 'apps/desktop/src/renderer/src/lib/workspace-agent-order.ts'
await verifyRendererSourceMutations({ name: 'mutations', evidenceRoot: resolve(process.env.AGENTMUX_RELATIONS_EVIDENCE ?? '.local/space-agent-relations'),
  tests: ['apps/desktop/test/space-agent-relations.test.tsx'],
  sources: [component,row,arrangement,order,'apps/desktop/src/renderer/src/lib/workspace-agent-key.ts','apps/desktop/src/renderer/src/lib/workspace-agent-relations.ts',
    'apps/desktop/src/renderer/src/store.ts','apps/desktop/test/helpers/composer-dom-fixture.tsx','apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx','apps/desktop/scripts/lib/fixture-values.mjs'],
  mutations: [
    { label:'parents-must-stay-in-one-group',file:arrangement,before:'if (parent && parent !== key && entries.has(parent)) parents.set(key, parent)',after:'if (false) parents.set(key, parent)' },
    { label:'observed-a2a-must-affect-auto-order',file:component,before:'workspaceAgentGroups(entries, manualOrder, relations.links)',after:'workspaceAgentGroups(entries, manualOrder, [])' },
    { label:'descendants-must-not-move-separately',file:component,before:'move={index === 0 ? move : undefined}',after:'move={move}' },
    { label:'closed-must-be-opt-in',file:component,before:'const [includeClosed, setIncludeClosed] = useState(false)',after:'const [includeClosed, setIncludeClosed] = useState(true)' },
    { label:'unknown-restore-must-not-replay',file:component,before:'reopenRetiredSession(source, intent.operationId, observeOnly, reveal)',after:'reopenRetiredSession(source, intent.operationId, false, reveal)' },
    { label:'newer-manual-order-must-survive',file:order,before:'if (JSON.stringify(currentOrder) !== JSON.stringify(before))',after:'if (false)' }
  ] })
