import { fixturePath } from './fixture-values.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { connectHostedAgentMux } from '../../src/hosted-client.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from '../../src/public-rpc-client.js'
import type { AgentMuxHostedClient } from '../../src/hosted-client-contract.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../../src/hosted-client-contract.js'

export async function testRuntimeService() {
  return process.env.AGENTMUX_TEST_SERVICE_ENTRY
    ? await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_SERVICE_ENTRY).href) as typeof import('../../src/hosted-runtime-service.js')
    : await import('../../src/hosted-runtime-service.js')
}

export async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) { const value = await read(); if (accept(value)) return value
    if (Date.now() > deadline) throw new Error(`Private Runtime did not satisfy: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20)) }
}
async function receipt(child: ChildProcess): Promise<{ owner: AgentMuxRuntimeOwnerIdentity; socketPath: string }> {
  return await new Promise((resolve, reject) => {
    let output = '', errors = ''
    const timer = setTimeout(() => reject(new Error('Private Headless did not publish readiness: ' + errors)), 30_000)
    child.stderr!.on('data', data => { errors += String(data) })
    child.stdout!.on('data', data => { output += String(data); if (!output.includes('\n')) return
      clearTimeout(timer); try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))) } catch (error) { reject(error) } })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Private Headless exited ${code}: ${errors}`)) })
  })
}
export async function headlessFixture(options: { cli?: boolean; memoryStore?: boolean } = {}) {
  const root = await mkdtemp(fixturePath("tmp/amrr-"))
  const runtimeDirectory = join(root, 'r'), stateDirectory = join(root, 's')
  await Promise.all([mkdir(runtimeDirectory, { mode: 0o700 }), mkdir(join(stateDirectory, 'ctxmux'), { recursive: true, mode: 0o700 }), mkdir(join(root, 'home'), { mode: 0o700 })])
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
    HOME: join(root, 'home'), AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: stateDirectory,
    ...(options.memoryStore ? { AGENTMUX_TEST_MEMORY_STORE: '1' } : {}),
    AGENTMUX_AGENT_SESSION_STORE: join(stateDirectory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(stateDirectory, 'messages.ndjson') }
  const artifact = resolve(import.meta.dirname, '../../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd')
  let daemon = spawn(artifact, ['--socket', join(runtimeDirectory, 'ctxmux.sock'), '--state-dir', join(stateDirectory, 'ctxmux'), '--readiness-fd', '3'],
    { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonErrors = ''; daemon.stderr!.on('data', data => { daemonErrors += String(data) })
  try {
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => no(new Error(`Private official ctxmux readiness timed out: ${daemonErrors}`)), 30_000)
      daemon.stdio[3]!.once('data', () => { clearTimeout(timer); yes() }); daemon.once('error', error => { clearTimeout(timer); no(error) })
      daemon.once('exit', code => { clearTimeout(timer); no(new Error(`Private official ctxmux exited ${code}: ${daemonErrors}`)) })
    })
  } catch (error) {
    if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit') }
    await rm(root, { recursive: true, force: true }); throw error
  }
  const ownerEntry = options.cli ? resolve(import.meta.dirname, '../../dist/headless-runtime-cli.js')
    : process.env.AGENTMUX_TEST_OWNER_ENTRY ?? resolve(import.meta.dirname, '../fixtures/headless-runtime-worker.mjs')
  const ownerArgs = options.cli ? ['serve'] : []
  let server = spawn(process.execPath, [ownerEntry, ...ownerArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let current: Awaited<ReturnType<typeof receipt>>
  try { current = await receipt(server) }
  catch (error) {
    if (server.pid && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await once(server, 'exit') }
    if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit') }
    await rm(root, { recursive: true, force: true }); throw error
  }
  const clients: AgentMuxHostedClient[] = []
  const ownedRpc: AgentMuxRpcClient[] = []
  const client = async (providedRpc?: AgentMuxRpcClient) => {
    const connectHosted = process.env.AGENTMUX_TEST_CLIENT_ENTRY
      ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_CLIENT_ENTRY).href) as typeof import('../../src/hosted-client.js')).connectHostedAgentMux
      : connectHostedAgentMux
    const connectRpc = process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY
      ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY).href) as typeof import('../../src/public-rpc-client.js')).connectAgentMuxRpc
      : connectAgentMuxRpc
    const rpc = providedRpc ?? await connectRpc({ endpoint: { transport: 'unix', path: current.socketPath } })
    if (!providedRpc) ownedRpc.push(rpc)
    const client = await connectHosted({ rpc, expectedRuntimeId: current.owner.runtimeId,
      forwardRpc: async (method, params, context = {}) => await rpc.call(method, params, {
        ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}),
        ...(context.caller ? { credentials: context.caller } : {}), ...(context.signal ? { signal: context.signal } : {}) }) })
    clients.push(client); return client
  }
  const stopOwner = async () => {
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await once(server, 'exit') }
  }
  const restart = async () => {
    await stopOwner()
    server = spawn(process.execPath, [ownerEntry, ...ownerArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    current = await receipt(server); return current
  }
  const restartNativeDaemon = async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit') }
    daemonErrors = ''
    daemon = spawn(artifact, ['--socket', join(runtimeDirectory, 'ctxmux.sock'), '--state-dir', join(stateDirectory, 'ctxmux'), '--readiness-fd', '3'],
      { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    daemon.stderr!.on('data', data => { daemonErrors += String(data) })
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => no(new Error(`Private official ctxmux restart readiness timed out: ${daemonErrors}`)), 30_000)
      daemon.stdio[3]!.once('data', () => { clearTimeout(timer); yes() })
      daemon.once('error', error => { clearTimeout(timer); no(error) })
      daemon.once('exit', code => { clearTimeout(timer); no(new Error(`Private official ctxmux restart exited ${code}: ${daemonErrors}`)) })
    })
  }
  return { root, env, client, restart, restartNativeDaemon, stopOwner, failProbe: () => writeFile(join(stateDirectory, 'probe-failure'), 'failed'), get owner() { return current.owner }, get socketPath() { return current.socketPath },
    failInput: (failure: import('../../src/errors.js').AgentMuxControlFailure) => writeFile(join(stateDirectory, 'input-failure'), JSON.stringify(failure)),
    inputFailureCalls: async () => (await readFile(join(stateDirectory, 'input-failure-calls'), 'utf8')).trim().split('\n'),
    async cleanup() {
      for (const client of clients) await client.dispose()
      for (const rpc of ownedRpc) await rpc.dispose()
      if (server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await once(server, 'exit') }
      if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit') }
      await rm(root, { recursive: true, force: true })
    }
  }
}
