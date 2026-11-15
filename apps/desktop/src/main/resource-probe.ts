import { writeFile } from 'node:fs/promises'
import { app, webContents, type BrowserWindow } from 'electron'
import type { AgentMuxTerminalViewObservation } from '@agentmux/core'
import {
  isScratchWorkspaceId,
  type AppConfig,
  type SessionControl,
  type SessionSnapshot
} from '../shared/contracts.js'
import {
  DESKTOP_SESSION_ATTRIBUTE,
  desktopActionSelector
} from '../shared/desktop-actions.js'
import { ConfigStore } from './config-store.js'
import { RuntimeController } from './runtime-controller.js'
import { workspaceFileObserverCount } from './workspace-files.js'

const MAX_TERMINAL_INCREMENT_KIB = 256 * 1024
const MAX_EDITOR_INCREMENT_KIB = 512 * 1024
const MAX_BROWSER_INCREMENT_KIB = 256 * 1024
const MAX_BROWSER_RELEASED_INCREMENT_KIB = 256 * 1024
const MAX_RELEASED_TOTAL_KIB = 1024 * 1024
const MIN_EXPECTED_IDLE_KIB = 448 * 1024
const MAX_RELEASED_INCREMENT_KIB = MAX_RELEASED_TOTAL_KIB - MIN_EXPECTED_IDLE_KIB
const MAX_RELEASE_DRIFT_KIB = 128 * 1024
const RELEASE_WARMUP_CYCLES = 2
const RELEASE_CYCLES = 7
const RESOURCE_PROBE_DEBUG = process.env.AGENTMUX_DESKTOP_RESOURCE_DEBUG === '1'

/**
 * These limits are reference points for comparing receipts, not product SLOs.
 * Chromium helpers and the macOS allocator can legitimately retain working-set
 * pages between samples, so a single observed value must never fail the probe.
 */
const WORKING_SET_DIAGNOSTIC_NOTE =
  'Reference working-set limits are diagnostic only; allocator/Chromium high-water marks do not fail the probe or prove a leak.'

function traceResourceProbe(message: string): void {
  if (RESOURCE_PROBE_DEBUG) process.stderr.write(`[resource-probe] ${message}\n`)
}

/**
 * Report an observation against a reference limit WITHOUT deciding pass/fail. This is the
 * diagnostics path: `exceeded` is a reported flag, never a thrown gate. Chromium helpers and the
 * macOS allocator legitimately retain working-set pages, so an over-limit reading must surface in
 * the receipt (`diagnostics.exceededWorkingSetDiagnostics`) and let the probe keep running — it
 * must never abort the run. Exported so a behavior test can execute this exact function and prove
 * an over-limit input still returns rather than throws (a source grep cannot see that);
 * resource-probe-behavior.test.ts is the sole consumer of the export.
 */
export function diagnosticWorkingSet(actualKiB: number, limitKiB: number): {
  actualKiB: number
  limitKiB: number
  exceeded: boolean
} {
  return {
    actualKiB,
    limitKiB,
    exceeded: actualKiB > limitKiB
  }
}

type ResourceOwners = {
  browserWebContents: number
  monacoEditors: number | null
  monacoModels: number | null
  monacoState: 'cold' | 'observed' | 'missing'
  documents: number
  fileWatchers: number
  runtimeSubscriptions: number
  terminalViews: number
  terminalAddons: number
  terminalListeners: number
  sessionAttachmentOwners: number
  sessionAttachmentLeases: number
}

type ResourceIdentity = {
  agentmuxCommit: string | null
  electron: string
  ctxmuxManifest: {
    sourceCommit: string | null
    sourceTree: string | null
    protocolVersion: string | null
    artifactPlatform: string | null
    daemonSha256: string | null
  } | null
  platform: string
}

type RendererMemoryObservation = {
  supported: boolean
  gcAvailable: boolean
  heapUsedBeforeKiB: number | null
  heapUsedAfterGcKiB: number | null
  heapTotalKiB: number | null
  note: string
}

type ResourceAttribution = {
  coreCtxmux: {
    sessionCount: number
    runCount: number
    runningRunCount: number
    attachmentOwners: number
    attachmentLeases: number
    runtimeSubscriptions: number
    note: string
  }
  rendererMainSurface: {
    terminalViews: number
    terminalAddons: number
    terminalListeners: number
    monacoEditors: number | null
    monacoModels: number | null
    monacoState: ResourceOwners['monacoState']
    documents: number
    fileWatchers: number
    browserWebContents: number
    processWorkingSetKiB: {
      main: number
      renderer: number
      gpu: number
      utility: number
      other: number
    }
    note: string
  }
}

type ResourceSample = {
  label: string
  surface: 'idle' | 'workspace' | 'terminal' | 'monaco' | 'browser' | 'release'
  totalWorkingSetKiB: number
  owners: ResourceOwners
  identity: ResourceIdentity
  attribution: ResourceAttribution
  rendererMemory: RendererMemoryObservation
  processes: Array<{
    pid: number
    type: string
    workingSetKiB: number
    privateKiB: number
  }>
}

function resourceIdentity(): ResourceIdentity {
  let supplied: Record<string, unknown> = {}
  try {
    const raw = process.env.AGENTMUX_DESKTOP_RESOURCE_IDENTITY
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') supplied = parsed as Record<string, unknown>
    }
  } catch {
    // Keep measured facts useful even if the optional identity envelope is malformed; the
    // harness receipt will expose the missing fields instead of inventing them.
  }
  const ctxmux = supplied.ctxmux && typeof supplied.ctxmux === 'object'
    ? supplied.ctxmux as Record<string, unknown>
    : null
  const text = (value: unknown): string | null => (
    typeof value === 'string' && value.length > 0
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : null
  )
  return {
    agentmuxCommit: text(supplied.agentmuxCommit),
    electron: process.versions.electron,
    ctxmuxManifest: ctxmux
      ? {
          sourceCommit: text(ctxmux.sourceCommit),
          sourceTree: text(ctxmux.sourceTree),
          protocolVersion: text(ctxmux.protocolVersion),
          artifactPlatform: text(ctxmux.artifactPlatform),
          daemonSha256: text(ctxmux.daemonSha256)
        }
      : null,
    platform: text(supplied.platform) ?? `${process.platform}-${process.arch}`
  }
}

function surfaceForLabel(label: string): ResourceSample['surface'] {
  const normalized = label.toLocaleLowerCase()
  if (normalized.includes('browser')) return 'browser'
  if (normalized.includes('monaco') || normalized.includes('editor')) return 'monaco'
  if (normalized.includes('terminal') || normalized.includes('xterm')) return 'terminal'
  if (normalized.includes('release')) return 'release'
  if (normalized.includes('workspace') || normalized.includes('hidden')) return 'workspace'
  return 'idle'
}

async function ownerCounts(
  window: BrowserWindow,
  runtime: RuntimeController
): Promise<ResourceOwners> {
  const { monacoSourceRequested, monacoRegistryPresent, ...renderer } = await window.webContents.executeJavaScript(`(() => {
    const event = new CustomEvent('agentmux:resource-owner-counts', { detail: { observed: false } })
    window.dispatchEvent(event)
    if (!event.detail.observed) throw new Error('Renderer resource owner observer is not installed')
    const { observed: _observed, ...owners } = event.detail
    return owners
  })()`) as {
    monacoEditors: number | null
    monacoModels: number | null
    monacoSourceRequested: boolean
    monacoRegistryPresent: boolean
    documents: number
    runtimeSubscriptions: number
    terminalViews: number
    terminalAddons: number
    terminalListeners: number
  }
  const { monacoEditors, monacoModels, ...otherRenderer } = renderer
  const observed = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0
  const owners = {
    browserWebContents: webContents.getAllWebContents().filter((item) => item !== window.webContents).length,
    fileWatchers: workspaceFileObserverCount(),
    ...otherRenderer,
    ...runtime.resourceOwnerCounts()
  }
  for (const [name, value] of Object.entries(owners)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid resource owner count for ${name}.`)
    }
  }
  const monacoState = monacoRegistryPresent === true && observed(monacoEditors) && observed(monacoModels)
    ? 'observed'
    : monacoSourceRequested === false && monacoRegistryPresent === false && monacoEditors === null && monacoModels === null
      ? 'cold' : 'missing'
  return { ...owners, monacoState, monacoEditors, monacoModels }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000
): Promise<void> {
  traceResourceProbe(`wait:start ${description}`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  traceResourceProbe(`wait:timeout ${description}`)
  throw new Error(`Timed out waiting for ${description}.`)
}

async function sample(
  label: string,
  window: BrowserWindow,
  runtime: RuntimeController,
  config: AppConfig,
  identity: ResourceIdentity
): Promise<ResourceSample> {
  traceResourceProbe(`sample:start ${label}`)
  await delay(500)
  const snapshots = []
  for (let index = 0; index < 5; index += 1) {
    snapshots.push(app.getAppMetrics())
    await delay(200)
  }
  const latest = snapshots.at(-1) ?? []
  const byPid = new Map<number, number[]>()
  for (const current of snapshots) {
    for (const metric of current) {
      const values = byPid.get(metric.pid) ?? []
      values.push(metric.memory.workingSetSize)
      byPid.set(metric.pid, values)
    }
  }
  const processes = latest.map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    workingSetKiB: Math.round((byPid.get(metric.pid) ?? [metric.memory.workingSetSize])
      .reduce((sum, value) => sum + value, 0) / (byPid.get(metric.pid)?.length ?? 1)),
    privateKiB: metric.memory.privateBytes ?? 0
  }))
  const owners = await ownerCounts(window, runtime)
  const snapshot = await runtime.snapshot(config)
  const processWorkingSetKiB: ResourceAttribution['rendererMainSurface']['processWorkingSetKiB'] = {
    main: 0,
    renderer: 0,
    gpu: 0,
    utility: 0,
    other: 0
  }
  for (const process of processes) {
    const type = process.type.toLocaleLowerCase()
    const bucket: keyof typeof processWorkingSetKiB = type.includes('gpu')
      ? 'gpu'
      : type.includes('utility')
        ? 'utility'
        : type.includes('renderer') || type === 'tab'
          ? 'renderer'
          : type === 'browser' || type === 'main'
            ? 'main'
            : 'other'
    processWorkingSetKiB[bucket] += process.workingSetKiB
  }
  const runIds = new Set(snapshot.sessions.map((session) => session.control.run.runId))
  return {
    label,
    surface: surfaceForLabel(label),
    totalWorkingSetKiB: processes.reduce((sum, process) => sum + process.workingSetKiB, 0),
    owners,
    identity: structuredClone(identity),
    attribution: {
      coreCtxmux: {
        sessionCount: snapshot.sessions.length,
        runCount: runIds.size,
        runningRunCount: snapshot.sessions.filter((session) => session.processState === 'running').length,
        attachmentOwners: owners.sessionAttachmentOwners,
        attachmentLeases: owners.sessionAttachmentLeases,
        runtimeSubscriptions: owners.runtimeSubscriptions,
        note: 'Core/ctxmux lifecycle and attachment facts; these counts are not Renderer/Main memory.'
      },
      rendererMainSurface: {
        terminalViews: owners.terminalViews,
        terminalAddons: owners.terminalAddons,
        terminalListeners: owners.terminalListeners,
        monacoState: owners.monacoState,
        monacoEditors: owners.monacoEditors,
        monacoModels: owners.monacoModels,
        documents: owners.documents,
        fileWatchers: owners.fileWatchers,
        browserWebContents: owners.browserWebContents,
        processWorkingSetKiB,
        note: 'Renderer/Main surface owner counts and process working-set observations; Browser helpers/shared pages are not assigned to Terminal or Monaco.'
      }
    },
    rendererMemory: await rendererMemory(window),
    processes
  }
}

async function rendererBoolean(window: BrowserWindow, source: string): Promise<boolean> {
  return await window.webContents.executeJavaScript(`Boolean(${source})`) as boolean
}

async function rendererProbeSummary(window: BrowserWindow): Promise<string> {
  try {
    const summary = await window.webContents.executeJavaScript(`(() => ({
      url: location.href,
      activeWorkspace: document.querySelector('.project-rail-row--active')?.getAttribute('data-workspace-id'),
      activeWorkspaceRows: [...document.querySelectorAll('.project-rail-row')].map((row) => ({
        id: row.getAttribute('data-workspace-id'),
        active: row.classList.contains('project-rail-row--active'),
        text: row.textContent
      })),
      slots: [...document.querySelectorAll('.workspace-workbench-slot[data-workspace-id]')].map((slot) => ({
        id: slot.getAttribute('data-workspace-id'),
        visible: slot.getAttribute('data-visible'),
        editors: slot.querySelectorAll('.monaco-editor').length,
        unavailable: slot.querySelectorAll('.pane-state--error').length,
        tabs: [...slot.querySelectorAll('[data-workbench-tab-id]')].map((tab) => ({
          id: tab.getAttribute('data-workbench-tab-id'),
          active: tab.getAttribute('aria-selected'),
          text: tab.textContent
        }))
      })),
      fileRows: [...document.querySelectorAll('[data-tree-path="resource-probe.ts"]')].map((row) => ({
        text: row.textContent,
        connected: row.isConnected,
        selected: row.getAttribute('aria-selected'),
        tabIndex: row.getAttribute('tabindex')
      })),
      errors: [...document.querySelectorAll('[role="alert"], .error-toast, .app-error')].map((node) => node.textContent),
      body: document.body.innerText.slice(-1200)
    }))()`)
    return JSON.stringify(summary)
  } catch (error) {
    return `summary unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function rendererMemory(window: BrowserWindow): Promise<RendererMemoryObservation> {
  try {
    return await window.webContents.executeJavaScript(`(() => {
      const memory = globalThis.performance?.memory
      const gcAvailable = typeof globalThis.gc === 'function'
      const heapUsedBefore = typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null
      if (gcAvailable) {
        try { globalThis.gc() } catch { /* expose-gc may be present but unavailable in a sandbox */ }
      }
      const heapUsedAfterGc = typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null
      const heapTotal = typeof memory?.totalJSHeapSize === 'number' ? memory.totalJSHeapSize : null
      return {
        supported: memory !== undefined,
        gcAvailable,
        heapUsedBeforeKiB: heapUsedBefore === null ? null : Math.round(heapUsedBefore / 1024),
        heapUsedAfterGcKiB: heapUsedAfterGc === null ? null : Math.round(heapUsedAfterGc / 1024),
        heapTotalKiB: heapTotal === null ? null : Math.round(heapTotal / 1024),
        note: gcAvailable
          ? 'heapUsedAfterGc is an observation; RSS/working-set may retain allocator pages.'
          : 'Renderer heap metrics or expose-gc are unavailable; RSS/working-set is observation-only.'
      }
    })()`)
  } catch (error) {
    return {
      supported: false,
      gcAvailable: false,
      heapUsedBeforeKiB: null,
      heapUsedAfterGcKiB: null,
      heapTotalKiB: null,
      note: `Renderer heap observation unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

async function click(window: BrowserWindow, source: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => { const target = ${source}; target?.click(); return Boolean(target) })()`)
  if (!clicked) throw new Error(`Desktop resource probe could not find UI control: ${source}`)
}

type ProbeFileOccurrence = { tabId: string; regionId: string }

async function observeProbeFile(window: BrowserWindow, workspaceId: string, path: string): Promise<ProbeFileOccurrence | null> {
  return await window.webContents.executeJavaScript(`(() => {
    const event = new CustomEvent('agentmux:resource-owner-counts', { detail: { observed: false, file: ${JSON.stringify({ workspaceId, path })} } })
    window.dispatchEvent(event)
    if (!event.detail.observed || event.detail.occurrence === undefined) throw new Error('Original File occurrence observation is unavailable')
    return event.detail.occurrence
  })()`) as ProbeFileOccurrence | null
}

async function openProbeFile(window: BrowserWindow, workspaceId: string, path: string, description: string): Promise<ProbeFileOccurrence> {
  const rowSelector = `[data-tree-path=${JSON.stringify(path)}]`
  const rowSource = `[...document.querySelectorAll(${JSON.stringify(rowSelector)})].find(row => row.getClientRects().length > 0 && !row.closest('[hidden], [inert]'))`
  await waitFor(`${description} resource probe file row`, () => rendererBoolean(window, rowSource))
  if (await observeProbeFile(window, workspaceId, path)) throw new Error(`${description} file is already open before its FileExplorer action.`)
  await click(window, rowSource)
  let occurrence: ProbeFileOccurrence | null = null
  await waitFor(`${description} original File occurrence`, async () => {
    occurrence = await observeProbeFile(window, workspaceId, path)
    return Boolean(occurrence)
  })
  if (!occurrence) throw new Error(`${description} original File occurrence is unconfirmed.`)
  return occurrence
}

function hasEditorOwners(owners: ResourceOwners, baseline: ResourceOwners): boolean {
  // The active Terminal may drop its visible WebGL owner while the File is in front.
  return owners.terminalAddons <= baseline.terminalAddons && owners.terminalAddons >= baseline.terminalAddons - 1 &&
    ownersEqual(owners, { ...baseline, terminalAddons: owners.terminalAddons,
      monacoState: 'observed', monacoEditors: 1, monacoModels: 1, documents: 1, fileWatchers: 1 })
}

async function waitForProbeEditor(window: BrowserWindow, runtime: RuntimeController, file: ProbeFileOccurrence, baseline: ResourceOwners, description: string): Promise<void> {
  const selector = `[data-workbench-region-id=${JSON.stringify(file.regionId)}] .monaco-editor`
  let latest: ResourceOwners | undefined
  await waitFor(`${description} original Monaco editor and model owners`, async () => {
    latest = await ownerCounts(window, runtime)
    return hasEditorOwners(latest, baseline) && await rendererBoolean(window,
      `[...document.querySelectorAll(${JSON.stringify(selector)})].some(editor => editor.getClientRects().length > 0 && !editor.closest('[hidden], [inert]'))`)
  }).catch(error => {
    throw new Error(`${description} Monaco owner coverage is unconfirmed: ${JSON.stringify(latest)}`, { cause: error })
  })
}

async function closeProbeFile(window: BrowserWindow, runtime: RuntimeController, workspaceId: string, path: string,
  file: ProbeFileOccurrence, expected: ResourceOwners, description: string): Promise<void> {
  const closeSelector = `.workbench-tab[data-workbench-tab-id=${JSON.stringify(file.tabId)}] .workbench-tab__close`
  await click(window, `document.querySelector(${JSON.stringify(closeSelector)})`)
  let latest: ResourceOwners | undefined
  await waitFor(`${description} original File and editor owner release`, async () => {
    latest = await ownerCounts(window, runtime)
    return ownersEqual(latest, expected) && !await observeProbeFile(window, workspaceId, path)
  }).catch(error => {
    throw new Error(`${description} File owner release did not converge: ${JSON.stringify(latest)}`, { cause: error })
  })
}

async function stopProbeTerminalTab(description: string, window: BrowserWindow, runtime: RuntimeController,
  workspaceId: string, terminal: SessionSnapshot): Promise<void> {
  const workspace = workspaceSlotSelector(workspaceId)
  const sessionSelector = `${workspace} .workbench-tab[${DESKTOP_SESSION_ATTRIBUTE}=${JSON.stringify(terminal.id)}]`
  const tabId = await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(sessionSelector)})?.getAttribute('data-workbench-tab-id')`
  ) as unknown
  if (typeof tabId !== 'string' || !tabId) throw new Error(`${description} original Terminal Tab was not found.`)
  const control = terminal.control
  const receipt = await runtime.stopSession(control)
  if (control.kind !== 'terminal' || !receipt || !('action' in receipt) || receipt.action !== 'terminal-stop' ||
      receipt.target.run.runId !== control.runId || receipt.target.hostId !== control.hostId || receipt.phase !== 'settled' ||
      !((receipt.outcome === 'applied' && receipt.acknowledgement?.kind === 'stop') ||
        (receipt.outcome === 'no-op' && receipt.acknowledgement?.kind === 'stop-absent')) ||
      receipt.acknowledgement.runId !== control.runId) {
    throw new Error(`${description} did not confirm the original Native Terminal Stop.`)
  }
  const tabSelector = `${workspace} [data-workbench-tab-id=${JSON.stringify(tabId)}]`
  await waitFor(`${description} original Terminal Tab removal`, async () => !await rendererBoolean(
    window, `document.querySelector(${JSON.stringify(tabSelector)})`
  ))
}

function ownersEqual(left: ResourceOwners, right: ResourceOwners): boolean {
  return left.monacoState !== 'missing' && Object.entries(left).every(([name, value]) => right[name as keyof ResourceOwners] === value)
}

function isReadyLauncherOwnerBaseline(owners: ResourceOwners): boolean {
  return (
    owners.browserWebContents === 0 &&
    (owners.monacoState === 'cold' || (owners.monacoState === 'observed' && owners.monacoEditors === 0 && owners.monacoModels === 0)) &&
    owners.documents === 0 &&
    owners.fileWatchers === 0 &&
    owners.runtimeSubscriptions === 4 &&
    owners.terminalViews === 1 &&
    owners.terminalAddons >= 1 &&
    owners.terminalListeners >= 1 &&
    owners.sessionAttachmentOwners === 1 &&
    owners.sessionAttachmentLeases === 1
  )
}

function runningTerminal(sessions: readonly SessionSnapshot[], sessionId: string): SessionSnapshot | null {
  return sessions.find((session) => (
    session.id === sessionId && session.kind === 'terminal' && session.processState === 'running'
  )) ?? null
}

function sameTerminalRun(current: SessionSnapshot, expected: SessionSnapshot): boolean {
  return current.control.kind === 'terminal' && expected.control.kind === 'terminal' &&
    current.control.hostId === expected.control.hostId && current.control.runId === expected.control.runId
}

const claimTerminalSelector = desktopActionSelector('claimReusableTerminal')
const readyTerminalSelector = `${claimTerminalSelector}[${DESKTOP_SESSION_ATTRIBUTE}]`
const openBrowserSelector = desktopActionSelector('openBrowser')

function workspaceSlotSelector(workspaceId: string): string {
  return `.workspace-workbench-slot[data-workspace-id=${JSON.stringify(workspaceId)}]`
}

async function openProbeLauncher(window: BrowserWindow, workspaceId: string): Promise<void> {
  const selector = `${workspaceSlotSelector(workspaceId)}[data-visible="true"] button[aria-label="New Tab"]`
  const source = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(button => ` +
    `!button.disabled && button.getClientRects().length > 0 && !button.closest('[hidden], [inert]'))`
  await waitFor('visible Workspace New Tab control', () => rendererBoolean(window, source))
  await click(window, source)
}

async function launcherTerminalSessionId(window: BrowserWindow, workspaceId?: string): Promise<string | null> {
  const root = workspaceId
    ? `document.querySelector(${JSON.stringify(workspaceSlotSelector(workspaceId))})`
    : 'document'
  const value = await window.webContents.executeJavaScript(
    `${root}?.querySelector(${JSON.stringify(readyTerminalSelector)})?.getAttribute(${JSON.stringify(DESKTOP_SESSION_ATTRIBUTE)}) ?? null`
  ) as unknown
  return typeof value === 'string' && value.length > 0 ? value : null
}

function desktopActionSource(selector: string, sessionId?: string, workspaceId?: string): string {
  const root = workspaceId
    ? `document.querySelector(${JSON.stringify(workspaceSlotSelector(workspaceId))})`
    : 'document'
  if (!sessionId) return `${root}?.querySelector(${JSON.stringify(selector)})`
  return `[...(${root}?.querySelectorAll(${JSON.stringify(selector)}) ?? [])].find((button) => ` +
    `button.getAttribute(${JSON.stringify(DESKTOP_SESSION_ATTRIBUTE)}) === ${JSON.stringify(sessionId)})`
}

async function waitForReadyLauncherTerminal(options: {
  description: string
  window: BrowserWindow
  runtime: RuntimeController
  config: AppConfig
  workspaceId?: string
  usedSessionIds?: ReadonlySet<string>
  expectedTerminal?: SessionSnapshot
  expectedOwners?: ResourceOwners
  ownerPredicate?: (owners: ResourceOwners) => boolean
}): Promise<SessionSnapshot> {
  let ready: SessionSnapshot | null = null
  let sessionId: string | null = null
  let running = false
  let observedOwners: ResourceOwners | null = null
  await waitFor(options.description, async () => {
    sessionId = await launcherTerminalSessionId(options.window, options.workspaceId)
    if (
      !sessionId ||
      options.usedSessionIds?.has(sessionId) ||
      (options.expectedTerminal && sessionId !== options.expectedTerminal.id)
    ) return false
    const current = runningTerminal((await options.runtime.snapshot(options.config)).sessions, sessionId)
    running = current !== null
    if (!current || (options.expectedTerminal && !sameTerminalRun(current, options.expectedTerminal))) return false
    const owners = observedOwners = await ownerCounts(options.window, options.runtime)
    if (options.expectedOwners
      ? !ownersEqual(owners, options.expectedOwners)
      : options.ownerPredicate
        ? !options.ownerPredicate(owners)
        : !isReadyLauncherOwnerBaseline(owners)) {
      return false
    }
    ready = current
    return true
  }).catch(async error => {
    traceResourceProbe(`${options.description}: ${JSON.stringify({ sessionId, running, owners: observedOwners })}`)
    if (RESOURCE_PROBE_DEBUG) traceResourceProbe(await rendererProbeSummary(options.window))
    throw error
  })
  if (!ready) throw new Error(`Desktop resource probe lost ${options.description}.`)
  return ready
}

async function claimLauncherTerminal(
  description: string,
  window: BrowserWindow,
  runtime: RuntimeController,
  terminal: SessionSnapshot,
  expectedOwners: ResourceOwners,
  workspaceId?: string
): Promise<void> {
  await click(window, desktopActionSource(claimTerminalSelector, terminal.id, workspaceId))
  let remainingLauncher: string | null = null
  let openedTerminal = false
  let observedOwners: ResourceOwners | null = null
  await waitFor(description, async () => {
    remainingLauncher = await launcherTerminalSessionId(window, workspaceId)
    if (remainingLauncher === terminal.id) return false
    openedTerminal = await rendererBoolean(window, workspaceId
      ? `document.querySelector(${JSON.stringify(`${workspaceSlotSelector(workspaceId)} .terminal-view .xterm`)})`
      : "document.querySelector('.terminal-view .xterm')")
    if (!openedTerminal) return false
    observedOwners = await ownerCounts(window, runtime)
    return ownersEqual(observedOwners, expectedOwners)
  }).catch(async error => {
    traceResourceProbe(`${description}: ${JSON.stringify({ remainingLauncher, openedTerminal, observedOwners, expectedOwners })}`)
    if (RESOURCE_PROBE_DEBUG) traceResourceProbe(await rendererProbeSummary(window))
    throw error
  })
}

export async function selectWorkspace(window: BrowserWindow, workspaceId: string): Promise<void> {
  await click(window, `document.querySelector(${JSON.stringify(`.project-rail-row[data-workspace-id=${JSON.stringify(workspaceId)}]`)})`)
  await waitFor(`Workspace ${workspaceId} to become visible`, () => rendererBoolean(
    window,
    `document.querySelector(${JSON.stringify(`${workspaceSlotSelector(workspaceId)}[data-visible="true"]`)})`
  ))
}

function launcherOwnerPredicate(
  previous: ResourceOwners,
  expectedAdditionalTerminalViews: number
): (owners: ResourceOwners) => boolean {
  return (owners) => (
    owners.browserWebContents === previous.browserWebContents &&
    owners.monacoState === previous.monacoState &&
    owners.monacoEditors === previous.monacoEditors &&
    owners.monacoModels === previous.monacoModels &&
    owners.documents === previous.documents &&
    owners.fileWatchers === previous.fileWatchers &&
    owners.runtimeSubscriptions === previous.runtimeSubscriptions &&
    owners.terminalViews === previous.terminalViews + expectedAdditionalTerminalViews &&
    owners.terminalAddons >= previous.terminalAddons &&
    owners.terminalListeners >= previous.terminalListeners &&
    owners.sessionAttachmentOwners === previous.sessionAttachmentOwners + expectedAdditionalTerminalViews &&
    owners.sessionAttachmentLeases === previous.sessionAttachmentLeases + expectedAdditionalTerminalViews
  )
}

export type ResourceProbeTerminalReader = (regionId: string, signal: AbortSignal) => Promise<AgentMuxTerminalViewObservation | undefined>

export async function runDesktopResourceProbe(options: {
  window: BrowserWindow
  runtime: RuntimeController
  configStore: ConfigStore
  inspectTerminal?: ResourceProbeTerminalReader
  startup: {
    spawnedAtMs: number
    appReadyAtMs: number
    windowCreationStartedAtMs: number
    rendererLoadedAtMs: number
  }
}): Promise<boolean> {
  const reportPath = process.env.AGENTMUX_DESKTOP_RESOURCE_REPORT
  if (!reportPath) return false
  const representativeFixture = process.env.AGENTMUX_DESKTOP_RESOURCE_WORKFACE
  if (representativeFixture) {
    if (!options.inspectTerminal) throw new Error('The private resource probe did not receive the Desktop Terminal observer.')
    const { measureRepresentativeWorkface } = await import('./representative-resource-probe.js')
    const representative = await measureRepresentativeWorkface(options.window, options.runtime, representativeFixture, options.inspectTerminal)
    await writeFile(reportPath, `${JSON.stringify({
      schema: 'agentmux.desktop-representative-resources.v1', measuredAt: new Date().toISOString(),
      mainPid: process.pid, identity: resourceIdentity(), representative
    }, null, 2)}\n`, { mode: 0o600 })
    return true
  }
  let terminalControl: SessionControl | null = null
  const activeTerminalControls = new Set<SessionControl>()
  let reportEvidence: Record<string, unknown> | null = null
  try {
    const config = await options.configStore.get()
    const identity = resourceIdentity()
    const measuredIds: unknown = JSON.parse(process.env.AGENTMUX_DESKTOP_RESOURCE_WORKSPACES ?? 'null')
    if (!Array.isArray(measuredIds) || measuredIds.length !== 3 || new Set(measuredIds).size !== 3 ||
        measuredIds.some(id => typeof id !== 'string' || isScratchWorkspaceId(id))) {
      throw new Error('Desktop resource probe requires three distinct measured workspace IDs.')
    }
    const [workspaceA, workspaceB, workspaceC] = measuredIds.map(id => config.workspaces.find(workspace => workspace.id === id))
    if (!workspaceA || !workspaceB || !workspaceC || !config.workspaces.some(workspace => isScratchWorkspaceId(workspace.id))) {
      throw new Error('Desktop resource probe requires the original measured workspaces and built-in Scratch workspace.')
    }
    if (config.workspaces[0]?.id !== workspaceA.id) {
      throw new Error('Desktop resource probe requires the measured workspace to be the active first workspace.')
    }
    const usedTerminalSessionIds = new Set<string>()
    let launcherTerminal = await waitForReadyLauncherTerminal({
      description: 'fresh ready reusable Terminal launcher',
      window: options.window,
      runtime: options.runtime,
      config,
      workspaceId: workspaceA.id
    })
    if (
      launcherTerminal.hostId !== workspaceA.hostId ||
      launcherTerminal.workspacePath !== workspaceA.path
    ) {
      throw new Error('Desktop resource probe reusable Terminal is not owned by the measured active workspace.')
    }
    const interactiveAtMs = Date.now()
    const startupTimes = [
      options.startup.spawnedAtMs,
      options.startup.appReadyAtMs,
      options.startup.windowCreationStartedAtMs,
      options.startup.rendererLoadedAtMs,
      interactiveAtMs
    ]
    if (startupTimes.some((value) => !Number.isFinite(value))) {
      throw new Error('Desktop startup timeline contains a non-finite timestamp.')
    }
    if (startupTimes.some((value, index) => index > 0 && value < startupTimes[index - 1]!)) {
      throw new Error('Desktop startup timeline is not monotonic.')
    }
    const idle = await sample('idle', options.window, options.runtime, config, identity)
    if (!isReadyLauncherOwnerBaseline(idle.owners)) {
      throw new Error(`Desktop ready reusable Terminal baseline is not clean: ${JSON.stringify(idle.owners)}`)
    }
    const readyLauncherOwners = idle.owners

    usedTerminalSessionIds.add(launcherTerminal.id)
    terminalControl = launcherTerminal.control
    activeTerminalControls.add(terminalControl)
    await claimLauncherTerminal(
      'reusable Terminal promotion in Workspace A',
      options.window,
      options.runtime,
      launcherTerminal,
      readyLauncherOwners,
      workspaceA.id
    )

    // Keep the first claimed terminal mounted while navigating to B. This is the real
    // single-hidden-workspace stage: Workspace A is hidden, its Run/Attachment remain live,
    // and Workspace B owns the newly warmed launcher.
    await selectWorkspace(options.window, workspaceB.id)
    let workspaceBLauncher = await waitForReadyLauncherTerminal({
      description: 'ready launcher in Workspace B',
      window: options.window,
      runtime: options.runtime,
      config,
      workspaceId: workspaceB.id,
      usedSessionIds: usedTerminalSessionIds,
      ownerPredicate: launcherOwnerPredicate(readyLauncherOwners, 1)
    })
    const singleHiddenOwners = await ownerCounts(options.window, options.runtime)
    const singleHiddenWorkspace = await sample(
      'single-hidden-workspace',
      options.window,
      options.runtime,
      config,
      identity
    )
    if (singleHiddenWorkspace.owners.terminalViews !== readyLauncherOwners.terminalViews + 1) {
      throw new Error(`Single-hidden-workspace stage did not retain one hidden Terminal view: ${JSON.stringify(singleHiddenWorkspace.owners)}`)
    }

    // Claim B, then add a second Tab in C. At the next sample A and B are hidden
    // Workspaces and C has a hidden terminal Tab plus its active launcher Tab.
    usedTerminalSessionIds.add(workspaceBLauncher.id)
    terminalControl = workspaceBLauncher.control
    activeTerminalControls.add(terminalControl)
    await claimLauncherTerminal(
      'reusable Terminal promotion in Workspace B',
      options.window,
      options.runtime,
      workspaceBLauncher,
      singleHiddenOwners,
      workspaceB.id
    )
    await selectWorkspace(options.window, workspaceC.id)
    let workspaceCLauncher = await waitForReadyLauncherTerminal({
      description: 'ready launcher in Workspace C',
      window: options.window,
      runtime: options.runtime,
      config,
      workspaceId: workspaceC.id,
      usedSessionIds: usedTerminalSessionIds,
      ownerPredicate: launcherOwnerPredicate(singleHiddenOwners, 1)
    })
    const ownersWithWorkspaceC = await ownerCounts(options.window, options.runtime)
    usedTerminalSessionIds.add(workspaceCLauncher.id)
    terminalControl = workspaceCLauncher.control
    activeTerminalControls.add(terminalControl)
    await claimLauncherTerminal(
      'reusable Terminal promotion in Workspace C',
      options.window,
      options.runtime,
      workspaceCLauncher,
      ownersWithWorkspaceC,
      workspaceC.id
    )
    const workspaceCPrimary = workspaceCLauncher
    await openProbeLauncher(options.window, workspaceC.id)
    workspaceCLauncher = await waitForReadyLauncherTerminal({
      description: 'second ready launcher Tab in Workspace C',
      window: options.window,
      runtime: options.runtime,
      config,
      workspaceId: workspaceC.id,
      usedSessionIds: usedTerminalSessionIds,
      ownerPredicate: launcherOwnerPredicate(ownersWithWorkspaceC, 1)
    })
    const multipleHiddenWorkspaceOwners = await ownerCounts(options.window, options.runtime)
    const multipleHiddenWorkspacesTabs = await sample(
      'multiple-hidden-workspaces-tabs',
      options.window,
      options.runtime,
      config,
      identity
    )
    const hiddenTopology = await options.window.webContents.executeJavaScript(`(() => ({
      workspaceSlots: [...document.querySelectorAll('.workspace-workbench-slot[data-workspace-id]')]
        .map((slot) => ({
          id: slot.getAttribute('data-workspace-id'),
          visible: slot.getAttribute('data-visible') === 'true',
          tabs: slot.querySelectorAll('[data-workbench-tab-id]').length,
          terminalTabs: slot.querySelectorAll('[${DESKTOP_SESSION_ATTRIBUTE}]').length
        })),
      hiddenWorkspaceCount: [...document.querySelectorAll('.workspace-workbench-slot[data-visible="false"]')].length
    }))()`) as {
      workspaceSlots: Array<{ id: string | null; visible: boolean; tabs: number; terminalTabs: number }>
      hiddenWorkspaceCount: number
    }
    if (multipleHiddenWorkspacesTabs.owners.terminalViews !== ownersWithWorkspaceC.terminalViews + 1) {
      throw new Error(`Multiple-hidden-workspaces/tabs stage did not add the second C Tab: ${JSON.stringify(multipleHiddenWorkspacesTabs.owners)}`)
    }
    if (
      hiddenTopology.hiddenWorkspaceCount < 2 ||
      hiddenTopology.workspaceSlots.filter((slot) => slot.tabs > 0 && !slot.visible).length < 2 ||
      hiddenTopology.workspaceSlots.some((slot) => slot.terminalTabs < 1)
    ) {
      throw new Error(`Multiple-hidden-workspaces/tabs topology was not established: ${JSON.stringify(hiddenTopology)}`)
    }
    usedTerminalSessionIds.add(workspaceCLauncher.id)
    terminalControl = workspaceCLauncher.control
    activeTerminalControls.add(terminalControl)
    await claimLauncherTerminal(
      'second Terminal Tab promotion in Workspace C',
      options.window,
      options.runtime,
      workspaceCLauncher,
      multipleHiddenWorkspaceOwners,
      workspaceC.id
    )
    // Leave the measurement Terminal as the sole Region in C's group for the release cycles.
    await stopProbeTerminalTab('hidden Workspace C Terminal', options.window, options.runtime, workspaceC.id, workspaceCPrimary)
    activeTerminalControls.delete(workspaceCPrimary.control)
    launcherTerminal = workspaceCLauncher
    const terminalBaselineOwners = await ownerCounts(options.window, options.runtime)
    const terminalBaseline = await sample('terminal-baseline', options.window, options.runtime, config, identity)
    const source = "process.stdout.write('t'.repeat(300000))"
    const terminalCommand = `ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}\r`
    await options.runtime.write(terminalControl, terminalCommand, 'user')
    await waitFor('bounded Terminal output', async () => {
      const current = runningTerminal((await options.runtime.snapshot(config)).sessions, launcherTerminal.id)
      return (current?.latestOutputBytes ?? 0) >= 300_000
    })
    const terminalSample = await sample('terminal', options.window, options.runtime, config, identity)
    if (!ownersEqual(terminalSample.owners, terminalBaselineOwners)) {
      throw new Error(`Desktop claimed Terminal owners diverged from the multiple-workspace baseline: ${JSON.stringify(terminalSample.owners)}`)
    }

    const filePath = 'resource-probe.ts'
    const firstFile = await openProbeFile(options.window, workspaceC.id, filePath, 'initial')
    traceResourceProbe(`after resource file click ${await rendererProbeSummary(options.window)}`)
    await waitForProbeEditor(options.window, options.runtime, firstFile, terminalBaselineOwners, 'initial')
    const editorSample = await sample('monaco', options.window, options.runtime, config, identity)
    if (!hasEditorOwners(editorSample.owners, terminalBaselineOwners)) {
      throw new Error(`Desktop editor did not own exactly one Document, Monaco Editor, and Monaco Model: ${JSON.stringify(editorSample.owners)}`)
    }
    if (!runningTerminal((await options.runtime.snapshot(config)).sessions, launcherTerminal.id)) {
      throw new Error('Desktop editor did not retain the claimed Terminal backend.')
    }

    const releaseBaselineOwners: ResourceOwners = {
      ...terminalBaselineOwners, monacoState: 'observed', monacoEditors: 0, monacoModels: 0
    }
    await closeProbeFile(options.window, options.runtime, workspaceC.id, filePath, firstFile, releaseBaselineOwners, 'initial')
    await stopProbeTerminalTab('first claimed Terminal', options.window, options.runtime, workspaceC.id, launcherTerminal)
    activeTerminalControls.delete(terminalControl)
    terminalControl = null
    await openProbeLauncher(options.window, workspaceC.id)
    launcherTerminal = await waitForReadyLauncherTerminal({
      description: 'fresh reusable Terminal after first release',
      window: options.window,
      runtime: options.runtime,
      config,
      usedSessionIds: usedTerminalSessionIds,
      workspaceId: workspaceC.id,
      expectedOwners: releaseBaselineOwners
    })
    const released = await sample('released-panes', options.window, options.runtime, config, identity)
    const releaseCycles = [released]
    for (let cycle = 1; cycle < RELEASE_CYCLES; cycle += 1) {
      const current = launcherTerminal
      usedTerminalSessionIds.add(current.id)
      terminalControl = current.control
      await claimLauncherTerminal(
        `cycle ${cycle} reusable Terminal promotion`,
        options.window,
        options.runtime,
        current,
        releaseBaselineOwners,
        workspaceC.id
      )
      await options.runtime.write(terminalControl, terminalCommand, 'user')
      await waitFor(`cycle ${cycle} bounded Terminal output`, async () => (
        (runningTerminal((await options.runtime.snapshot(config)).sessions, current.id)?.latestOutputBytes ?? 0) >= 300_000
      ))
      const file = await openProbeFile(options.window, workspaceC.id, filePath, `cycle ${cycle}`)
      traceResourceProbe(`cycle ${cycle} after resource file click ${await rendererProbeSummary(options.window)}`)
      await waitForProbeEditor(options.window, options.runtime, file, releaseBaselineOwners, `cycle ${cycle}`)
      await closeProbeFile(options.window, options.runtime, workspaceC.id, filePath, file, releaseBaselineOwners, `cycle ${cycle}`)
      await stopProbeTerminalTab(`cycle ${cycle} claimed Terminal`, options.window, options.runtime, workspaceC.id, current)
      activeTerminalControls.delete(terminalControl)
      terminalControl = null
      await openProbeLauncher(options.window, workspaceC.id)
      launcherTerminal = await waitForReadyLauncherTerminal({
        description: `cycle ${cycle} fresh reusable Terminal after release`,
        window: options.window,
        runtime: options.runtime,
        config,
        usedSessionIds: usedTerminalSessionIds,
        workspaceId: workspaceC.id,
        expectedOwners: releaseBaselineOwners
      })
      releaseCycles.push(await sample(`released-panes-${cycle + 1}`, options.window, options.runtime, config, identity))
    }
    const browserOwnerBefore = releaseBaselineOwners.browserWebContents
    const browserWarmTerminal = launcherTerminal
    await click(options.window, desktopActionSource(openBrowserSelector, undefined, workspaceC.id))
    const browserOwners: ResourceOwners = {
      ...releaseBaselineOwners,
      browserWebContents: browserOwnerBefore + 1,
      terminalViews: releaseBaselineOwners.terminalViews - 1,
      terminalAddons: releaseBaselineOwners.terminalAddons - readyLauncherOwners.terminalAddons,
      terminalListeners: releaseBaselineOwners.terminalListeners - readyLauncherOwners.terminalListeners,
      sessionAttachmentOwners: releaseBaselineOwners.sessionAttachmentOwners - 1,
      sessionAttachmentLeases: releaseBaselineOwners.sessionAttachmentLeases - 1
    }
    await waitFor('Browser WebContents and Launcher resource transition', async () => ownersEqual(await ownerCounts(options.window, options.runtime), browserOwners))
    const browser = await sample('browser', options.window, options.runtime, config, identity)
    if (!ownersEqual(browser.owners, browserOwners)) {
      throw new Error(`Desktop Browser did not release reusable Terminal view owners: ${JSON.stringify(browser.owners)}`)
    }
    const retainedBrowserTerminal = runningTerminal((await options.runtime.snapshot(config)).sessions, browserWarmTerminal.id)
    if (!retainedBrowserTerminal || !sameTerminalRun(retainedBrowserTerminal, browserWarmTerminal)) {
      throw new Error('Desktop Browser did not retain the reusable Terminal backend.')
    }
    await click(options.window, `document.querySelector(${JSON.stringify(`${workspaceSlotSelector(workspaceC.id)} [aria-label="Close New Tab"]`)})`)
    await waitFor('Browser WebContents release', async () => (
      (await ownerCounts(options.window, options.runtime)).browserWebContents === browserOwnerBefore
    ))
    await openProbeLauncher(options.window, workspaceC.id)
    launcherTerminal = await waitForReadyLauncherTerminal({
      description: 'same reusable Terminal after Browser release',
      window: options.window,
      runtime: options.runtime,
      config,
      workspaceId: workspaceC.id,
      expectedTerminal: browserWarmTerminal,
      expectedOwners: releaseBaselineOwners
    })
    const browserReleased = await sample('browser-released', options.window, options.runtime, config, identity)
    const warmupReleaseCycles = releaseCycles.slice(0, RELEASE_WARMUP_CYCLES)
    const steadyReleaseCycles = releaseCycles.slice(RELEASE_WARMUP_CYCLES)
    const ownerCleanReleaseSamples = [...releaseCycles, browserReleased]
    const maxReleasedWorkingSetKiB = Math.max(
      ...ownerCleanReleaseSamples.map((entry) => entry.totalWorkingSetKiB)
    )
    const maxReleasedIncrementKiB = maxReleasedWorkingSetKiB - released.totalWorkingSetKiB
    const totalReleaseDriftKiB = Math.max(...releaseCycles.map((entry) => entry.totalWorkingSetKiB)) -
      Math.min(...releaseCycles.map((entry) => entry.totalWorkingSetKiB))
    const warmupReleaseDriftKiB = Math.max(...warmupReleaseCycles.map((entry) => entry.totalWorkingSetKiB)) -
      Math.min(...warmupReleaseCycles.map((entry) => entry.totalWorkingSetKiB))
    const releaseDriftKiB = Math.max(...steadyReleaseCycles.map((entry) => entry.totalWorkingSetKiB)) -
      steadyReleaseCycles[0]!.totalWorkingSetKiB
    const workingSetDiagnostics = {
      terminalIncrement: diagnosticWorkingSet(
        terminalSample.totalWorkingSetKiB - terminalBaseline.totalWorkingSetKiB,
        MAX_TERMINAL_INCREMENT_KIB
      ),
      editorIncrement: diagnosticWorkingSet(
        editorSample.totalWorkingSetKiB - terminalBaseline.totalWorkingSetKiB,
        MAX_EDITOR_INCREMENT_KIB
      ),
      browserIncrement: diagnosticWorkingSet(
        browser.totalWorkingSetKiB - released.totalWorkingSetKiB,
        MAX_BROWSER_INCREMENT_KIB
      ),
      browserReleasedIncrement: diagnosticWorkingSet(
        browserReleased.totalWorkingSetKiB - released.totalWorkingSetKiB,
        MAX_BROWSER_RELEASED_INCREMENT_KIB
      ),
      maxReleasedIncrement: diagnosticWorkingSet(
        maxReleasedIncrementKiB,
        MAX_RELEASED_INCREMENT_KIB
      ),
      maxReleasedTotal: diagnosticWorkingSet(
        maxReleasedWorkingSetKiB,
        MAX_RELEASED_TOTAL_KIB
      ),
      releaseDrift: diagnosticWorkingSet(releaseDriftKiB, MAX_RELEASE_DRIFT_KIB)
    }
    const exceededWorkingSetDiagnostics = Object.entries(workingSetDiagnostics)
      .filter(([, observation]) => observation.exceeded)
      .map(([name]) => name)
    const report = {
      schema: 'agentmux.t001-desktop-resources.v2',
      measuredAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      electron: process.versions.electron,
      identity,
      attribution: {
        coreCtxmux: 'Session/Run/Replay/Attachment facts are owned by Core/ctxmux; counts below do not claim process-memory ownership.',
        rendererMainSurface: 'Terminal, Monaco, Browser and Main/Renderer/GPU/Utility working-set observations are kept separate.',
        rssInterpretation: 'working-set/RSS is an observation only. V8 and macOS allocators may retain pages after heapUsed falls; owner counts, heap/GC and repeated steady-state samples are required before calling a leak.'
      },
      startup: {
        ...options.startup,
        interactiveAtMs,
        processToAppReadyMs: options.startup.appReadyAtMs - options.startup.spawnedAtMs,
        processToWindowCreationMs: options.startup.windowCreationStartedAtMs - options.startup.spawnedAtMs,
        processToRendererLoadedMs: options.startup.rendererLoadedAtMs - options.startup.spawnedAtMs,
        processToInteractiveMs: interactiveAtMs - options.startup.spawnedAtMs
      },
      budgets: {
        mode: 'diagnostic-only',
        note: WORKING_SET_DIAGNOSTIC_NOTE,
        maxTerminalIncrementKiB: MAX_TERMINAL_INCREMENT_KIB,
        maxEditorIncrementKiB: MAX_EDITOR_INCREMENT_KIB,
        maxBrowserIncrementKiB: MAX_BROWSER_INCREMENT_KIB,
        maxBrowserReleasedIncrementKiB: MAX_BROWSER_RELEASED_INCREMENT_KIB,
        maxReleasedIncrementKiB: MAX_RELEASED_INCREMENT_KIB,
        maxReleasedTotalKiB: MAX_RELEASED_TOTAL_KIB,
        maxReleaseDriftKiB: MAX_RELEASE_DRIFT_KIB,
        releaseCycles: RELEASE_CYCLES,
        warmupReleaseCycles: RELEASE_WARMUP_CYCLES,
        steadyReleaseCycles: steadyReleaseCycles.length
      },
      diagnostics: {
        workingSet: workingSetDiagnostics,
        exceededWorkingSetDiagnostics,
        note: WORKING_SET_DIAGNOSTIC_NOTE
      },
      phases: {
        idle,
        singleHiddenWorkspace,
        multipleHiddenWorkspacesTabs,
        terminalBaseline,
        terminal: terminalSample,
        monaco: editorSample,
        editor: editorSample,
        released,
        browser,
        browserReleased
      },
      phaseOrder: [
        'idle',
        'single-hidden-workspace',
        'multiple-hidden-workspaces-tabs',
        'terminal',
        'monaco',
        'browser'
      ],
      topology: hiddenTopology,
      releaseCycles,
      deltas: {
        terminalWorkingSetKiB: terminalSample.totalWorkingSetKiB - terminalBaseline.totalWorkingSetKiB,
        terminalWorkingSetFromIdleKiB: terminalSample.totalWorkingSetKiB - idle.totalWorkingSetKiB,
        editorWorkingSetKiB: editorSample.totalWorkingSetKiB - terminalBaseline.totalWorkingSetKiB,
        editorWorkingSetFromIdleKiB: editorSample.totalWorkingSetKiB - idle.totalWorkingSetKiB,
        browserWorkingSetKiB: browser.totalWorkingSetKiB - released.totalWorkingSetKiB,
        browserReleasedWorkingSetKiB: browserReleased.totalWorkingSetKiB - released.totalWorkingSetKiB,
        maxReleasedWorkingSetKiB,
        maxReleasedIncrementKiB,
        totalReleaseDriftKiB,
        warmupReleaseDriftKiB,
        releaseDriftKiB
      }
    }
    reportEvidence = report
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    for (const [name, value] of Object.entries(report.deltas)) {
      if (!Number.isFinite(value)) {
        throw new Error(`Desktop resource probe produced a non-finite working-set delta: ${name}.`)
      }
    }
    for (const phase of [released, ...releaseCycles, browserReleased]) {
      if (!ownersEqual(phase.owners, releaseBaselineOwners)) {
        throw new Error(`Desktop resource owners did not converge at ${phase.label}.`)
      }
    }
  } catch (error) {
    if (terminalControl) await options.runtime.stopSession(terminalControl).catch(() => {})
    for (const control of activeTerminalControls) {
      if (control === terminalControl) continue
      await options.runtime.stopSession(control).catch(() => {})
    }
    await writeFile(reportPath, `${JSON.stringify({
      ...reportEvidence,
      schema: 'agentmux.t001-desktop-resources.v2',
      measuredAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    }, null, 2)}\n`, { mode: 0o600 })
    throw error
  }
  return true
}
