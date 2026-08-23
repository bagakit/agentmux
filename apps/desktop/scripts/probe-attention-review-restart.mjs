import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { runProbeProcess } from './probe-process.mjs'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(import.meta.dirname, '..')
const electronExecutable = require('electron')
const entry = join(desktopRoot, 'out', 'main', 'index.js')
if (!process.argv.includes('--isolated')) throw new Error('The restart probe requires --isolated so it cannot touch user data.')

const temporaryRoot = await mkdtemp(join(tmpdir(), `amx-attention-review-${process.pid}-`))
const userData = join(temporaryRoot, 'user-data')
const runtimeDirectory = join(temporaryRoot, 'runtime')
const workspacePath = join(temporaryRoot, 'workspace')
const sessionId = 'session-restart-probe'
const runId = 'run-restart-probe'
const tabId = 'tab-restart-probe'
const regionId = 'region-restart-probe'
const draft = 'draft survives a real Electron restart'

const fixtureConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'Restart Probe' }],
  executors: {},
  workspaces: [{ id: 'workspace-restart-probe', name: 'Restart Probe', hostId: 'local', path: workspacePath, kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const fixtureSession = {
  kind: 'agent', agentSessionId: sessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath,
  run: { runId }, retiredRuns: [], hookBindingId: 'hook-binding-restart-probe', hookToken: 'hook-token-restart-probe',
  outputCursorBytes: 0, createdAt: 1, updatedAt: 1,
  nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-restart-probe' }
}
const workbenchSeed = {
  state: {
    activeWorkspaceId: 'workspace-restart-probe', mainSurface: 'workbench', selectedAgentSessionId: sessionId,
    agentComposerDrafts: { [sessionId]: draft },
    restoredWorkbench: {
      tabs: { [tabId]: {
        id: tabId, workspaceId: 'workspace-restart-probe', titleRegionId: regionId,
        layout: { root: { type: 'leaf', regionId }, activeRegionId: regionId },
        regions: { [regionId]: { regionId, kind: 'agent', phase: 'attached', workspaceId: 'workspace-restart-probe', sessionId } }
      } },
      layouts: { 'workspace-restart-probe': {
        root: { type: 'leaf', groupId: 'group-restart-probe' },
        groups: [{ id: 'group-restart-probe', tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }],
        activeGroupId: 'group-restart-probe'
      } }
    }
  }, version: 1
}
const workbenchSeedRaw = JSON.stringify(workbenchSeed)
const inputDigest = createHash('sha256').update(JSON.stringify({ fixtureConfig, fixtureSession, workbenchSeed })).digest('hex')

async function waitForJson(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)) }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

function identity(report) {
  return {
    userData: report.userData, runtimeDirectory: report.runtimeDirectory,
    tabIds: report.workbench.tabIds, regionIds: report.workbench.regionIds,
    activeRegionIds: report.workbench.activeRegionIds, activeWorkspaceId: report.workbench.activeWorkspaceId,
    draftSessionIds: report.workbench.draftSessionIds, drafts: report.workbench.drafts,
    selectedAgentSessionId: report.workbench.selectedAgentSessionId,
    sessionIds: report.sessions.sessions.map((session) => session.agentSessionId),
    runIds: report.sessions.sessions.flatMap((session) => session.runId ? [session.runId] : [])
  }
}

function assertReport(report, label) {
  if (report.schema !== 'agentmux.desktop-restart-recovery.v1') throw new Error(`${label}: report schema is missing.`)
  if (!Number.isInteger(report.pid) || report.pid <= 0) throw new Error(`${label}: Electron PID is missing.`)
  if (report.userData !== userData || report.runtimeDirectory !== runtimeDirectory) throw new Error(`${label}: durable roots drifted.`)
  if (report.workbench.storagePresent !== true) throw new Error(`${label}: Workbench storage is absent.`)
  if (JSON.stringify(report.workbench.tabIds) !== JSON.stringify([tabId])) throw new Error(`${label}: Tab identity was not recovered.`)
  if (JSON.stringify(report.workbench.regionIds) !== JSON.stringify([regionId])) throw new Error(`${label}: Region identity was not recovered.`)
  if (JSON.stringify(report.workbench.activeRegionIds) !== JSON.stringify([regionId])) throw new Error(`${label}: active Region focus was not recovered.`)
  if (report.workbench.activeWorkspaceId !== 'workspace-restart-probe') throw new Error(`${label}: active Workspace was not recovered.`)
  if (report.workbench.drafts[sessionId] !== draft) throw new Error(`${label}: composer draft was not recovered.`)
  if (report.workbench.selectedAgentSessionId !== sessionId) throw new Error(`${label}: selected Session identity was not recovered.`)
  const session = report.sessions.sessions.find((candidate) => candidate.agentSessionId === sessionId)
  if (!session || session.runId !== runId || session.nativeSessionId !== 'native-restart-probe') throw new Error(`${label}: Core Session identity was not recovered.`)
}

async function launch(label, seed) {
  const reportFile = join(temporaryRoot, `recovery-${label}.json`)
  const readyFile = join(temporaryRoot, `ready-${label}.json`)
  const execution = await runProbeProcess(electronExecutable, [entry], {
    temporaryRoot, cwd: desktopRoot, timeoutMs: 60_000,
    env: {
      ...process.env, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
      AGENTMUX_DESKTOP_RECOVERY_REPORT: reportFile, ...(seed ? { AGENTMUX_DESKTOP_RECOVERY_SEED: seed } : {}),
      AGENTMUX_DESKTOP_READY_FILE: readyFile, AGENTMUX_DESKTOP_EXIT_AFTER_READY: '1'
    }
  })
  const [report, ready] = await Promise.all([waitForJson(reportFile), waitForJson(readyFile)])
  if (execution.exitCode !== 0 || execution.timedOut || execution.interruption) throw new Error(`${label}: Electron exited unsuccessfully: ${JSON.stringify(execution)}`)
  assertReport(report, label)
  if (ready.executable === undefined || ready.packaged === undefined) throw new Error(`${label}: ready receipt lost executable identity.`)
  return { report, ready, execution }
}

let result
try {
  await mkdir(userData, { recursive: true, mode: 0o700 })
  await mkdir(workspacePath, { recursive: true, mode: 0o700 })
  await writeFile(join(userData, 'agentmux.config.json'), `${JSON.stringify(fixtureConfig)}\n`, { mode: 0o600 })
  await writeFile(join(userData, 'agent-sessions.json'), `${JSON.stringify({ version: 5, sessions: [fixtureSession], reservations: [], retiredRuns: [], retiredAgentSessions: [] })}\n`, { mode: 0o600 })
  const first = await launch('first', workbenchSeedRaw)
  const second = await launch('second', null)
  if (first.report.pid === second.report.pid) throw new Error('Restart reused the same Electron PID.')
  if (first.ready.executable !== second.ready.executable) throw new Error('Restart changed the executable identity.')
  if (first.ready.packaged !== second.ready.packaged) throw new Error('Restart changed packaging state.')
  const before = identity(first.report)
  const after = identity(second.report)
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Durable restart identity drifted.')
  result = { event: 'attention-review-restart', schema: 'agentmux.desktop-restart-recovery.v1', inputDigest,
    first: { pid: first.report.pid, userData: first.report.userData, runtimeDirectory: first.report.runtimeDirectory, identity: before, cleanup: first.execution },
    second: { pid: second.report.pid, userData: second.report.userData, runtimeDirectory: second.report.runtimeDirectory, identity: after, cleanup: second.execution },
    sameUserData: first.report.userData === second.report.userData, sameRuntimeDirectory: first.report.runtimeDirectory === second.report.runtimeDirectory,
    differentPid: first.report.pid !== second.report.pid }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
process.stdout.write(`${JSON.stringify({ ...result, cleanup: { temporaryRootRemoved: true } })}\n`)
