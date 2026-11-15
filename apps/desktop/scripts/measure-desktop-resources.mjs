import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'
import { runProbeProcess, stopProbeProcesses } from './probe-process.mjs'
import { inspectRuntimeApplicationPayload, materializeRuntimePayload, PACKAGED_CTXMUX_ROOT } from './runtime-application-payload.mjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const electron = require('electron')
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const coreRoot = join(repositoryRoot, 'packages', 'core')
const daemonPath = join(coreRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmuxd')
const manifestPath = join(coreRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'manifest.json')
const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-desktop-resource-')))
const runtimeDirectory = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amx-desktop-resource-")))
const userData = join(directory, 'user-data')
const workspaceRoot = join(directory, 'workspaces')
const measuredWorkspaces = [
  { id: 'resource-workspace-a', name: 'Resource Probe A', path: join(workspaceRoot, 'a') },
  { id: 'resource-workspace-b', name: 'Resource Probe B', path: join(workspaceRoot, 'b') },
  { id: 'resource-workspace-c', name: 'Resource Probe C', path: join(workspaceRoot, 'c') }
]
const reportPath = join(directory, 'report.json')
const desktopRoot = join(directory, 'app')
const entry = join(desktopRoot, 'out', 'main', 'index.js')
const stagedDaemonPath = join(desktopRoot, PACKAGED_CTXMUX_ROOT, 'darwin-arm64', 'bin', 'ctxmuxd')
const socketPath = join(runtimeDirectory, 'ctxmux.sock')
const stateDirectory = join(runtimeDirectory, 'state', 'ctxmux')
const representativeDirectory = join(directory, 'representative')
const representativeRuntime = join(runtimeDirectory, 'representative')
const representativeReportPath = join(representativeDirectory, 'report.json')

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
    stateDirectory
  ]
  const remaining = []
  for (const path of paths) {
    if (await pathExists(path)) remaining.push(path)
  }
  if (remaining.length > 0) {
    throw new Error(`Desktop resource probe cleanup left paths behind: ${remaining.join(', ')}`)
  }
}

async function ownedDaemonPids(daemonSocket = socketPath, daemonState = stateDirectory, executable = daemonPath) {
  // Private cleanup is authorized by this invocation's exact socket/process scope.
  // Product provenance files are independent observations, not cleanup ownership.
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
    else if (current && line === `n${daemonSocket}`) current.ownsSocket = true
  }
  const expectedCommand = [
    executable,
    '--socket', daemonSocket,
    '--state-dir', daemonState,
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
  const env = privatePackageSmokeEnvironment(process.env, { userData, runtimeRoot: runtimeDirectory })
  await Promise.all([stateDirectory, env.HOME, env.TMPDIR].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const child = spawn(daemonPath, [
    '--socket', socketPath,
    '--state-dir', stateDirectory,
    '--readiness-fd', '3'
  ], {
    env, stdio: ['ignore', 'ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
  try {
    child.stdio[3]?.resume()
    const deadline = Date.now() + 5_000
    let owned = []
    while (Date.now() <= deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Receiptless cleanup fixture daemon exited before ownership discovery: ${stderr.trim() || child.exitCode || child.signalCode}.`)
      }
      owned = await ownedDaemonPids()
      if (owned.length > 0) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    if (owned.length !== 1 || owned[0] !== child.pid) {
      throw new Error('Desktop resource probe could not prove its exact receiptless ctxmuxd owner.')
    }
    if ((await readdir(runtimeDirectory)).some(name => /^owner-[a-f0-9]{64}\.json$/u.test(name))) {
      throw new Error('Receiptless cleanup fixture unexpectedly created a product owner receipt.')
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

async function waitForDaemonCleanup(...scope) {
  const deadline = Date.now() + 5_000
  let remaining = await ownedDaemonPids(...scope)
  while (remaining.length > 0 && Date.now() <= deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    remaining = await ownedDaemonPids(...scope)
  }
  return remaining
}

async function stopOwnedDaemons(...scope) {
  const owned = await ownedDaemonPids(...scope)
  for (const pid of owned) {
    if (!(await ownedDaemonPids(...scope)).includes(pid)) continue
    try { process.kill(pid, 'SIGTERM') } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ESRCH')) throw error
    }
  }
  let remaining = await waitForDaemonCleanup(...scope)
  for (const pid of remaining) {
    if (!(await ownedDaemonPids(...scope)).includes(pid)) continue
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ESRCH')) throw error
    }
  }
  remaining = await waitForDaemonCleanup(...scope)
  if (remaining.length > 0) {
    throw new Error(`Desktop resource probe left ${remaining.length} test-owned ctxmuxd process(es).`)
  }
  return owned.length
}

async function prepareStage({ root, userData, runtimeRoot, workspaces }) {
  const configurationPath = join(userData, 'agentmux.config.json')
  const { AGENTMUX_DESKTOP_READY_FILE, AGENTMUX_DESKTOP_EXIT_AFTER_READY, ...environment } =
    privatePackageSmokeEnvironment(process.env, { userData, runtimeRoot })
  if (environment.AGENTMUX_DESKTOP_USER_DATA !== userData || environment.AGENTMUX_RUNTIME_DIRECTORY !== runtimeRoot ||
      environment.AGENTMUX_STATE_DIRECTORY !== join(runtimeRoot, 'state')) {
    throw new Error('Private Desktop and Runtime paths did not resolve to the resource fixture.')
  }
  const paths = { home: environment.HOME, appData: join(userData, 'appData'), userData, sessionData: join(userData, 'sessionData') }
  await Promise.all([...new Set([...Object.values(paths), environment.TMPDIR,
    ...workspaces.map(({ path }) => path)])].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  await writeFile(configurationPath, `${JSON.stringify({
    version: 9,
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
    workspaces: workspaces.map(({ id, name, path }) => ({
      id,
      name,
      hostId: 'local',
      path,
      kind: 'folder'
    })),
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  }, null, 2)}\n`, { mode: 0o600 })
  const bootstrap = join(root, 'launch.cjs')
  await writeFile(bootstrap, `const {app}=require('electron');
for (const [name,path] of Object.entries(${JSON.stringify(paths)})) {
  app.setPath(name,path);
  if (app.getPath(name)!==path) throw new Error('Private Electron path mismatch: '+name);
}
app.setAppPath(${JSON.stringify(desktopRoot)});
import(${JSON.stringify(pathToFileURL(entry).href)}).catch(error=>{console.error(error);app.exit(1)});`)
  return { bootstrap, environment, configurationPath, hostPaths: paths }
}

async function loadResourceWorkbenchFixture() {
  const { build } = await import(createRequire(join(coreRoot, 'package.json')).resolve('esbuild'))
  const fixtureModule = join(desktopRoot, 'out', 'main', 'resource-workbench-documents.mjs')
  await build({ entryPoints: [join(import.meta.dirname, 'resource-workbench-documents.ts')],
    platform: 'node', format: 'esm', bundle: true, packages: 'external', outfile: fixtureModule })
  return await import(pathToFileURL(fixtureModule).href)
}

async function runStage(stage, identity, run) {
  const { root, runtimeRoot, userData, reportPath, workspaces } = stage
  const fixturePath = stage.representative ? join(root, 'workface.json') : undefined
  const { bootstrap, environment, configurationPath, hostPaths } = await prepareStage(stage)
  await stage.initializeResourceWorkbench(userData, stage.representative ? undefined : workspaces[0].id)
  const storePath = environment.AGENTMUX_AGENT_SESSION_STORE
  const hostEntry = join(desktopRoot, 'out', 'main', 'agentmux-host.js')
  const host = spawn(electron, [hostEntry, '--store', storePath], {
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1',
      AGENTMUX_MOBILE_BUILD_DIRECTORY: join(desktopRoot, 'out', 'mobile'),
      AGENTMUX_HOST_CONFIGURATION_PATH: configurationPath,
      AGENTMUX_MOTE_CONFIGURATION_PATH: configurationPath,
      AGENTMUX_CONNECTOR_DIRECTORY: join(userData, 'connectors') },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true
  })
  let hostError
  host.on('error', error => { hostError = error })
  let stdout = '', hostStderr = '', stderr = ''
  host.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-65_536) })
  host.stderr.setEncoding('utf8').on('data', chunk => { hostStderr = (hostStderr + chunk).slice(-65_536) })
  const daemonSocket = join(runtimeRoot, 'ctxmux.sock')
  const daemonState = join(runtimeRoot, 'state', 'ctxmux')
  let desktopPid = null
  const failures = []
  try {
    const deadline = Date.now() + 30_000
    let ready
    while (!ready && Date.now() < deadline) {
      if (hostError) throw hostError
      if (host.exitCode !== null || host.signalCode !== null) {
        throw new Error(`Private resource Host exited before its ready receipt (${host.exitCode ?? host.signalCode}).`)
      }
      ready = stdout.split('\n').find(line => {
        try {
          const value = JSON.parse(line)
          return value.protocol === 'jsonrpc-2.0' && value.pid === host.pid && value.owner?.processId === host.pid
        }
        catch { return false }
      })
      if (!ready) await delay(100)
    }
    if (!ready) throw new Error('Private resource Host did not emit an exact ready receipt.')
    const hostIdentity = JSON.parse(ready).owner

    if (fixturePath) {
      const { connectAgentMuxRpc } = await import('@agentmux/core')
      const { seedRepresentativeWorkface } = await import('./representative-resource-fixture.mjs')
      const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(runtimeRoot, 'control.sock') } })
      try { await seedRepresentativeWorkface({ rpc, storePath, directory: root, workspaces, fixturePath }) }
      finally { await rpc.dispose() }
    }
    const timeoutMs = Number(process.env.AGENTMUX_DESKTOP_RESOURCE_TIMEOUT_MS ?? 180_000)
    const result = await runProbeProcess(electron, [
      ...(!fixturePath ? ['--js-flags=--expose-gc'] : []),
      bootstrap
    ], {
      cwd: desktopRoot,
      env: { ...environment, AGENTMUX_DESKTOP_RESOURCE_REPORT: reportPath,
        ...(fixturePath ? { AGENTMUX_DESKTOP_RESOURCE_WORKFACE: fixturePath }
          : { AGENTMUX_DESKTOP_RESOURCE_WORKSPACES: JSON.stringify(workspaces.map(workspace => workspace.id)) }),
        AGENTMUX_DESKTOP_RESOURCE_IDENTITY: JSON.stringify(identity),
        AGENTMUX_DESKTOP_SPAWNED_AT_MS: String(Date.now()),
        AGENTMUX_DESKTOP_RESOURCE_DEBUG: process.env.AGENTMUX_DESKTOP_RESOURCE_DEBUG ?? '0' },
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000,
      onSpawn: child => { desktopPid = child.originalPid },
      onLine: line => { stderr = (stderr + line + '\n').slice(-65_536) }
    })
    run.report = JSON.parse(await readFile(reportPath, 'utf8'))
    run.isolation = { paths: hostPaths, hostPid: host.pid, desktopPid, runtimeId: hostIdentity.runtimeId,
      ownerInstanceId: hostIdentity.ownerInstanceId }
    if (result.exitCode !== 0 || run.report.error) throw new Error(run.report.error ?? `Desktop resource probe exited ${result.exitCode}.`)
    if (fixturePath && run.report.mainPid !== desktopPid) throw new Error('Representative probe reported a different Main process.')
  } catch (error) {
    failures.push(new Error([error.message, stderr.trim(), hostStderr.trim(), stdout.trim()].filter(Boolean).join('\n'), { cause: error }))
  } finally {
    for (const clean of [
      async () => { if (desktopPid) await stopProbeProcesses(desktopPid, '') },
      async () => { if (host.pid) await stopProbeProcesses(host.pid, '', 2_000) },
      async () => { run.daemonCount = await stopOwnedDaemons(daemonSocket, daemonState, stagedDaemonPath) },
      async () => { await stopProbeProcesses(0, root) }
    ]) {
      try { await clean() } catch (error) { failures.push(error); run.cleanup = false }
    }
  }
  if (failures.length) throw new AggregateError(failures, `Desktop resource probe stage ${stage.representative ? 'representative' : 'diagnostic'} failed.`)
}

function assertRepresentativeResult(report) {
  const status = report?.representative?.status
  if (status !== 'passed') {
    throw new Error(`Representative resource Gate ${status ?? 'coverage-missing'}: ${report?.representative?.issue ?? 'inspect the workload and phase receipt.'}`)
  }
}

async function main() {
  const representativeOnly = process.argv.includes('--representative-only')
  const diagnostic = { report: null, cleanup: true, daemonCount: 0 }
  const representative = { report: null, cleanup: true, daemonCount: 0 }
  const failures = []
  let sourceCommit, trackedDiff, manifest, receiptlessDaemonCleanup = false
  try {
    const [commit, status, bytes] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
      execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot }),
      readFile(manifestPath, 'utf8')
    ])
    sourceCommit = commit.stdout.trim()
    trackedDiff = status.stdout
    manifest = JSON.parse(bytes)
    const identity = {
      agentmuxCommit: sourceCommit,
      ctxmux: { sourceCommit: manifest.source.commit, sourceTree: manifest.source.tree,
        protocolVersion: manifest.product.protocol, artifactPlatform: `${manifest.support.platform}-${manifest.support.architecture}`,
        daemonSha256: manifest.binaries.find(binary => binary.name === 'ctxmuxd')?.sha256 ?? null },
      platform: `${process.platform}-${process.arch}`
    }
    await Promise.all([chmod(runtimeDirectory, 0o700),
      mkdir(representativeRuntime, { recursive: true, mode: 0o700 })])
    await exerciseReceiptlessDaemonCleanup()
    receiptlessDaemonCleanup = true
    await materializeRuntimePayload(await inspectRuntimeApplicationPayload(repositoryRoot), desktopRoot)
    await access(entry)
    const { initializeResourceWorkbench } = await loadResourceWorkbenchFixture()
    const workspaces = measuredWorkspaces.map(workspace => ({ ...workspace, hostId: 'local', kind: 'folder' }))
    if (!representativeOnly) {
      try {
        await Promise.all(workspaces.map(async ({ path }) => {
          await mkdir(path, { recursive: true, mode: 0o700 })
          await writeFile(join(path, 'resource-probe.ts'), 'export const value = 1\n'.repeat(20_000))
        }))
        await runStage({ root: directory, runtimeRoot: runtimeDirectory, userData, reportPath, workspaces, initializeResourceWorkbench }, identity, diagnostic)
      } catch (error) { failures.push(error) }
    }

    if (diagnostic.cleanup) {
      try {
        await runStage({ root: representativeDirectory, runtimeRoot: representativeRuntime,
          userData: join(representativeDirectory, 'user-data'), reportPath: representativeReportPath, representative: true, initializeResourceWorkbench,
          workspaces: workspaces.map((workspace, index) => ({ ...workspace,
            path: join(representativeDirectory, 'workspaces', String(index)) })) }, identity, representative)
      } catch (error) { failures.push(error) }
    }
  } catch (error) { failures.push(error) }

  try { assertRepresentativeResult(representative.report) } catch (error) { failures.push(error) }
  let diagnosticCleanup = false
  if (diagnostic.cleanup && representative.cleanup) {
    try {
      await Promise.all([
        rm(directory, { recursive: true, force: true }),
        rm(runtimeDirectory, { recursive: true, force: true })
      ])
      await assertProbePathsRemoved()
      diagnosticCleanup = true
    } catch (error) { failures.push(error) }
  }
  const [finalCommit, finalStatus] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot })
  ])
  const report = diagnostic.report
  const receipt = {
    ...report,
    representative: representative.report?.representative ?? { status: 'coverage-missing', issue: 'Representative workload receipt unavailable.' },
    identity: {
      agentmux: { sourceCommit, endCommit: finalCommit.stdout.trim(), trackedDiffClean: trackedDiff?.trim().length === 0,
        worktreeStable: finalStatus.stdout === trackedDiff, sourceCommitStable: finalCommit.stdout.trim() === sourceCommit,
        statusAtStart: trackedDiff, statusAtEnd: finalStatus.stdout },
      ctxmux: manifest ? { sourceCommit: manifest.source.commit, sourceTree: manifest.source.tree,
        protocolVersion: manifest.product.protocol, artifactPlatform: `${manifest.support.platform}-${manifest.support.architecture}`,
        daemonSha256: manifest.binaries.find(binary => binary.name === 'ctxmuxd')?.sha256 ?? null } : null
    },
    harness: {
      requestedScenarios: representativeOnly ? ['representative'] : ['diagnostic', 'representative'],
      isolatedRuntime: true, receiptlessDaemonCleanup, ownedDaemonCount: diagnostic.daemonCount + representative.daemonCount,
      daemonCleanup: diagnostic.cleanup && representative.cleanup, pathsRemoved: diagnosticCleanup,
      diagnostic: diagnostic.isolation ?? null, representative: representative.isolation ?? null,
      ...(diagnosticCleanup ? {} : { retained: [directory, runtimeDirectory] })
    }
  }
  process.stdout.write(`T017_DESKTOP_RESOURCE_RECEIPT=${JSON.stringify(receipt)}\n`)
  if (failures.length) throw new AggregateError(failures, 'Desktop resource probe failed.')
}

await main()
