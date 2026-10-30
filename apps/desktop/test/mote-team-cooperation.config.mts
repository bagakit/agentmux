import { defineConfig } from 'vitest/config'
import owning from './mote-primary-agent.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutations = {
  'wrong-mote': ['apps/desktop/src/renderer/src/lib/mote-team.ts', 'tab.zoneId !== null && zones.has(tab.zoneId)', 'tab.zoneId !== null'],
  'wrong-primary': ['apps/desktop/src/renderer/src/components/MoteCooperation.tsx', 'observed.control.agentSessionId === primary.sessionId', 'true'],
  'stale-run': ['apps/desktop/src/renderer/src/components/MoteCooperation.tsx', '(!request.evidence?.run || request.evidence.run.runId === source!.control.run.runId)', 'true'],
  'retarget-member': ['apps/desktop/src/renderer/src/components/MoteCooperation.tsx', 'if (onSelect(location))', 'if (onSelect(primary!))'],
  'global-goal-scan': ['apps/desktop/src/renderer/src/components/MoteCooperation.tsx', '[demands, goalMembers, graph, spaceId,', '[demands, sessions, goalMembers, graph, spaceId,'],
  'foreign-human': ['apps/desktop/src/renderer/src/components/MoteCooperation.tsx', "row.nextOwner.kind === 'human' && (contentOwned(goal) || memberRow(row))", "row.nextOwner.kind === 'human'"],
  'wrong-host': ['apps/desktop/src/renderer/src/lib/mote-team.ts', 'session.control.hostId === member.hostId && session.control.agentSessionId === member.agentSessionId', 'session.control.agentSessionId === member.agentSessionId']
} as const
export default defineConfig({ ...owning, plugins: [...owning.plugins ?? [], {
  name: 'mote-team-loaded-mutations', enforce: 'pre',
  transform(code, id) {
    const mutation = process.env.AGENTMUX_MOTE_TEAM_MUTATION as keyof typeof mutations | undefined
    if (!mutation) return
    if (!mutations[mutation]) throw new Error('Unknown production mutation')
    const [path, before, after] = mutations[mutation]
    if (relative(root, id.split('?')[0]!) !== path) return
    if (code.split(before).length !== 2) throw new Error('Production mutation must match exactly once')
    const changed = code.replace(before, after)
    if (process.env.AGENTMUX_MOTE_TEAM_TRACE) appendFileSync(process.env.AGENTMUX_MOTE_TEAM_TRACE,
      JSON.stringify({ mutation, path, before: createHash('sha256').update(code).digest('hex'), after: createHash('sha256').update(changed).digest('hex') }) + '\n')
    return { code: changed, map: null }
  }
}], test: { ...owning.test,
  include: ['test/mote-team-cooperation.test.tsx', 'test/mote-space-home.test.tsx', 'test/mote-recent-agent.test.tsx'],
  passWithNoTests: false, testTimeout: 30000
} })
