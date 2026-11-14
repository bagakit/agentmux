import type { FocusAgentTarget } from './focus-agent-navigation'
import { workbenchDocuments, workbenchDocumentIdentity } from './workbench-window-registry'
import type { AgentMuxDesktopFocusTarget, AgentMuxDesktopFloating, AgentMuxDesktopInput, AgentMuxDesktopObservation,
  AgentMuxDesktopOverlays, AgentMuxDesktopPresentation, AgentMuxDesktopSelection } from '@agentmux/core'
import type { WorkbenchTab } from './workbench-tabs'
import { workbenchRegionProjectionSlotId } from './workbench-projection'
import { surveyPageOwner } from './survey-page-references'

export type DesktopAppPresentationOwner = {
  loading: boolean
  overlays: { settings: boolean; quickSwitcher: boolean }
  settings?: { sectionIds: readonly string[]; open(sectionId: string, hostId?: string): void; close(): void; read(): { sectionId: string; visible: boolean; hostId?: string | null } | null }
  survey?: { select(target: Extract<AgentMuxDesktopFocusTarget, { kind: 'survey' }>): void }
  /** The existing Space content slot may cover its retained main workface. */
  contentExpanded?: boolean
  floating: { state: 'closed' | 'preview' | 'pinned'; topicId: string | null; tabId: string | null; regionId?: string | null } | null
}
// The original App supplies its committed local facts. This is one reader, not a second router,
// overlay store, floating state, or View registry. Reading never mounts or initializes an owner.
let appReader: (() => DesktopAppPresentationOwner) | null = null
const commitListeners = new Set<() => void>()
export function installDesktopPresentationOwner(read: () => DesktopAppPresentationOwner): () => void {
  appReader = read
  return () => { if (appReader === read) appReader = null }
}
export function desktopPresentationCommitted(): void {
  for (const listener of commitListeners) listener()
}

/** Overlay control comes from the App owner; it does not require a DOM presentation probe. */
export function readDesktopOverlays(): AgentMuxDesktopOverlays {
  const owner = typeof document === 'undefined' ? null : appReader?.() ?? null
  if (!owner) return unknownOverlays()
  const page = owner.settings?.read()
  return { provenance: 'observed', ...owner.overlays, ...(owner.settings ? { settingsPage: {
    sectionIds: [...owner.settings.sectionIds], sectionId: page?.sectionId ?? null, visible: page?.visible ?? false,
    ...(page?.hostId === undefined ? {} : { hostId: page.hostId })
  } } : {}) }
}

/** Delegate only to the original App router; catalog IDs never come from titles or DOM prose. */
export function requestDesktopSettingsNavigation(sectionId: string | null, hostId?: string): 'requested' | 'unknown-section' | 'unavailable' {
  const settings = appReader?.()?.settings
  if (!settings) return 'unavailable'
  if (sectionId === null) { settings.close(); return 'requested' }
  if (!settings.sectionIds.includes(sectionId)) return 'unknown-section'
  settings.open(sectionId, hostId)
  return 'requested'
}

/** The App's original Survey navigator owns its occurrence preference and saved selection. */
export function requestDesktopSurveyNavigation(target: Extract<AgentMuxDesktopFocusTarget, { kind: 'survey' }>): void {
  const survey = appReader?.()?.survey
  if (!survey) throw new Error('The original Survey navigator is unavailable. Existing pages, references and input are kept.')
  survey.select(target)
}

export function desktopElementVisible(element: HTMLElement | null): boolean {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  // Native text carriers may have no painted area while participating in the visible layout.
  const laidOutText = Boolean((element as HTMLElement & { editContext?: unknown }).editContext) && element.getClientRects().length > 0
  return style.display !== 'none' && style.visibility !== 'hidden' && (rect.width > 0 && rect.height > 0 || laidOutText)
}
/** Only an original mounted selected card can confirm the requested Agent. No title or MRU is read. */
export function readFocusAgentPresentation(target: FocusAgentTarget | null): AgentMuxDesktopObservation['focus']['agent'] {
  if (!target) return null
  const pending = { hostId: target.hostId, agentSessionId: target.agentSessionId, presentationSessionId: null, state: 'unconfirmed' as const }
  if (typeof document === 'undefined') return pending
  const matches = [...document.querySelectorAll<HTMLElement>('[data-focus-agent-selected="true"]')].filter(slot =>
    slot.dataset.focusAgentHost === target.hostId && slot.dataset.focusAgentSession === target.agentSessionId)
  if (matches.length !== 1) return pending
  const slot = matches[0]!, rect = slot.getBoundingClientRect()
  let top = 0, left = 0, right = document.documentElement.clientWidth, bottom = document.documentElement.clientHeight
  // The selected card can sit in a retained reader, a lane scrollport or a narrow
  // Focus workface. Intersect the original clipping owners; its own box is not a viewport.
  for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), clip = parent.getBoundingClientRect()
    if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
    if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
  }
  const visible = desktopElementVisible(slot) && slot.dataset.focusCardBody === 'mounted' &&
    right > left && bottom > top && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right &&
    !appReader?.().overlays.settings && !appReader?.().overlays.quickSwitcher
  return { hostId: target.hostId, agentSessionId: target.agentSessionId,
    presentationSessionId: slot.dataset.focusPresentationSession ?? null, state: visible ? 'visible' : 'hidden' }
}
function queryIdentity(attribute: string, id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${attribute}=${CSS.escape(id)}]`)
}
/** Read the original View's committed occurrence, independently of secondary DOM order. */
function primaryRegion(selection: AgentMuxDesktopSelection['space'], tabs: Readonly<Record<string, WorkbenchTab>>): HTMLElement | null {
  if (!selection?.tabId || !selection.regionId || !selection.groupId) return null
  const tab = tabs[selection.tabId]
  if (!tab || !Object.hasOwn(tab.regions, selection.regionId)) return null
  const reference = { displayWorkspaceId: selection.workspaceId, groupId: selection.groupId,
    tabId: selection.tabId, regionId: selection.regionId }
  const exactRegion = workbenchRegionProjectionSlotId('primary', reference)
  const selectedRegionId = selection.regionId
  const matches = [...new Set([document, ...workbenchDocuments()])].flatMap(doc => Array.from(doc.querySelectorAll<HTMLElement>(`[data-workbench-region-id=${CSS.escape(selectedRegionId)}]`))).filter(region => {
    const native = region.closest<HTMLElement>('.retained-workbench-region')
    if (native) return native.dataset.workbenchRegionReference === exactRegion
    const primary = region.closest<HTMLElement>('[data-workbench-primary-tab-id]')
    return primary?.dataset.workbenchPrimaryTabId === tab.id && Object.keys(tab.regions).some(regionId =>
      primary.dataset.workbenchPrimaryReference === workbenchRegionProjectionSlotId('primary', { ...reference, regionId }))
  })
  return matches.length === 1 ? matches[0]! : null
}
const unknownInput = (): AgentMuxDesktopInput => ({ provenance: 'unknown', scope: 'unknown', ownerKind: null,
  tabId: null, regionId: null, sessionId: null, connected: null, visible: null, inert: null })
const unknownOverlays = (): AgentMuxDesktopOverlays => ({ provenance: 'unknown', settings: null, quickSwitcher: null })
export type DesktopInputCapture = { element: HTMLElement | null; fact: AgentMuxDesktopInput }

/** One actual activeElement and its exact projection; no value, draft, selection text or bytes. */
export function captureDesktopInput(tabs: Readonly<Record<string, WorkbenchTab>>): DesktopInputCapture {
  if (typeof document === 'undefined') return { element: null, fact: unknownInput() }
  const focused = [...new Set([document, ...workbenchDocuments()])].filter(doc => doc.hasFocus())
  if (focused.length !== 1) return { element: null, fact: unknownInput() }
  const inputDocument = focused[0]!, identity = workbenchDocumentIdentity(inputDocument)
  const windowFact = identity ? { windowId: identity.windowId, documentGeneration: identity.documentGeneration } : {}
  const element = inputDocument.activeElement?.nodeType === 1 ? inputDocument.activeElement as HTMLElement : null
  const acceptsText = element && (element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' ||
    Boolean((element as HTMLElement & { editContext?: unknown }).editContext))
  if (!element || element === inputDocument.body || !acceptsText) return { element: null, fact: { ...unknownInput(), provenance: 'observed', scope: 'none', ...windowFact } }
  const regionId = element.closest<HTMLElement>('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null
  const tabId = element.closest<HTMLElement>('[data-workbench-tab-id]')?.dataset.workbenchTabId ??
    (regionId ? Object.values(tabs).find(tab => Object.hasOwn(tab.regions, regionId))?.id : null) ?? null
  const surface = tabId && regionId ? tabs[tabId]?.regions[regionId] : undefined
  const floating = Boolean(element.closest('[data-pmo-teams-topic-floating]'))
  const overlay = Boolean(element.closest('[role="dialog"], .settings-page')) && !floating
  const ownerKind = element.closest('.xterm') ? 'terminal' : element.closest('.composer__editor') ? 'composer'
    : element.closest('.monaco-editor') ? 'editor' : overlay ? 'dialog' : 'other'
  return { element, fact: { provenance: 'observed', scope: floating ? 'floating' : overlay ? 'overlay' : identity && inputDocument !== document ? 'window' : 'main', ...windowFact,
    ownerKind, tabId, regionId, sessionId: surface?.kind === 'agent' || surface?.kind === 'terminal' ? surface.sessionId : null,
    connected: element.isConnected, visible: desktopElementVisible(element), inert: Boolean(element.closest('[inert]')) } }
}

function observeFloating(owner: DesktopAppPresentationOwner | null, tabs: Readonly<Record<string, WorkbenchTab>>): AgentMuxDesktopFloating {
  if (!owner?.floating) return { provenance: 'unknown', state: 'unknown', topicId: null, tabId: null, regionId: null, sessionId: null, presentation: 'unknown' }
  const { state, topicId, tabId } = owner.floating
  const tab = tabId ? tabs[tabId] : undefined
  const regionId = owner.floating.regionId ?? null
  const surface = regionId ? tab?.regions[regionId] : undefined
  const panel = document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')
  const region = regionId ? Array.from(panel?.querySelectorAll<HTMLElement>(`[data-workbench-region-id=${CSS.escape(regionId)}]`) ?? []).find(element => {
    const slot = element.closest<HTMLElement>('[data-workbench-tab-id], [data-workbench-primary-tab-id]')
    return (slot?.dataset.workbenchTabId ?? slot?.dataset.workbenchPrimaryTabId) === tabId && desktopElementVisible(element)
  }) ?? null : null
  return { provenance: 'observed', state, topicId, tabId, regionId,
    sessionId: surface?.kind === 'agent' || surface?.kind === 'terminal' ? surface.sessionId : null,
    presentation: state === 'closed' ? 'hidden' : !tab || !surface ? 'unknown'
      : desktopElementVisible(panel) && Boolean(region && panel?.contains(region) && desktopElementVisible(region)) ? 'visible' : 'pending' }
}

export function readDesktopPresentation(selection: AgentMuxDesktopSelection, tabs: Readonly<Record<string, WorkbenchTab>>):
  Pick<AgentMuxDesktopObservation, 'presentation' | 'floating' | 'overlays' | 'input'> {
  const owner = typeof document === 'undefined' ? null : appReader?.() ?? null
  const overlays = readDesktopOverlays()
  const blockers: AgentMuxDesktopPresentation['blockers'] = []
  if (overlays.settings) blockers.push('settings')
  if (overlays.quickSwitcher) blockers.push('quick-switcher')
  const survey = selection.surface === 'survey' ? selection.survey : null
  const pageOwner = survey && 'kind' in survey ? surveyPageOwner(tabs, survey) : undefined
  const { tabId = null, regionId = null } = selection.surface === 'space' ? selection.space ?? {}
    : survey ? 'kind' in survey ? survey.presentation ?? { tabId: pageOwner?.tab.id ?? null, regionId: survey.regionId } : survey.active ?? {} : {}
  const windowTarget = selection.surface === 'space' && regionId ? primaryRegion(selection.space, tabs) : null
  const windowIdentity = windowTarget && windowTarget.ownerDocument !== document ? workbenchDocumentIdentity(windowTarget.ownerDocument) : null
  if (windowIdentity) blockers.length = 0
  const base = { tabId, regionId, blockers }
  let presentation: AgentMuxDesktopPresentation = { ...base, provenance: 'unknown', state: 'unknown' }
  if (owner) {
    if (owner.loading) presentation = { ...base, provenance: 'observed', state: 'pending' }
    else if (windowIdentity && desktopElementVisible(windowTarget)) presentation = { ...base, ...windowIdentity, provenance: 'observed', state: 'window' }
    else if (blockers.length || selection.surface === 'space' && owner.contentExpanded) presentation = { ...base, provenance: 'observed', state: 'covered' }
    else {
      const main = document.querySelector<HTMLElement>(`[data-desktop-surface="${selection.surface}"]`)
      const views = selection.surface === 'focus' && main ? [...(main.matches(`[data-desktop-focus-view="${selection.focusView}"]`) ? [main] : []), ...main.querySelectorAll<HTMLElement>(`[data-desktop-focus-view="${selection.focusView}"]`)]
        .filter(element => desktopElementVisible(element) && !element.closest('[data-pmo-teams-topic-floating]')) : []
      const surveyRegions = survey && regionId && tabId ? Array.from(main?.querySelectorAll<HTMLElement>('[data-workbench-region-id]') ?? []).filter(region =>
        region.dataset.workbenchRegionId === regionId && desktopElementVisible(region) &&
        (region.closest<HTMLElement>('[data-workbench-primary-tab-id]')?.dataset.workbenchPrimaryTabId ??
          region.closest<HTMLElement>('[data-workbench-tab-id]')?.dataset.workbenchTabId) === tabId) : []
      const target = selection.surface === 'focus' ? views.length === 1 ? views[0]! : null
        : survey && regionId ? surveyRegions.length === 1 ? surveyRegions[0]! : null : selection.surface !== 'space' ? main : regionId ? primaryRegion(selection.space, tabs)
        : selection.space?.zoneId ? queryIdentity('data-desktop-zone-id', selection.space.zoneId) : selection.space ? null : main
      const borrowed = selection.surface === 'space' && target?.closest('[data-pmo-teams-topic-floating]')
      const exactGoal = selection.surface !== 'goals' || !selection.goalId ||
        Boolean(main?.querySelector(`[data-goal-detail-id=${CSS.escape(selection.goalId)}]`))
      presentation = { ...base, provenance: 'observed', state: borrowed && desktopElementVisible(target) ? 'floating'
        : desktopElementVisible(main) && desktopElementVisible(target) && Boolean(target && main?.contains(target)) && exactGoal ? 'main-visible' : 'pending' }
    }
  }
  return { presentation, floating: observeFloating(owner, tabs), overlays, input: captureDesktopInput(tabs).fact }
}

/** Presentation confirmation only; object/role qualification stays with the original Mote owners. */
export function readMoteLinkPresentation(target: { spaceId: string; eventId?: string }): AgentMuxDesktopPresentation['mote'] | null {
  if (typeof document === 'undefined') return null
  const frames = [...document.querySelectorAll<HTMLElement>('[data-mote-space-id]')].filter(frame =>
    frame.dataset.moteSpaceId === target.spaceId && desktopElementVisible(frame))
  if (frames.length !== 1) return null
  const frame = frames[0]!, spaceId = frame.dataset.moteSpaceId!
  if (target.eventId === undefined) return frame.dataset.motePage === 'discussion' ? { spaceId, page: 'discussion', eventId: null } : null
  if (frame.dataset.motePage !== 'threads') return null
  const thread = [...frame.querySelectorAll<HTMLElement>('[data-mote-work-thread]')]
    .find(thread => thread.dataset.moteWorkThread === target.eventId && desktopElementVisible(thread))
  return thread ? { spaceId, page: 'threads', eventId: thread.dataset.moteWorkThread! } : null
}


/** Observe only the original mounted reading section intersecting its actual clipping owners. */
export function readGoalReadingPresentation(target: { goalId: string; runtimeId?: string; namespace?: string; section?: 'plan' }): AgentMuxDesktopPresentation['goal'] | null {
  if (typeof document === 'undefined' || appReader?.().overlays.settings || appReader?.().overlays.quickSwitcher) return null
  const matches = [...document.querySelectorAll<HTMLElement>('[data-goal-reading-section]')].filter(element =>
    element.dataset.goalReadingId === target.goalId && (target.runtimeId === undefined || element.dataset.goalReadingRuntime === target.runtimeId && element.dataset.goalReadingNamespace === target.namespace) &&
    (target.section === undefined || element.dataset.goalReadingSection === target.section) && desktopElementVisible(element))
  const intersects = (element: HTMLElement) => {
    if (!desktopElementVisible(element)) return false
    const rect = element.getBoundingClientRect()
    let top = 0, left = 0, right = document.documentElement.clientWidth, bottom = document.documentElement.clientHeight
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), clip = parent.getBoundingClientRect()
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
    }
    return right > left && bottom > top && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right
  }
  const visible = matches.filter(element => intersects(element) && (element.dataset.goalReadingSection !== 'plan' ||
    [...element.querySelectorAll<HTMLElement>('[data-goal-plan-node], [data-goal-plan-origin]')].some(intersects)))
  const element = visible[0], section = element?.dataset.goalReadingSection
  if (!element || !['overview', 'plan', 'activity'].includes(section ?? '') || visible.some(other => other.dataset.goalReadingId !== element.dataset.goalReadingId || other.dataset.goalReadingRuntime !== element.dataset.goalReadingRuntime || other.dataset.goalReadingNamespace !== element.dataset.goalReadingNamespace)) return null
  return { goalId: target.goalId, runtimeId: element.dataset.goalReadingRuntime || null, namespace: element.dataset.goalReadingNamespace || null, section: section as 'overview' | 'plan' | 'activity' }
}

/** Only an in-flight cold navigation listens. No steady observer, output scan or polling loop. */
export async function awaitDesktopPresentation(ready: () => boolean, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return
  await new Promise<void>(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      commitListeners.delete(check)
      document.removeEventListener('focusin', check)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const check = (): void => { if (ready()) finish() }
    const deadline = setTimeout(finish, 700)
    commitListeners.add(check)
    document.addEventListener('focusin', check)
    signal?.addEventListener('abort', finish, { once: true })
    requestAnimationFrame(() => requestAnimationFrame(check))
  })
}

export function desktopInputPreserved(before: DesktopInputCapture, after: DesktopInputCapture): boolean {
  return before.element !== null && before.element === after.element &&
    before.fact.provenance === 'observed' && after.fact.provenance === 'observed' &&
    after.fact.connected === true && after.fact.visible === true && after.fact.inert === false &&
    before.fact.windowId === after.fact.windowId && before.fact.documentGeneration === after.fact.documentGeneration &&
    before.fact.scope === after.fact.scope && before.fact.ownerKind === after.fact.ownerKind &&
    before.fact.tabId === after.fact.tabId && before.fact.regionId === after.fact.regionId && before.fact.sessionId === after.fact.sessionId
}
