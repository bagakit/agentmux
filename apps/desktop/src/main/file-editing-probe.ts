import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { WorkspaceFileWriteInput } from '../shared/contracts.js'

type ProbeBarrier = {
  reached(): void
  reachedPromise: Promise<void>
  release(): void
  releasePromise: Promise<void>
}

type DirectoryReadReceipt = {
  workspaceId: string
  path: string
}

function createProbeBarrier(): ProbeBarrier {
  let reached!: () => void
  let release!: () => void
  return {
    reached: () => reached(),
    reachedPromise: new Promise<void>((resolve) => { reached = resolve }),
    release: () => release(),
    releasePromise: new Promise<void>((resolve) => { release = resolve })
  }
}

export class WorkspaceFileEditingProbeControl {
  private writeBarrier: ProbeBarrier | null = null
  private moveCommitBarrier: ProbeBarrier | null = null
  private nextFault: 'temporary-write' | 'replace' | undefined
  private readonly directoryReads: DirectoryReadReceipt[] = []

  armWriteBarrier(): Promise<void> {
    if (this.writeBarrier) throw new Error('Workspace file write barrier is already armed')
    const barrier = createProbeBarrier()
    this.writeBarrier = barrier
    return barrier.reachedPromise
  }

  async beforeWrite(_input: WorkspaceFileWriteInput): Promise<void> {
    const barrier = this.writeBarrier
    if (!barrier) return
    barrier.reached()
    await barrier.releasePromise
    if (this.writeBarrier === barrier) this.writeBarrier = null
  }

  releaseWriteBarrier(): void {
    if (!this.writeBarrier) throw new Error('Workspace file write barrier is not armed')
    this.writeBarrier.release()
  }

  cancelWriteBarrier(): void {
    const barrier = this.writeBarrier
    if (!barrier) return
    this.writeBarrier = null
    barrier.release()
  }

  armMoveCommitBarrier(): Promise<void> {
    if (this.moveCommitBarrier) throw new Error('Workspace move commit barrier is already armed')
    const barrier = createProbeBarrier()
    this.moveCommitBarrier = barrier
    return barrier.reachedPromise
  }

  async afterLocalMoveCommit(): Promise<void> {
    const barrier = this.moveCommitBarrier
    if (!barrier) return
    barrier.reached()
    await barrier.releasePromise
    if (this.moveCommitBarrier === barrier) this.moveCommitBarrier = null
  }

  releaseMoveCommitBarrier(): void {
    if (!this.moveCommitBarrier) throw new Error('Workspace move commit barrier is not armed')
    this.moveCommitBarrier.release()
  }

  cancelMoveCommitBarrier(): void {
    const barrier = this.moveCommitBarrier
    if (!barrier) return
    this.moveCommitBarrier = null
    barrier.release()
  }

  recordDirectoryRead(workspaceId: string, path: string): void {
    this.directoryReads.push({ workspaceId, path })
  }

  directoryReadCursor(): number {
    return this.directoryReads.length
  }

  directoryReadsSince(cursor: number): DirectoryReadReceipt[] {
    return this.directoryReads.slice(cursor)
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

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function publishReport(path: string, report: Record<string, unknown>): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryPath, path)
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

type ExplorerProjectionEvidence = {
  total: number
  byWorkspace: Record<string, number>
  rejectedDirectoryLoads: Array<{ workspaceId: string; path: string }>
}

async function explorerProjectionEvidence(window: BrowserWindow): Promise<ExplorerProjectionEvidence> {
  let evidence: ExplorerProjectionEvidence | null = null
  await waitFor('mounted Explorer projection evidence receipt', async () => {
    evidence = await window.webContents.executeJavaScript(`(() => {
      const value = document.querySelector('.file-tree')?.dataset.fileEditingExplorerEvidence
      return value ? JSON.parse(value) : null
    })()`) as ExplorerProjectionEvidence | null
    return evidence !== null
  })
  return evidence!
}

function explorerProjectionEvidenceDelta(
  before: ExplorerProjectionEvidence,
  after: ExplorerProjectionEvidence
): ExplorerProjectionEvidence {
  assertProbe(after.total >= before.total, 'Explorer projection notification receipt moved backwards')
  assertProbe(
    after.rejectedDirectoryLoads.length >= before.rejectedDirectoryLoads.length,
    'Rejected Explorer load receipt moved backwards'
  )
  const workspaceIds = new Set([...Object.keys(before.byWorkspace), ...Object.keys(after.byWorkspace)])
  return {
    total: after.total - before.total,
    byWorkspace: Object.fromEntries([...workspaceIds].map((workspaceId) => [
      workspaceId,
      (after.byWorkspace[workspaceId] ?? 0) - (before.byWorkspace[workspaceId] ?? 0)
    ])),
    rejectedDirectoryLoads: after.rejectedDirectoryLoads.slice(before.rejectedDirectoryLoads.length)
  }
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

type Point = { x: number; y: number }
type InputModifier = 'shift' | 'meta' | 'leftbuttondown'

function treeRowSource(path: string): string {
  return `document.querySelector('[data-tree-path=${JSON.stringify(path)}]')`
}

function projectRowSource(path: string): string {
  return `document.querySelector('.project-rail-row[title=${JSON.stringify(path)}]')`
}

function visibleMenuItemSource(label: string): string {
  return `[...document.querySelectorAll('[role="menuitem"]')].find((candidate) => ` +
    `candidate.textContent?.includes(${JSON.stringify(label)}) && candidate.getClientRects().length > 0)`
}

async function elementPoint(
  window: BrowserWindow,
  description: string,
  source: string
): Promise<Point> {
  let point: Point | null = null
  await waitFor(description, async () => {
    point = await window.webContents.executeJavaScript(`(() => {
      const element = ${source}
      if (!(element instanceof HTMLElement)) return null
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`) as Point | null
    return point !== null
  })
  return point!
}

function sendMouse(
  window: BrowserWindow,
  type: 'mouseMove' | 'mouseDown' | 'mouseUp' | 'contextMenu',
  point: Point,
  button?: 'left' | 'right',
  modifiers: InputModifier[] = []
): void {
  window.webContents.sendInputEvent({
    type,
    x: point.x,
    y: point.y,
    ...(button ? { button, clickCount: 1 } : {}),
    ...(modifiers.length > 0 ? { modifiers } : {})
  })
}

async function nativeClick(
  window: BrowserWindow,
  description: string,
  source: string,
  modifiers: InputModifier[] = []
): Promise<void> {
  const point = await elementPoint(window, description, source)
  sendMouse(window, 'mouseMove', point, undefined, modifiers)
  sendMouse(window, 'mouseDown', point, 'left', modifiers)
  sendMouse(window, 'mouseUp', point, 'left', modifiers)
}

async function nativeContextMenu(
  window: BrowserWindow,
  description: string,
  source: string
): Promise<void> {
  const point = await elementPoint(window, description, source)
  sendMouse(window, 'mouseMove', point)
  sendMouse(window, 'mouseDown', point, 'right')
  sendMouse(window, 'mouseUp', point, 'right')
  sendMouse(window, 'contextMenu', point, 'right')
}

async function nativeHover(
  window: BrowserWindow,
  description: string,
  source: string
): Promise<void> {
  const point = await elementPoint(window, description, source)
  sendMouse(window, 'mouseMove', point)
}

function sendKey(window: BrowserWindow, keyCode: string, modifiers: InputModifier[] = []): void {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

async function beginPointerDrag(window: BrowserWindow, path: string): Promise<Point> {
  const point = await elementPoint(window, `draggable Explorer row ${path}`, treeRowSource(path))
  sendMouse(window, 'mouseMove', point)
  sendMouse(window, 'mouseDown', point, 'left')
  sendMouse(window, 'mouseMove', { x: point.x + 8, y: point.y + 2 }, undefined, ['leftbuttondown'])
  await waitFor(`PointerSensor overlay for ${path}`, async () => (
    await window.webContents.executeJavaScript("Boolean(document.querySelector('.file-tree-drag-preview'))") as boolean
  ))
  return point
}

async function moveActivePointerDrag(
  window: BrowserWindow,
  description: string,
  source: string
): Promise<Point> {
  const point = await elementPoint(window, description, source)
  sendMouse(window, 'mouseMove', point, undefined, ['leftbuttondown'])
  return point
}

async function waitForActivePointerDropTarget(
  window: BrowserWindow,
  path: string,
  point: Point
): Promise<void> {
  await waitFor(`PointerSensor drop target ${path}`, async () => {
    const active = await window.webContents.executeJavaScript(
      `${treeRowSource(path)}?.classList.contains('tree-row--drop-over') === true`
    ) as boolean
    if (!active) sendMouse(window, 'mouseMove', point, undefined, ['leftbuttondown'])
    return active
  })
}

function endPointerDrag(window: BrowserWindow, point: Point): void {
  sendMouse(window, 'mouseUp', point, 'left')
}

function cancelPointerDrag(window: BrowserWindow, point: Point): void {
  sendKey(window, 'Escape')
  endPointerDrag(window, point)
}

async function expandDirectory(window: BrowserWindow, path: string): Promise<void> {
  const source = treeRowSource(path)
  const expanded = await window.webContents.executeJavaScript(
    `${source}?.getAttribute('aria-expanded') === 'true'`
  ) as boolean
  if (!expanded) await nativeClick(window, `collapsed Explorer directory ${path}`, source)
  await waitFor(`expanded Explorer directory ${path}`, async () => (
    await window.webContents.executeJavaScript(
      `${source}?.getAttribute('aria-expanded') === 'true'`
    ) as boolean
  ))
}

async function explorerProjection(window: BrowserWindow): Promise<{
  selected: string[]
  expanded: string[]
}> {
  return await window.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('[data-tree-path]')]
    return {
      selected: rows.filter((row) => row.getAttribute('aria-selected') === 'true')
        .map((row) => row.getAttribute('data-tree-path')).filter(Boolean).sort(),
      expanded: rows.filter((row) => row.getAttribute('aria-expanded') === 'true')
        .map((row) => row.getAttribute('data-tree-path')).filter(Boolean).sort()
    }
  })()`) as { selected: string[]; expanded: string[] }
}

async function explorerRowPaths(window: BrowserWindow): Promise<string[]> {
  return await window.webContents.executeJavaScript(`[
    ...document.querySelectorAll('[data-tree-path]')
  ].map((row) => row.getAttribute('data-tree-path')).filter(Boolean).sort()`) as string[]
}

async function explorerProjectionSettles(window: BrowserWindow): Promise<boolean> {
  return await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const snapshot = () => JSON.stringify({
      rows: [...document.querySelectorAll('[data-tree-path]')]
        .map((row) => row.getAttribute('data-tree-path')).filter(Boolean).sort(),
      selected: [...document.querySelectorAll('[data-tree-path][aria-selected="true"]')]
        .map((row) => row.getAttribute('data-tree-path')).filter(Boolean).sort(),
      expanded: [...document.querySelectorAll('[data-tree-path][aria-expanded="true"]')]
        .map((row) => row.getAttribute('data-tree-path')).filter(Boolean).sort()
    })
    let previous = snapshot()
    let stableFrames = 0
    let totalFrames = 0
    const sample = () => {
      const current = snapshot()
      stableFrames = current === previous ? stableFrames + 1 : 0
      previous = current
      totalFrames += 1
      if (stableFrames >= 4) resolve(true)
      else if (totalFrames >= 120) resolve(false)
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })`) as boolean
}

async function pathExists(path: string): Promise<boolean> {
  return await readFile(path).then(() => true, () => false)
}

async function runExplorerInteractionProbe(options: {
  window: BrowserWindow
  workspacePath: string
  alternateWorkspacePath: string
  control: WorkspaceFileEditingProbeControl
}): Promise<Record<string, unknown>> {
  const { window } = options
  window.webContents.focus()
  await expandDirectory(window, 'explorer-source')
  await expandDirectory(window, 'targets')
  await expandDirectory(window, 'targets/collision')
  await waitFor('loaded Explorer collision owner', async () => (
    await window.webContents.executeJavaScript(
      `Boolean(${treeRowSource('targets/collision/drag-invalid.txt')})`
    ) as boolean
  ))

  await nativeClick(window, 'menu source activation', treeRowSource('explorer-source/menu.txt'))
  await waitFor('menu source editor activation', async () => await rendererValue(window) === 'menu move')
  await nativeClick(window, 'menu neighbor multi-selection', treeRowSource('explorer-source/menu-neighbor.txt'), ['meta'])
  await waitFor('menu source multi-selection', async () => (
    await window.webContents.executeJavaScript(
      `${treeRowSource('explorer-source/menu.txt')}?.getAttribute('aria-selected') === 'true' && ` +
      `${treeRowSource('explorer-source/menu-neighbor.txt')}?.getAttribute('aria-selected') === 'true'`
    ) as boolean
  ))
  const revisitEvidenceBefore = await explorerProjectionEvidence(window)
  const beforeRevisit = await explorerProjection(window)
  await nativeClick(window, 'alternate Workspace project', projectRowSource(options.alternateWorkspacePath))
  await waitFor('active alternate Workspace project', async () => (
    await window.webContents.executeJavaScript(
      `${projectRowSource(options.alternateWorkspacePath)}?.classList.contains('project-rail-row--active') === true`
    ) as boolean
  ))
  await waitFor('alternate Workspace Explorer', async () => (
    await window.webContents.executeJavaScript(
      `Boolean(${treeRowSource('alternate.txt')})`
    ) as boolean
  ))
  await nativeClick(window, 'primary Workspace project', projectRowSource(options.workspacePath))
  await waitFor('active primary Workspace project', async () => (
    await window.webContents.executeJavaScript(
      `${projectRowSource(options.workspacePath)}?.classList.contains('project-rail-row--active') === true`
    ) as boolean
  ))
  await waitFor('revisited active and neighbor rows', async () => (
    await window.webContents.executeJavaScript(
      `${treeRowSource('explorer-source/menu.txt')}?.getAttribute('aria-selected') === 'true' && ` +
      `${treeRowSource('explorer-source/menu-neighbor.txt')}?.getAttribute('aria-selected') === 'true'`
    ) as boolean
  ))
  const afterRevisit = await explorerProjection(window)
  const revisitSettledWithoutLoop = await explorerProjectionSettles(window)
  const revisitEvidence = explorerProjectionEvidenceDelta(
    revisitEvidenceBefore,
    await explorerProjectionEvidence(window)
  )
  const workspaceRevisit = {
    preserved: JSON.stringify(afterRevisit) === JSON.stringify(beforeRevisit),
    settledWithoutLoop: revisitSettledWithoutLoop,
    nativeWorkspaceTransitions: 2,
    explorerProjectionNotifications: revisitEvidence,
    before: beforeRevisit,
    after: afterRevisit
  }

  await window.webContents.executeJavaScript(`${treeRowSource('explorer-source/menu.txt')}?.focus()`)
  sendKey(window, 'F10', ['shift'])
  await waitFor('Shift+F10 Radix Move submenu trigger', async () => (
    await window.webContents.executeJavaScript(
      `Boolean(${visibleMenuItemSource('Move This Item to')})`
    ) as boolean
  ))
  const shiftF10Opened = true
  const multiSelectionPreserved = await window.webContents.executeJavaScript(
    `Boolean(${visibleMenuItemSource('Copy Paths')})`
  ) as boolean
  sendKey(window, 'Escape')
  await waitFor('closed Shift+F10 menu', async () => !(
    await window.webContents.executeJavaScript(
      `Boolean(${visibleMenuItemSource('Move This Item to')})`
    ) as boolean
  ))

  await expandDirectory(window, 'targets/menu')
  await nativeContextMenu(window, 'Radix menu source', treeRowSource('explorer-source/menu.txt'))
  const submenuTrigger = visibleMenuItemSource('Move This Item to')
  await waitFor('Radix Move submenu trigger', async () => (
    await window.webContents.executeJavaScript(`Boolean(${submenuTrigger})`) as boolean
  ))
  await nativeHover(window, 'Radix Move submenu trigger', submenuTrigger)
  const menuTarget = visibleMenuItemSource('targets/menu')
  await waitFor('Radix Move destination item', async () => (
    await window.webContents.executeJavaScript(`Boolean(${menuTarget})`) as boolean
  ))
  const moveCommitReached = options.control.armMoveCommitBarrier()
  await nativeClick(window, 'Radix Move destination item', menuTarget)
  await withTimeout('committed Radix menu move', moveCommitReached)
  await waitFor('committed Radix menu disk move', async () => (
    await pathExists(join(options.workspacePath, 'targets', 'menu', 'menu.txt')) &&
      !await pathExists(join(options.workspacePath, 'explorer-source', 'menu.txt'))
  ))
  await nativeClick(window, 'alternate Workspace during committed move', projectRowSource(options.alternateWorkspacePath))
  await waitFor('active alternate Workspace during committed move', async () => (
    await window.webContents.executeJavaScript(
      `${projectRowSource(options.alternateWorkspacePath)}?.classList.contains('project-rail-row--active') === true`
    ) as boolean
  ))
  await waitFor('alternate Workspace tree during committed move', async () => (
    await window.webContents.executeJavaScript(`Boolean(${treeRowSource('alternate.txt')})`) as boolean
  ))
  const alternateRowsBeforeRelease = await explorerRowPaths(window)
  const directoryReadCursor = options.control.directoryReadCursor()
  const moveProjectionEvidenceBefore = await explorerProjectionEvidence(window)
  options.control.releaseMoveCommitBarrier()
  await waitFor('single move notification and rejected stale parent refreshes', async () => {
    const evidence = explorerProjectionEvidenceDelta(
      moveProjectionEvidenceBefore,
      await explorerProjectionEvidence(window)
    )
    return evidence.total === 1 && evidence.rejectedDirectoryLoads.length === 2
  })
  assertProbe(
    await explorerProjectionSettles(window),
    'Alternate Workspace tree did not settle after releasing the primary move'
  )
  const alternateRowsAfterRelease = await explorerRowPaths(window)
  const stalePrimaryReads = options.control.directoryReadsSince(directoryReadCursor)
    .filter((read) => read.workspaceId === 'workspace-file-editing-e2e')
  assertProbe(
    stalePrimaryReads.length === 0,
    `Stale primary Workspace refresh reached Main while alternate was active: ${JSON.stringify(stalePrimaryReads)}`
  )
  assertProbe(
    JSON.stringify(alternateRowsAfterRelease) === JSON.stringify(alternateRowsBeforeRelease),
    `Primary Workspace cache polluted the alternate tree: ${JSON.stringify({ alternateRowsBeforeRelease, alternateRowsAfterRelease })}`
  )

  await nativeClick(window, 'primary Workspace after committed move', projectRowSource(options.workspacePath))
  await waitFor('active primary Workspace after committed move', async () => (
    await window.webContents.executeJavaScript(
      `${projectRowSource(options.workspacePath)}?.classList.contains('project-rail-row--active') === true`
    ) as boolean
  ))
  await waitFor('moved Radix menu row', async () => (
    await window.webContents.executeJavaScript(
      `Boolean(${treeRowSource('targets/menu/menu.txt')})`
    ) as boolean
  ))
  assertProbe(
    await explorerProjectionSettles(window),
    'Primary Workspace tree did not settle after recovering the committed move'
  )
  const moveProjectionEvidence = explorerProjectionEvidenceDelta(
    moveProjectionEvidenceBefore,
    await explorerProjectionEvidence(window)
  )
  const menuSelection = await explorerProjection(window)
  const menu = {
    shiftF10Opened,
    multiSelectionPreserved,
    moved: true,
    singleSelection: menuSelection.selected.length === 1 &&
      menuSelection.selected[0] === 'targets/menu/menu.txt',
    workspaceRace: {
      alternateTreeUnchanged: JSON.stringify(alternateRowsAfterRelease) === JSON.stringify(alternateRowsBeforeRelease),
      stalePrimaryReadsStarted: stalePrimaryReads.length,
      primaryRecovered: menuSelection.expanded.includes('targets/menu'),
      explorerProjectionNotifications: moveProjectionEvidence
    }
  }

  await expandDirectory(window, 'targets/valid')
  await nativeClick(window, 'pointer source selection', treeRowSource('explorer-source/drag-valid.txt'))
  await nativeClick(window, 'pointer neighbor selection', treeRowSource('explorer-source/menu-neighbor.txt'), ['meta'])
  await waitFor('pointer multi-selection', async () => (
    await window.webContents.executeJavaScript(
      `${treeRowSource('explorer-source/drag-valid.txt')}?.getAttribute('aria-selected') === 'true' && ` +
      `${treeRowSource('explorer-source/menu-neighbor.txt')}?.getAttribute('aria-selected') === 'true'`
    ) as boolean
  ))

  await beginPointerDrag(window, 'explorer-source/drag-valid.txt')
  const pointerDragState = await window.webContents.executeJavaScript(`(() => ({
    sourceSelected: ${treeRowSource('explorer-source/drag-valid.txt')}?.getAttribute('aria-selected') === 'true',
    neighborSelected: ${treeRowSource('explorer-source/menu-neighbor.txt')}?.getAttribute('aria-selected') === 'true',
    fileOverlay: Boolean(document.querySelector('.file-tree-drag-preview')),
    workbenchOverlay: Boolean(document.querySelector('.tab-drag-preview'))
  }))()`) as {
    sourceSelected: boolean
    neighborSelected: boolean
    fileOverlay: boolean
    workbenchOverlay: boolean
  }
  const validTarget = await moveActivePointerDrag(window, 'valid PointerSensor destination', treeRowSource('targets/valid'))
  await waitForActivePointerDropTarget(window, 'targets/valid', validTarget)
  endPointerDrag(window, validTarget)
  await waitFor('PointerSensor disk move', async () => (
    await pathExists(join(options.workspacePath, 'targets', 'valid', 'drag-valid.txt')) &&
      !await pathExists(join(options.workspacePath, 'explorer-source', 'drag-valid.txt'))
  ))
  await waitFor('settled PointerSensor parent projections', async () => (
    await window.webContents.executeJavaScript(
      `!${treeRowSource('explorer-source/drag-valid.txt')} && ` +
      `${treeRowSource('targets/valid')}?.getAttribute('aria-expanded') === 'true' && ` +
      `Boolean(${treeRowSource('targets/valid/drag-valid.txt')})`
    ) as boolean
  ))
  const pointerMove = {
    moved: true,
    singleSelection: pointerDragState.sourceSelected && !pointerDragState.neighborSelected,
    fileOverlayOnly: pointerDragState.fileOverlay && !pointerDragState.workbenchOverlay
  }

  await beginPointerDrag(window, 'explorer-source/drag-invalid.txt')
  await waitFor('disabled collision drop target', async () => (
    await window.webContents.executeJavaScript(
      `${treeRowSource('targets/collision')}?.dataset.moveDropDisabled === 'true'`
    ) as boolean
  ))
  const collisionTarget = await moveActivePointerDrag(window, 'loaded collision destination', treeRowSource('targets/collision'))
  endPointerDrag(window, collisionTarget)
  await waitFor('invalid PointerSensor drag cleanup', async () => !(
    await window.webContents.executeJavaScript("Boolean(document.querySelector('.file-tree-drag-preview'))") as boolean
  ))
  const invalidDrop = {
    blocked: await pathExists(join(options.workspacePath, 'explorer-source', 'drag-invalid.txt')) &&
      await readFile(join(options.workspacePath, 'targets', 'collision', 'drag-invalid.txt'), 'utf8') === 'collision owner'
  }

  await beginPointerDrag(window, 'explorer-source/drag-invalid.txt')
  const cancelTarget = await moveActivePointerDrag(window, 'cancelled hover destination', treeRowSource('targets/cancel'))
  await waitForActivePointerDropTarget(window, 'targets/cancel', cancelTarget)
  await delay(150)
  const cancelTargetStayedActive = await window.webContents.executeJavaScript(
    `${treeRowSource('targets/cancel')}?.classList.contains('tree-row--drop-over') === true`
  ) as boolean
  assertProbe(cancelTargetStayedActive, 'Cancelled hover target lost PointerSensor admission before Escape')
  cancelPointerDrag(window, cancelTarget)
  await waitFor('cancelled hover PointerSensor cleanup', async () => !(
    await window.webContents.executeJavaScript("Boolean(document.querySelector('.file-tree-drag-preview'))") as boolean
  ))
  await delay(600)
  const cancelledStayedCollapsed = await window.webContents.executeJavaScript(
    `${treeRowSource('targets/cancel')}?.getAttribute('aria-expanded') === 'false'`
  ) as boolean

  await beginPointerDrag(window, 'explorer-source/drag-invalid.txt')
  const hoverTarget = await moveActivePointerDrag(window, 'hover-expand destination', treeRowSource('targets/hover'))
  await waitForActivePointerDropTarget(window, 'targets/hover', hoverTarget)
  await waitFor('500ms hover-expanded directory', async () => (
    await window.webContents.executeJavaScript(
      `${treeRowSource('targets/hover')}?.classList.contains('tree-row--drop-over') === true && ` +
      `${treeRowSource('targets/hover')}?.getAttribute('aria-expanded') === 'true'`
    ) as boolean
  ))
  cancelPointerDrag(window, hoverTarget)
  await waitFor('hover-expand PointerSensor cleanup', async () => !(
    await window.webContents.executeJavaScript("Boolean(document.querySelector('.file-tree-drag-preview'))") as boolean
  ))
  await waitFor('loaded hover-expanded directory', async () => (
    await window.webContents.executeJavaScript(
      `Boolean(${treeRowSource('targets/hover/child.txt')})`
    ) as boolean
  ))
  const hover = {
    expanded: true,
    cancelledStayedCollapsed
  }

  assertProbe(pointerMove.singleSelection, 'Pointer drag did not converge Explorer selection to one item')
  assertProbe(pointerMove.fileOverlayOnly, 'File drag leaked into the Workbench DragOverlay')
  assertProbe(invalidDrop.blocked, 'Loaded destination collision accepted an invalid drop')
  assertProbe(hover.expanded && hover.cancelledStayedCollapsed, 'Hover expand or cancel cleanup failed')
  assertProbe(menu.multiSelectionPreserved, 'Shift+F10 did not retain the active multi-selection')
  assertProbe(menu.singleSelection, 'Menu Move did not converge selection onto the moved item')
  assertProbe(
    menu.workspaceRace.explorerProjectionNotifications.total === 1 &&
      menu.workspaceRace.explorerProjectionNotifications.byWorkspace['workspace-file-editing-e2e'] === 1 &&
      JSON.stringify(menu.workspaceRace.explorerProjectionNotifications.rejectedDirectoryLoads) ===
        JSON.stringify([
          { workspaceId: 'workspace-file-editing-e2e', path: 'explorer-source' },
          { workspaceId: 'workspace-file-editing-e2e', path: 'targets/menu' }
        ]),
    `Committed move produced extra Explorer projection notifications: ${JSON.stringify(menu.workspaceRace.explorerProjectionNotifications)}`
  )
  assertProbe(
    workspaceRevisit.preserved &&
      workspaceRevisit.settledWithoutLoop &&
      workspaceRevisit.explorerProjectionNotifications.total === 0,
    `Workspace revisit changed the Explorer projection: ${JSON.stringify(workspaceRevisit)}`
  )
  return { pointerMove, invalidDrop, hover, menu, workspaceRevisit }
}

export async function runDesktopFileEditingProbe(options: {
  window: BrowserWindow
  workspacePath: string
  alternateWorkspacePath: string
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
    phases.explorer = await runExplorerInteractionProbe(options)

    await publishReport(reportPath, {
      schema: 'agentmux.workspace-file-editing-e2e.v2',
      ok: true,
      phases
    })
  } catch (error) {
    await publishReport(reportPath, {
      schema: 'agentmux.workspace-file-editing-e2e.v2',
      ok: false,
      phases,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  } finally {
    options.control.cancelWriteBarrier()
    options.control.cancelMoveCommitBarrier()
  }
  return true
}
