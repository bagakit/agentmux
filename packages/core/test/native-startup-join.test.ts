import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, copyFile, chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'
import { observeCodexTerminalFrontend, reconnectCodexTerminalFrontend, CODEX_NATIVE_TOKEN_ENV,
  CODEX_ACTOR_ID_ENV, CODEX_ACTOR_LIFECYCLE_ENV } from '../src/providers/codex-managed-frontend.js'
import { nativeProcessTcpListeners } from '../src/agent-native-process.js'
import type { AgentTerminalFrontendObservation } from '../src/agent-terminal-frontend.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const nativeId = '00000000-0000-4000-8000-000000000041'
const rows = async (path: string): Promise<any[]> => (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

async function fixture(options: { delay?: boolean; wrongRuntime?: boolean; wrongJoinedRuntime?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'amux-native-startup-join-')))
  const executable = join(directory, 'native.cjs'), calls = join(directory, 'calls.jsonl'), events = join(directory, 'tui.jsonl')
  const commands = join(directory, 'commands.jsonl'), input = join(directory, 'input.jsonl'), gate = join(directory, 'join-gate')
  await copyFile(new URL('./fixtures/native-startup-join.cjs', import.meta.url), executable); await chmod(executable, 0o700)
  if (options.delay) await writeFile(gate, 'hold original join response')
  if (options.wrongRuntime) await writeFile(join(directory, 'wrong-runtime'), 'different loaded runtime')
  if (options.wrongJoinedRuntime) await writeFile(join(directory, 'wrong-joined-runtime'), 'different joined runtime')
  const token = randomBytes(32).toString('hex')
  const child = spawn(process.execPath, [process.env.AGENTMUX_STARTUP_JOIN_WORKER!, JSON.stringify({ command: executable,
    serverConfig: [], frontendArgs: ['--no-alt-screen'], create: { cwd: directory, model: 'original-model', approvalPolicy: 'never', sandbox: 'read-only' } })],
  { cwd: directory, detached: true, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    AGENTMUX_STARTUP_FIXTURE_DIRECTORY: directory, AGENTMUX_TEST_WS_MODULE: createRequire(import.meta.url).resolve('ws'),
    [CODEX_NATIVE_TOKEN_ENV]: token, [CODEX_ACTOR_ID_ENV]: 'original-actor', [CODEX_ACTOR_LIFECYCLE_ENV]: 'original-lifecycle' }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume(); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
  let ended = false; const end = new Promise<void>(resolve => child.once('close', () => { ended = true; resolve() }))
  const stop = async () => { if (!ended) { child.kill('SIGTERM'); const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 1500)
    try { await end } finally { clearTimeout(timer) } } }
  cleanup.push(async () => { await stop(); await rm(directory, { recursive: true, force: true }) })
  const context = { processId: child.pid!, workspacePath: directory, signal: new AbortController().signal,
    nativeActor: { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token,
      frontendControl: true as const, initializationControl: true as const, launch: { command: executable, args: [] } }, assertCurrent: async () => {} }
  let latest: AgentTerminalFrontendObservation | undefined, observer: Awaited<ReturnType<typeof observeCodexTerminalFrontend>> | undefined
  await expect.poll(async () => { try { observer = await observeCodexTerminalFrontend({ ...context, onFrontend: value => { latest = value }, onUnavailable() {} }); return true } catch { return false } }, { timeout: 5000 }).toBe(true)
  cleanup.push(async () => observer?.dispose())
  const wait = async (check: (value: AgentTerminalFrontendObservation) => boolean) => {
    try { await expect.poll(() => latest !== undefined && check(latest), { timeout: 5000 }).toBe(true) }
    catch { expect(latest !== undefined && check(latest), JSON.stringify({ latest, calls: await rows(calls), stderr })).toBe(true) }
    return latest!
  }
  const notify = (value: object) => appendFile(commands, JSON.stringify(value) + '\n')
  const request = async (method: string, params: object) => {
    const listeners = await nativeProcessTcpListeners(child.pid!, new AbortController().signal)
    expect(listeners).toHaveLength(1)
    const ws = new WebSocket(listeners[0]!.endpoint, { headers: { Authorization: 'Bearer ' + token } }); await once(ws, 'open')
    try { const result = once(ws, 'message'); ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })); return JSON.parse(String((await result)[0])) }
    finally { ws.close() }
  }
  const check = () => reconnectCodexTerminalFrontend(context, { operationId: 'continue-original-startup', expectedFrontendId: latest!.frontendId,
    target: { kind: 'initialization', lifecycleOperationId: 'original-lifecycle' } })
  return { child, calls, events, input, gate, wait, notify, request, check, stop, current: () => latest! }
}

it.runIf(process.platform === 'darwin')('keeps ready native input independent of first frontend join and wakes from exact native turn progress', async () => {
  const f = await fixture(), original = await f.wait(value => value.initialization?.failure?.step === 'frontend')
  expect(original).toMatchObject({ state: 'starting', initialization: { phase: 'ready', native: { state: 'confirmed', sessionId: nativeId } } })
  expect(await rows(f.events)).toHaveLength(0)
  const before = (await rows(f.calls)).filter(row => row.method === 'thread/resume').length
  await f.notify({ method: 'turn/started', threadId: 'unrelated-thread' })
  await f.notify({ method: 'thread/started', materialized: false })
  await f.notify({ method: 'turn/completed', materialized: false })
  await expect.poll(async () => (await rows(f.calls)).filter(row => row.method === 'thread/resume').length).toBe(before + 1)
  expect(await rows(f.events), 'A notification cannot substitute for a successful same-object join').toHaveLength(0)
  const initial = { threadId: nativeId, input: [{ type: 'text', text: 'ORIGINAL_REAL_INPUT' }] }
  expect(await f.request('turn/start', initial)).toMatchObject({ result: { turn: { id: 'original-turn' } } })
  const attached = await f.wait(value => value.state === 'attached')
  expect(attached.frontendId).toBe(original.frontendId)
  expect(await rows(f.input)).toEqual([initial]); await expect.poll(async () => (await rows(f.events)).length).toBe(1)
  expect((await rows(f.events))[0].args.slice(4)).toEqual(['resume', nativeId, '--no-alt-screen'])
  const calls = await rows(f.calls)
  expect(calls.filter(row => row.method === 'thread/start')).toHaveLength(1)
  expect(calls.filter(row => row.method === 'thread/resume').every(row => JSON.stringify(row.params) === JSON.stringify({ threadId: nativeId, excludeTurns: true }))).toBe(true)
  expect(calls.find(row => row.method === 'thread/start').params).toMatchObject({ model: 'original-model', sandbox: 'read-only', approvalPolicy: 'never' })
})

it.runIf(process.platform === 'darwin')('does not dispatch a frontend for a different loaded native runtime identity', async () => {
  const f = await fixture({ wrongRuntime: true })
  await f.wait(value => value.initialization?.failure?.step === 'frontend')
  await f.notify({ method: 'turn/completed', materialized: true }); await f.check()
  expect(await rows(f.events)).toHaveLength(0)
  expect((await rows(f.calls)).filter(row => row.method === 'thread/resume')).toHaveLength(0)
})

it.runIf(process.platform === 'darwin')('refuses a changed runtime in the actual native join receipt while retaining original input', async () => {
  const f = await fixture({ wrongJoinedRuntime: true })
  await f.wait(value => value.initialization?.failure?.step === 'frontend')
  await f.request('turn/start', { threadId: nativeId, input: [{ type: 'text', text: 'ORIGINAL_REAL_INPUT' }] })
  expect((await f.check()).state).toBe('starting')
  expect(await rows(f.events)).toHaveLength(0)
  expect(await rows(f.input)).toHaveLength(1)
  expect((await rows(f.calls)).filter(row => row.method === 'thread/start')).toHaveLength(1)
})

it.runIf(process.platform === 'darwin')('retains one delayed join through observation deadlines and cancellation never dispatches its TUI', async () => {
  const f = await fixture({ delay: true })
  await expect.poll(async () => (await rows(f.calls)).filter(row => row.method === 'thread/resume').length, { timeout: 6000 }).toBe(1)
  expect((await f.check()).initialization?.phase).toBe('ready'); expect((await f.check()).state).toBe('starting')
  await f.notify({ method: 'turn/started', materialized: true }); await f.notify({ method: 'turn/completed', materialized: true })
  // The original bounded observation lets those actual notifications be handled
  // while their one original join response is still withheld.
  await f.check()
  expect((await rows(f.calls)).filter(row => row.method === 'thread/resume')).toHaveLength(1)
  await f.stop(); await rm(f.gate)
  expect(await rows(f.events)).toHaveLength(0)
  expect((await rows(f.calls)).filter(row => row.method === 'thread/start')).toHaveLength(1)
})

it.runIf(process.platform === 'darwin')('continues the original frontend join after reader transport closure without creating or inputting again', async () => {
  const f = await fixture(), original = await f.wait(value => value.initialization?.failure?.step === 'frontend')
  await f.notify({ close: true, materialized: true })
  await expect.poll(async () => { await f.check(); return f.current().state }, { timeout: 5000 }).toBe('attached')
  expect(f.current().frontendId).toBe(original.frontendId)
  expect((await rows(f.calls)).filter(row => row.method === 'thread/start')).toHaveLength(1)
  expect(await rows(f.input)).toHaveLength(0); await expect.poll(async () => (await rows(f.events)).length).toBe(1)
})
