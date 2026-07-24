import { writeFile } from 'node:fs/promises'
import { app, type BrowserWindow } from 'electron'
import type { SessionControl, SessionSnapshot } from '../shared/contracts.js'
import { ConfigStore } from './config-store.js'
import { RuntimeController } from './runtime-controller.js'

const MAX_TERMINAL_INCREMENT_KIB = 256 * 1024
const MAX_EDITOR_INCREMENT_KIB = 512 * 1024
const MAX_RELEASED_TOTAL_KIB = 1024 * 1024
const MAX_RELEASE_DRIFT_KIB = 128 * 1024
const RELEASE_CYCLES = 5

type ResourceSample = {
  label: string
  totalWorkingSetKiB: number
  processes: Array<{
    pid: number
    type: string
    workingSetKiB: number
    privateKiB: number
  }>
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

async function sample(label: string): Promise<ResourceSample> {
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
    processes
  }
}

async function rendererBoolean(window: BrowserWindow, source: string): Promise<boolean> {
  return await window.webContents.executeJavaScript(`Boolean(${source})`) as boolean
}

async function click(window: BrowserWindow, source: string): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => { const target = ${source}; target?.click(); return Boolean(target) })()`)
  if (!clicked) throw new Error('Desktop resource probe could not find the requested UI control.')
}

function newTerminal(before: ReadonlySet<string>, sessions: readonly SessionSnapshot[]): SessionSnapshot | null {
  return sessions.find((session) => session.kind === 'terminal' && !before.has(session.id)) ?? null
}

export async function runDesktopResourceProbe(options: {
  window: BrowserWindow
  runtime: RuntimeController
  configStore: ConfigStore
}): Promise<boolean> {
  const reportPath = process.env.AGENTMUX_DESKTOP_RESOURCE_REPORT
  if (!reportPath) return false
  let terminalControl: SessionControl | null = null
  let reportEvidence: Record<string, unknown> | null = null
  try {
    const config = await options.configStore.get()
    if (config.workspaces.length !== 1) throw new Error('Desktop resource probe requires exactly one workspace.')
    await waitFor('New Tab launcher', async () => await rendererBoolean(
      options.window,
      "[...document.querySelectorAll('.new-tab-grid button')].some((button) => button.textContent?.includes('Terminal'))"
    ))
    const before = new Set((await options.runtime.snapshot(config)).sessions.map((session) => session.id))
    const idle = await sample('idle-desktop')

    await click(
      options.window,
      "[...document.querySelectorAll('.new-tab-grid button')].find((button) => button.textContent?.includes('Terminal'))"
    )
    await waitFor('Raw Terminal session', async () => {
      return newTerminal(before, (await options.runtime.snapshot(config)).sessions) !== null &&
        await rendererBoolean(options.window, "document.querySelector('.terminal-view .xterm')")
    })
    const terminal = newTerminal(before, (await options.runtime.snapshot(config)).sessions)
    if (!terminal) throw new Error('Desktop resource probe lost the created Terminal session.')
    terminalControl = terminal.control
    const source = "process.stdout.write('t'.repeat(300000))"
    await options.runtime.write(terminalControl, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}\n`)
    await waitFor('bounded Terminal output', async () => {
      const current = newTerminal(before, (await options.runtime.snapshot(config)).sessions)
      return (current?.latestOutputBytes ?? 0) >= 300_000
    })
    const terminalSample = await sample('xterm-300kb-output')

    await waitFor('resource probe file row', async () => await rendererBoolean(
      options.window,
      "document.querySelector('[data-tree-path=\"resource-probe.ts\"]')"
    ))
    await click(options.window, "document.querySelector('[data-tree-path=\"resource-probe.ts\"]')")
    await waitFor('Monaco editor', async () => await rendererBoolean(options.window, "document.querySelector('.monaco-editor')"))
    const editorSample = await sample('monaco-editor')

    await click(options.window, "document.querySelector('[aria-label=\"Close resource-probe.ts\"]')")
    await waitFor('Monaco disposal', async () => !await rendererBoolean(options.window, "document.querySelector('.monaco-editor')"))
    await options.runtime.stopSession(terminalControl)
    terminalControl = null
    await waitFor('Terminal release', async () => newTerminal(before, (await options.runtime.snapshot(config)).sessions) === null)
    const released = await sample('released-panes')
    const releaseCycles = [released]
    for (let cycle = 1; cycle < RELEASE_CYCLES; cycle += 1) {
      await waitFor(`cycle ${cycle} New Tab launcher`, async () => await rendererBoolean(
        options.window,
        "[...document.querySelectorAll('.new-tab-grid button')].some((button) => button.textContent?.includes('Terminal'))"
      ))
      await click(
        options.window,
        "[...document.querySelectorAll('.new-tab-grid button')].find((button) => button.textContent?.includes('Terminal'))"
      )
      await waitFor(`cycle ${cycle} Raw Terminal`, async () => (
        newTerminal(before, (await options.runtime.snapshot(config)).sessions) !== null &&
        await rendererBoolean(options.window, "document.querySelector('.terminal-view .xterm')")
      ))
      const current = newTerminal(before, (await options.runtime.snapshot(config)).sessions)
      if (!current) throw new Error(`Desktop resource probe lost Terminal cycle ${cycle}.`)
      terminalControl = current.control
      await options.runtime.write(terminalControl, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}\n`)
      await waitFor(`cycle ${cycle} bounded Terminal output`, async () => (
        (newTerminal(before, (await options.runtime.snapshot(config)).sessions)?.latestOutputBytes ?? 0) >= 300_000
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
      await options.runtime.stopSession(terminalControl)
      terminalControl = null
      await waitFor(`cycle ${cycle} Terminal release`, async () => (
        newTerminal(before, (await options.runtime.snapshot(config)).sessions) === null
      ))
      releaseCycles.push(await sample(`released-panes-${cycle + 1}`))
    }
    const releaseDriftKiB = Math.max(...releaseCycles.map((entry) => entry.totalWorkingSetKiB)) -
      releaseCycles[0]!.totalWorkingSetKiB
    const report = {
      measuredAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      electron: process.versions.electron,
      budgets: {
        maxTerminalIncrementKiB: MAX_TERMINAL_INCREMENT_KIB,
        maxEditorIncrementKiB: MAX_EDITOR_INCREMENT_KIB,
        maxReleasedTotalKiB: MAX_RELEASED_TOTAL_KIB,
        maxReleaseDriftKiB: MAX_RELEASE_DRIFT_KIB,
        releaseCycles: RELEASE_CYCLES
      },
      phases: { idle, terminal: terminalSample, editor: editorSample, released },
      releaseCycles,
      deltas: {
        terminalWorkingSetKiB: terminalSample.totalWorkingSetKiB - idle.totalWorkingSetKiB,
        editorWorkingSetKiB: editorSample.totalWorkingSetKiB - idle.totalWorkingSetKiB,
        releasedWorkingSetKiB: released.totalWorkingSetKiB - idle.totalWorkingSetKiB,
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
    if (released.totalWorkingSetKiB > MAX_RELEASED_TOTAL_KIB) {
      throw new Error('Released Desktop process group exceeded its working-set budget.')
    }
    if (releaseDriftKiB > MAX_RELEASE_DRIFT_KIB) {
      throw new Error('Desktop working set kept growing across release cycles.')
    }
  } catch (error) {
    if (terminalControl) await options.runtime.stopSession(terminalControl).catch(() => {})
    await writeFile(reportPath, `${JSON.stringify({
      ...reportEvidence,
      measuredAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    }, null, 2)}\n`, { mode: 0o600 })
    throw error
  }
  return true
}
