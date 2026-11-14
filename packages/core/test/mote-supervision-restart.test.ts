import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { createMoteWorkThreadFixture, openMoteWorkThread } from './helpers/mote-work-thread.js'

// Preserve the original native File artifact before the Runtime fixture isolates its environment.
const originalFileHelper = process.env.AGENTMUX_WORKSPACE_MOVE_HELPER
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function readInProcess(f: Awaited<ReturnType<typeof createMoteWorkThreadFixture>>, messageId: string, ordinal: string) {
  const trace = join(f.root, 'restart-' + ordinal + '.ndjson')
  const child = spawn(process.execPath, ['--loader', fileURLToPath(new URL('./fixtures/mote-supervision-restart-loader.mjs', import.meta.url)),
    fileURLToPath(new URL('./fixtures/mote-supervision-restart.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(originalFileHelper ? { AGENTMUX_WORKSPACE_MOVE_HELPER: originalFileHelper } : {}), MOTE_RESTART_SOURCE_TRACE: trace } })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
    child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal }))
  })
  closes.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exit
  })
  child.stdin.end(JSON.stringify({ root: f.root, target: f.target, motePath: f.motePath, messageId }))
  expect(await exit, stderr).toEqual({ code: 0, signal: null })
  const owner = JSON.parse((await readFile(trace, 'utf8')).trim())
  if (process.env.MOTE_RESTART_LOADED) await appendFile(process.env.MOTE_RESTART_LOADED, JSON.stringify({ pid: child.pid, ...owner }) + '\n')
  expect(owner.path).toBe('apps/host/src/mote-dialogue.ts')
  expect(owner.originalSHA256).toBe(createHash('sha256').update(await readFile(new URL('../../../apps/host/src/mote-dialogue.ts', import.meta.url))).digest('hex'))
  return { ...JSON.parse(stdout), owner }
}

it('fresh read processes retain original Mote work, Main, Sessions and layout without replay after an unknown source read', async () => {
  const f = await createMoteWorkThreadFixture(); closes.push(f.close)
  const work = await openMoteWorkThread(f)
  expect(work.page.links).toHaveLength(1)
  const expected = {
    main: await f.main.readCurrentMoteMain(f.target), spatial: await f.spatial.readForLayout(),
    sessions: [...await new AgentMuxFileAgentSessionStore(join(f.root, 'sessions.json')).loadMetadata()]
      .sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId))
  }
  const counts = { launches: f.launches.length, native: f.writes.length,
    input: (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length }
  const first = await readInProcess(f, work.messageId, 'first')
  const second = await readInProcess(f, work.messageId, 'second')
  expect(first.pid).not.toBe(process.pid); expect(second.pid).not.toBe(process.pid); expect(second.pid).not.toBe(first.pid)
  for (const result of [first, second]) {
    expect(result.normal.main).toEqual(expected.main)
    expect(result.normal.links).toEqual(work.page.links)
    expect(result.normal.observations).toMatchObject([{ sequence: work.page.links[0]!.sequence,
      communication: { events: [{ kind: 'worker_done', replyMessageId: 'first-work-result' }], replyMessageIds: ['first-work-result'] }, issue: null }])
    expect(result.unknown.main).toEqual(result.normal.main)
    expect(result.unknown.links).toEqual(result.normal.links)
    expect(result.unknown.observations).toEqual([{ sequence: work.page.links[0]!.sequence,
      communication: null, issue: expect.stringContaining('exact message Host owner is unavailable') }])
    expect(result.recovered).toEqual(result.normal)
    expect(result.dispatch.dispatch).toEqual(work.observation.dispatch)
    expect(result.dispatch.source.envelope).toEqual(work.source!.envelope)
    expect(result.dispatch.source.promptCondition).toEqual(work.source!.promptCondition)
    expect(result.dispatch.replies).toEqual(work.observation.replies)
    expect(result.spatial).toEqual(expected.spatial)
    expect(result.sessions).toEqual(expected.sessions)
    expect(Object.keys(result.files)).toHaveLength(7)
  }
  expect(second.files).toEqual(first.files)
  expect(f.launches).toHaveLength(counts.launches); expect(f.launches).toHaveLength(1)
  expect(f.writes).toHaveLength(counts.native)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(counts.input)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(await f.client.readMessage({ messageId: work.messageId })).toEqual(work.source)
}, 45_000)
