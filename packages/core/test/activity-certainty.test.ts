import { fixtureEpoch } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'

const NOW = fixtureEpoch(1, 28800, 0)
const SCENE_NOW = Date.now()
const opened: Awaited<ReturnType<typeof activityCertaintyClient>>[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(opened.splice(0).map(item => item.close())) })
async function open(id: string, provider?: 'codex' | 'grok' | 'traex') {
  const h = await activityCertaintyClient(id, provider); opened.push(h); return h
}
it('public Client with an actual FileStore reports bare running as unknown while keeping the exact healthy Run ready', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const h = await open('bare')
  const status = await h.client.statusAgent('bare')
  expect(status.session.semanticStatus).toBeUndefined()
  expect(status.observation).toMatchObject({ process: 'running', semantic: 'unknown', readiness: 'ready', source: 'run-process' })
  expect(status.session.run.runId).toBe(h.run.runId); expect(status.run.latestOutputBytes).toBe(17)
  expect(h.requests).toEqual([h.run.runId])
  expect((await h.sessions())[0]!.run).toEqual(status.session.run)
})
it('accepted native working persisted in FileStore becomes unknown after the existing TTL without fabricating idle or done', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW - 25 * 60_000)
  const h = await open('stale', 'grok')
  await h.hook('session_start', 'real-working', { eventName: 'session_start' })
  expect((await h.sessions())[0]!.semanticStatus?.state).toBe('working')
  clock.mockReturnValue(NOW)
  const status = await h.client.statusAgent('stale')
  expect(status.observation).toMatchObject({ process: 'running', semantic: 'unknown', readiness: 'ready', stale: true })
  expect(status.session.semanticStatus).toMatchObject({ state: 'working', observedAt: NOW - 25 * 60_000 })
  expect(status.session.run.runId).toBe(h.run.runId); expect(h.requests).toEqual([h.run.runId])
})
it('accepted current working, Stop completion and static waiting keep distinct public meanings', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const h = await open('confirmed')
  await h.hook('UserPromptSubmit', 'confirmed-working')
  expect((await h.client.statusAgent('confirmed')).observation.semantic).toBe('active')
  clock.mockReturnValue(NOW + 1); await h.hook('Stop', 'confirmed-done')
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
  const working = await activityCertaintyClient('scene-working', 'codex', { workspacePath: bare.directory }); opened.push(working)
  const idle = await activityCertaintyClient('scene-idle', 'codex', { workspacePath: bare.directory }); opened.push(idle)
  clock.mockReturnValue(SCENE_NOW - 25 * 60_000); await stale.hook('session_start', 'scene-stale-observation', { eventName: 'session_start' })
  clock.mockReturnValue(SCENE_NOW); await working.hook('UserPromptSubmit', 'scene-working-observation'); await idle.hook('Stop', 'scene-idle-observation')
  const rows = await Promise.all([bare, stale, working, idle].map(item => item.client.statusAgent(item === bare ? 'scene-bare'
    : item === stale ? 'scene-stale' : item === working ? 'scene-working' : 'scene-idle')))
  expect(rows.map(row => row.observation.semantic)).toEqual(['unknown', 'unknown', 'active', 'idle'])
  expect(new Set(rows.map(row => row.session.agentSessionId)).size).toBe(4)
  expect(rows.every(row => row.session.workspacePath === bare.directory && row.run.state === 'running')).toBe(true)
  const path = process.env.AGENTMUX_ACTIVITY_CERTAINTY_SCENE_SEED
  if (path) {
    const inputs = Object.fromEntries(await Promise.all(['agent-status-freshness.ts', 'client.ts', 'agent-session-store.ts', 'providers/grok.ts', 'providers/codex.ts'].map(async name =>
      ['packages/core/src/' + name, createHash('sha256').update(await readFile(new URL('../src/' + name, import.meta.url))).digest('hex')])))
    await writeFile(path, JSON.stringify({ schema: 'agentmux.activity-certainty-public-scene-seed.v1', inputs, rows,
      observerNow: SCENE_NOW, boundary: 'Actual public Client/private FileStore and accepted Hooks; isolated fixed Run transport, not Native Writer or physical Run proof.' }, null, 2) + '\n')
  }
})
