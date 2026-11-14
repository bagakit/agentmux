import { afterEach, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import type { AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import type { AgentMuxAgentRuntimeStatus } from '../src/client-contract.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

type Owner = { type: 'ready'; pid: number; endpoint: string; runtimeWrites: number; status: AgentMuxAgentRuntimeStatus;
  input: AgentInputSubmissionReceipt; stored: AgentMuxStoredAgentSession }
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

async function owner(mode: 'create' | 'restore', root: string) {
  const worker = resolve(import.meta.dirname, 'fixtures/provider-session-state-owner.mjs')
  const compiled = process.env.AMX_SESSION_STATE_COMPILED ?? resolve(import.meta.dirname, '../dist')
  const env = objectCliEnvironment(root, { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, '.claude') })
  const child = fork(worker, [mode, root, compiled], { env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr?.setEncoding('utf8'); child.stderr?.on('data', chunk => { stderr += chunk })
  const exited = new Promise<number | null>(done => child.once('exit', done))
  const stop = async (target: ChildProcess = child) => {
    if (target.exitCode !== null || target.signalCode !== null) return
    target.send({ type: 'close' })
    const timeout = setTimeout(() => target.kill('SIGKILL'), 5000)
    try { expect(await exited, stderr).toBe(0) } finally { clearTimeout(timeout) }
  }
  closes.push(stop)
  const ready = await new Promise<Owner>((done, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private Core owner did not start: ' + stderr)) }, 20000)
    child.once('message', value => { clearTimeout(timeout); done(value as Owner) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Private Core owner exited before readiness (' + code + '): ' + stderr)) })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  expect(ready.type).toBe('ready'); expect(ready.pid).toBe(child.pid)
  expect(ready.runtimeWrites).toBe(0)
  return { child, ready, stop }
}

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'amx-session-state-'))
  closes.push(() => rm(root, { recursive: true, force: true }))
  return root
}

it('compiled public CLI consumes the original overall, main and child observations', async () => {
  const root = await directory(), first = await owner('create', root)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + first.ready.endpoint, 'agent', 'inspect', '--session', 'session-original'], objectCliEnvironment(root))
  expect(cli.code, cli.stderr).toBe(0)
  const value = JSON.parse(cli.stdout).result
  expect(value.status.observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'idle', nativeTurnId: 'main-turn-original' },
    subagentSessions: { run: { runId: 'run-original' }, nativeSessionId: 'native-main',
      sessions: [{ nativeAgentId: 'child-original', nativeTurnId: 'child-turn-original', state: 'working', phase: 'running' }] } })
  expect(parseRpcNativeResult('agent.inspect', value, { target: { kind: 'agent-session', agentSessionId: 'session-original' } })).toEqual(value)
})

it('a new owner process reads the original Session, Run, child clock and saved input without reseeding', async () => {
  const root = await directory(), first = await owner('create', root), before = first.ready
  expect(before.status.observation.semantic).toBe('active')
  expect(before.input).toMatchObject({ status: 'waiting', key: { submissionId: 'query-original' }, admission: null })
  await first.stop()
  const restored = await owner('restore', root), after = restored.ready
  expect(after.pid).not.toBe(before.pid)
  expect(after.stored.agentSessionId).toBe(before.stored.agentSessionId)
  expect(after.stored.run).toEqual(before.stored.run)
  expect(after.stored.nativeHandle).toEqual(before.stored.nativeHandle)
  expect(after.stored.nativeSubagents).toEqual(before.stored.nativeSubagents)
  expect(after.status.observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'idle',
    observedAt: before.status.observation.mainSession!.observedAt } })
  expect(after.status.session.currentActivity).toBeUndefined()
  expect(after.input.key).toEqual(before.input.key)
  expect(after.input.ref).toEqual(before.input.ref)
  expect(after.input.control).toEqual(before.input.control)
  expect(after.input.admission).toBeNull()
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + restored.ready.endpoint, 'agent', 'input', 'inspect', '--input', '-'], objectCliEnvironment(root), JSON.stringify({ key: before.input.key }))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.input).toMatchObject({ key: before.input.key, control: before.input.control, status: 'waiting' })
  expect(JSON.parse(cli.stdout).result.record).toBeNull()
})
