import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'
export const collaborationAreaMutations = [
  { name: 'project-parent-terrain', file: 'lib/collaboration-areas.ts', before: 'parentId: parents.get(project.id)', after: 'parentId: null', assertion: 'preserves the real project ancestry without grouping prefix siblings, other Hosts or worktrees as children' },
  { name: 'folded-ancestor-terrain', file: 'lib/collaboration-hierarchy.ts', before: 'ancestor && folded.has(ancestor) ? ancestor : id', after: 'id', assertion: 'folds the exact ancestor subtree while retaining original relations, shared identities and accurate expansion' },
  { name: 'distinct-message-strength', file: 'lib/collaboration-presentation.ts', before: 'Math.max(1, messages.size)', after: '1', assertion: 'counts distinct original communication evidence rather than event stages, dispatch or repeated observations' },
  { name: 'original-project-appearance', file: 'lib/collaboration-areas.ts', before: 'folderSpaceIconTarget(project)', after: "folderSpaceIconTarget({ ...project, hostId: 'local' })", assertion: 'keeps the captured request independent from background selection and coalesces project worktrees by original identity' },
  { name: 'original-topic-appearance', file: 'lib/collaboration-areas.ts', before: '...(iconTarget ? { iconTarget } : {})', after: "...(iconTarget ? { iconTarget: { ...iconTarget, key: display?.spaceId ?? '' } } : {})", assertion: 'keeps Topic category Space and original Zone distinct and groups a category without broadening to other objects' },
  { name: 'original-agent-provider', file: 'lib/collaboration-map-presentation.ts', before: 'providerId: session.providerId', after: 'providerId: session.executorId', assertion: 'projects the exact Session Provider and Executor independently of names or display metadata' },
  { name: 'selection-issue', file: 'lib/collaboration-areas.ts', before: 'issue = category ? null : selected.issue', after: 'issue = null', assertion: 'preserves an exact unconfirmed selection issue instead of silently presenting its healthy canonical area' },
  { name: 'exact-host', file: 'lib/workspace-agent-scope.ts', before: 'hostId !== undefined && session.control.hostId !== hostId || ', after: '', assertion: 'keeps original Host ownership when a collaborator SID also has a presentation on another Host' },
  { name: 'display-owner', file: 'lib/workspace-agent-scope.ts', before: 'if (choice?.workspaceId !== workspace.id) return null', after: 'if (choice?.workspaceId !== workspace.id || workspace.id !== SCRATCH_WORKSPACE_ID) return null', assertion: 'uses the original Mote membership across display Workspaces and includes visible members in reorder validation' },
  { name: 'project-relations', file: 'lib/workspace-agent-scope.ts', before: 'binding.spaceId === projectId', after: 'true', assertion: 'uses original project Region ownership even when execution cwd belongs elsewhere' },
  { name: 'single-path', file: 'lib/collaboration-presentation.ts', before: 'held.relations.push(relation); connections.set(id, held)', after: 'held.relations.push(relation, relation); connections.set(id, held)', assertion: 'projects each original relation once when the same Agents participate in several areas' },
  { name: 'internal-originals', file: 'lib/collaboration-presentation.ts', before: 'values.push(relation); internal.set(owner, values)', after: 'internal.set(owner, values)', assertion: 'retains folded internal originals and original cross-area direction without inventing duplicate relationships' }
] as const
const selected = process.env.AGENTMUX_COLLABORATION_AREA_MUTATION
const mutation = collaborationAreaMutations.find(value => value.name === selected)
if (selected && !mutation) throw Error('Unknown area mutation')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...shared, plugins: [...shared.plugins ?? [], { name: 'collaboration-area-source-proof', enforce: 'pre', transform(source, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
  let code = source
  if (mutation && path === 'apps/desktop/src/renderer/src/' + mutation.file) {
    if (code.split(mutation.before).length !== 2) throw Error('Unique area mutation anchor required')
    code = code.replace(mutation.before, mutation.after)
  }
  if (process.env.AGENTMUX_COLLABORATION_AREA_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_AREA_LOADED, JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutated: source !== code }) + '\n')
  if (source !== code) return { code, map: null }
} }], test: { ...shared.test, include: ['apps/desktop/test/collaboration-areas.test.ts', 'apps/desktop/test/collaboration-presentation.test.ts'], passWithNoTests: false } })
