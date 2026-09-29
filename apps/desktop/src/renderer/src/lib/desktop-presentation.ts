import type { AgentMuxDesktopFloating, AgentMuxDesktopInput, AgentMuxDesktopObservation,
  AgentMuxDesktopOverlays, AgentMuxDesktopPresentation, AgentMuxDesktopSelection } from '@agentmux/core'
import type { WorkbenchTab } from './workbench-tabs'

export type DesktopAppPresentationOwner = {
  loading: boolean
  overlays: { settings: boolean; quickSwitcher: boolean }
  floating: { state: 'closed' | 'preview' | 'pinned'; topicId: string | null; tabId: string | null } | null
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

export function desktopElementVisible(element: HTMLElement | null): boolean {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const style = window.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
}
function queryIdentity(attribute: string, id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${attribute}=${CSS.escape(id)}]`)
}
const unknownInput = (): AgentMuxDesktopInput => ({ provenance: 'unknown', scope: 'unknown', ownerKind: null,
  tabId: null, regionId: null, sessionId: null, connected: null, visible: null, inert: null })
const unknownOverlays = (): AgentMuxDesktopOverlays => ({ provenance: 'unknown', settings: null, quickSwitcher: null })
export type DesktopInputCapture = { element: HTMLElement | null; fact: AgentMuxDesktopInput }

/** One actual activeElement and its exact projection; no value, draft, selection text or bytes. */
export function captureDesktopInput(tabs: Readonly<Record<string, WorkbenchTab>>): DesktopInputCapture {
  if (typeof document === 'undefined') return { element: null, fact: unknownInput() }
  const element = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const acceptsText = element && (element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')
  if (!element || element === document.body || !acceptsText) return { element: null, fact: { ...unknownInput(), provenance: 'observed', scope: 'none' } }
  const regionId = element.closest<HTMLElement>('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null
  const tabId = element.closest<HTMLElement>('[data-workbench-tab-id]')?.dataset.workbenchTabId ??
    (regionId ? Object.values(tabs).find(tab => Object.hasOwn(tab.regions, regionId))?.id : null) ?? null
  const surface = tabId && regionId ? tabs[tabId]?.regions[regionId] : undefined
  const floating = Boolean(element.closest('[data-pmo-teams-topic-floating]'))
  const overlay = Boolean(element.closest('[role="dialog"], .settings-page')) && !floating
  const ownerKind = element.closest('.xterm') ? 'terminal' : element.closest('.composer__editor') ? 'composer'
    : element.closest('.monaco-editor') ? 'editor' : overlay ? 'dialog' : 'other'
  return { element, fact: { provenance: 'observed', scope: floating ? 'floating' : overlay ? 'overlay' : 'main',
    ownerKind, tabId, regionId, sessionId: surface?.kind === 'agent' || surface?.kind === 'terminal' ? surface.sessionId : null,
    connected: element.isConnected, visible: desktopElementVisible(element), inert: Boolean(element.closest('[inert]')) } }
}

function observeFloating(owner: DesktopAppPresentationOwner | null, tabs: Readonly<Record<string, WorkbenchTab>>): AgentMuxDesktopFloating {
  if (!owner?.floating) return { provenance: 'unknown', state: 'unknown', topicId: null, tabId: null, regionId: null, sessionId: null, presentation: 'unknown' }
  const { state, topicId, tabId } = owner.floating
  const tab = tabId ? tabs[tabId] : undefined
  const regionId = tab?.layout.activeRegionId ?? null
  const surface = regionId ? tab?.regions[regionId] : undefined
  const panel = document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')
  const region = regionId ? queryIdentity('data-workbench-region-id', regionId) : null
  return { provenance: 'observed', state, topicId, tabId, regionId,
    sessionId: surface?.kind === 'agent' || surface?.kind === 'terminal' ? surface.sessionId : null,
    presentation: state === 'closed' ? 'hidden' : !tab || !surface ? 'unknown'
      : desktopElementVisible(panel) && Boolean(region && panel?.contains(region) && desktopElementVisible(region)) ? 'visible' : 'pending' }
}

export function readDesktopPresentation(selection: AgentMuxDesktopSelection, tabs: Readonly<Record<string, WorkbenchTab>>):
  Pick<AgentMuxDesktopObservation, 'presentation' | 'floating' | 'overlays' | 'input'> {
  const owner = typeof document === 'undefined' ? null : appReader?.() ?? null
  const overlays: AgentMuxDesktopOverlays = owner ? { provenance: 'observed', ...owner.overlays } : unknownOverlays()
  const blockers: AgentMuxDesktopPresentation['blockers'] = []
  if (overlays.settings) blockers.push('settings')
  if (overlays.quickSwitcher) blockers.push('quick-switcher')
  const { tabId = null, regionId = null } = selection.surface === 'space' ? selection.space ?? {} : {}
  const base = { tabId, regionId, blockers }
  let presentation: AgentMuxDesktopPresentation = { ...base, provenance: 'unknown', state: 'unknown' }
  if (owner) {
    if (owner.loading) presentation = { ...base, provenance: 'observed', state: 'pending' }
    else if (blockers.length) presentation = { ...base, provenance: 'observed', state: 'covered' }
    else {
      const main = document.querySelector<HTMLElement>(`[data-desktop-surface="${selection.surface}"]`)
      const target = selection.surface !== 'space' ? main : regionId ? queryIdentity('data-workbench-region-id', regionId)
        : selection.space ? queryIdentity('data-desktop-zone-id', selection.space.zoneId) : main
      const borrowed = selection.surface === 'space' && target?.closest('[data-pmo-teams-topic-floating]')
      const exactGoal = selection.surface !== 'goals' || !selection.goalId ||
        Boolean(main?.querySelector(`[data-goal-detail-id=${CSS.escape(selection.goalId)}]`))
      presentation = { ...base, provenance: 'observed', state: borrowed && desktopElementVisible(target) ? 'floating'
        : desktopElementVisible(main) && desktopElementVisible(target) && exactGoal ? 'main-visible' : 'pending' }
    }
  }
  return { presentation, floating: observeFloating(owner, tabs), overlays, input: captureDesktopInput(tabs).fact }
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
  return before.element !== null && before.element === after.element && after.fact.provenance === 'observed' &&
    after.fact.connected === true && after.fact.visible === true && after.fact.inert === false
}
