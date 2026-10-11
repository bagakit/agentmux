import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, terminalEnvironment } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { classifyExecutable } from '../src/executable-probe.js'
import type { AgentMuxAgentSession, AgentProviderNativeSessionDiscoveryContext } from '../src/types.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs() })
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let value!: T
  await vi.waitFor(async () => { value = await read(); expect(accept(value)).toBe(true) }, { timeout: 10_000 })
  return value
}
async function end(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done }
}
async function fixture(shape: 'configured-path' | 'workspace-relative') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'exctx-'))), runtime = join(root, 'r'), state = join(root, 's')
  await Promise.all([mkdir(runtime), mkdir(state), mkdir(join(root, 'bin')), mkdir(join(root, 'receipts'))])
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  cleanups.push(async () => { await end(daemon); await rm(root, { recursive: true, force: true }) })
  await new Promise<void>((yes, no) => {
    const timer = setTimeout(() => no(new Error('Private Native readiness unavailable')), 15_000)
    daemon.stdio[3]!.once('data', () => { clearTimeout(timer); yes() })
    daemon.once('error', error => { clearTimeout(timer); no(error) })
    daemon.once('exit', code => { clearTimeout(timer); no(new Error('Private Native exited ' + code)) })
  })
  for (const key of Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_'))) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const executable = join(root, 'bin', 'context-runner')
  await writeFile(executable, `#!${process.execPath}
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
writeFileSync(join(process.env.CONTEXT_RECEIPTS, process.pid + '.json'), JSON.stringify({
  pid:process.pid, cwd:process.cwd(), args:process.argv.slice(2), marker:process.env.CONTEXT_MARKER,
  sid:process.env.AGENTMUX_AGENT_SESSION_ID, nativeId:'native-' + process.env.AGENTMUX_AGENT_SESSION_ID
}))
setInterval(()=>{},1000)
`)
  await chmod(executable, 0o755)
  const command = shape === 'configured-path' ? 'context-runner' : './bin/context-runner'
  const env = { PATH: join(root, 'bin'), CONTEXT_RECEIPTS: join(root, 'receipts'), CONTEXT_MARKER: shape }
  const { planManagedHooks: _hooks, inspectHookActivation: _activation, terminalPromptRender: _render, discoverNativeSession: _discover, observeSessionStatus: _status, ...base } = new AgentProviderRegistry().get('claude')
  const provider = { ...base, catalog: { ...base.catalog, hookStrategy: { kind: 'none' as const } },
    async discoverNativeSession(context: AgentProviderNativeSessionDiscoveryContext) {
      const path = join(root, 'receipts', context.processId + '.json')
      let value: { pid: number; nativeId: string }
      try { value = JSON.parse(await readFile(path, 'utf8')) } catch { return null }
      if (value.pid !== context.processId) return null
      const assertCurrent = async () => { process.kill(value.pid, 0); expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject(value) }
      return { handle: { kind: 'provider' as const, providerId: base.id, sessionId: value.nativeId }, assertCurrent }
    }
  }
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), providers: [provider] })
  cleanups.unshift(async () => {
    try { for (const session of client.agentSessions()) if ((await client.statusAgent(session.agentSessionId)).run.state === 'running') await client.stopAgent(session.agentSessionId, session.run) }
    finally { await client.dispose() }
  })
  await client.connect()
  async function receipt(session: AgentMuxAgentSession) {
    const status = await client.statusAgent(session.agentSessionId)
    return await until(async () => { try { return JSON.parse(await readFile(join(root, 'receipts', status.run.pid + '.json'), 'utf8')) } catch { return null } }, Boolean) as {
      pid: number; cwd: string; args: string[]; marker: string; sid: string; nativeId: string
    }
  }
  async function exit(session: AgentMuxAgentSession) {
    const status = await client.statusAgent(session.agentSessionId); process.kill(status.run.pid!, 'SIGTERM')
    await until(() => client.statusAgent(session.agentSessionId), value => value.run.state === 'exited')
  }
  async function hosted() {
    const service = new AgentMuxHostedRuntimeService(client, null, () => hostedTestOwner(client))
    const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => service }, join(root, 'p.sock'))
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const value = await connectHostedAgentMux({ rpc })
    cleanups.unshift(async () => { await value.dispose(); await rpc.dispose(); await server.stop(); await service.dispose() })
    return value
  }
  return { root, client, executable, command, env, receipt, exit, hosted }
}

describe('the executable owner uses the actual invocation context', () => {
  it.each(['configured-path', 'workspace-relative'] as const)('%s reaches real Native create, direct resume and continuity', async shape => {
    const f = await fixture(shape), caller = await f.hosted(), originalPath = process.env.PATH, originalCwd = process.cwd()
    expect(await caller.probeExecutorAvailability('claude', f.command, { workspacePath: f.root, env: terminalEnvironment(f.env) })).toMatchObject({ availability: 'available' })
    const created = await caller.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: f.command, env: f.env, injectAgentMuxGuide: false, prompt: 'original task' })
    const first = await f.receipt(created)
    expect(first).toMatchObject({ cwd: f.root, marker: shape, sid: created.agentSessionId })
    expect(first.args).toContain('original task')
    await until(() => f.client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle))
    await f.exit(created)
    const pendingResume = caller.resumeAgent({ agentSessionId: created.agentSessionId, operationId: 'context-direct-resume',
      prompt: 'resume task', commandOverride: f.command, env: f.env })
    await expect(pendingResume).resolves.toMatchObject({ agentSessionId: created.agentSessionId })
    const resumed = await pendingResume
    const second = await f.receipt(resumed)
    expect(second).toMatchObject({ cwd: f.root, marker: shape, sid: created.agentSessionId })
    expect(second.pid).not.toBe(first.pid); expect(second.args).toContain('--resume'); expect(second.args).toContain(first.nativeId); expect(second.args).toContain('resume task')
    await f.exit(resumed)
    const continuity = await caller.ensureAgentContinuity({ agentSessionId: created.agentSessionId, expectedRun: resumed.run,
      operationId: 'context-continuity', commandOverride: f.command, env: f.env, trigger: 'manual' })
    expect(continuity.kind).toBe('resumed')
    const third = await f.receipt(f.client.agentSession(created.agentSessionId))
    expect(third).toMatchObject({ cwd: f.root, marker: shape, sid: created.agentSessionId })
    expect(third.pid).not.toBe(second.pid); expect(third.args).toContain(first.nativeId)
    expect(process.env.PATH).toBe(originalPath); expect(process.cwd()).toBe(originalCwd)
  }, 45_000)
  it('checks the Provider plan command and environment instead of the pre-plan request', async () => {
    const f = await fixture('configured-path'), provider = f.client.providers.get('claude')
    const launch = provider.buildLaunch.bind(provider), resume = provider.buildResumeLaunch.bind(provider)
    provider.buildLaunch = input => ({ ...launch(input), command: f.command, env: f.env })
    provider.buildResumeLaunch = input => ({ ...resume(input), command: f.command, env: f.env })
    const created = await f.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: 'pre-plan-command', env: { PATH: '' }, injectAgentMuxGuide: false, prompt: 'actual plan task' })
    expect((await f.receipt(created)).marker).toBe('configured-path')
    await until(() => f.client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle))
    await f.exit(created)
    const resumed = await f.client.resumeAgent({ agentSessionId: created.agentSessionId, operationId: 'provider-plan-resume',
      prompt: 'actual resume plan', commandOverride: 'pre-plan-command', env: { PATH: '' } })
    expect((await f.receipt(resumed)).args).toContain('actual resume plan')
    await f.exit(resumed)
    const continuity = await f.client.ensureAgentContinuity({ agentSessionId: created.agentSessionId, expectedRun: resumed.run,
      operationId: 'provider-plan-continuity', commandOverride: 'pre-plan-command', env: { PATH: '' }, trigger: 'manual' })
    expect(continuity.kind).toBe('resumed')
    expect((await f.receipt(f.client.agentSession(created.agentSessionId))).marker).toBe('configured-path')
  }, 30_000)
  it('keeps missing, uncertain workspace, directories and unavailable observations distinct', async () => {
    const f = await fixture('configured-path')
    await expect(f.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: f.root,
      commandOverride: './absent', env: f.env, injectAgentMuxGuide: false })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
    expect(f.client.agentSessions()).toEqual([])
    expect(await f.client.probeExecutorAvailability('claude', './bin/context-runner', { env: f.env })).toMatchObject({
      availability: 'check-failed', cause: { code: 'EXECUTABLE_WORKSPACE_REQUIRED' } })
    expect(await classifyExecutable(dirname(f.executable), { workspacePath: f.root, env: f.env })).toMatchObject({
      availability: 'missing', cause: { code: 'EXECUTABLE_NOT_FILE' } })
    await chmod(f.executable, 0o644)
    expect(await classifyExecutable(f.executable, { workspacePath: f.root, env: f.env })).toMatchObject({
      availability: 'check-failed', cause: { code: 'EACCES' } })
  }, 30_000)
})
