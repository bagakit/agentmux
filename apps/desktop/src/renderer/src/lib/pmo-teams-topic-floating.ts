import type { MoteRecentAgent } from './mote-quick-preferences'
import { sessionPresentationById } from './session-presentation'
import type { SessionSnapshot } from '../../../shared/contracts'
import { moteDefaultConversation, moteConversationReference } from './mote-quick-preferences'
import { useSyncExternalStore } from 'react'
import { groupIds, type WorkspaceLayout } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'
import type { WorkbenchTab } from './workbench-tabs'
import { projectWorkbenchProjection, sameWorkbenchProjectionSelection, type WorkbenchProjection, type WorkbenchProjectionSelection, workbenchProjectionSlotId } from './workbench-projection'
import { type WorkbenchViewTarget, type WorkbenchViewTargets } from './workbench-presentation'
import { subscribeWorkbenchTabRemoved } from './workbench-tab-removal'
import { scratchTopicKind, scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { showMoteConversation } from './mote-conversation-mode'

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
  /** Expected identity of a remembered Agent; absence leaves ordinary explicit targets unchanged. */
  targetAgent?: Pick<MoteRecentAgent, 'hostId' | 'sessionId' | 'presentationSessionId'> | undefined
  /** Explicit original Agent destination; it does not make the Agent a Mote member. */
  agentTarget?: { agentSessionId: string | null; hostId?: string | undefined } | undefined
  /** Entry feedback only. Agent working state remains the original Session fact. */
  entryMessage?: string | undefined
  /** Transient navigation correlation; the original Goal owner still owns the operation. */
  entryContext?: { kind: 'goal-patrol'; goalId: string; scope: string | null; afterReportOperationId: string | null } | undefined
  /** null means no current selection; existing Topic members remain navigable. A missing string remains an exact recovery target. */
  targetTabId?: string | null | undefined
  /** Exact selected occurrence; null keeps an unconfirmed saved placement. */
  reference?: WorkbenchProjectionSelection | null | undefined
  /** Navigation presentation only; unrelated to an Agent's explicit view mode. */
  railMode?: 'cards' | 'avatars' | undefined
  size?: PmoTeamsTopicFloatingSize | undefined
  /** Focus Chat recipient: absent follows floating; null retains an unconfirmed saved choice. */
  focusChatTopicId?: string | null | undefined
  /** Advisory UI persistence failure; never disables the retained workspace. */
  preferenceIssue?: string | undefined
  /** Ephemeral explicit-entry intent. Hover and natural pinning do not create one. */
  conversationEntry?: number | undefined
}

function validReference(value: unknown): value is WorkbenchProjectionSelection {
  return Boolean(value && typeof value === 'object' && ['displayWorkspaceId', 'groupId', 'tabId', 'regionId']
    .every(key => typeof (value as Record<string, unknown>)[key] === 'string' && (value as Record<string, string>)[key]!.trim()))
}

const CLOSED: PmoTeamsTopicFloatingState = { open: false, preview: false }
let state: PmoTeamsTopicFloatingState | undefined
let conversationEntrySequence = 0
function nextConversationEntry(): number { return ++conversationEntrySequence }
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
    if (raw === null) return CLOSED
    const value = JSON.parse(raw) as Partial<PmoTeamsTopicFloatingState>
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Mote preferences')
    const invalidChoice = value.focusChatTopicId !== undefined && (typeof value.focusChatTopicId !== 'string' || !value.focusChatTopicId.trim())
    return { open: value.open === true, preview: false,
      ...(typeof value.targetTopicId === 'string' && value.targetTopicId.trim() ? { targetTopicId: value.targetTopicId.trim() } : {}),
      ...(value.targetTabId === null ? { targetTabId: null } :
        typeof value.targetTabId === 'string' && value.targetTabId.trim() ? { targetTabId: value.targetTabId.trim() } : {}),
      ...(Object.hasOwn(value, 'reference') ? { reference: validReference(value.reference) ? value.reference : null } : {}),
      ...(value.targetAgent && typeof value.targetAgent.hostId === 'string' && typeof value.targetAgent.sessionId === 'string' && typeof value.targetAgent.presentationSessionId === 'string' ? { targetAgent: { hostId: value.targetAgent.hostId, sessionId: value.targetAgent.sessionId, presentationSessionId: value.targetAgent.presentationSessionId } } : {}),
      ...(value.agentTarget && (value.agentTarget.agentSessionId === null || typeof value.agentTarget.agentSessionId === 'string') ? { agentTarget: value.agentTarget } : {}),
      ...(value.railMode === 'cards' || value.railMode === 'avatars' ? { railMode: value.railMode } : {}),
      ...(validSize(value.size) ? { size: value.size } : {}),
      ...(invalidChoice ? { focusChatTopicId: null, preferenceIssue: 'The saved Chat recipient is unconfirmed. Select a Mote to confirm the recipient.' } : typeof value.focusChatTopicId === 'string' ? { focusChatTopicId: value.focusChatTopicId.trim() } : {}) }
  } catch { return { ...CLOSED, focusChatTopicId: null, preferenceIssue: 'Mote preferences could not be read. Select a Mote to confirm the Chat recipient; reload the app to retry the saved choice and size.' } }
}

function snapshot(): PmoTeamsTopicFloatingState {
  return state ??= readState()
}
function cancelClose(): void { clearTimeout(closeTimer); closeTimer = undefined }
function update(next: Partial<PmoTeamsTopicFloatingState>, persist = true): void {
  const current = snapshot()
  const explicitChoice = Object.hasOwn(next, 'focusChatTopicId') && Boolean(next.focusChatTopicId?.trim())
  const retryPreference = Boolean(current.preferenceIssue && (explicitChoice || Object.hasOwn(next, 'size')))
  const retargeted = (Object.hasOwn(next, 'targetTopicId') && next.targetTopicId !== current.targetTopicId) ||
    (Object.hasOwn(next, 'targetTabId') && next.targetTabId !== current.targetTabId) ||
    (Object.hasOwn(next, 'reference') && JSON.stringify(next.reference) !== JSON.stringify(current.reference))
  const resolved = { ...current, ...(retargeted && !Object.hasOwn(next, 'reference') ? { reference: undefined } : {}),
    ...(retargeted && !Object.hasOwn(next, 'targetAgent') ? { targetAgent: undefined } : {}), ...next }
  if (resolved.open === current.open && resolved.preview === current.preview &&
    resolved.targetTopicId === current.targetTopicId && resolved.targetTabId === current.targetTabId &&
    JSON.stringify(resolved.reference) === JSON.stringify(current.reference) && JSON.stringify(resolved.targetAgent) === JSON.stringify(current.targetAgent) &&
    JSON.stringify(resolved.agentTarget) === JSON.stringify(current.agentTarget) && resolved.entryMessage === current.entryMessage &&
    JSON.stringify(resolved.entryContext) === JSON.stringify(current.entryContext) &&
    resolved.railMode === current.railMode && sameSize(resolved.size, current.size) && resolved.focusChatTopicId === current.focusChatTopicId &&
    resolved.preferenceIssue === current.preferenceIssue && resolved.conversationEntry === current.conversationEntry && !retryPreference) return
  state = resolved
  if (persist && (resolved.open !== current.open || JSON.stringify(resolved.agentTarget) !== JSON.stringify(current.agentTarget) || resolved.targetTopicId !== current.targetTopicId || resolved.targetTabId !== current.targetTabId || JSON.stringify(resolved.reference) !== JSON.stringify(current.reference) || JSON.stringify(resolved.targetAgent) !== JSON.stringify(current.targetAgent) || resolved.railMode !== current.railMode || !sameSize(resolved.size, current.size) || resolved.focusChatTopicId !== current.focusChatTopicId || retryPreference)) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: resolved.open, agentTarget: resolved.agentTarget,
      targetTopicId: resolved.targetTopicId, targetTabId: resolved.targetTabId, targetAgent: resolved.targetAgent, reference: resolved.reference, railMode: resolved.railMode, size: resolved.size, focusChatTopicId: resolved.focusChatTopicId }))
      state = { ...resolved, preferenceIssue: undefined }
    } catch { state = { ...resolved, preferenceIssue: 'Mote preferences could not be saved. This window keeps your choice and size; select the Mote or resize again to retry.' } }
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
  if (floating.agentTarget) return floating.targetTabId ? tabs[floating.targetTabId]?.topicId ?? '' : ''
  return floating.targetTopicId ?? (floating.targetTabId ? tabs[floating.targetTabId]?.topicId : undefined) ?? PMO_TEAMS_TOPIC_ID
}
export function pmoTeamsTopicFloatingTargetTabId(
  floating: PmoTeamsTopicFloatingState,
  tabs: Readonly<Record<string, WorkbenchTab>>,
  layout: WorkspaceLayout | undefined,
  _pmoSessionId: string | null
): string | undefined {
  if (floating.agentTarget) return floating.targetTabId ?? undefined
  if (floating.targetTabId === null) return undefined
  if (floating.targetTabId) return floating.targetTabId
  const topicId = pmoTeamsTopicFloatingTargetTopicId(floating, tabs)
  const belongs = (tab: WorkbenchTab | undefined): tab is WorkbenchTab =>
    tab?.workspaceId === SCRATCH_WORKSPACE_ID && tab.topicId === topicId
  const group = layout?.groups.find(item => item.id === layout.activeGroupId && groupIds(layout.root).includes(item.id))
  if (group?.activeTabId && belongs(tabs[group.activeTabId])) return group.activeTabId
  const candidates = Object.values(tabs).filter(belongs)
  // No arbitrary array-first choice or another Mote's active member.

  return candidates.length === 1 ? candidates[0]!.id : undefined
}

/** Only entering without an explicit target uses the original saved default. No global navigation or Run operation. */
export function floatingMoteDefaultSelection(floating: PmoTeamsTopicFloatingState): PmoTeamsTopicFloatingState {
  if (floating.agentTarget) return floating
  const current = useAppStore.getState(), topicId = pmoTeamsTopicFloatingTargetTopicId(floating, current.tabs)
  const workspace = current.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  const topics = scratchTopicsForWorkspace(current.scratchTopicSnapshots, workspace)
  const topic = topics?.find(item => item.id === topicId)
  const recent = current.recentMoteAgents[topicId]
  if (recent) return { ...floating, targetTopicId: topicId, targetTabId: recent.tabId,
    reference: moteConversationReference(recent), targetAgent: { hostId: recent.hostId, sessionId: recent.sessionId, presentationSessionId: recent.presentationSessionId } }
  if (floating.targetTabId) return floating
  const preferred = topic ? moteDefaultConversation(current, topic, SCRATCH_WORKSPACE_ID) : {}
  return preferred.conversation && !preferred.issue ? { ...floating, targetTopicId: topicId, targetTabId: preferred.conversation.tabId,
    reference: moteConversationReference(preferred.conversation) } : floating
}

/** Capture a first confirmed local choice once; unknown saved addresses stay verbatim. */
function initialFloatingSelection(floating: PmoTeamsTopicFloatingState): PmoTeamsTopicFloatingState {
  if (floating.agentTarget) return floating
  const current = useAppStore.getState()
  const topicId = pmoTeamsTopicFloatingTargetTopicId(floating, current.tabs)
  const tabId = pmoTeamsTopicFloatingTargetTabId(floating, current.tabs, current.layouts[SCRATCH_WORKSPACE_ID], null)
  const tab = tabId ? current.tabs[tabId] : undefined
  if (!tab || tab.workspaceId !== SCRATCH_WORKSPACE_ID || tab.topicId !== topicId) return floating
  const next = { ...floating, targetTopicId: topicId, targetTabId: tab.id }
  if (Object.hasOwn(floating, 'reference') && floating.reference !== undefined) return next
  const regionId = tab.layout.activeRegionId
  if (!tab.regions[regionId]) return next
  if (floating.targetTabId === undefined) return next
  const references = Object.entries(current.layouts).flatMap(([displayWorkspaceId, layout]) => {
    const visible = new Set(groupIds(layout.root))
    return layout.groups.filter(group => visible.has(group.id) && group.tabOrder.includes(tab.id))
      .map(group => ({ displayWorkspaceId, groupId: group.id, tabId: tab.id, regionId }))
  })
  return references.length === 1 ? { ...next, reference: references[0] } : next
}

/** A bookmark never authorizes a different Agent that later occupies its Region. */
export function pmoTeamsTopicFloatingAgentIssue(floating: PmoTeamsTopicFloatingState,
  tab: WorkbenchTab | undefined, session?: SessionSnapshot): string | null {
  if (floating.agentTarget) {
    if (!floating.agentTarget.agentSessionId) return '原 Goal 尚未确认 Supervisor。巡查请求保留；请明确选择 Supervisor。'
    if (!floating.reference) return '原 Agent 的准确对话位置尚未确认。原身份、请求和输入保留；请选择原位置或读取原 Session。'
    const region = tab?.regions[floating.reference.regionId]
    if (!region || region.kind !== 'agent' || !session && !floating.targetAgent && region.sessionId !== floating.agentTarget.agentSessionId ||
      floating.targetAgent && region.sessionId !== floating.targetAgent.presentationSessionId ||
      session?.control.kind === 'agent' && (session.control.agentSessionId !== floating.agentTarget.agentSessionId ||
        floating.agentTarget.hostId && session.control.hostId !== floating.agentTarget.hostId))
      return '原 Agent 未在所选位置确认。原身份和工作保留；请重新读取原对话位置。'
  }
  if (!floating.targetAgent || !floating.reference) return null
  const region = tab?.id === floating.reference.tabId ? tab.regions[floating.reference.regionId] : undefined
  if (!region || region.kind !== 'agent' || region.sessionId !== floating.targetAgent.presentationSessionId || session?.control.kind === 'agent' &&
    (session.control.hostId !== floating.targetAgent.hostId || session.control.agentSessionId !== floating.targetAgent.sessionId))
    return 'The last visited Agent is not confirmed at its original location. Its identity and work are kept; inspect the original Tab to continue.'
  return null
}

/** Zustand calls selectors for every output event; resolve only navigation changes. */
export function createPmoTeamsTopicTargetSelector(floating: PmoTeamsTopicFloatingState) {
  let previous: { tabs: Readonly<Record<string, WorkbenchTab>>; layout: WorkspaceLayout | undefined; tabId: string | undefined } | undefined
  return (state: Pick<ReturnType<typeof useAppStore.getState>, 'tabs' | 'layouts' | 'agentFocus'>): string | undefined => {
    const layout = state.layouts[SCRATCH_WORKSPACE_ID]
    if (previous && previous.tabs === state.tabs && previous.layout === layout) return previous.tabId
    const tabId = pmoTeamsTopicFloatingTargetTabId(floating, state.tabs, layout, null)
    previous = { tabs: state.tabs, layout, tabId }
    return tabId
  }
}

/** App and projection use these same destinations; only visible target Views move. */
export function pmoTeamsTopicFloatingViewTargets(
  floating: PmoTeamsTopicFloatingState, tabs: Readonly<Record<string, WorkbenchTab>>,
  layout: WorkspaceLayout | undefined, pmoSessionId: string | null, projection: WorkbenchProjection | null
): WorkbenchViewTargets | undefined {
  if (!(floating.open || floating.preview)) return undefined
  const current = useAppStore.getState(), heldTab = floating.reference ? tabs[floating.reference.tabId] : undefined
  const heldRegion = floating.reference ? heldTab?.regions[floating.reference.regionId] : undefined
  const heldSession = heldRegion?.kind === 'agent' ? sessionPresentationById(current.sessions).get(heldRegion.sessionId) : undefined
  if (pmoTeamsTopicFloatingAgentIssue(floating, heldTab, heldSession)) return undefined
  if (projection) {
    const current = useAppStore.getState()
    const projected = projectWorkbenchProjection(current.layouts[projection.displayWorkspaceId], tabs, projection)
    const references = projection.selection.filter(reference => projected.layout?.groups.some(group =>
      group.id === reference.groupId && group.activeTabId === reference.tabId) && !projected.unsupportedTabIds.has(reference.tabId))
    const targets: Record<string, WorkbenchViewTarget[]> = {}
    for (const reference of references) (targets[reference.tabId] ??= []).push({
      hostId: workbenchProjectionSlotId(PMO_FLOATING_TAB_SLOT_PREFIX, reference),
      active: floating.open, visible: true, surface: 'mote', reference, projection, retainedRegionId: reference.regionId,
      onSelectRegion: regionId => projection.onSelect({ ...reference, regionId })
    })
    return targets
  }
  const topicId = pmoTeamsTopicFloatingTargetTopicId(floating, tabs)
  const tabId = pmoTeamsTopicFloatingTargetTabId(floating, tabs, layout, pmoSessionId)
  const tab = tabId ? tabs[tabId] : undefined
  if (!tab || !floating.agentTarget && (tab.workspaceId !== SCRATCH_WORKSPACE_ID || tab.topicId !== topicId)) return undefined
  // An unknown address keeps only its original entity, never a guessed occurrence.
  return { [tab.id]: [{
    hostId: `${PMO_FLOATING_TAB_SLOT_PREFIX}:${tab.id}`, active: floating.open, visible: true, surface: 'mote'
  }] }

}

export function requestPmoTeamsTopicFloatingPreview(): void {
  cancelClose()
  if (snapshot().open) return
  captureFocus()
  // A preview may resolve its current address without saving a navigation choice.
  update(initialFloatingSelection(floatingMoteDefaultSelection({ ...snapshot(), preview: true })), false)
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
  update({ ...snapshot(), open: true, preview: false })
}
export function requestPmoTeamsTopicFloatingOpen(options?: { targetTopicId?: string; targetTabId?: string; reference?: WorkbenchProjectionSelection; onReturnFocus?: () => void }): void {
  cancelClose()
  captureFocus(options?.onReturnFocus)
  const retained = snapshot(), previous = retained.agentTarget ? { ...retained, targetTopicId: undefined, targetTabId: undefined, reference: undefined, targetAgent: undefined } : retained
  const current = useAppStore.getState()
  const suppliedReference = options?.reference ? { displayWorkspaceId: options.reference.displayWorkspaceId,
    groupId: options.reference.groupId, tabId: options.reference.tabId, regionId: options.reference.regionId } : undefined
  const tabId = options?.targetTabId?.trim() ?? options?.reference?.tabId
  const topicId = options?.targetTopicId?.trim() ?? (tabId ? current.tabs[tabId]?.topicId : undefined)
  const retargeted = Boolean(topicId && topicId !== previous.targetTopicId || tabId && tabId !== previous.targetTabId)
  let next: PmoTeamsTopicFloatingState = { ...previous, open: true, preview: false, agentTarget: undefined, entryMessage: undefined, entryContext: undefined, ...(topicId ? { targetTopicId: topicId } : {}),
    ...(tabId ? { targetTabId: tabId } : topicId && topicId !== previous.targetTopicId ? { targetTabId: undefined } : {}),
    ...(suppliedReference ? { reference: suppliedReference } : retargeted ? { reference: undefined } : {}),
    ...(tabId || suppliedReference || retargeted ? { targetAgent: undefined } : {}) }
  if (!tabId && !suppliedReference && (!previous.open || topicId && topicId !== previous.targetTopicId)) next = floatingMoteDefaultSelection(next)
  next = initialFloatingSelection(next)
  const layout = current.layouts[SCRATCH_WORKSPACE_ID]
  const resolvedTopicId = pmoTeamsTopicFloatingTargetTopicId(next, current.tabs)
  const resolvedTabId = pmoTeamsTopicFloatingTargetTabId(next, current.tabs, layout, current.agentFocus.pmo.sessionId)
  const isOpening = !previous.open || resolvedTopicId !== pmoTeamsTopicFloatingTargetTopicId(previous, current.tabs) ||
    resolvedTabId !== pmoTeamsTopicFloatingTargetTabId(previous, current.tabs, layout, current.agentFocus.pmo.sessionId) ||
    Boolean(suppliedReference && (!previous.reference || !sameWorkbenchProjectionSelection(suppliedReference, previous.reference)))
  if (isOpening) {
    next = { ...next, conversationEntry: nextConversationEntry() }
    const workspace = current.config?.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)
    const topics = scratchTopicsForWorkspace(current.scratchTopicSnapshots, workspace)
    const topic = topics?.find(one => one.id === resolvedTopicId)
    const rootPath = workspace && topic ? scratchTopicLogicalPath(workspace, topic) : null
    const heldTab = next.reference ? current.tabs[next.reference.tabId] : undefined
    const heldRegion = next.reference ? heldTab?.regions[next.reference.regionId] : undefined
    const heldSession = heldRegion?.kind === 'agent' ? sessionPresentationById(current.sessions).get(heldRegion.sessionId) : undefined
    if (!pmoTeamsTopicFloatingAgentIssue(next, heldTab, heldSession) && workspace && topic && !topic.readError && rootPath !== null && scratchTopicKind(topic.id, topics) === 'mote')
      showMoteConversation({ workspace, topic, rootPath }, { floating: true, reference: next.reference })
  }
  if ((tabId || suppliedReference) && next.reference) current.rememberMoteAgent(next.reference)
  update(next)
  requestAnimationFrame(() => {
    if (!snapshot().open) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('[data-pmo-teams-topic-floating]')) return
    document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')?.focus({ preventScroll: true })
  })
}

/** Open the original Agent synchronously, before any business input or recovery awaits. */
export function requestAgentConversationFloatingOpen(agentSessionId: string | null, hostId?: string, entryMessage?: string, originalReference?: WorkbenchProjectionSelection,
  entryContext?: PmoTeamsTopicFloatingState['entryContext']): number {
  cancelClose(); captureFocus()
  const current = useAppStore.getState(), previous = snapshot()
  const suppliedReference = originalReference ? { displayWorkspaceId: originalReference.displayWorkspaceId, groupId: originalReference.groupId,
    tabId: originalReference.tabId, regionId: originalReference.regionId } : undefined
  const sessions = current.sessions.filter(session => session.kind === 'agent' && session.control.agentSessionId === agentSessionId && (!hostId || session.control.hostId === hostId))
  const session = sessions.length === 1 ? sessions[0] : undefined
  const candidates = Object.values(current.tabs).flatMap(tab => Object.values(tab.regions).flatMap(region =>
    session && region.kind === 'agent' && region.sessionId === session.id ? [{ tab, region }] : []))
  const sameOriginal = previous.agentTarget?.agentSessionId === agentSessionId && (!hostId || previous.agentTarget.hostId === hostId || previous.targetAgent?.hostId === hostId)
  const previousCandidate = sameOriginal && previous.reference ? candidates.find(item => item.tab.id === previous.reference!.tabId && item.region.regionId === previous.reference!.regionId) : undefined
  const candidate = suppliedReference ? candidates.find(item => item.tab.id === suppliedReference.tabId && item.region.regionId === suppliedReference.regionId)
    : previousCandidate ?? (candidates.length === 1 ? candidates[0] : undefined)
  const references = candidate ? Object.entries(current.layouts).flatMap(([displayWorkspaceId, layout]) => layout.groups
    .filter(group => groupIds(layout.root).includes(group.id) && group.tabOrder.includes(candidate.tab.id))
    .map(group => ({ displayWorkspaceId, groupId: group.id, tabId: candidate.tab.id, regionId: candidate.region.regionId }))) : []
  const retained = sameOriginal && previous.reference ? references.find(reference => sameWorkbenchProjectionSelection(reference, previous.reference!)) : undefined
  const reference = suppliedReference ?? retained ?? (sameOriginal && previous.reference ? previous.reference : references.length === 1 ? references[0] : null)
  const sameEntry = Boolean(sameOriginal && entryContext && previous.entryContext && JSON.stringify(entryContext) === JSON.stringify(previous.entryContext))
  const conversationEntry = sameEntry && previous.conversationEntry !== undefined ? previous.conversationEntry : nextConversationEntry()
  update({ open: true, preview: false, agentTarget: { agentSessionId, ...(hostId ? { hostId } : {}) },
    targetTopicId: undefined, targetTabId: suppliedReference?.tabId ?? candidate?.tab.id ?? (sameOriginal ? previous.targetTabId ?? null : null), reference,
    targetAgent: session?.control.kind === 'agent' ? { hostId: session.control.hostId, sessionId: session.control.agentSessionId, presentationSessionId: session.id } : sameOriginal ? previous.targetAgent : undefined,
    entryMessage, entryContext, conversationEntry })
  if (session && reference) current.setViewMode(session.id, 'activity', { focus: false })
  requestAnimationFrame(() => {
    if (snapshot().open && snapshot().agentTarget?.agentSessionId === agentSessionId && snapshot().conversationEntry === conversationEntry)
      document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')?.focus({ preventScroll: true })
  })
  return conversationEntry
}
export function setAgentConversationFloatingMessage(agentSessionId: string | null, entryMessage?: string, expectedEntry?: number): void {
  if (snapshot().agentTarget?.agentSessionId === agentSessionId && (expectedEntry === undefined || snapshot().conversationEntry === expectedEntry)) update({ entryMessage }, false)
}
export function requestPmoTeamsTopicFloatingClose(options?: { restoreFocus?: boolean }): void {
  cancelClose()
  const active = document.activeElement
  const inside = active instanceof HTMLElement && Boolean(active.closest('[data-pmo-teams-topic-floating]'))
  const target = returnFocus
  returnFocus = null
  update({ open: false, preview: false, ...(snapshot().agentTarget ? {} : { conversationEntry: undefined }) })
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
  unsubscribeTabRemoved ??= subscribeWorkbenchTabRemoved((tab, placement) => {
    const current = state
    if (!current || current.targetTabId !== tab.id) return
    if (current.agentTarget) {
      update({ entryMessage: '原对话 Tab 已关闭。原 Agent 身份与位置引用保留；读取原 Session 后继续。' }, false)
      return
    }
    if (tab.workspaceId !== SCRATCH_WORKSPACE_ID ||
      current.targetTopicId && current.targetTopicId !== tab.topicId) return
    const topicId = current.targetTopicId ?? tab.topicId
    if (!topicId) return
    const committed = useAppStore.getState()
    if (committed.tabs[tab.id]) return
    // Continue this display Group's committed choice, never the background's active Group.
    const address = placement
    const layout = committed.layouts[address.displayWorkspaceId]
    const groups = layout && groupIds(layout.root).includes(address.groupId)
      ? layout.groups.filter(group => group.id === address.groupId) : []
    const group = groups.length === 1 ? groups[0] : undefined
    const belongs = (id: string | null | undefined) => Boolean(id && committed.tabs[id]?.workspaceId === SCRATCH_WORKSPACE_ID && committed.tabs[id]?.topicId === topicId)
    let nextTabId = group?.activeTabId && belongs(group.activeTabId) ? group.activeTabId : undefined
    if (!nextTabId && group && address.displayWorkspaceId === placement.displayWorkspaceId && address.groupId === placement.groupId) {
      const index = placement.tabOrder.indexOf(tab.id)
      const adjacent = index < 0 ? [] : [...placement.tabOrder.slice(index + 1), ...placement.tabOrder.slice(0, index).reverse()]
      nextTabId = adjacent.find(id => group.tabOrder.includes(id) && belongs(id))
    }
    const next = nextTabId ? committed.tabs[nextTabId] : undefined
    const reference = next && group && group.tabOrder.includes(next.id) && next.regions[next.layout.activeRegionId]
      ? { displayWorkspaceId: address.displayWorkspaceId, groupId: group.id, tabId: next.id, regionId: next.layout.activeRegionId } : undefined
    // An unconfirmed continuation stays unselected, even if a single foreign Group remains.
    update({ targetTopicId: topicId, targetTabId: reference?.tabId ?? null, reference })
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
