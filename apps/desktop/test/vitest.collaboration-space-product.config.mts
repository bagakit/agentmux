import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'
const sourceAliases = shared.resolve?.alias
if (!Array.isArray(sourceAliases)) throw Error('Original source aliases required')
export const collaborationSpaceMutations = [
  { name: 'scope-owner', file: 'components/SurfaceToolDock.tsx', before: 'return <WorkspaceCollaborationScope workspaceId={props.workspace.id}><WorkspaceAgentsContent {...props} /></WorkspaceCollaborationScope>', after: 'const choice = useAppStore(state => state.workbenchSpaceSelection)\n  return <WorkspaceCollaborationScope key={JSON.stringify(choice)} workspaceId={props.workspace.id}><WorkspaceAgentsContent {...props} /></WorkspaceCollaborationScope>', assertion: 'opens the real Space graph from a captured area without retargeting it when background selection changes' },
  { name: 'original-request', file: 'components/AgentCollaborationDialog.tsx', before: "request.kind === 'space' ? request : undefined", after: "request.kind === 'space' ? { ...request, choice: useAppStore.getState().workbenchSpaceSelection } : undefined", assertion: 'opens the real Space graph from a captured area without retargeting it when background selection changes' },
  { name: 'fold-inspection', file: 'components/AgentCollaborationGraph.tsx', before: 'relatedIds: internal.map(relation => relation.id)', after: 'relatedIds: []', assertion: 'makes folded internal connections inspectable as original messages and applies kind filters to the same badge' }
] as const
const selected = process.env.AGENTMUX_COLLABORATION_SPACE_MUTATION
const mutation = collaborationSpaceMutations.find(value => value.name === selected)
if (selected && !mutation) throw Error('Unknown Space mutation')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...shared, resolve: { ...shared.resolve, alias: [{ find: /^@agentmux\/identity$/, replacement: resolve(import.meta.dirname, '../../../packages/identity/src/index.ts') }, ...sourceAliases] }, plugins: [...shared.plugins ?? [], { name: 'collaboration-space-source-proof', enforce: 'pre', transform(source, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
  let code = source
  if (mutation && path === 'apps/desktop/src/renderer/src/' + mutation.file) {
    if (code.split(mutation.before).length !== 2) throw Error('Unique Space mutation anchor required')
    code = code.replace(mutation.before, mutation.after)
  }
  if (process.env.AGENTMUX_COLLABORATION_SPACE_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_SPACE_LOADED, JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutated: source !== code }) + '\n')
  if (source !== code) return { code, map: null }
} }], test: { ...shared.test, include: ['apps/desktop/test/collaboration-space-product.test.tsx'], passWithNoTests: false } })
