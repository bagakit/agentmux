import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'
export const collaborationProductMutations = [
  { name: 'focus-entry', file: 'components/FocusToolbar.tsx', before: 'onClick={onOpenCollaboration}', after: 'onClick={() => {}}', assertion: 'opens the real Focus graph at the exact original subject and keeps the background workface and draft' },
  { name: 'production-card', file: 'components/AgentCollaborationGraph.tsx', before: 'agent.context ? <FocusContextCardBody', after: 'false ? <FocusContextCardBody', assertion: 'opens the real Focus graph at the exact original subject and keeps the background workface and draft' },
  { name: 'exact-workface', file: 'components/AgentCollaborationDialog.tsx', before: 'onOpen(context, locations[0])', after: "onOpen({ ...context, id: 'wrong-workface' }, locations[0])", assertion: 'opens the real Focus graph at the exact original subject and keeps the background workface and draft' },
  { name: 'explicit-body-demand', file: 'components/AgentCollaborationDialog.tsx', before: 'const [read, setRead] = useState(false)', after: 'const [read, setRead] = useState(true)', assertion: 'offers explicit source reading, keeps failure local and leaves healthy relations visible' },
  { name: 'presentation-context-key', file: 'components/AgentCollaborationDialog.tsx', before: 'const key = JSON.stringify([session.hostId, session.id]), old = contextCache.current.get(key)', after: 'const key = collaborationSubjectKey(session.control), old = contextCache.current.get(key)', assertion: 'consumes retained incremental facts in the real Dialog without redecoding status or rebuilding unchanged cards' },
  { name: 'unchanged-context-cache', file: 'components/AgentCollaborationDialog.tsx', before: 'if (old && old.session === session && old.name === name && old.workspace === workspace && old.topicId === topicId)', after: 'if (false)', assertion: 'consumes retained incremental facts in the real Dialog without redecoding status or rebuilding unchanged cards' },
  { name: 'incremental-facts-consumer', file: 'components/AgentCollaborationDialog.tsx', before: 'const project = useMemo(createCollaborationProjector, [])', after: 'const project = createCollaborationProjector()', assertion: 'consumes retained incremental facts in the real Dialog without redecoding status or rebuilding unchanged cards' },
  { name: 'visible-relation-filter', file: 'lib/agent-collaboration.ts', before: 'kinds.has(relation.kind) &&', after: 'true &&', assertion: 'relation controls filter the actual canvas and inspector without changing input or Session state' }
] as const
const selected = process.env.AGENTMUX_COLLABORATION_PRODUCT_MUTATION
const mutation = collaborationProductMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown product mutation')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...shared, plugins: [...shared.plugins ?? [], { name: 'collaboration-product-source-proof', enforce: 'pre', transform(source, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
  let code = source
  if (mutation && path === 'apps/desktop/src/renderer/src/' + mutation.file) {
    if (code.split(mutation.before).length !== 2) throw Error('Unique product mutation anchor required')
    code = code.replace(mutation.before, mutation.after)
  }
  if (process.env.AGENTMUX_COLLABORATION_PRODUCT_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_PRODUCT_LOADED, JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutated: source !== code }) + '\n')
  if (source !== code) return { code, map: null }
} }], test: { ...shared.test, include: ['apps/desktop/test/collaboration-focus-product.test.tsx', 'apps/desktop/test/collaboration-product-reading.test.tsx'], passWithNoTests: false } })
