import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { hostedTestOwner } from './hosted-runtime-port.js'
import type { AgentMuxAgentSession, AgentProviderNativeSessionDiscoveryContext } from '../../src/types.js'

export const cleanups: Array<() => Promise<void>> = []
export async function cleanupExecutableNativeFixtures() { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs() }
export async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let value!: T
  await vi.waitFor(async () => { value = await read(); expect(accept(value)).toBe(true) }, { timeout: 10_000 })
  return value
}
async function end(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done }
}
export async function executableNativeFixture(shape: 'configured-path' | 'workspace-relative') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'exctx-'))), runtime = join(root, 'r'), state = join(root, 's')
  await Promise.all([mkdir(runtime), mkdir(state), mkdir(join(root, 'bin')), mkdir(join(root, 'receipts'))])
  const daemon = spawn(resolve(import.meta.dirname, '../../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
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

