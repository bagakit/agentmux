import { app, type BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { connectAgentMuxRpc, defaultAgentMuxControlSocketPath } from '@agentmux/core'
import { parseDesktopClientObservation, type DesktopClientObservation } from '../shared/client-observation.js'
import type { RuntimeController } from './runtime-controller.js'
import { selectWorkspace, type ResourceProbeTerminalReader } from './resource-probe.js'
import {
  evaluateRepresentativeResourceBudget,
  REPRESENTATIVE_ACTIVITY_MS,
  REPRESENTATIVE_SAMPLE_INTERVAL_MS,
  REPRESENTATIVE_WARM_MS,
  type RepresentativeRendererSample,
  type RepresentativeResourceEvidence
} from './representative-resource-budget.js'

type Terminal = { runId: string; pid: number; seededOutputBytes: number; workspaceId: string; regionId: string }
type Fixture = {
  revision: number
  tabs: Array<{ id: string; workspaceId: string; groupId: string; regionId: string }>
  runs: Terminal[]
}

async function waitFor<T>(description: string, read: () => Promise<T | undefined>, timeoutMs = 12_000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(150)
  }
  throw new Error(`Representative workload did not confirm ${description}.`)
}

/** The main document's identity is sampled with every process table cut. */
async function sampleWindow(window: BrowserWindow, destination: RepresentativeRendererSample[], durationMs: number, documentGeneration: () => number) {
  const start = performance.now()
  do {
    const elapsedMs = destination.length ? Math.round(performance.now() - start) : 0
    destination.push({
      elapsedMs,
      documentPid: window.webContents.getOSProcessId(),
      documentGeneration: documentGeneration(),
      metrics: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, workingSetKiB: memory.workingSetSize }))
    })
    if (elapsedMs >= durationMs) break
    await delay(REPRESENTATIVE_SAMPLE_INTERVAL_MS)
  } while (true)
}

export async function measureRepresentativeWorkface(window: BrowserWindow, runtime: RuntimeController, fixturePath: string,
  inspectTerminal: ResourceProbeTerminalReader) {
  const evidence: RepresentativeResourceEvidence = {
    hostMemoryBytes: totalmem(), rendererPid: 0, documentGenerationChanges: 0, fixtureRevision: 0,
    restoredTabs: 0, restoredRegions: 0, restoredWorkspaces: 0, restoredRuns: [],
    visibleRunId: '', alternateRunId: '', warmInputEcho: false, burstOutputBytes: 0,
    activityFinishedMs: null, alternateInputEcho: false, returnedInputEcho: false, warm: [], activity: []
  }
  const warm: RepresentativeRendererSample[] = [], activity: RepresentativeRendererSample[] = []
  evidence.warm = warm; evidence.activity = activity
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: defaultAgentMuxControlSocketPath() } })
  const documentGeneration = () => evidence.documentGenerationChanges
  const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame && !event.isSameDocument) evidence.documentGenerationChanges++
  }
  window.webContents.on('did-start-navigation', navigation)
  let issue: string | null = null
  let loadedIdentity: DesktopClientObservation['main'] | null = null
  let lastTerminalObservation: unknown = null
  let originalRunCountAtRestore = 0
  let lastTarget: Terminal | undefined
  let failedPresentation: unknown = null
  let lastRestoreObservation: unknown = null
  try {
    const fixture: Fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
    const [visible, , alternate] = fixture.runs
    if (!visible || !alternate || visible.workspaceId === alternate.workspaceId) throw new Error('Missing original Terminal fixture targets.')
    const snapshot = await waitFor('the restored Renderer workbench and Core topology revision', async () => {
      const signal = AbortSignal.timeout(4_000)
      const receipt = await rpc.call('app.inspect', {}, { signal }).catch(error => {
        const code = (error as { code?: string }).code
        if (signal.aborted || code === 'CONTROL_TIMEOUT') {
          lastRestoreObservation = { code: code ?? 'READ_DEADLINE' }
          return undefined
        }
        throw error
      })
      if (!receipt) return undefined
      const { observation } = receipt
      const inspected = parseDesktopClientObservation(observation)
      if (inspected.main.pid !== process.pid) throw new Error('Workbench observation belongs to a different Desktop Main process.')
      const state = inspected.workbench
      lastRestoreObservation = { loading: state.loading, revision: state.persistence?.spatial.revision ?? null, tabCount: state.tabs.length }
      if (state.loading || (state.persistence?.spatial.revision ?? 0) < fixture.revision) return undefined
      loadedIdentity = inspected.main
      return state
    }, 40_000)
    evidence.fixtureRevision = snapshot.persistence?.spatial.revision ?? 0
    const tabs = new Map(snapshot.tabs.map(tab => [tab.id, tab]))
    const projected = fixture.tabs.filter(expected => {
      const tab = tabs.get(expected.id)
      return tab?.workspaceId === expected.workspaceId && tab.regions.some(region => region.regionId === expected.regionId) &&
        snapshot.layouts[expected.workspaceId]?.groups.some(group => group.id === expected.groupId && group.tabOrder.includes(expected.id))
    })
    evidence.restoredTabs = projected.length
    evidence.restoredRegions = projected.reduce((sum, tab) => sum + (tabs.get(tab.id)?.regions.length ?? 0), 0)
    evidence.restoredWorkspaces = new Set(projected.map(tab => tab.workspaceId)).size
    evidence.rendererPid = window.webContents.getOSProcessId()
    const client = runtime.rpcClients().find(item => item.hostId === 'local')?.client
    if (!client) throw new Error('Original local Core consumer unavailable.')

    const runFacts = async (terminal: Terminal) => {
      const { run } = await client.runtimeSubject({ kind: 'terminal-run', runId: terminal.runId })
      if (!run || run.runId !== terminal.runId || run.pid !== terminal.pid || run.state !== 'running') {
        throw new Error(`Original fixture Run ${terminal.runId} is unavailable or changed identity.`)
      }
      return run
    }
    originalRunCountAtRestore = (await Promise.all(fixture.runs.map(runFacts))).length
    const ready = async (terminal: Terminal) => await waitFor(`visible input-ready Terminal ${terminal.regionId}`, async () => {
      const view = await inspectTerminal(terminal.regionId, AbortSignal.timeout(3_000))
      lastTerminalObservation = { regionId: terminal.regionId, view: view ?? null }
      return view?.runId === terminal.runId && view.visible && view.liveReady && view.acceptsInput && !view.readOnly &&
        view.buffer.baseY > 0 ? view : undefined
    })
    const selectTerminal = async (terminal: Terminal) => {
      lastTarget = terminal
      await selectWorkspace(window, terminal.workspaceId)
      return await ready(terminal)
    }
    const echo = async (terminal: Terminal, key: string) => {
      const before = await runFacts(terminal)
      const selector = `[data-workbench-region-id=${JSON.stringify(terminal.regionId)}] .xterm-helper-textarea`
      const focused = await window.webContents.executeJavaScript(`(() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        if (!target || !target.getClientRects().length) return false;
        target.focus(); return document.activeElement === target && document.hasFocus();
      })()`)
      if (!focused) throw new Error(`Original Terminal ${terminal.regionId} did not take real keyboard focus.`)
      window.webContents.sendInputEvent({ type: 'char', keyCode: key })
      return await waitFor(`same-Run PTY echo after keyboard input ${key}`, async () => {
        const replay = await client.readRunReplay({ runId: terminal.runId }, before.latestOutputBytes, 'raw')
        if (replay.run.runId !== terminal.runId || replay.run.pid !== terminal.pid || replay.gap) return undefined
        const bytes = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes)))
        return bytes.includes(`resource-probe-echo:${key}`) ? replay.run.latestOutputBytes - before.latestOutputBytes : undefined
      })
    }

    if (!window.isVisible()) throw new Error('The representative Desktop window is not visible.')
    if (process.platform === 'darwin') app.focus({ steal: true })
    window.moveTop()
    window.focus()
    window.webContents.focus()
    await selectTerminal(visible)
    evidence.visibleRunId = visible.runId
    evidence.alternateRunId = alternate.runId
    evidence.warmInputEcho = await echo(visible, 'w') > 0
    const warmStart = await Promise.all(fixture.runs.map(runFacts))
    await sampleWindow(window, warm, REPRESENTATIVE_WARM_MS, documentGeneration)
    const warmEnd = await Promise.all(fixture.runs.map(runFacts))

    const activityStart = performance.now()
    const sampling = sampleWindow(window, activity, REPRESENTATIVE_ACTIVITY_MS, documentGeneration)
    try {
      evidence.burstOutputBytes = await echo(visible, 'p')
      await selectTerminal(alternate)
      evidence.alternateInputEcho = await echo(alternate, 'a') > 0
      await selectTerminal(visible)
      evidence.returnedInputEcho = await echo(visible, 'r') > 0
      evidence.activityFinishedMs = Math.ceil(performance.now() - activityStart)
    } finally {
      await sampling
    }
    const final = await Promise.all(fixture.runs.map(runFacts))
    evidence.restoredRuns = fixture.runs.map((run, index) => ({
      ...run, warmStartOutputBytes: warmStart[index]!.latestOutputBytes,
      warmOutputBytes: warmEnd[index]!.latestOutputBytes, finalOutputBytes: final[index]!.latestOutputBytes
    }))
  } catch (error) {
    issue = error instanceof Error ? error.message : String(error)
    if (lastTarget && !window.isDestroyed()) {
      const region = `[data-workbench-region-id=${JSON.stringify(lastTarget.regionId)}]`
      const workspace = `.workspace-workbench-slot[data-workspace-id=${JSON.stringify(lastTarget.workspaceId)}]`
      failedPresentation = await window.webContents.executeJavaScript(`(() => ({
        documentVisibility: document.visibilityState, documentFocused: document.hasFocus(),
        workspaceVisible: document.querySelector(${JSON.stringify(workspace)})?.getAttribute('data-visible') ?? null,
        regionRects: document.querySelector(${JSON.stringify(region)})?.getClientRects().length ?? null
      }))()`).catch(() => null)
    }
  } finally {
    window.webContents.off('did-start-navigation', navigation)
    await rpc.dispose()
  }
  return { ...evaluateRepresentativeResourceBudget(evidence), loadedIdentity, originalRunCountAtRestore,
    lastRestoreObservation, lastTerminalObservation, failedPresentation, evidence, issue }
}
