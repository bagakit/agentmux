import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import { parseAgentInputSubmissionReceipt } from '../src/agent-input-receipt-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

type Observation = { type: 'ready'; pid: number; nativePid: number; nativeAlive: boolean; endpoint: string;
  runtimeWrites: number; input: AgentInputSubmissionReceipt; inspection: { home: string; profile: string } | null;
  nativeHome: string; specEnv: Record<string, string> }
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

it.runIf(['darwin', 'linux'].includes(process.platform))('compiled original input waiting consumes the original PID environment through the actual adapter and native reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-initialization-process-'))
  closes.push(() => rm(root, { recursive: true, force: true }))
  const compiled = process.env.AMX_SESSION_STATE_COMPILED ?? resolve(import.meta.dirname, '../dist')
  const child = fork(resolve(import.meta.dirname, 'fixtures/provider-initialization-process-owner.mjs'), [root, compiled], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: objectCliEnvironment(root, {
      HOME: root, GROK_HOME: join(root, 'observer-wrong'), DAEMON_NATIVE_PROFILE: 'observer-wrong',
      AMX_SESSION_STATE_COMPILED_MUTATION: process.env.AMX_SESSION_STATE_COMPILED_MUTATION ?? '',
      AMX_SESSION_STATE_COMPILED_LOADED: process.env.AMX_SESSION_STATE_COMPILED_LOADED ?? ''
    })
  })
  let stderr = ''
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', text => { stderr += text })
  const exited = new Promise<number | null>(done => child.once('exit', done))
  closes.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.send({ type: 'close' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    try { expect(await exited, stderr).toBe(0) } finally { clearTimeout(timer) }
  })
  const observed = await new Promise<Observation>((done, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private compiled initialization owner did not reply: ' + stderr)) }, 20000)
    child.once('message', message => { clearTimeout(timer); done(message as Observation) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Private initialization owner exited (' + code + '): ' + stderr)) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
  expect(observed.type).toBe('ready'); expect(observed.pid).toBe(child.pid)
  expect(observed.nativePid).toBeGreaterThan(0); expect(observed.nativeAlive).toBe(true); expect(observed.runtimeWrites).toBe(0)
  expect(observed.specEnv).toEqual({ HOME: root })
  expect(observed.input).toMatchObject({ status: 'waiting', admission: null, control: { waiting: {
    phase: 'session', reason: 'native-session-starting', initialization: { state: 'pending', reason: 'directory-trust',
      source: 'native-protocol', scope: 'prerequisite', providerId: 'grok', run: { runId: 'initialization-run-original' } }
  } } })
  expect(observed.inspection).toEqual({ home: observed.nativeHome, profile: 'original-extra' })
  expect(parseAgentInputSubmissionReceipt(JSON.parse(JSON.stringify(observed.input)))).toEqual(observed.input)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + observed.endpoint, 'agent', 'input', 'inspect', '--input', '-'],
    objectCliEnvironment(root), JSON.stringify({ key: observed.input.key }))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.input).toMatchObject({ key: observed.input.key, control: observed.input.control, status: 'waiting' })
})
