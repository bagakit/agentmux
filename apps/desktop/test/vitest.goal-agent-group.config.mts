import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import original from './vitest.goal-current-work.config.mts'

const shared = 'packages/client-ui/src/components/AvatarGroup.tsx'
const group = 'apps/desktop/src/renderer/src/components/GoalAgentGroup.tsx'
const mutation = process.env.GOAL_AVATARS_MUTATION || null
const mutants = {
  'overflow-hidden': [shared, 'const visible = items.slice(0, max), remaining = items.length - visible.length', 'const visible = items.slice(0, max), remaining = 0'],
  'history-members': [group, 'demand.assigneeSessionIds ?? []', 'demand.sessionIds'],
  'alias-not-deduped': [group, "JSON.stringify(['actor', session.control.hostId, session.control.agentSessionId])", 'referenceKey'],
  'assumed-running': [group, 'avatar: <ResolvedAgentAvatar label={face.name}', 'avatar: <ResolvedAgentAvatar state="running" label={face.name}']
} as const
if (mutation && !(mutation in mutants)) throw Error('Unknown Goal avatar mutation')
const full = [shared, group, 'packages/client-ui/src/styles/avatar-group.css', 'apps/desktop/src/renderer/src/styles/goal-agent-group.css']
const segments: Record<string, [string, string]> = {
  'apps/desktop/src/renderer/src/components/GoalsCollection.tsx': ['/** One Goal reading unit.', '/** The grouped list,'],
  'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx': ['<GoalRow', 'setSelectedDemand(demand.id) }} />'],
  'apps/desktop/src/renderer/src/lib/goal-agent-selection.ts': ['export function goalAgentPresentation(', '/** Business selection uses canonical'],
  'apps/desktop/src/renderer/src/components/AgentAvatar.tsx': ['export function executorAvatarAppearance(', '\nfunction AgentAvatarFace(']
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...original, plugins: [...original.plugins ?? [], { name: 'actual-goal-agent-group', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!full.includes(file) && !segments[file]) return
    const originalSHA256 = sha(source)
    let boundSource: string | undefined
    if (segments[file]) {
      const [start, end] = segments[file]!
      if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('Goal avatar consumer segment needs one exact anchor: ' + file)
      boundSource = source.slice(source.indexOf(start), source.indexOf(end) + end.length)
    }
    if (mutation) { const [target, anchor, replacement] = mutants[mutation as keyof typeof mutants]; if (file === target) {
      if (source.split(anchor).length !== 2) throw Error('Goal avatar mutant needs one actual production anchor')
      source = source.replace(anchor, replacement)
    } }
    const output = process.env.GOAL_AVATARS_LOADED
    if (!output) return source
    const row = { file, originalSHA256, loadedSHA256: sha(source), mutation: mutation && mutants[mutation as keyof typeof mutants][0] === file ? mutation : null, ...(boundSource ? { boundSource, boundSHA256: sha(boundSource) } : {}) }
    if (file.endsWith('.css')) { appendFileSync(output, JSON.stringify(row) + '\n'); return }
    return `import {appendFileSync as __goalAvatarsLoaded} from 'node:fs';__goalAvatarsLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...original.test, include: ['apps/desktop/test/goal-agent-group.test.tsx'], passWithNoTests: false } }
