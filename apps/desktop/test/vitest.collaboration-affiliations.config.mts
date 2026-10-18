import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'

export const affiliationMutations = [
  { name: 'retained-workspace', file: 'lib/workspace-agent-scope.ts', before: 'if (sources) {', after: 'if (false) {', assertion: 'associates retained exact workspaces and worktrees with the original project without live Sessions' },
  { name: 'retained-spatial', file: 'lib/workspace-agent-scope.ts', before: "if (members) addMember(members, { hostId: execution.hostId, agentSessionId: ref.agentSessionId }, 'spatial')", after: 'void members', assertion: 'retains original spatial and collaborator membership without live presentation or an active Run' },
  { name: 'retained-collaborator', file: 'lib/workspace-agent-scope.ts', before: "if (members && (!provider || provider === plaque.providerId)", after: 'if (false && (!provider || provider === plaque.providerId)', assertion: 'retains original spatial and collaborator membership without live presentation or an active Run' },
  { name: 'source-host', file: 'lib/workspace-agent-scope.ts', before: 'return index.get(hostId)', after: "return index.get('local')", assertion: 'qualifies exact resource association by Host and rejects ambiguous Topic directory evidence' },
  { name: 'binding-priority', file: 'lib/collaboration-areas.ts', before: '!placed.has(id) ||', after: 'true ||', assertion: 'preserves all original multi-area bindings without adding an execution-directory occurrence' },
  { name: 'late-map-consumer', file: 'components/AgentCollaborationMap.tsx', before: "const affiliation = useMemo(() => areaSelector(facts, request.kind === 'space' ? request : undefined, descriptors)", after: "const affiliation = useMemo(() => areaSelector(facts, request.kind === 'space' ? request : undefined, catalog.history)", assertion: 'the real map associates a late original metadata endpoint with its project without inventing a workface or reading its body' },
  { name: 'resource-authority', file: 'components/AgentCollaborationMap.tsx', before: "member.basis === 'collaborator' ? 'Recorded collaborator' : 'Workspace association'", after: "member.basis === 'collaborator' ? 'Recorded collaborator' : 'Display binding'", assertion: 'shows retained project association in the real Map while unknown area and identity stay separate' },
  { name: 'unknown-area-detail', file: 'components/AgentCollaborationMap.tsx', before: 'selectedAffiliations.length ? <dl>', after: 'true ? <dl>', assertion: 'shows retained project association in the real Map while unknown area and identity stay separate' },
  { name: 'stale-original-metadata', file: 'lib/use-collaboration-identities.ts', before: 'if (!accepted()) return\n          const read = { reference, source: result.source', after: 'const read = { reference, source: result.source', assertion: 'fences a late exact lookup after the owner changes and never reads unrelated metadata or bodies' }
] as const
const selected = process.env.AGENTMUX_AFFILIATION_MUTATION, mutation = affiliationMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown affiliation mutation')
const hash = (code: string) => createHash('sha256').update(code).digest('hex')
const scope = process.env.AGENTMUX_AFFILIATION_SCOPE
const include = scope === 'bridge' ? ['apps/desktop/test/collaboration-identity-bridge.test.tsx'] : scope === 'product' ? ['apps/desktop/test/collaboration-product-reading.test.tsx'] :
  ['apps/desktop/test/collaboration-areas.test.ts', 'apps/desktop/test/topic-agent-scope.test.ts', 'apps/desktop/test/collaboration-identities.test.tsx']
export default defineConfig({ ...shared, define: { ...shared.define, __AGENTMUX_WEB_PREVIEW__: scope === 'bridge' ? 'false' : 'true' },
  plugins: [...shared.plugins ?? [], { name: 'actual-map-affiliation-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    let code = source
    if (mutation && path === 'apps/desktop/src/renderer/src/' + mutation.file) {
      if (source.split(mutation.before).length !== 2) throw Error('One exact affiliation mutation anchor required')
      code = source.replace(mutation.before, mutation.after)
    }
    if (process.env.AGENTMUX_AFFILIATION_LOADED) appendFileSync(process.env.AGENTMUX_AFFILIATION_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutated: code !== source }) + '\n')
    if (code !== source) return { code, map: null }
  } }], test: { ...shared.test, include, passWithNoTests: false, testNamePattern: mutation?.assertion } })
