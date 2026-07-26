import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const electron = require('electron')
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const coreRoot = join(repositoryRoot, 'packages', 'core')
const daemonPath = join(coreRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmuxd')
const manifestPath = join(coreRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'manifest.json')
const directory = await mkdtemp(join(tmpdir(), 'agentmux-desktop-resource-'))
const runtimeDirectory = await mkdtemp('/private/tmp/amx-desktop-resource-')
const userData = join(directory, 'user-data')
const workspaceRoot = join(directory, 'workspaces')
const measuredWorkspaces = [
  { id: 'resource-workspace-a', name: 'Resource Probe A', path: join(workspaceRoot, 'a') },
  { id: 'resource-workspace-b', name: 'Resource Probe B', path: join(workspaceRoot, 'b') },
  { id: 'resource-workspace-c', name: 'Resource Probe C', path: join(workspaceRoot, 'c') }
]
const workspace = measuredWorkspaces[0].path
const reportPath = join(directory, 'report.json')
const entry = resolve(import.meta.dirname, '../out/main/index.js')
const socketPath = join(runtimeDirectory, 'ctxmux.sock')
const stateDirectory = join(runtimeDirectory, 'state')

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
}

async function assertProbePathsRemoved() {
  const paths = [
    directory,
    runtimeDirectory,
    userData,
    workspaceRoot,
    ...measuredWorkspaces.map(({ path }) => path),
    reportPath,
    socketPath,
    stateDirectory,
    join(runtimeDirectory, 'owner.json')
  ]
  const remaining = []
  for (const path of paths) {
    if (await pathExists(path)) remaining.push(path)
  }
  if (remaining.length > 0) {
    throw new Error(`Desktop resource probe cleanup left paths behind: ${remaining.join(', ')}`)
  }
}

async function ownedDaemonPids() {
  let receipt = null
  try {
    receipt = JSON.parse(await readFile(join(runtimeDirectory, 'owner.json'), 'utf8'))
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error
  }
  if (receipt && (
    receipt.schema !== 'agentmux.ctxmux-owner.v1' ||
    receipt.daemonPath !== daemonPath ||
    receipt.socketPath !== socketPath ||
    receipt.stateDirectory !== stateDirectory
  )) {
    throw new Error('Desktop resource probe found an invalid ctxmux owner receipt.')
  }
  const processes = await execFileAsync('/usr/sbin/lsof', ['-n', '-P', '-a', '-U', '-Fpcn'], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const candidates = []
  let current = null
  for (const line of processes.stdout.split('\n')) {
    if (line.startsWith('p')) {
      current = { pid: Number(line.slice(1)), command: '', ownsSocket: false }
      candidates.push(current)
    } else if (current && line.startsWith('c')) current.command = line.slice(1)
    else if (current && line === `n${socketPath}`) current.ownsSocket = true
  }
  const expectedCommand = [
    daemonPath,
    '--socket', socketPath,
    '--state-dir', stateDirectory,
    '--readiness-fd', '3'
  ].join(' ')
  const owned = []
  for (const candidate of candidates) {
    if (!candidate.ownsSocket || candidate.command !== 'ctxmuxd') continue
    const process = await execFileAsync('/bin/ps', [
      '-p', String(candidate.pid), '-o', 'command='
    ], { timeout: 5_000, maxBuffer: 64 * 1024 }).catch(() => null)
    if (process?.stdout.trim() === expectedCommand) owned.push(candidate.pid)
  }
  return owned
}

async function exerciseReceiptlessDaemonCleanup() {
  const child = spawn(daemonPath, [
    '--socket', socketPath,
    '--state-dir', stateDirectory,
    '--readiness-fd', '3'
  ], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe']
  })
  try {
    child.stdio[3]?.resume()
    const deadline = Date.now() + 5_000
    let owned = []
    while (Date.now() <= deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Receiptless cleanup fixture daemon exited before ownership discovery.')
      }
      owned = await ownedDaemonPids()
      if (owned.length > 0) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    if (owned.length !== 1 || owned[0] !== child.pid) {
      throw new Error('Desktop resource probe could not prove its exact receiptless ctxmuxd owner.')
    }
    const unexpectedReceipt = await readFile(join(runtimeDirectory, 'owner.json'), 'utf8').catch((error) => {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return null
      throw error
    })
    if (unexpectedReceipt !== null) {
      throw new Error('Receiptless cleanup fixture unexpectedly created an owner receipt.')
    }
    if (await stopOwnedDaemons() !== 1) {
      throw new Error('Desktop resource probe did not clean exactly one receiptless ctxmuxd owner.')
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
      ])
    }
  }
}

async function waitForDaemonCleanup() {
  const deadline = Date.now() + 5_000
  let remaining = await ownedDaemonPids()
  while (remaining.length > 0 && Date.now() <= deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    remaining = await ownedDaemonPids()
  }
  return remaining
}

async function stopOwnedDaemons() {
  const owned = await ownedDaemonPids()
  for (const pid of owned) {
    if (!(await ownedDaemonPids()).includes(pid)) continue
    try { process.kill(pid, 'SIGTERM') } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ESRCH')) throw error
    }
  }
  let remaining = await waitForDaemonCleanup()
  for (const pid of remaining) {
    if (!(await ownedDaemonPids()).includes(pid)) continue
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ESRCH')) throw error
    }
  }
  remaining = await waitForDaemonCleanup()
  if (remaining.length > 0) {
    throw new Error(`Desktop resource probe left ${remaining.length} test-owned ctxmuxd process(es).`)
  }
  return owned.length
}

async function main() {
  let child = null
  let timer = null
  let report = null
  let failure = null
  let daemonCount = 0
  let sourceCommit = null
  let trackedDiff = null
  let finalCommit = null
  let finalStatus = null
  let manifest = null
  let receiptlessDaemonCleanup = false

  try {
    const evidence = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
      execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot }),
      readFile(manifestPath, 'utf8')
    ])
    sourceCommit = evidence[0]
    trackedDiff = evidence[1]
    manifest = JSON.parse(evidence[2])
    await Promise.all([
      mkdir(userData, { recursive: true }),
      chmod(runtimeDirectory, 0o700),
      mkdir(workspaceRoot, { recursive: true }),
      ...measuredWorkspaces.map(({ path }) => mkdir(path, { recursive: true }))
    ])
    await exerciseReceiptlessDaemonCleanup()
    receiptlessDaemonCleanup = true
    await Promise.all(measuredWorkspaces.map(({ path }) => (
      writeFile(join(path, 'resource-probe.ts'), 'export const value = 1\n'.repeat(20_000))
    )))
    await writeFile(join(userData, 'agentmux.config.json'), `${JSON.stringify({
      version: 7,
      hosts: [{ id: 'local', kind: 'local', label: 'Resource Probe' }],
      executors: {
        codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true },
        claude: { label: 'Claude', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true },
        traex: { label: 'TraeX', providerId: 'traex', command: 'traex', args: [], env: {}, injectAgentMuxGuide: true },
        hermes: { label: 'Hermes', providerId: 'hermes', command: 'hermes', args: [], env: {}, injectAgentMuxGuide: true },
        pi: { label: 'Pi', providerId: 'pi', command: 'pi', args: [], env: {}, injectAgentMuxGuide: true },
        grok: {
          label: 'Grok',
          providerId: 'grok',
          command: 'grok',
          args: ['--permission-mode', 'bypassPermissions'],
          env: {},
          injectAgentMuxGuide: true
        },
        gemini: { label: 'Gemini', providerId: 'gemini', command: 'gemini', args: [], env: {}, injectAgentMuxGuide: true },
        antigravity: { label: 'Antigravity', providerId: 'antigravity', command: 'agy', args: [], env: {}, injectAgentMuxGuide: true },
        cursor: { label: 'Cursor', providerId: 'cursor', command: 'cursor-agent', args: [], env: {}, injectAgentMuxGuide: true }
      },
      workspaces: measuredWorkspaces.map(({ id, name, path }) => ({
        id,
        name,
        hostId: 'local',
        path,
        kind: 'folder'
      })),
      appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
    }, null, 2)}\n`, { mode: 0o600 })

    child = spawn(electron, [`--user-data-dir=${userData}`, '--js-flags=--expose-gc', entry], {
      env: {
        ...process.env,
        // The main process deliberately binds Electron's userData path so dev and packaged
        // launches share durable state. A probe must override that binding with its own
        // isolated directory; otherwise an already-running desktop instance owns the
        // single-instance lock and the probe exits before writing a report.
        AGENTMUX_DESKTOP_USER_DATA: userData,
        AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
        AGENTMUX_DESKTOP_RESOURCE_REPORT: reportPath,
        AGENTMUX_DESKTOP_RESOURCE_IDENTITY: JSON.stringify({
          agentmuxCommit: sourceCommit.stdout.trim(),
          worktreeStatus: trackedDiff.stdout,
          ctxmux: {
            sourceCommit: manifest.source.commit,
            sourceTree: manifest.source.tree,
            protocolVersion: manifest.product.protocol,
            artifactPlatform: `${manifest.support.platform}-${manifest.support.architecture}`,
            daemonSha256: manifest.binaries.find((binary) => binary.name === 'ctxmuxd')?.sha256 ?? null
          },
          platform: `${process.platform}-${process.arch}`
        }),
        AGENTMUX_DESKTOP_SPAWNED_AT_MS: String(Date.now()),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (Buffer.byteLength(stderr) > 1024 * 1024) child?.kill('SIGKILL')
    })
    timer = setTimeout(() => child?.kill('SIGKILL'), 60_000)
    timer.unref()
    const [exitCode] = await once(child, 'exit')
    clearTimeout(timer)
    timer = null
    const reportText = await readFile(reportPath, 'utf8').catch(() => '')
    if (!reportText) throw new Error(`Desktop resource probe did not produce a report. ${stderr.trim()}`)
    report = JSON.parse(reportText)
    if (exitCode !== 0 || report.error) {
      const detail = report.error ?? `Desktop resource probe exited ${exitCode}.`
      throw new Error(stderr.trim() ? `${detail}\nElectron stderr:\n${stderr.trim()}` : detail)
    }
  } catch (error) {
    failure = error
  } finally {
    if (timer) clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    try {
      daemonCount = await stopOwnedDaemons()
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError([failure, cleanupError], 'Desktop resource probe and cleanup failed.')
        : cleanupError
    }
  }

  if (report) {
    if (!sourceCommit || !trackedDiff || !manifest) {
      throw new Error('Desktop resource probe identity evidence is incomplete.')
    }
    ;[finalCommit, finalStatus] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
      execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot })
    ])
    const worktreeStable = finalStatus.stdout === trackedDiff.stdout
    const sourceCommitStable = finalCommit.stdout === sourceCommit.stdout
    const daemon = manifest.binaries.find((binary) => binary.name === 'ctxmuxd')
    const receipt = {
      ...report,
      identity: {
        agentmux: {
          sourceCommit: sourceCommit.stdout.trim(),
          endCommit: finalCommit.stdout.trim(),
          trackedDiffClean: trackedDiff.stdout.trim().length === 0,
          worktreeStable,
          sourceCommitStable,
          statusAtStart: trackedDiff.stdout,
          statusAtEnd: finalStatus.stdout
        },
        ctxmux: {
          sourceCommit: manifest.source.commit,
          sourceTree: manifest.source.tree,
          protocolVersion: manifest.product.protocol,
          artifactPlatform: `${manifest.support.platform}-${manifest.support.architecture}`,
          daemonSha256: daemon?.sha256 ?? null
        }
      },
      harness: {
        isolatedRuntime: true,
        receiptlessDaemonCleanup,
        ownedDaemonCount: daemonCount,
        daemonCleanup: true
      }
    }
    process.stdout.write(`T017_DESKTOP_RESOURCE_RECEIPT=${JSON.stringify(receipt)}\n`)
  }
  try {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(runtimeDirectory, { recursive: true, force: true })
    ])
    await assertProbePathsRemoved()
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError([failure, cleanupError], 'Desktop resource probe cleanup failed.')
      : cleanupError
  }
  if (failure) throw failure
}

await main()
