import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'
const mutations: Record<string, { file: string; before: string; after: string }> = {
  'team-entry': { file: '/src/MobileApp.tsx', before: 'workspaceVisible && showSession && teamSpaceId && <MobileMoteTeamSummary', after: 'false && <MobileMoteTeamSummary' },
  'member-scope': { file: '/src/navigation/mobile-mote-team.ts', before: 'tab.zoneId !== null && zones.has(tab.zoneId)', after: 'true' },
  'main-target': { file: '/src/MobileApp.tsx', before: 'openSession(main.sessionId, identity); setSheet(null)', after: 'openSession(team!.members[0]!.sessionId, identity); setSheet(null)' },
  'recipient-role': { file: '/src/navigation/MobileMoteTeam.tsx', before: "? '主 Agent' : '成员'", after: "? '主 Agent' : '主 Agent'" },
  'member-host-key': { file: '/src/navigation/mobile-mote-team.ts', before: "const key = JSON.stringify(hostId ? ['agent', hostId, sessionId] : ['unknown-agent', tab.tabId, region.regionId, sessionId])", after: "const key = JSON.stringify(['agent', sessionId])" },
  'unknown-host-target': { file: '/src/MobileApp.tsx', before: 'if (!member.hostId || !current || current.agentSessionId !== id || current.hostId !== member.hostId) {', after: 'if (current && member.hostId && current.hostId !== member.hostId) {' },
  'request-host': { file: '/src/navigation/mobile-mote-team.ts', before: 'request: requestCurrent ? request : undefined', after: 'request: agentInteractionActiveRequest(observed?.pendingInteraction)' }
}
const name = process.env.AGENTMUX_TEST_MOTE_MOBILE_MUTATION
if (name && !mutations[name]) throw new Error('Unknown Mobile cooperation mutation')
const config = mergeConfig(base, { plugins: [{ name: 'loaded-mote-mobile-mutation', enforce: 'pre' as const, transform(code, id) {
  const mutation = name && mutations[name]
  if (!mutation || !id.split('?')[0]!.endsWith(mutation.file)) return
  if (code.split(mutation.before).length !== 2) throw new Error('Loaded Mobile mutation marker changed: ' + name)
  const changed = code.replace(mutation.before, mutation.after), trace = process.env.AGENTMUX_TEST_MOTE_MOBILE_TRACE
  if (!trace) throw new Error('Loaded source trace is required')
  appendFileSync(trace, JSON.stringify({ name, file: id.split('?')[0], before: createHash('sha256').update(code).digest('hex'), after: createHash('sha256').update(changed).digest('hex') }) + '\n')
  return changed
} }] })
config.test!.include = ['test/mote-cooperation.test.tsx', 'test/mobile-mote-input.test.tsx', 'test/mobile-chat-start.test.tsx', 'test/mobile-mote-header-owner.test.tsx']
// Deferred production workfaces compile on first use; keep the runner beyond the existing 10s DOM-load observation.
config.test!.testTimeout = 15000
export default config
