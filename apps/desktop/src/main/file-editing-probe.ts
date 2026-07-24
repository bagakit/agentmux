import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { WorkspaceFileWriteInput } from '../shared/contracts.js'

type WriteBarrier = {
  reached(): void
  reachedPromise: Promise<void>
  release(): void
  releasePromise: Promise<void>
}

export class WorkspaceFileEditingProbeControl {
  private barrier: WriteBarrier | null = null
  private nextFault: 'temporary-write' | 'replace' | undefined

  armWriteBarrier(): Promise<void> {
    if (this.barrier) throw new Error('Workspace file write barrier is already armed')
    let reached!: () => void
    let release!: () => void
    const barrier: WriteBarrier = {
      reached: () => reached(),
      reachedPromise: new Promise<void>((resolve) => { reached = resolve }),
      release: () => release(),
      releasePromise: new Promise<void>((resolve) => { release = resolve })
    }
    this.barrier = barrier
    return barrier.reachedPromise
  }

  async beforeWrite(_input: WorkspaceFileWriteInput): Promise<void> {
    const barrier = this.barrier
    if (!barrier) return
    barrier.reached()
    await barrier.releasePromise
    if (this.barrier === barrier) this.barrier = null
  }

  releaseWriteBarrier(): void {
    if (!this.barrier) throw new Error('Workspace file write barrier is not armed')
    this.barrier.release()
  }

  cancelWriteBarrier(): void {
    const barrier = this.barrier
    if (!barrier) return
    this.barrier = null
    barrier.release()
  }

  injectNextFault(fault: 'temporary-write' | 'replace'): void {
    this.nextFault = fault
  }

  consumeFault(): 'temporary-write' | 'replace' | undefined {
    const fault = this.nextFault
    this.nextFault = undefined
    return fault
  }
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
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function withTimeout<T>(description: string, promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 20_000).unref()
    })
  ])
}

async function rendererValue(window: BrowserWindow): Promise<string | null> {
  return await window.webContents.executeJavaScript(
    'window.__agentmuxFileEditingProbe?.value() ?? null'
  ) as string | null
}

async function rendererState(window: BrowserWindow): Promise<string | null> {
  return await window.webContents.executeJavaScript(
    "document.querySelector('.editor-pane')?.dataset.fileState ?? null"
  ) as string | null
}

async function setRendererValue(
  window: BrowserWindow,
  value: string,
  expectedState: 'dirty' | 'saving' = 'dirty'
): Promise<void> {
  const temporaryValue = `${value}\n`
  await waitFor(`${expectedState} Monaco value ${value}`, async () => {
    if (await rendererValue(window) === value && await rendererState(window) === expectedState) {
      return true
    }
    await window.webContents.executeJavaScript(`(() => {
      const probe = window.__agentmuxFileEditingProbe
      if (!probe) return
      probe.setValue(${JSON.stringify(temporaryValue)})
      probe.setValue(${JSON.stringify(value)})
    })()`)
    return await rendererValue(window) === value && await rendererState(window) === expectedState
  })
}

async function clickButton(window: BrowserWindow, label: string): Promise<void> {
  await waitFor(`enabled ${label} button`, async () => (
    await window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('.editor-header button')]
        .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)})
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false
      button.click()
      return true
    })()`)
  ) as boolean)
}

async function diskValue(path: string): Promise<string> {
  return await readFile(path, 'utf8')
}

async function snapshot(window: BrowserWindow, path: string): Promise<{
  disk: string
  editor: string | null
  state: string | null
}> {
  return {
    disk: await diskValue(path),
    editor: await rendererValue(window),
    state: await rendererState(window)
  }
}

export async function runDesktopFileEditingProbe(options: {
  window: BrowserWindow
  workspacePath: string
  control: WorkspaceFileEditingProbeControl
}): Promise<boolean> {
  const reportPath = process.env.AGENTMUX_DESKTOP_FILE_EDITING_REPORT
  if (!reportPath) return false
  const relativePath = 'revision-probe.txt'
  const path = join(options.workspacePath, relativePath)
  const phases: Record<string, unknown> = {}
  try {
    await waitFor('revision probe file row', async () => (
      await options.window.webContents.executeJavaScript(
        `Boolean(document.querySelector('[data-tree-path=${JSON.stringify(relativePath)}]'))`
      ) as boolean
    ))
    await options.window.webContents.executeJavaScript(
      `document.querySelector('[data-tree-path=${JSON.stringify(relativePath)}]')?.click()`
    )
    await waitFor('revision probe Monaco editor', async () => await rendererValue(options.window) === 'alpha')

    await setRendererValue(options.window, 'bravo')
    const saveReached = options.control.armWriteBarrier()
    await clickButton(options.window, 'Save')
    await withTimeout('blocked bravo save', saveReached)
    await setRendererValue(options.window, 'charlie', 'saving')
    options.control.releaseWriteBarrier()
    await waitFor('bravo disk with charlie dirty buffer', async () => (
      await diskValue(path) === 'bravo' &&
      await rendererValue(options.window) === 'charlie' &&
      await rendererState(options.window) === 'dirty'
    ))
    phases.saveGeneration = await snapshot(options.window, path)

    await clickButton(options.window, 'Save')
    await waitFor('charlie saved cleanly', async () => (
      await diskValue(path) === 'charlie' && await rendererState(options.window) === 'clean'
    ))
    phases.secondSave = await snapshot(options.window, path)

    await writeFile(path, 'delta')
    await waitFor('clean external change adoption', async () => (
      await rendererValue(options.window) === 'delta' && await rendererState(options.window) === 'clean'
    ))
    phases.cleanInvalidation = await snapshot(options.window, path)

    await setRendererValue(options.window, 'echo')
    await writeFile(path, 'foxtrot')
    await waitFor('dirty external conflict', async () => (
      await rendererValue(options.window) === 'echo' && await rendererState(options.window) === 'changed'
    ))
    phases.dirtyConflict = await snapshot(options.window, path)
    await clickButton(options.window, 'Reload')
    await waitFor('explicit reload', async () => (
      await rendererValue(options.window) === 'foxtrot' && await rendererState(options.window) === 'clean'
    ))
    phases.reload = await snapshot(options.window, path)

    await setRendererValue(options.window, 'golf')
    await writeFile(path, 'hotel')
    await waitFor('overwrite conflict', async () => await rendererState(options.window) === 'changed')
    const overwriteReached = options.control.armWriteBarrier()
    await clickButton(options.window, 'Overwrite')
    await withTimeout('blocked overwrite', overwriteReached)
    await writeFile(path, 'india')
    options.control.releaseWriteBarrier()
    await waitFor('repeated overwrite conflict', async () => (
      await diskValue(path) === 'india' &&
      await rendererValue(options.window) === 'golf' &&
      await rendererState(options.window) === 'changed'
    ))
    phases.repeatedConflict = await snapshot(options.window, path)
    await clickButton(options.window, 'Overwrite')
    await waitFor('explicit overwrite', async () => (
      await diskValue(path) === 'golf' && await rendererState(options.window) === 'clean'
    ))
    phases.overwrite = await snapshot(options.window, path)

    await setRendererValue(options.window, 'juliet')
    await rm(path)
    await waitFor('deleted file conflict', async () => (
      await rendererValue(options.window) === 'juliet' && await rendererState(options.window) === 'deleted'
    ))
    phases.deleted = { editor: await rendererValue(options.window), state: await rendererState(options.window) }
    await clickButton(options.window, 'Overwrite')
    await waitFor('deleted file recreation', async () => (
      await diskValue(path).catch(() => null) === 'juliet' &&
      await rendererState(options.window) === 'clean'
    ))

    await setRendererValue(options.window, 'kilo')
    await rm(path)
    await mkdir(path)
    await waitFor('read failure distinct from deletion', async () => (
      await rendererValue(options.window) === 'kilo' && await rendererState(options.window) === 'read-error'
    ))
    phases.readError = { editor: await rendererValue(options.window), state: await rendererState(options.window) }
    await rm(path, { recursive: true })
    await writeFile(path, 'lima')
    await waitFor('post-error disk conflict', async () => await rendererState(options.window) === 'changed')
    await clickButton(options.window, 'Reload')
    await waitFor('post-error reload', async () => (
      await rendererValue(options.window) === 'lima' && await rendererState(options.window) === 'clean'
    ))

    await setRendererValue(options.window, 'mike')
    options.control.injectNextFault('replace')
    await clickButton(options.window, 'Save')
    await waitFor('visible atomic replace failure', async () => (
      await diskValue(path) === 'lima' &&
      await rendererValue(options.window) === 'mike' &&
      await rendererState(options.window) === 'write-error'
    ))
    phases.writeError = await snapshot(options.window, path)
    await clickButton(options.window, 'Save')
    await waitFor('save recovery', async () => (
      await diskValue(path) === 'mike' && await rendererState(options.window) === 'clean'
    ))
    phases.recovered = await snapshot(options.window, path)

    await writeFile(reportPath, `${JSON.stringify({
      schema: 'agentmux.workspace-file-editing-e2e.v1',
      ok: true,
      phases
    }, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    await writeFile(reportPath, `${JSON.stringify({
      schema: 'agentmux.workspace-file-editing-e2e.v1',
      ok: false,
      phases,
      error: error instanceof Error ? error.message : String(error)
    }, null, 2)}\n`, { mode: 0o600 })
    throw error
  } finally {
    options.control.cancelWriteBarrier()
  }
  return true
}
