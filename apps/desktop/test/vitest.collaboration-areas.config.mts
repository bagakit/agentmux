import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'
const sourceAliases = shared.resolve?.alias
if (!Array.isArray(sourceAliases)) throw Error('Original source aliases required')
export const collaborationAreaMutations = [
  { name: 'selection-issue', file: 'lib/collaboration-areas.ts', before: 'issue = category ? null : selected.issue', after: 'issue = null', assertion: 'preserves an exact unconfirmed selection issue instead of silently presenting its healthy canonical area' },
  { name: 'exact-host', file: 'lib/workspace-agent-scope.ts', before: 'hostId !== undefined && session.control.hostId !== hostId || ', after: '', assertion: 'keeps original Host ownership when a collaborator SID also has a presentation on another Host' },
  { name: 'display-owner', file: 'lib/workspace-agent-scope.ts', before: 'if (choice?.workspaceId !== workspace.id) return null', after: 'if (choice?.workspaceId !== workspace.id || workspace.id !== SCRATCH_WORKSPACE_ID) return null', assertion: 'uses the original Mote membership across display Workspaces and includes visible members in reorder validation' },
  { name: 'project-relations', file: 'lib/workspace-agent-scope.ts', before: 'binding.spaceId === projectId', after: 'true', assertion: 'uses original project Region ownership even when execution cwd belongs elsewhere' },
  { name: 'single-path', file: 'lib/collaboration-presentation.ts', before: 'held.relations.push(relation); connections.set(id, held)', after: 'held.relations.push(relation, relation); connections.set(id, held)', assertion: 'projects each original relation once when the same Agents participate in several areas' },
  { name: 'internal-originals', file: 'lib/collaboration-presentation.ts', before: 'values.push(relation); internal.set(from.id, values)', after: 'internal.set(from.id, values)', assertion: 'retains folded internal originals and original cross-area direction without inventing duplicate relationships' }
] as const
const selected = process.env.AGENTMUX_COLLABORATION_AREA_MUTATION
const mutation = collaborationAreaMutations.find(value => value.name === selected)
if (selected && !mutation) throw Error('Unknown area mutation')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...shared, resolve: { ...shared.resolve, alias: [{ find: /^@agentmux\/identity$/, replacement: resolve(import.meta.dirname, '../../../packages/identity/src/index.ts') }, ...sourceAliases] }, plugins: [...shared.plugins ?? [], { name: 'collaboration-area-source-proof', enforce: 'pre', transform(source, id) {
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
