import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'
export const collaborationProductMutations = [
  { name: 'projected-activity-scope', file: 'components/AgentCollaborationMap.tsx', before: 'new Set([...agents.values()].flatMap(agent => agent.subject ?', after: 'new Set([...catalog.agents.values()].flatMap(agent => agent.subject ?', assertion: 'shows live activity between original referenced Agents outside the catalogue without extending history demand' },
  { name: 'keyboard-locate', file: 'components/CollaborationMapToolbar.tsx', before: 'locate(options[index].id)', after: 'setOpen(false)', assertion: 'uses keyboard search to explicitly locate an Agent and discloses sources without losing the selection' },
  { name: 'source-reader-retention', file: 'components/AgentCollaborationMap.tsx', before: '<div hidden={sourcesOpen} inert={sourcesOpen}>', after: '<div key={String(sourcesOpen)} hidden={sourcesOpen} inert={sourcesOpen}>', assertion: 'retains the opened original message while inspecting its map sources' },
  { name: 'focus-entry', file: 'components/FocusToolbar.tsx', before: 'onClick={onOpenCollaboration}', after: 'onClick={() => {}}', assertion: 'locates the exact Focus Agent in the shared map and keeps the complete world and original draft' },
  { name: 'production-card', file: 'components/AgentCollaborationGraph.tsx', before: "agent.context && tier === 'active' && readable ? <FocusContextCardBody", after: 'false ? <FocusContextCardBody', assertion: 'locates the exact Focus Agent in the shared map and keeps the complete world and original draft' },
  { name: 'exact-workface', file: 'components/AgentCollaborationMap.tsx', before: 'onOpen(context, locations[0])', after: "onOpen({ ...context, id: 'wrong-workface' }, locations[0])", assertion: 'locates the exact Focus Agent in the shared map and keeps the complete world and original draft' },
  { name: 'explicit-body-demand', file: 'components/AgentCollaborationMap.tsx', before: 'const [read, setRead] = useState(false)', after: 'const [read, setRead] = useState(true)', assertion: 'offers explicit source reading, keeps failure local and leaves healthy relations visible' },
  { name: 'disconnected-world', file: 'components/AgentCollaborationGraph.tsx', before: 'const agent = agents.get(id); if (!agent) continue', after: 'const agent = agents.get(id); if (!agent || !relations.some(relation => relation.source === id || relation.target === id)) continue', assertion: 'locates the exact Focus Agent in the shared map and keeps the complete world and original draft' },
  { name: 'retired-context-identity', file: 'components/AgentCollaborationMap.tsx', before: 'const context = retainedFocusContext(source, name)', after: "const context = { ...retainedFocusContext(source, name), id: 'wrong-retained-subject' }", assertion: 'opens the shared reader for a retired map point without inventing a live Session or control' },
  { name: 'unobserved-catalogue-member', file: 'components/AgentCollaborationMap.tsx', before: 'for (const source of history.sources) {', after: "for (const source of history.sources) { if (source.state !== 'retired') continue", assertion: 'keeps an active catalogue identity missing from the current snapshot readable as unknown on its exact Host' },
  { name: 'catalogue-failure-signal', file: 'components/AgentCollaborationMap.tsx', before: 'Number(Boolean(history.error)))', after: '0)', assertion: 'surfaces original catalogue failure with no selection and recovers through its owner while keeping the world usable' },
  { name: 'confirmed-exit-tier', file: 'lib/collaboration-map-presentation.ts', before: "const tier = session.processState === 'exited' && !session.runUnobserved ? 'closed'\n    : bucket === 'working' || bucket === 'attention' ? 'active'", after: "const tier = bucket === 'working' || bucket === 'attention' ? 'active'\n    : session.processState === 'exited' && !session.runUnobserved ? 'closed'", assertion: 'keeps a confirmed exited Agent a closed map point while preserving its original error and Focus attention' },
  { name: 'unchanged-context-cache', file: 'components/AgentCollaborationMap.tsx', before: 'if (old && old.session === session && old.name === name && old.workspace === workspace && old.topicId === topicId)', after: 'if (false)', assertion: 'consumes retained incremental facts in the real Map without redecoding status or rebuilding unchanged cards' },
  { name: 'incremental-facts-consumer', file: 'components/AgentCollaborationMap.tsx', before: 'const project = useMemo(createCollaborationProjector, [])', after: 'const project = createCollaborationProjector()', assertion: 'consumes retained incremental facts in the real Map without redecoding status or rebuilding unchanged cards' },
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
