import { useSyncExternalStore } from 'react'
import type { WorkspaceLayout } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import type { WorkbenchTab } from './workbench-tabs'
import { workbenchProjectionSlotId } from './workbench-projection'
import { tabGroupForTab } from './workbench-tabs'
import { layoutForActiveTopic } from './scratch-topic-layout'
import type { WorkbenchViewTarget, WorkbenchViewTargets } from './workbench-presentation'
import { subscribeWorkbenchTabRemoved } from './workbench-tab-removal'
import { scratchTopicKind, scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { effectiveSessionViewMode, sessionPresentationById } from './session-presentation'

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
  /** null is an explicit empty Topic; a missing string remains an exact recovery target. */
  targetTabId?: string | null | undefined
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
let unsubscribeTabRemoved: (() => void) | undefined
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
      ...(value.targetTabId === null ? { targetTabId: null } :
        typeof value.targetTabId === 'string' && value.targetTabId.trim() ? { targetTabId: value.targetTabId.trim() } : {}),
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
  if (floating.targetTabId === null) return undefined
  if (floating.targetTabId) return floating.targetTabId
  const topicId = pmoTeamsTopicFloatingTargetTopicId(floating, tabs)
  const belongs = (tab: WorkbenchTab | undefined): tab is WorkbenchTab =>
    tab?.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === topicId
  const candidates = Object.values(tabs).filter(tab => belongs(tab) && layout && tabGroupForTab(layout, tab.id) !== null)
  const focused = pmoSessionId ? candidates.find(tab => Object.values(tab.regions)
    .some(region => region.kind === 'agent' && region.sessionId === pmoSessionId)) : undefined
  if (focused) return focused.id
  const active = layout?.groups.find(group => group.id === layout.activeGroupId)?.activeTabId
  if (active && candidates.some(tab => tab.id === active)) return active
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
): WorkbenchViewTargets | undefined {
  if (!(floating.open || floating.preview) || !layout) return undefined
  const topicId = pmoTeamsTopicFloatingTargetTopicId(floating, tabs)
  const tabId = pmoTeamsTopicFloatingTargetTabId(floating, tabs, layout, pmoSessionId)
  const tab = tabId ? tabs[tabId] : undefined
  if (!tab || tab.workspaceId !== SCRATCH_WORKSPACE_ID || tab.topicId !== topicId || !tabGroupForTab(layout, tab.id)) return undefined
  const targets: Record<string, WorkbenchViewTarget[]> = {}
  for (const group of layoutForActiveTopic(layout, tabs, topicId, false, tabId).groups) {
    const member = group.activeTabId ? tabs[group.activeTabId] : undefined
    if (!member?.regions[member.layout.activeRegionId]) continue
    const reference = { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: group.id, tabId: member.id, regionId: member.layout.activeRegionId }
    ;(targets[member.id] ??= []).push({ hostId: workbenchProjectionSlotId(PMO_FLOATING_TAB_SLOT_PREFIX, reference),
      active: floating.open, visible: true, surface: 'mote', reference })
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
  const previous = snapshot(), current = useAppStore.getState()
  const tabId = options?.targetTabId?.trim()
  const topicId = options?.targetTopicId?.trim() ?? (tabId ? current.tabs[tabId]?.topicId : undefined)
  const next = { ...previous, open: true, preview: false, ...(topicId ? { targetTopicId: topicId } : {}),
    ...(tabId ? { targetTabId: tabId } : topicId && topicId !== previous.targetTopicId ? { targetTabId: undefined } : {}) }
  const layout = current.layouts[SCRATCH_WORKSPACE_ID]
  const resolvedTopicId = pmoTeamsTopicFloatingTargetTopicId(next, current.tabs)
  const resolvedTabId = pmoTeamsTopicFloatingTargetTabId(next, current.tabs, layout, current.agentFocus.pmo.sessionId)
  const isOpening = !previous.open || resolvedTopicId !== pmoTeamsTopicFloatingTargetTopicId(previous, current.tabs) ||
    resolvedTabId !== pmoTeamsTopicFloatingTargetTabId(previous, current.tabs, layout, current.agentFocus.pmo.sessionId)
  if (isOpening) {
    const tab = resolvedTabId ? current.tabs[resolvedTabId] : undefined
    const workspace = current.config?.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)
    const topics = scratchTopicsForWorkspace(current.scratchTopicSnapshots, workspace)
    const region = tab?.regions[tab.layout.activeRegionId]
    const session = region?.kind === 'agent' ? sessionPresentationById(current.sessions).get(region.sessionId) : undefined
    if (tab?.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === resolvedTopicId && layout && tabGroupForTab(layout, tab.id) &&
      scratchTopicKind(resolvedTopicId, topics) === 'mote' && session?.kind === 'agent' &&
      effectiveSessionViewMode(current, session.id) !== 'activity') current.setViewMode(session.id, 'activity', { focus: false })
  }
  update(next)
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

export function subscribePmoTeamsTopicFloatingState(listener: () => void): () => void {
  listeners.add(listener)
  unsubscribeTabRemoved ??= subscribeWorkbenchTabRemoved(tab => {
    const current = state
    if (!current || current.targetTabId !== tab.id || tab.workspaceId !== SCRATCH_WORKSPACE_ID ||
      current.targetTopicId && current.targetTopicId !== tab.topicId) return
    const topicId = current.targetTopicId ?? tab.topicId
    if (!topicId) return
    const committed = useAppStore.getState()
    if (committed.tabs[tab.id]) return
    const nextTabId = pmoTeamsTopicFloatingTargetTabId({ ...current, targetTopicId: topicId, targetTabId: undefined }, committed.tabs,
      committed.layouts[SCRATCH_WORKSPACE_ID], committed.agentFocus.pmo.sessionId)
    update({ targetTopicId: topicId, targetTabId: nextTabId ?? null })
  })
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unsubscribeTabRemoved?.(); unsubscribeTabRemoved = undefined
      cancelClose(); returnFocus = null; state = undefined
    }
  }
}
export function usePmoTeamsTopicFloatingState(): [PmoTeamsTopicFloatingState, (next: Partial<PmoTeamsTopicFloatingState>) => void] {
  return [useSyncExternalStore(subscribePmoTeamsTopicFloatingState, snapshot, () => CLOSED), update]
}
