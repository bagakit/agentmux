import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentMuxSshRemoteDaemon,
  type AgentMuxRemoteArtifact,
  type AgentMuxRemoteInstallation,
  type AgentMuxRemotePlatform
} from '../src/ssh-remote-daemon.js'
import { runProcess, type ProcessRunner } from '../src/process-runner.js'
import {
  AgentMuxClient,
  type AgentMuxDaemonDataEvent,
  type AgentMuxDaemonEvent
} from '../src/daemon-client.js'
import {
  SshAgentMuxDaemonConnector,
  type AgentMuxSshSpawn,
  type AgentMuxSshTarget
} from '../src/ssh-daemon-connector.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const fakeSshPath = fileURLToPath(new URL('./fixtures/fake-system-ssh.mjs', import.meta.url))
const stubbornTreePath = fileURLToPath(new URL('./fixtures/stubborn-process-tree.mjs', import.meta.url))
const supportedPlatform = (
  (process.platform === 'darwin' || process.platform === 'linux') &&
  (process.arch === 'arm64' || process.arch === 'x64')
)

async function waitForCondition(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

function output(events: readonly AgentMuxDaemonEvent[]): string {
  return events
    .filter((event): event is AgentMuxDaemonDataEvent => event.type === 'data')
    .map((event) => event.data)
    .join('')
}

function latestSequence(events: readonly AgentMuxDaemonEvent[]): number {
  return events
    .filter((event): event is AgentMuxDaemonDataEvent => event.type === 'data')
    .at(-1)?.endSequence ?? 0
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

describe.runIf(supportedPlatform)('AgentMux isolated system SSH remote daemon', () => {
  let artifactRoot: string
  let artifact: AgentMuxRemoteArtifact
  let upgradeArtifact: AgentMuxRemoteArtifact
  let remoteHome: string
  let manager: AgentMuxSshRemoteDaemon
  let installation: AgentMuxRemoteInstallation | null
  let daemonPid = 0
  let sshSpawn: AgentMuxSshSpawn
  const clients: Array<{ disconnect(): void }> = []
  const spawned: Array<{ child: ChildProcessWithoutNullStreams; args: readonly string[] }> = []

  beforeAll(async () => {
    artifactRoot = await mkdtemp(join(tmpdir(), 'agentmux-remote-artifact-'))
    const staging = join(artifactRoot, 'staging')
    const deployedPackage = join(staging, 'package')
    await mkdir(staging, { recursive: true })
    await mkdir(deployedPackage, { recursive: true })
    const nodePtySource = resolve(repositoryRoot, 'packages/core/node_modules/node-pty')
    const nodePtyDestination = join(deployedPackage, 'node_modules/node-pty')
    await mkdir(nodePtyDestination, { recursive: true })
    await Promise.all([
      cp(resolve(repositoryRoot, 'packages/core/dist'), join(deployedPackage, 'dist'), { recursive: true }),
      cp(resolve(repositoryRoot, 'packages/core/bin'), join(deployedPackage, 'bin'), { recursive: true }),
      cp(resolve(repositoryRoot, 'packages/core/package.json'), join(deployedPackage, 'package.json')),
      cp(join(nodePtySource, 'package.json'), join(nodePtyDestination, 'package.json')),
      cp(join(nodePtySource, 'lib'), join(nodePtyDestination, 'lib'), { recursive: true }),
      cp(
        join(nodePtySource, 'prebuilds', `${process.platform}-${process.arch}`),
        join(nodePtyDestination, 'prebuilds', `${process.platform}-${process.arch}`),
        { recursive: true }
      )
    ])
    const platform = `${process.platform}-${process.arch}` as AgentMuxRemotePlatform
    await writeFile(join(staging, 'agentmux-artifact.json'), `${JSON.stringify({
      schema: 'agentmux.remote-artifact.v1',
      buildIdentity: 'fixture-build-1',
      platform,
      entrypoint: 'package/dist/agentmuxd.js'
    })}\n`, { mode: 0o600 })
    const archivePath = join(artifactRoot, 'agentmux-remote.tgz')
    await execFileAsync('tar', ['-czf', archivePath, '-C', staging, '.'], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    })
    artifact = { archivePath, buildIdentity: 'fixture-build-1', platform }
    await writeFile(join(staging, 'agentmux-artifact.json'), `${JSON.stringify({
      schema: 'agentmux.remote-artifact.v1',
      buildIdentity: 'fixture-build-2',
      platform,
      entrypoint: 'package/dist/agentmuxd.js'
    })}\n`, { mode: 0o600 })
    const upgradeArchivePath = join(artifactRoot, 'agentmux-remote-upgrade.tgz')
    await execFileAsync('tar', ['-czf', upgradeArchivePath, '-C', staging, '.'], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    })
    upgradeArtifact = {
      archivePath: upgradeArchivePath,
      buildIdentity: 'fixture-build-2',
      platform
    }
  }, 95_000)

  afterAll(async () => {
    await rm(artifactRoot, { recursive: true, force: true })
  })

  beforeEach(async () => {
    remoteHome = await mkdtemp(join(tmpdir(), 'agentmux-fake-remote-'))
    installation = null
    daemonPid = 0
    const environment = (delayOutput: boolean): NodeJS.ProcessEnv => ({
      ...process.env,
      AGENTMUX_FAKE_SSH_HOME: remoteHome,
      ...(delayOutput ? { AGENTMUX_FAKE_SSH_OUTPUT_DELAY_MS: '150' } : {})
    })
    const sshRunner: ProcessRunner = async (_command, args, options = {}) => await runProcess(
      process.execPath,
      [fakeSshPath, ...args],
      { ...options, env: { ...options.env, ...environment(false) } }
    )
    sshSpawn = (
      _command: string,
      args: readonly string[],
      options: SpawnOptionsWithoutStdio & { stdio: 'pipe' }
    ) => {
      const remoteCommand = args.at(-1) ?? ''
      const child = spawn(process.execPath, [fakeSshPath, ...args], {
        ...options,
        detached: true,
        env: environment(remoteCommand.includes(' connect '))
      })
      spawned.push({ child, args })
      return child
    }
    manager = new AgentMuxSshRemoteDaemon({
      target: sshTarget(),
      sshRunner,
      spawnProcess: sshSpawn
    })
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect()
    try {
      await unlink(join(remoteHome, '.agentmux-ssh-unavailable'))
    } catch {}
    if (installation) await manager.shutdown(installation).catch(() => {})
    if (daemonPid > 0 && processIsAlive(daemonPid)) {
      try {
        process.kill(daemonPid, 'SIGTERM')
      } catch {}
    }
    for (const { child } of spawned.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    await rm(remoteHome, { recursive: true, force: true })
  })

  async function installAndActivate(): Promise<AgentMuxRemoteInstallation> {
    installation = await manager.install(artifact)
    const hello = await manager.activate(installation)
    daemonPid = hello.daemonPid
    return installation
  }

  function latestTransport(): ChildProcessWithoutNullStreams {
    const transport = [...spawned].reverse().find(({ args }) => (args.at(-1) ?? '').includes(' connect '))
    if (!transport) throw new Error('No SSH transport process was spawned.')
    return transport.child
  }

  function sshTarget(): AgentMuxSshTarget {
    return {
      hostId: 'fixture-remote',
      hostname: 'fixture.example',
      identityFile: '/credentials/fixture key'
    }
  }

  function clientExpecting(
    current: AgentMuxRemoteInstallation,
    expected: { hostId: string; buildIdentity: string }
  ): AgentMuxClient {
    return new AgentMuxClient({
      connector: new SshAgentMuxDaemonConnector({
        target: sshTarget(),
        remoteNodePath: 'node',
        remoteAgentMuxdPath: current.remoteAgentMuxdPath,
        remoteSocketPath: current.remoteSocketPath,
        expectedBuildIdentity: current.buildIdentity,
        spawnProcess: sshSpawn
      }),
      expectedHostId: expected.hostId,
      expectedBuildIdentity: expected.buildIdentity
    })
  }

  function crashTransport(): void {
    const child = latestTransport()
    if (!child.pid) throw new Error('SSH fixture transport has no pid.')
    process.kill(-child.pid, 'SIGKILL')
  }

  it('installs explicitly, survives an SSH partition, replays output, and uninstalls cleanly', async () => {
    const current = await installAndActivate()
    expect((await stat(current.remoteAgentMuxdPath)).isFile()).toBe(true)
    const firstIdentity = await manager.audit(current)

    const client = manager.createClient(current)
    clients.push(client)
    const events: AgentMuxDaemonEvent[] = []
    client.onEvent((event) => events.push(event))
    await client.connect()
    expect(client.daemonIdentity()).toMatchObject({
      hostId: current.hostId,
      buildIdentity: current.buildIdentity,
      daemonInstanceId: firstIdentity.daemonInstanceId
    })
    const session = await client.createTerminal({
      sessionId: 'ssh-partition-session',
      createOperationId: 'ssh-partition-operation',
      cwd: process.cwd()
    })
    await expect(client.resize(session, 118, 37)).resolves.toMatchObject({ cols: 118, rows: 37 })
    await client.write(
      session,
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(()=>console.log('after-partition'),300)")}\n`
    )
    const cursor = latestSequence(events)
    crashTransport()
    await waitForCondition('the SSH client to observe its partition', async () => {
      try {
        await client.listSessions()
        return false
      } catch {
        return true
      }
    })
    await client.connect()
    let attached = await client.attach(session.sessionId, cursor)
    await waitForCondition('partition output to reach remote replay', async () => {
      attached = await client.attach(session.sessionId, cursor)
      return attached.replay.some((event) => event.data.includes('after-partition'))
    })
    expect(attached.session).toMatchObject({
      incarnationId: session.incarnationId,
      pid: session.pid,
      state: 'running'
    })
    expect(attached.replay.map((event) => event.data).join('')).toContain('after-partition')
    expect(client.daemonIdentity().daemonInstanceId).toBe(firstIdentity.daemonInstanceId)

    await client.detach(attached.session)
    const source = "process.stdout.write('r'.repeat(700000))"
    await client.write(attached.session, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}\n`)
    await waitForCondition('remote bounded replay output', async () => {
      const snapshot = (await client.listSessions()).find((candidate) => candidate.sessionId === session.sessionId)
      return (snapshot?.latestSequence ?? 0) >= 700_000
    })
    const replayed = await client.attach(session.sessionId, 0)
    expect(replayed.gap).not.toBeNull()
    expect(Buffer.byteLength(replayed.replay.map((event) => event.data).join(''))).toBeLessThanOrEqual(256 * 1024)
    await client.acknowledgeOutput(replayed.session, replayed.session.latestSequence)
    await client.stop(replayed.session)
    client.disconnect()

    await manager.uninstall(current)
    installation = null
    daemonPid = 0
    await expect(stat(current.remoteAgentMuxdPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(artifact.archivePath)).size).toBeGreaterThan(0)
  }, 30_000)

  it('recovers a Create whose response was lost with the crashed SSH client', async () => {
    const current = await installAndActivate()
    const client = manager.createClient(current)
    clients.push(client)
    await client.connect()
    const create = client.createTerminal({
      sessionId: 'ssh-lost-create',
      createOperationId: 'ssh-lost-create-operation',
      cwd: process.cwd()
    })
    await waitForCondition('the remote create journal receipt', async () => {
      try {
        const document = JSON.parse(await readFile(current.remoteStatePath, 'utf8')) as { sessions?: unknown[] }
        return document.sessions?.length === 1
      } catch {
        return false
      }
    })
    crashTransport()
    await expect(create).rejects.toBeInstanceOf(Error)

    await client.connect()
    const recovered = await client.findCreateOperation('ssh-lost-create-operation')
    expect(recovered).toMatchObject({
      sessionId: 'ssh-lost-create',
      state: 'running'
    })
    const attached = await client.attach('ssh-lost-create')
    expect(attached.session.pid).toBe(recovered?.pid)
    await client.stop(attached.session)
  }, 25_000)

  it('fails closed on Build, Host, and transport identity failures', async () => {
    const current = await installAndActivate()
    const wrongBuild = clientExpecting(current, {
      hostId: current.hostId,
      buildIdentity: 'wrong-build'
    })
    clients.push(wrongBuild)
    await expect(wrongBuild.connect()).rejects.toMatchObject({ code: 'DAEMON_BUILD_MISMATCH' })

    const wrongHost = clientExpecting(current, {
      hostId: 'wrong-host',
      buildIdentity: current.buildIdentity
    })
    clients.push(wrongHost)
    await expect(wrongHost.connect()).rejects.toMatchObject({ code: 'DAEMON_HOST_MISMATCH' })

    await writeFile(join(remoteHome, '.agentmux-ssh-unavailable'), 'offline\n')
    const unavailable = manager.createClient(current)
    clients.push(unavailable)
    await expect(unavailable.connect()).rejects.toMatchObject({ code: 'SSH_TRANSPORT_FAILED' })
  }, 25_000)

  it('upgrades through an explicit side-by-side install and daemon replacement', async () => {
    const first = await installAndActivate()
    const firstIdentity = await manager.audit(first)
    const next = await manager.upgrade(upgradeArtifact, first)
    installation = next
    const nextIdentity = await manager.audit(next)
    daemonPid = nextIdentity.daemonPid
    expect(next).toMatchObject({ buildIdentity: 'fixture-build-2' })
    expect(nextIdentity.daemonInstanceId).not.toBe(firstIdentity.daemonInstanceId)
    await waitForCondition('the previous remote daemon to stop', () => !processIsAlive(firstIdentity.daemonPid))
    expect((await stat(first.remoteAgentMuxdPath)).isFile()).toBe(true)

    await manager.uninstall(next)
    installation = null
    daemonPid = 0
    await manager.uninstall(first)
    await expect(stat(first.remoteAgentMuxdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('uses the remote daemon to force-stop a stubborn Agent process tree', async () => {
    const current = await installAndActivate()
    const client = manager.createClient(current)
    clients.push(client)
    const events: AgentMuxDaemonEvent[] = []
    client.onEvent((event) => events.push(event))
    await client.connect()
    const session = await client.createAgent({
      sessionId: 'ssh-stubborn-tree',
      createOperationId: 'ssh-stubborn-tree-operation',
      agentId: 'codex',
      args: [stubbornTreePath],
      commandOverride: process.execPath,
      cwd: process.cwd()
    })
    let childPid = 0
    await waitForCondition('the remote stubborn child pid', () => {
      const match = /stubborn-root:\d+:(\d+)/.exec(output(events))
      if (!match) return false
      childPid = Number(match[1])
      return childPid > 0
    })
    await client.stop(session)
    await waitForCondition('the remote PTY process tree to exit', () => (
      !processIsAlive(session.pid) && !processIsAlive(childPid)
    ))
  }, 25_000)
})
