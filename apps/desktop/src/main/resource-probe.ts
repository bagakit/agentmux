import { writeFile } from 'node:fs/promises'
import { app, webContents, type BrowserWindow } from 'electron'
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

type ResourceOwners = {
  browserWebContents: number
  monacoModels: number
  documents: number
  fileWatchers: number
  runtimeSubscriptions: number
  terminalViews: number
  terminalAddons: number
  terminalListeners: number
  sessionAttachmentOwners: number
  sessionAttachmentLeases: number
}

type ResourceSample = {
  label: string
  totalWorkingSetKiB: number
  owners: ResourceOwners
  processes: Array<{
    pid: number
    type: string
    workingSetKiB: number
    privateKiB: number
  }>
}

async function ownerCounts(
  window: BrowserWindow,
  runtime: RuntimeController
): Promise<ResourceOwners> {
  const renderer = await window.webContents.executeJavaScript(`(() => {
    const event = new CustomEvent('agentmux:resource-owner-counts', { detail: { observed: false } })
    window.dispatchEvent(event)
    if (!event.detail.observed) throw new Error('Renderer resource owner observer is not installed')
    const { observed: _observed, ...owners } = event.detail
    return owners
  })()`) as {
    monacoModels: number
    documents: number
    runtimeSubscriptions: number
    terminalViews: number
    terminalAddons: number
    terminalListeners: number
  }
  const owners = {
    browserWebContents: webContents.getAllWebContents().filter((item) => item !== window.webContents).length,
    fileWatchers: workspaceFileObserverCount(),
    ...renderer,
    ...runtime.resourceOwnerCounts()
  }
  for (const [name, value] of Object.entries(owners)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid resource owner count for ${name}.`)
    }
  }
  return owners
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function sample(
  label: string,
  window: BrowserWindow,
  runtime: RuntimeController
): Promise<ResourceSample> {
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
  return {
    label,
    totalWorkingSetKiB: processes.reduce((sum, process) => sum + process.workingSetKiB, 0),
    owners: await ownerCounts(window, runtime),
    processes
  }
}

async function rendererBoolean(window: BrowserWindow, source: string): Promise<boolean> {
  return await window.webContents.executeJavaScript(`Boolean(${source})`) as boolean
}

async function click(window: BrowserWindow, source: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => { const target = ${source}; target?.click(); return Boolean(target) })()`)
  if (!clicked) throw new Error(`Desktop resource probe could not find UI control: ${source}`)
}

function ownersEqual(left: ResourceOwners, right: ResourceOwners): boolean {
  return Object.entries(left).every(([name, value]) => right[name as keyof ResourceOwners] === value)
}

function isReadyLauncherOwnerBaseline(owners: ResourceOwners): boolean {
  return (
    owners.browserWebContents === 0 &&
    owners.monacoModels === 0 &&
    owners.documents === 0 &&
    owners.fileWatchers === 0 &&
    owners.runtimeSubscriptions === 4 &&
    owners.terminalViews === 1 &&
    (owners.terminalAddons === 3 || owners.terminalAddons === 4) &&
    owners.terminalListeners === 6 &&
    owners.sessionAttachmentOwners === 1 &&
    owners.sessionAttachmentLeases === 1
  )
}

function runningTerminal(sessions: readonly SessionSnapshot[], sessionId: string): SessionSnapshot | null {
  return sessions.find((session) => (
    session.id === sessionId && session.kind === 'terminal' && session.processState === 'running'
  )) ?? null
}

const claimTerminalSelector = desktopActionSelector('claimReusableTerminal')
const readyTerminalSelector = `${claimTerminalSelector}[${DESKTOP_SESSION_ATTRIBUTE}]`
const openBrowserSelector = desktopActionSelector('openBrowser')

async function launcherTerminalSessionId(window: BrowserWindow): Promise<string | null> {
  const value = await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(readyTerminalSelector)})?.getAttribute(${JSON.stringify(DESKTOP_SESSION_ATTRIBUTE)}) ?? null`
  ) as unknown
  return typeof value === 'string' && value.length > 0 ? value : null
}

function desktopActionSource(selector: string, sessionId?: string): string {
  if (!sessionId) return `document.querySelector(${JSON.stringify(selector)})`
  return `[...document.querySelectorAll(${JSON.stringify(selector)})].find((button) => ` +
    `button.getAttribute(${JSON.stringify(DESKTOP_SESSION_ATTRIBUTE)}) === ${JSON.stringify(sessionId)})`
}

async function waitForReadyLauncherTerminal(options: {
  description: string
  window: BrowserWindow
  runtime: RuntimeController
  config: AppConfig
  usedSessionIds?: ReadonlySet<string>
  expectedSessionId?: string
  expectedOwners?: ResourceOwners
}): Promise<SessionSnapshot> {
  let ready: SessionSnapshot | null = null
  await waitFor(options.description, async () => {
    const sessionId = await launcherTerminalSessionId(options.window)
    if (
      !sessionId ||
      options.usedSessionIds?.has(sessionId) ||
      (options.expectedSessionId && sessionId !== options.expectedSessionId)
    ) return false
    const current = runningTerminal((await options.runtime.snapshot(options.config)).sessions, sessionId)
    if (!current) return false
    const owners = await ownerCounts(options.window, options.runtime)
    if (options.expectedOwners ? !ownersEqual(owners, options.expectedOwners) : !isReadyLauncherOwnerBaseline(owners)) {
      return false
    }
    ready = current
    return true
  })
  if (!ready) throw new Error(`Desktop resource probe lost ${options.description}.`)
  return ready
}

async function waitForStoppedTerminal(
  description: string,
  runtime: RuntimeController,
  config: AppConfig,
  sessionId: string
): Promise<void> {
  await waitFor(description, async () => (
    runningTerminal((await runtime.snapshot(config)).sessions, sessionId) === null
  ))
}

async function claimLauncherTerminal(
  description: string,
  window: BrowserWindow,
  runtime: RuntimeController,
  terminal: SessionSnapshot,
  expectedOwners: ResourceOwners
): Promise<void> {
  await click(window, desktopActionSource(claimTerminalSelector, terminal.id))
  await waitFor(description, async () => (
    await launcherTerminalSessionId(window) !== terminal.id &&
    await rendererBoolean(window, "document.querySelector('.terminal-view .xterm')") &&
    ownersEqual(await ownerCounts(window, runtime), expectedOwners)
  ))
}

export async function runDesktopResourceProbe(options: {
  window: BrowserWindow
  runtime: RuntimeController
  configStore: ConfigStore
  startup: {
    spawnedAtMs: number
    appReadyAtMs: number
    windowCreationStartedAtMs: number
    rendererLoadedAtMs: number
  }
}): Promise<boolean> {
  const reportPath = process.env.AGENTMUX_DESKTOP_RESOURCE_REPORT
  if (!reportPath) return false
  let terminalControl: SessionControl | null = null
  let reportEvidence: Record<string, unknown> | null = null
  try {
    const config = await options.configStore.get()
    const measuredWorkspaces = config.workspaces.filter((workspace) => !isScratchWorkspaceId(workspace.id))
    const scratchWorkspaces = config.workspaces.filter((workspace) => isScratchWorkspaceId(workspace.id))
    if (measuredWorkspaces.length !== 1 || scratchWorkspaces.length !== 1 || config.workspaces.length !== 2) {
      throw new Error('Desktop resource probe requires one measured workspace and one built-in Scratch workspace.')
    }
    const measuredWorkspace = measuredWorkspaces[0]!
    if (config.workspaces[0]?.id !== measuredWorkspace.id) {
      throw new Error('Desktop resource probe requires the measured workspace to be the active first workspace.')
    }
    const usedTerminalSessionIds = new Set<string>()
    let launcherTerminal = await waitForReadyLauncherTerminal({
      description: 'fresh ready reusable Terminal launcher',
      window: options.window,
      runtime: options.runtime,
      config
    })
    if (
      launcherTerminal.hostId !== measuredWorkspace.hostId ||
      launcherTerminal.workspacePath !== measuredWorkspace.path
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
    const idle = await sample('ready-reusable-terminal-launcher', options.window, options.runtime)
    if (!isReadyLauncherOwnerBaseline(idle.owners)) {
      throw new Error(`Desktop ready reusable Terminal baseline is not clean: ${JSON.stringify(idle.owners)}`)
    }
    const readyLauncherOwners = idle.owners

    usedTerminalSessionIds.add(launcherTerminal.id)
    terminalControl = launcherTerminal.control
    await claimLauncherTerminal(
      'reusable Terminal promotion',
      options.window,
      options.runtime,
      launcherTerminal,
      readyLauncherOwners
    )
    const source = "process.stdout.write('t'.repeat(300000))"
    const terminalCommand = `ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}\r`
    await options.runtime.write(terminalControl, terminalCommand)
    await waitFor('bounded Terminal output', async () => {
      const current = runningTerminal((await options.runtime.snapshot(config)).sessions, launcherTerminal.id)
      return (current?.latestOutputBytes ?? 0) >= 300_000
    })
    const terminalSample = await sample('xterm-300kb-output', options.window, options.runtime)
    if (!ownersEqual(terminalSample.owners, readyLauncherOwners)) {
      throw new Error(`Desktop claimed Terminal owners diverged from the ready launcher baseline: ${JSON.stringify(terminalSample.owners)}`)
    }

    await waitFor('resource probe file row', async () => await rendererBoolean(
      options.window,
      "document.querySelector('[data-tree-path=\"resource-probe.ts\"]')"
    ))
    await click(options.window, "document.querySelector('[data-tree-path=\"resource-probe.ts\"]')")
    await waitFor('Monaco editor', async () => await rendererBoolean(options.window, "document.querySelector('.monaco-editor')"))
    const editorSample = await sample('monaco-editor', options.window, options.runtime)
    const editorOwners: ResourceOwners = {
      ...readyLauncherOwners,
      monacoModels: 1,
      documents: 1,
      fileWatchers: 1,
      terminalViews: 0,
      terminalAddons: 0,
      terminalListeners: 0,
      sessionAttachmentOwners: 0,
      sessionAttachmentLeases: 0
    }
    if (!ownersEqual(editorSample.owners, editorOwners)) {
      throw new Error(`Desktop editor did not own exactly one Document and Monaco Model: ${JSON.stringify(editorSample.owners)}`)
    }
    if (!runningTerminal((await options.runtime.snapshot(config)).sessions, launcherTerminal.id)) {
      throw new Error('Desktop editor did not retain the claimed Terminal backend.')
    }

    await click(options.window, "document.querySelector('[aria-label=\"Close resource-probe.ts\"]')")
    await waitFor('Monaco disposal', async () => !await rendererBoolean(options.window, "document.querySelector('.monaco-editor')"))
    await waitFor('Main file observer release', async () => (
      (await ownerCounts(options.window, options.runtime)).fileWatchers === 0
    ))
    await options.runtime.stopSession(terminalControl)
    terminalControl = null
    await waitForStoppedTerminal('first claimed Terminal stop', options.runtime, config, launcherTerminal.id)
    launcherTerminal = await waitForReadyLauncherTerminal({
      description: 'fresh reusable Terminal after first release',
      window: options.window,
      runtime: options.runtime,
      config,
      usedSessionIds: usedTerminalSessionIds,
      expectedOwners: readyLauncherOwners
    })
    const released = await sample('released-panes', options.window, options.runtime)
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
        readyLauncherOwners
      )
      await options.runtime.write(terminalControl, terminalCommand)
      await waitFor(`cycle ${cycle} bounded Terminal output`, async () => (
        (runningTerminal((await options.runtime.snapshot(config)).sessions, current.id)?.latestOutputBytes ?? 0) >= 300_000
      ))
      await waitFor(`cycle ${cycle} resource probe file row`, async () => await rendererBoolean(
        options.window,
        "document.querySelector('[data-tree-path=\"resource-probe.ts\"]')"
      ))
      await click(options.window, "document.querySelector('[data-tree-path=\"resource-probe.ts\"]')")
      await waitFor(`cycle ${cycle} Monaco editor`, async () => await rendererBoolean(
        options.window,
        "document.querySelector('.monaco-editor')"
      ))
      await click(options.window, "document.querySelector('[aria-label=\"Close resource-probe.ts\"]')")
      await waitFor(`cycle ${cycle} Monaco disposal`, async () => !await rendererBoolean(
        options.window,
        "document.querySelector('.monaco-editor')"
      ))
      await waitFor(`cycle ${cycle} Main file observer release`, async () => (
        (await ownerCounts(options.window, options.runtime)).fileWatchers === 0
      ))
      await options.runtime.stopSession(terminalControl)
      terminalControl = null
      await waitForStoppedTerminal(`cycle ${cycle} claimed Terminal stop`, options.runtime, config, current.id)
      launcherTerminal = await waitForReadyLauncherTerminal({
        description: `cycle ${cycle} fresh reusable Terminal after release`,
        window: options.window,
        runtime: options.runtime,
        config,
        usedSessionIds: usedTerminalSessionIds,
        expectedOwners: readyLauncherOwners
      })
      releaseCycles.push(await sample(`released-panes-${cycle + 1}`, options.window, options.runtime))
    }
    const browserOwnerBefore = idle.owners.browserWebContents
    const browserWarmTerminal = launcherTerminal
    await click(options.window, desktopActionSource(openBrowserSelector))
    await waitFor('Main-owned Browser WebContents', async () => (
      (await ownerCounts(options.window, options.runtime)).browserWebContents === browserOwnerBefore + 1
    ))
    const browser = await sample('browser-about-blank', options.window, options.runtime)
    const browserOwners: ResourceOwners = {
      ...readyLauncherOwners,
      browserWebContents: browserOwnerBefore + 1,
      runtimeSubscriptions: 0,
      terminalViews: 0,
      terminalAddons: 0,
      terminalListeners: 0,
      sessionAttachmentOwners: 0,
      sessionAttachmentLeases: 0
    }
    if (!ownersEqual(browser.owners, browserOwners)) {
      throw new Error(`Desktop Browser did not release reusable Terminal view owners: ${JSON.stringify(browser.owners)}`)
    }
    if (!runningTerminal((await options.runtime.snapshot(config)).sessions, browserWarmTerminal.id)) {
      throw new Error('Desktop Browser did not retain the reusable Terminal backend.')
    }
    await click(options.window, "document.querySelector('[aria-label=\"Close New Tab\"]')")
    await waitFor('Browser WebContents release', async () => (
      (await ownerCounts(options.window, options.runtime)).browserWebContents === browserOwnerBefore
    ))
    launcherTerminal = await waitForReadyLauncherTerminal({
      description: 'same reusable Terminal after Browser release',
      window: options.window,
      runtime: options.runtime,
      config,
      expectedSessionId: browserWarmTerminal.id,
      expectedOwners: readyLauncherOwners
    })
    const browserReleased = await sample('browser-released', options.window, options.runtime)
    const warmupReleaseCycles = releaseCycles.slice(0, RELEASE_WARMUP_CYCLES)
    const steadyReleaseCycles = releaseCycles.slice(RELEASE_WARMUP_CYCLES)
    const ownerCleanReleaseSamples = [...releaseCycles, browserReleased]
    const maxReleasedWorkingSetKiB = Math.max(
      ...ownerCleanReleaseSamples.map((entry) => entry.totalWorkingSetKiB)
    )
    const maxReleasedIncrementKiB = maxReleasedWorkingSetKiB - idle.totalWorkingSetKiB
    const totalReleaseDriftKiB = Math.max(...releaseCycles.map((entry) => entry.totalWorkingSetKiB)) -
      Math.min(...releaseCycles.map((entry) => entry.totalWorkingSetKiB))
    const warmupReleaseDriftKiB = Math.max(...warmupReleaseCycles.map((entry) => entry.totalWorkingSetKiB)) -
      Math.min(...warmupReleaseCycles.map((entry) => entry.totalWorkingSetKiB))
    const releaseDriftKiB = Math.max(...steadyReleaseCycles.map((entry) => entry.totalWorkingSetKiB)) -
      steadyReleaseCycles[0]!.totalWorkingSetKiB
    const report = {
      schema: 'agentmux.t017-desktop-resources.v1',
      measuredAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      electron: process.versions.electron,
      startup: {
        ...options.startup,
        interactiveAtMs,
        processToAppReadyMs: options.startup.appReadyAtMs - options.startup.spawnedAtMs,
        processToWindowCreationMs: options.startup.windowCreationStartedAtMs - options.startup.spawnedAtMs,
        processToRendererLoadedMs: options.startup.rendererLoadedAtMs - options.startup.spawnedAtMs,
        processToInteractiveMs: interactiveAtMs - options.startup.spawnedAtMs
      },
      budgets: {
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
      phases: {
        idle,
        terminal: terminalSample,
        editor: editorSample,
        released,
        browser,
        browserReleased
      },
      releaseCycles,
      deltas: {
        terminalWorkingSetKiB: terminalSample.totalWorkingSetKiB - idle.totalWorkingSetKiB,
        editorWorkingSetKiB: editorSample.totalWorkingSetKiB - idle.totalWorkingSetKiB,
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
    if (report.deltas.terminalWorkingSetKiB > MAX_TERMINAL_INCREMENT_KIB) {
      throw new Error('Desktop Terminal exceeded its working-set budget.')
    }
    if (report.deltas.editorWorkingSetKiB > MAX_EDITOR_INCREMENT_KIB) {
      throw new Error('Desktop editor exceeded its working-set budget.')
    }
    if (report.deltas.browserWorkingSetKiB > MAX_BROWSER_INCREMENT_KIB) {
      throw new Error('Desktop Browser exceeded its working-set budget.')
    }
    if (report.deltas.browserReleasedWorkingSetKiB > MAX_BROWSER_RELEASED_INCREMENT_KIB) {
      throw new Error('Released Desktop Browser exceeded its working-set budget.')
    }
    for (const phase of [released, ...releaseCycles, browserReleased]) {
      if (
        phase.owners.monacoModels !== idle.owners.monacoModels ||
        phase.owners.documents !== idle.owners.documents ||
        phase.owners.fileWatchers !== idle.owners.fileWatchers ||
        phase.owners.browserWebContents !== idle.owners.browserWebContents ||
        phase.owners.runtimeSubscriptions !== idle.owners.runtimeSubscriptions ||
        phase.owners.terminalViews !== idle.owners.terminalViews ||
        phase.owners.terminalAddons !== idle.owners.terminalAddons ||
        phase.owners.terminalListeners !== idle.owners.terminalListeners ||
        phase.owners.sessionAttachmentOwners !== idle.owners.sessionAttachmentOwners ||
        phase.owners.sessionAttachmentLeases !== idle.owners.sessionAttachmentLeases
      ) {
        throw new Error(`Desktop resource owners did not converge at ${phase.label}.`)
      }
    }
    if (report.deltas.maxReleasedIncrementKiB > MAX_RELEASED_INCREMENT_KIB) {
      throw new Error('An owner-clean Desktop sample exceeded its released working-set increment budget.')
    }
    if (report.deltas.maxReleasedWorkingSetKiB > MAX_RELEASED_TOTAL_KIB) {
      throw new Error('An owner-clean Desktop sample exceeded the released process-group budget.')
    }
    if (releaseDriftKiB > MAX_RELEASE_DRIFT_KIB) {
      throw new Error('Desktop steady-state working set kept growing across release cycles.')
    }
  } catch (error) {
    if (terminalControl) await options.runtime.stopSession(terminalControl).catch(() => {})
    await writeFile(reportPath, `${JSON.stringify({
      ...reportEvidence,
      schema: 'agentmux.t017-desktop-resources.v1',
      measuredAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    }, null, 2)}\n`, { mode: 0o600 })
    throw error
  }
  return true
}
