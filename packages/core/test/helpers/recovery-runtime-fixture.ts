import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fixturePath } from './fixture-values.js'
import { until } from './headless-runtime-fixture.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from '../../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../src/hosted-client.js'
import type { AgentMuxHostedClient, AgentMuxRuntimeOwnerIdentity } from '../../src/hosted-client-contract.js'

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(done => child.once('exit', () => done()))
  child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  const graceful = await Promise.race([exited.then(() => true), new Promise<false>(done => { timer = setTimeout(() => done(false), 5000) })])
  clearTimeout(timer)
  if (!graceful) { child.kill('SIGKILL'); await exited }
}

/** Owns every socket, state file and OS process used by this recovery proof. */
export async function recoveryRuntimeFixture(options: { nativeUnsupported?: boolean } = {}) {
  const root = await realpath(await mkdtemp(fixturePath('tmp/am-recovery-')))
  const runtime = join(root, 'r'), state = join(root, 's')
  await Promise.all([mkdir(runtime, { mode: 0o700 }), mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 }), mkdir(join(root, 'home'), { mode: 0o700 })])
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
    HOME: join(root, 'home'), AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
    AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'),
    ...(options.nativeUnsupported ? { AGENTMUX_RECOVERY_NATIVE_UNSUPPORTED: '1' } : {})
  }
  const clients: AgentMuxHostedClient[] = [], rpcs: AgentMuxRpcClient[] = [], children: ChildProcess[] = []
  const privateRuns = new Set<string>(), privateRunPids = new Set<number>()
  let owner: AgentMuxRuntimeOwnerIdentity, server: ChildProcess, socketPath = join(runtime, 'headless.sock')
  const cleanup = async () => {
    const errors: unknown[] = []
    const attempt = async (action: () => Promise<unknown>) => { try { await action() } catch (error) { errors.push(error) } }
    // Each finalizer is attempted even when another dispose or Stop fails.
    const latest = clients.at(-1)
    if (latest) await attempt(async () => {
      const runs = await latest.listRuns()
      for (const run of runs) {
        privateRuns.add(run.runId)
        if (run.pid) privateRunPids.add(run.pid)
        if (run.state === 'running') await attempt(() => latest.stopTerminal({ runId: run.runId }))
      }
    })
    for (const client of [...clients].reverse()) await attempt(() => client.dispose())
    for (const rpc of [...rpcs].reverse()) await attempt(() => rpc.dispose())
    for (const child of [...children].reverse()) await attempt(() => terminate(child))
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        return false
      }
    }
    for (const pid of privateRunPids) await attempt(async () => {
      if (!alive(pid)) return
      // Exact private PIDs were obtained from this fixture's public Run status.
      // A failed RPC finalizer still cannot leave that known private CLI behind.
      process.kill(pid, 'SIGKILL')
      await until(() => !alive(pid), value => value, 'exact private CLI cleanup', 5000)
      throw new Error(`Private CLI ${pid} required emergency cleanup after public Stop`)
    })
    await attempt(() => rm(root, { recursive: true, force: true }))
    const rootRemoved = await access(root).then(() => false, error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return true
    })
    console.log(JSON.stringify({ schema: 'agentmux.private-session-recovery-cleanup.v1', root, socketPath,
      childPids: children.map(child => child.pid), runIds: [...privateRuns], runPids: [...privateRunPids], rootRemoved,
      allPrivateProcessesGone: children.every(child => child.exitCode !== null || child.signalCode !== null) && [...privateRunPids].every(pid => !alive(pid)),
      errors: errors.length }))
    if (errors.length) throw new AggregateError(errors, 'Private recovery Runtime cleanup failed')
  }
  try {
    const daemon = spawn(resolve(import.meta.dirname, '../../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
      ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
      { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    children.push(daemon)
    let daemonErrors = ''; daemon.stderr!.on('data', value => { daemonErrors += String(value) })
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => no(new Error('Private ctxmux readiness timed out: ' + daemonErrors)), 30_000)
      daemon.stdio[3]!.once('data', () => { clearTimeout(timer); yes() })
      daemon.once('error', error => { clearTimeout(timer); no(error) })
      daemon.once('exit', code => { clearTimeout(timer); no(new Error(`Private ctxmux exited ${code}: ${daemonErrors}`)) })
    })
    const startOwner = async () => {
      server = spawn(process.execPath, [resolve(import.meta.dirname, '../fixtures/session-recovery-owner.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(server)
      let stdout = '', stderr = ''
      server.stdout!.on('data', value => { stdout += String(value) }); server.stderr!.on('data', value => { stderr += String(value) })
      await until(() => ({ stdout, code: server.exitCode }), value => {
        if (value.code !== null) throw new Error(`Private semantic owner exited ${value.code}: ${stderr}`)
        return value.stdout.includes('\n')
      }, 'private semantic owner receipt', 30_000)
      const published = JSON.parse(stdout.split('\n')[0]!) as { owner: AgentMuxRuntimeOwnerIdentity; socketPath: string }
      socketPath = published.socketPath
      const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); rpcs.push(rpc)
      owner = await until(async () => (await rpc.call('runtime.owner.identity', {})).owner,
        value => value.ctxmux !== null, 'private authoritative native owner')
      return owner
    }
    await startOwner()
    return { root, env, cleanup, get owner() { return owner }, get socketPath() { return socketPath },
      trackRun(runId: string, pid?: number | null) { privateRuns.add(runId); if (pid) privateRunPids.add(pid) },
      stopOwner: async () => { await terminate(server) },
      restartOwner: async () => { await terminate(server); return await startOwner() },
      async connect() {
        const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); rpcs.push(rpc)
        const client = await connectHostedAgentMux({ rpc, expectedRuntimeId: owner.runtimeId }); clients.push(client)
        return { client, rpc }
      }
    }
  } catch (error) {
    try { await cleanup() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Private recovery fixture failed') }
    throw error
  }
}
