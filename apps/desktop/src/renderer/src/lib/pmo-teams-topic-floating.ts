import { useSyncExternalStore } from 'react'
import type { WorkspaceLayout } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import type { WorkbenchTab } from './workbench-tabs'
import { tabGroupForTab } from './workbench-tabs'
import { layoutForActiveTopic } from './scratch-topic-layout'
import type { WorkbenchViewTarget } from './workbench-presentation'

export const PMO_FLOATING_TAB_SLOT_PREFIX = 'mote-floating-tab-slot'
const STORAGE_KEY = 'agentmux.leader-topic-floating.v1'

export type PmoTeamsTopicFloatingSize = { width: number; height: number }
export function resolvePmoTeamsTopicFloatingSize(preferred: PmoTeamsTopicFloatingSize | undefined,
  available: PmoTeamsTopicFloatingSize, railMode: 'cards' | 'avatars', viewportWidth: number): PmoTeamsTopicFloatingSize {
  const rail = railMode === 'avatars' ? 56 : viewportWidth <= 560 ? 136 : 172
  const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(0, maximum), Math.max(minimum, value))
  return { width: clamp(preferred?.width ?? 720, rail + 232, available.width),
    height: clamp(preferred?.height ?? 520, 250, available.height) }
}
function sameSize(a: PmoTeamsTopicFloatingSize | undefined, b: PmoTeamsTopicFloatingSize | undefined): boolean {
  return a?.width === b?.width && a?.height === b?.height
}
function validSize(value: unknown): value is PmoTeamsTopicFloatingSize {
  if (!value || typeof value !== 'object') return false
  const size = value as PmoTeamsTopicFloatingSize
  return Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0
}

export type PmoTeamsTopicFloatingState = {
  /** Only an explicitly pinned surface is restored. */
  open: boolean
  preview: boolean
  targetTopicId?: string | undefined
  targetTabId?: string | undefined
  /** Navigation presentation only; unrelated to an Agent's explicit view mode. */
  railMode?: 'cards' | 'avatars' | undefined
  size?: PmoTeamsTopicFloatingSize | undefined
  /** Advisory UI persistence failure; never disables the retained workspace. */
  preferenceIssue?: string | undefined
}

const CLOSED: PmoTeamsTopicFloatingState = { open: false, preview: false }
let state: PmoTeamsTopicFloatingState | undefined
/** Read the original mounted owner without initializing, opening or retargeting it. */
export function readPmoTeamsTopicFloatingState(): PmoTeamsTopicFloatingState | null { return state ?? null }
const listeners = new Set<() => void>()
let closeTimer: ReturnType<typeof setTimeout> | undefined
let returnFocus: { primary: HTMLElement | null; onReturnFocus?: (() => void) | undefined } | null = null

function readState(): PmoTeamsTopicFloatingState {
  if (typeof window === 'undefined') return CLOSED
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return CLOSED
    const value = JSON.parse(raw) as Partial<PmoTeamsTopicFloatingState>
    return { open: value.open === true, preview: false,
      ...(typeof value.targetTopicId === 'string' && value.targetTopicId.trim() ? { targetTopicId: value.targetTopicId.trim() } : {}),
      ...(typeof value.targetTabId === 'string' && value.targetTabId.trim() ? { targetTabId: value.targetTabId.trim() } : {}),
      ...(value.railMode === 'cards' || value.railMode === 'avatars' ? { railMode: value.railMode } : {}),
      ...(validSize(value.size) ? { size: value.size } : {}) }
  } catch { return { ...CLOSED, preferenceIssue: 'Mote preferences could not be read. This window uses the default size; reload the app to retry.' } }
}

function snapshot(): PmoTeamsTopicFloatingState {
  return state ??= readState()
}
function cancelClose(): void { clearTimeout(closeTimer); closeTimer = undefined }
function update(next: Partial<PmoTeamsTopicFloatingState>): void {
  const current = snapshot()
  const resolved = { ...current, ...next }
  if (resolved.open === current.open && resolved.preview === current.preview &&
    resolved.targetTopicId === current.targetTopicId && resolved.targetTabId === current.targetTabId &&
    resolved.railMode === current.railMode && sameSize(resolved.size, current.size) && resolved.preferenceIssue === current.preferenceIssue) return
  state = resolved
  if (resolved.open !== current.open || resolved.targetTopicId !== current.targetTopicId || resolved.targetTabId !== current.targetTabId || resolved.railMode !== current.railMode || !sameSize(resolved.size, current.size)) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: resolved.open,
      targetTopicId: resolved.targetTopicId, targetTabId: resolved.targetTabId, railMode: resolved.railMode, size: resolved.size }))
      state = { ...resolved, preferenceIssue: undefined }
    } catch { state = { ...resolved, preferenceIssue: 'Mote preferences could not be saved. This window keeps your size; resize again to retry.' } }
  }
  for (const listener of listeners) listener()
}
function captureFocus(onReturnFocus?: () => void): void {
  const active = document.activeElement
  if (!returnFocus || onReturnFocus) returnFocus = {
    primary: active instanceof HTMLElement && !active.closest('[data-pmo-teams-topic-floating]') ? active : returnFocus?.primary ?? null,
    onReturnFocus
  }
}

/** Select from durable Tabs first; never borrow another Mote while one restores. */
export function pmoTeamsTopicFloatingTargetTopicId(floating: PmoTeamsTopicFloatingState, tabs: Readonly<Record<string, WorkbenchTab>>): string {
  return floating.targetTopicId ?? (floating.targetTabId ? tabs[floating.targetTabId]?.topicId : undefined) ?? PMO_TEAMS_TOPIC_ID
}
export function pmoTeamsTopicFloatingTargetTabId(
  floating: PmoTeamsTopicFloatingState,
  tabs: Readonly<Record<string, WorkbenchTab>>,
  layout: WorkspaceLayout | undefined,
  pmoSessionId: string | null
): string | undefined {
  if (floating.targetTabId) return floating.targetTabId
  const topicId = pmoTeamsTopicFloatingTargetTopicId(floating, tabs)
  const belongs = (tab: WorkbenchTab | undefined): tab is WorkbenchTab =>
    tab?.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === topicId
  const candidates = Object.values(tabs).filter(belongs)
  const focused = pmoSessionId ? candidates.find(tab => Object.values(tab.regions)
    .some(region => region.kind === 'agent' && region.sessionId === pmoSessionId)) : undefined
  if (focused) return focused.id
  const active = layout?.groups.find(group => group.id === layout.activeGroupId)?.activeTabId
  if (active && belongs(tabs[active])) return active
  return candidates[0]?.id
}

/** Zustand calls selectors for every output event; resolve only navigation changes. */
export function createPmoTeamsTopicTargetSelector(floating: PmoTeamsTopicFloatingState) {
  let previous: { tabs: Readonly<Record<string, WorkbenchTab>>; layout: WorkspaceLayout | undefined; sessionId: string | null; tabId: string | undefined } | undefined
  return (state: Pick<ReturnType<typeof useAppStore.getState>, 'tabs' | 'layouts' | 'agentFocus'>): string | undefined => {
    const layout = state.layouts[SCRATCH_WORKSPACE_ID]
    const sessionId = state.agentFocus.pmo.sessionId
    if (previous && previous.tabs === state.tabs && previous.layout === layout && previous.sessionId === sessionId) return previous.tabId
    const tabId = pmoTeamsTopicFloatingTargetTabId(floating, state.tabs, layout, sessionId)
    previous = { tabs: state.tabs, layout, sessionId, tabId }
    return tabId
  }
}

/** App and projection use these same destinations; only visible target Views move. */
export function pmoTeamsTopicFloatingViewTargets(
  floating: PmoTeamsTopicFloatingState, tabs: Readonly<Record<string, WorkbenchTab>>,
  layout: WorkspaceLayout | undefined, pmoSessionId: string | null
): Readonly<Record<string, WorkbenchViewTarget>> | undefined {
  if (!(floating.open || floating.preview) || !layout) return undefined
  const topicId = pmoTeamsTopicFloatingTargetTopicId(floating, tabs)
  const tabId = pmoTeamsTopicFloatingTargetTabId(floating, tabs, layout, pmoSessionId)
  const tab = tabId ? tabs[tabId] : undefined
  if (!tab || tab.workspaceId !== SCRATCH_WORKSPACE_ID || tab.topicId !== topicId || !tabGroupForTab(layout, tab.id)) return undefined
  const targets: Record<string, WorkbenchViewTarget> = {}
  for (const group of layoutForActiveTopic(layout, tabs, topicId, false, tabId).groups) {
    if (group.activeTabId) targets[group.activeTabId] = { hostId: PMO_FLOATING_TAB_SLOT_PREFIX + ':' + group.activeTabId, active: floating.open }
  }
  return targets
}

export function requestPmoTeamsTopicFloatingPreview(): void {
  cancelClose()
  if (snapshot().open) return
  captureFocus()
  update({ preview: true })
}
export function leavePmoTeamsTopicFloatingPreview(): void {
  cancelClose()
  if (!snapshot().preview || snapshot().open) return
  closeTimer = setTimeout(() => requestPmoTeamsTopicFloatingClose({ restoreFocus: false }), 180)
}
export function keepPmoTeamsTopicFloatingPreview(): void { cancelClose() }

/** Pinning reuses the visible surface and the original input/focus owners. */
export function pinPmoTeamsTopicFloating(): void {
  cancelClose()
  captureFocus()
  update({ open: true, preview: false })
}
export function requestPmoTeamsTopicFloatingOpen(options?: { targetTopicId?: string; targetTabId?: string; onReturnFocus?: () => void }): void {
  cancelClose()
  captureFocus(options?.onReturnFocus)
  const tabId = options?.targetTabId?.trim()
  const topicId = options?.targetTopicId?.trim() ?? (tabId ? useAppStore.getState().tabs[tabId]?.topicId : undefined)
  update({ open: true, preview: false, ...(topicId ? { targetTopicId: topicId } : {}),
    ...(tabId ? { targetTabId: tabId } : topicId && topicId !== snapshot().targetTopicId ? { targetTabId: undefined } : {}) })
  requestAnimationFrame(() => {
    if (!snapshot().open) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('[data-pmo-teams-topic-floating]')) return
    document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')?.focus({ preventScroll: true })
  })
}
export function requestPmoTeamsTopicFloatingClose(options?: { restoreFocus?: boolean }): void {
  cancelClose()
  const active = document.activeElement
  const inside = active instanceof HTMLElement && Boolean(active.closest('[data-pmo-teams-topic-floating]'))
  const target = returnFocus
  returnFocus = null
  update({ open: false, preview: false })
  if (options?.restoreFocus === false || !inside) return
  requestAnimationFrame(() => {
    if (snapshot().open || snapshot().preview) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body &&
      !active.closest('[data-pmo-teams-topic-floating], [data-pmo-teams-topic-launcher]')) return
    if (target?.primary && target.primary !== document.body && document.contains(target.primary)) target.primary.focus({ preventScroll: true })
    else if (target?.onReturnFocus) target.onReturnFocus()
    else document.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')?.focus({ preventScroll: true })
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) { cancelClose(); returnFocus = null; state = undefined }
  }
}
export function usePmoTeamsTopicFloatingState(): [PmoTeamsTopicFloatingState, (next: Partial<PmoTeamsTopicFloatingState>) => void] {
  return [useSyncExternalStore(subscribe, snapshot, () => CLOSED), update]
}
