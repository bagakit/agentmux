import { fixtureEpoch } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'

const NOW = fixtureEpoch(1, 28800, 0)
const SCENE_NOW = Date.now()
const opened: Awaited<ReturnType<typeof activityCertaintyClient>>[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(opened.splice(0).map(item => item.close())) })
async function open(id: string, provider?: 'codex' | 'grok' | 'cursor' | 'traex') {
  const h = await activityCertaintyClient(id, provider); opened.push(h); return h
}
it('public Client with an actual FileStore reports bare running as unknown while keeping the exact healthy Run ready', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const h = await open('bare')
  const status = await h.client.statusAgent('bare')
  expect(status.session.semanticStatus).toBeUndefined()
  expect(status.observation).toMatchObject({ process: 'running', semantic: 'unknown', readiness: 'ready', source: 'run-process' })
  expect(status.session.run.runId).toBe(h.run.runId); expect(status.run.latestOutputBytes).toBe(17)
  expect([...new Set(h.requests)]).toEqual([h.run.runId])
  expect((await h.sessions())[0]!.run).toEqual(status.session.run)
})
it('accepted native working persisted in FileStore becomes unknown after the existing TTL without fabricating idle or done', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW - 25 * 60_000)
  const h = await open('stale', 'grok')
  // Each Hook names its native conversation with the key its Provider declares; an unnamed one changes no state.
  await h.hook('session_start', 'real-working', { eventName: 'session_start', sessionId: 'native-stale' })
  expect((await h.sessions())[0]!.semanticStatus?.state).toBe('working')
  clock.mockReturnValue(NOW)
  const status = await h.client.statusAgent('stale')
  expect(status.observation).toMatchObject({ process: 'running', semantic: 'unknown', readiness: 'ready', stale: true })
  expect(status.session.semanticStatus).toMatchObject({ state: 'working', observedAt: NOW - 25 * 60_000 })
  expect(status.session.run.runId).toBe(h.run.runId); expect([...new Set(h.requests)]).toEqual([h.run.runId])
})
it('accepted current working, Stop completion and static waiting keep distinct public meanings', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  // Cursor's own stop status confirms a completed turn; Codex leaves completion to its native outcome observer.
  const h = await open('confirmed', 'cursor')
  await h.hook('beforeSubmitPrompt', 'confirmed-working', { conversation_id: 'native-confirmed' })
  expect((await h.client.statusAgent('confirmed')).observation.semantic).toBe('active')
  clock.mockReturnValue(NOW + 1); await h.hook('stop', 'confirmed-done', { conversation_id: 'native-confirmed', status: 'completed' })
  expect((await h.client.statusAgent('confirmed')).observation.semantic).toBe('idle')
  const waiting = await activityCertaintyClient('separate-waiting', 'codex', {
    semanticStatus: { state: 'waiting', source: 'acp', observedAt: NOW } }); opened.push(waiting)
  clock.mockReturnValue(NOW + 60 * 60_000)
  expect((await waiting.client.statusAgent('separate-waiting')).observation.semantic).toBe('awaiting-input')
})
it('neutral child and late old Run hooks do not upgrade a bare public observation into current work', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const h = await open('isolated-subject')
  await h.hook('PreToolUse', 'child-tool', { agent_id: 'known-child', tool_name: 'Read' })
  expect((await h.client.statusAgent('isolated-subject')).observation.semantic).toBe('unknown')
  await h.hook('UserPromptSubmit', 'old-run', {}, 'obsolete-run')
  expect((await h.client.statusAgent('isolated-subject')).observation.semantic).toBe('unknown')
  expect((await h.sessions())[0]!.semanticStatus).toBeUndefined()
})
it('a registered Provider without semantic observation remains unsupported, with the original healthy process ready', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const h = await open('unsupported', 'traex')
  expect((await h.client.statusAgent('unsupported')).observation).toMatchObject({ process: 'running', semantic: 'unsupported', readiness: 'ready' })
})
it('actual public four-state snapshots provide exact scene inputs without a Runtime lifecycle', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(SCENE_NOW)
  const bare = await open('scene-bare')
  const stale = await activityCertaintyClient('scene-stale', 'grok', { workspacePath: bare.directory }); opened.push(stale)
  const working = await activityCertaintyClient('scene-working', 'cursor', { workspacePath: bare.directory }); opened.push(working)
  const idle = await activityCertaintyClient('scene-idle', 'cursor', { workspacePath: bare.directory }); opened.push(idle)
  clock.mockReturnValue(SCENE_NOW - 25 * 60_000); await stale.hook('session_start', 'scene-stale-observation', { eventName: 'session_start', sessionId: 'native-scene-stale' })
  clock.mockReturnValue(SCENE_NOW); await working.hook('beforeSubmitPrompt', 'scene-working-observation', { conversation_id: 'native-scene-working' })
  await idle.hook('stop', 'scene-idle-observation', { conversation_id: 'native-scene-idle', status: 'completed' })
  const rows = await Promise.all([bare, stale, working, idle].map(item => item.client.statusAgent(item === bare ? 'scene-bare'
    : item === stale ? 'scene-stale' : item === working ? 'scene-working' : 'scene-idle')))
  expect(rows.map(row => row.observation.semantic)).toEqual(['unknown', 'unknown', 'active', 'idle'])
  expect(new Set(rows.map(row => row.session.agentSessionId)).size).toBe(4)
  expect(rows.every(row => row.session.workspacePath === bare.directory && row.run.state === 'running')).toBe(true)
  const path = process.env.AGENTMUX_ACTIVITY_CERTAINTY_SCENE_SEED
  if (path) {
    const inputs = Object.fromEntries(await Promise.all(['agent-status-freshness.ts', 'client.ts', 'agent-session-store.ts', 'providers/grok.ts', 'providers/cursor.ts'].map(async name =>
      ['packages/core/src/' + name, createHash('sha256').update(await readFile(new URL('../src/' + name, import.meta.url))).digest('hex')])))
    await writeFile(path, JSON.stringify({ schema: 'agentmux.activity-certainty-public-scene-seed.v1', inputs, rows,
      observerNow: SCENE_NOW, boundary: 'Actual public Client/private FileStore and accepted Hooks; isolated fixed Run transport, not Native Writer or physical Run proof.' }, null, 2) + '\n')
  }
})
it('a Hook that reports its activity unknown reads unconfirmed through agent.input.inspect, never active', async () => {
  const { AgentMuxRpcService } = await import('../src/public-rpc-service.js')
  const h = await activityCertaintyClient('hook-unknown', 'claude'); opened.push(h)
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.client }] })
  const key = { kind: 'prompt' as const, agentSessionId: 'hook-unknown', expectedRun: { runId: h.run.runId }, submissionId: 'never-admitted' }
  const activity = async () => (await service.call('agent.input.inspect', { key, activity: true }, { principal: { kind: 'user', id: 'reader' } })).activity
  const native = (sequence: number, extra = {}) => ({ session_id: 'native-main', sourceId: 'native-source', sequence, turnId: 'native-turn-1', ...extra })
  await h.hook('turn.start', 'start-1', native(1))
  expect(await activity()).toMatchObject({ state: 'active', source: 'native-hook' })
  await h.hook('AgentMuxActivityUnavailable', 'source-gap', native(2, { reason: 'source-changed' }))
  expect(h.client.agentSession('hook-unknown').currentActivity?.state).toBe('unknown')
  // Claude declares no Provider evidence reader, so nothing else can confirm the state.
  expect(await activity()).toMatchObject({ state: 'unconfirmed', source: 'unconfirmed', sourceId: null, issue: expect.any(String) })
  await h.hook('turn.start', 'start-3', native(3, { turnId: 'native-turn-2' }))
  await h.hook('turn.complete', 'end-4', native(4, { turnId: 'native-turn-2', reason: 'answer', isAborted: false, backgroundWork: 'none' }))
  expect(await activity()).toMatchObject({ state: 'idle', source: 'native-hook' })
})
