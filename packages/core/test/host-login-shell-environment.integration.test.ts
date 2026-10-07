import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { fixtureDisplayPath } from './helpers/fixture-values.js'

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
}

/** Compile the production entry and give it its own original Store and Native process. */
async function withHost(mode: 'profile' | 'failed', check: (fixture: {
  client: Awaited<ReturnType<typeof connectHostedAgentMux>>
  root: string
  executables: readonly string[]
  nativePid: number
  stderr(): string
  restartHost(): Promise<Awaited<ReturnType<typeof connectHostedAgentMux>>>
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(fixtureDisplayPath('private/tmp/amx-host-env-'))
  const home = join(root, 'home'), runtime = join(root, 'runtime'), state = join(root, 'state')
  const bin = join(root, 'profile tools', 'bin')
  const executables = ['fixture-runner', 'fixture runner with spaces']
  let daemon: ChildProcess | undefined, host: ChildProcess | undefined
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  let client: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  try {
    await Promise.all([mkdir(home), mkdir(runtime, { mode: 0o700 }), mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 }), mkdir(bin, { recursive: true })])
    for (const executable of executables) {
      const path = join(bin, executable)
      await writeFile(path, '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_SHELL_VALUE"\nif [ "$1" = "--wait" ]; then\n  while IFS= read -r input; do printf "continued:%s\\n" "$input"; done\nfi\n')
      await chmod(path, 0o755)
    }
    // Only the interactive profile contributes these commands. Neither the parent process
    // nor the Native daemon has them in PATH, so a probe in the wrong owner fails.
    await writeFile(join(home, '.zprofile'), 'export FIXTURE_LOGIN_VALUE=login\n')
    await writeFile(join(home, '.zshrc'), `export PATH='${bin}:/usr/bin:/bin'\nexport FIXTURE_SHELL_VALUE=interactive-profile\n`)
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
      HOME: home, ZDOTDIR: home, SHELL: mode === 'profile' ? '/bin/zsh' : join(root, 'absent-shell'),
      PATH: mode === 'profile' ? '/usr/bin:/bin' : `${bin}:/usr/bin:/bin`,
      FIXTURE_SHELL_VALUE: 'inherited-environment',
      AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'),
      AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
      AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'),
      AGENTMUX_MOBILE_BUILD_DIRECTORY: join(root, 'absent-mobile-assets')
    }
    const artifact = resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd')
    daemon = spawn(artifact, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
      { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let daemonErrors = ''
    daemon.stderr!.on('data', data => { daemonErrors += String(data) })
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => no(new Error(`Private Native readiness failed: ${daemonErrors}`)), 10_000)
      daemon!.stdio[3]!.once('data', () => { clearTimeout(timer); yes() })
      daemon!.once('error', error => { clearTimeout(timer); no(error) })
      daemon!.once('exit', code => { clearTimeout(timer); no(new Error(`Private Native exited ${code}: ${daemonErrors}`)) })
    })
    await symlink(resolve(import.meta.dirname, '../../../apps/host/node_modules'), join(root, 'node_modules'), 'dir')
    const entry = join(root, 'host.mjs')
    await build({ entryPoints: [resolve(import.meta.dirname, '../../../apps/host/src/index.ts')], outfile: entry,
      bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' })
    let stderr = ''
    const startHost = async () => {
      // Reuse the same restricted inherited environment on every OS process launch.
      host = spawn(process.execPath, [entry, '--store', env.AGENTMUX_AGENT_SESSION_STORE!], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      host.stdout!.on('data', data => { stdout += String(data) })
      host.stderr!.on('data', data => { stderr += String(data) })
      await vi.waitFor(() => {
        expect(host!.exitCode, stderr).toBeNull()
        expect(stdout, stderr).toContain('\n')
      }, { timeout: 10_000 })
      const published = JSON.parse(stdout.split('\n')[0]!)
      expect(published).toMatchObject({ pid: host.pid, owner: { processId: host.pid } })
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtime, 'control.sock') } })
      client = await connectHostedAgentMux({ rpc })
      await client.connect()
      return client
    }
    const restartHost = async () => {
      const daemonPid = daemon!.pid
      await client?.dispose()
      await rpc?.dispose()
      await stop(host)
      expect(host!.exitCode).toBe(0)
      expect(daemon!.exitCode).toBeNull()
      const restarted = await startHost()
      expect(daemon!.pid).toBe(daemonPid)
      expect(daemon!.exitCode).toBeNull()
      return restarted
    }
    await check({ client: await startHost(), root, executables, nativePid: daemon.pid!, stderr: () => stderr, restartHost })
  } finally {
    await client?.dispose()
    await rpc?.dispose()
    await stop(host)
    await stop(daemon)
    await rm(root, { recursive: true, force: true })
  }
}

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('production Host login shell environment', () => {
  it('loads interactive PATH before public probes and keeps the original Run across a real Host restart', async () => {
    await withHost('profile', async ({ client, root, executables, nativePid, stderr, restartHost }) => {
      const catalog = client.catalog()
      expect(catalog.length).toBeGreaterThan(0)
      const providerId = catalog[0]!.id
      expect(executables).toHaveLength(2)
      for (const executable of executables) {
        expect(await client.probeExecutorAvailability(providerId, executable)).toEqual({ executable, availability: 'available' })
        expect(await client.probeAgent(providerId, executable)).toMatchObject({ executable, installed: true })
        const run = await client.createTerminal({ workspacePath: root, command: executable, args: [] })
        await vi.waitFor(async () => {
          const replay = await client.readRunReplay({ runId: run.runId }, 0, 'raw')
          expect(Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toContain('interactive-profile')
        })
        await client.removeTerminal({ runId: run.runId })
      }
      const originalOwner = client.runtimeOwnerIdentity()!
      const originalNative = client.runtimeIdentity()
      const retained = await client.createTerminal({ workspacePath: root, command: executables[0]!, args: ['--wait'] })
      await vi.waitFor(async () => {
        const replay = await client.readRunReplay({ runId: retained.runId }, 0, 'raw')
        expect(replay.run).toMatchObject({ runId: retained.runId, pid: retained.pid, state: 'running' })
        expect(Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toContain('interactive-profile')
      })
      const restarted = await restartHost()
      const replacementOwner = restarted.runtimeOwnerIdentity()!
      expect(replacementOwner.runtimeId).toBe(originalOwner.runtimeId)
      expect(replacementOwner.ownerInstanceId).not.toBe(originalOwner.ownerInstanceId)
      expect(replacementOwner.processId).not.toBe(originalOwner.processId)
      expect(restarted.runtimeIdentity()).toEqual(originalNative)
      expect((await restarted.listRuns()).filter(run => run.runId === retained.runId))
        .toMatchObject([{ runId: retained.runId, pid: retained.pid, state: 'running' }])
      const restored = await restarted.readRunReplay({ runId: retained.runId }, 0, 'raw')
      expect(restored.run).toMatchObject({ runId: retained.runId, pid: retained.pid, state: 'running' })
      expect(Buffer.concat(restored.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toContain('interactive-profile')
      for (const executable of executables) {
        expect(await restarted.probeExecutorAvailability(providerId, executable)).toEqual({ executable, availability: 'available' })
      }
      const attached = await restarted.attachTerminal(retained.runId, 0, 'raw')
      const ack = await restarted.writeTerminal({ runId: retained.runId }, {
        ownerInstanceId: restarted.runtimeIdentity().instanceId, operationId: 'continue-retained-host-environment-run',
        expectedByte: attached.run.acceptedInputBytes!, data: 'after-host-restart\n'
      })
      expect(ack).toMatchObject({ runId: retained.runId, acceptedThroughByte: attached.run.acceptedInputBytes! + 19 })
      await vi.waitFor(async () => {
        const replay = await restarted.readRunReplay({ runId: retained.runId }, 0, 'raw')
        expect(replay.run).toMatchObject({ runId: retained.runId, pid: retained.pid, state: 'running' })
        expect(Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toContain('continued:after-host-restart')
      })
      console.info(JSON.stringify({ schema: 'agentmux.host-environment-owner-restart.v1',
        firstHostPid: originalOwner.processId, secondHostPid: replacementOwner.processId,
        firstOwnerInstanceId: originalOwner.ownerInstanceId, secondOwnerInstanceId: replacementOwner.ownerInstanceId,
        originalRunId: retained.runId, originalRunPid: retained.pid, nativeDaemonPid: nativePid, native: originalNative,
        originalOutputRetained: true, sameRunAcceptedNewInput: true, probesAfterRestart: executables }))
      expect(stderr()).not.toContain('Shell environment loading did not complete')
    })
  }, 20_000)

  it('keeps inherited executable access and reports a failed shell read without blocking the Host', async () => {
    await withHost('failed', async ({ client, root, executables, stderr }) => {
      expect(stderr()).toContain('Shell environment loading did not complete')
      const catalog = client.catalog()
      expect(catalog.length).toBeGreaterThan(0)
      const executable = executables[0]!
      expect(await client.probeExecutorAvailability(catalog[0]!.id, executable)).toEqual({ executable, availability: 'available' })
      const run = await client.createTerminal({ workspacePath: root, command: executable, args: [] })
      await vi.waitFor(async () => {
        const replay = await client.readRunReplay({ runId: run.runId }, 0, 'raw')
        expect(Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toContain('inherited-environment')
      })
      await client.removeTerminal({ runId: run.runId })
      // An unrelated successful probe does not erase the process owner's diagnostic.
      expect(stderr()).toContain('New Agents and terminals use the inherited application environment')
    })
  }, 20_000)
})
