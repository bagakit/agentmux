// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createJSONStorage } from 'zustand/middleware'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { currentNotificationRows, notificationEventRows, notificationTrigger, toggleNotificationCenter } from './helpers/notification-center'

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement
const healthySession = (id: string) => ({ ...composerSession(id), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } })
const original = healthySession('original'), healthy = healthySession('healthy')
const originalTab = createWorkbenchTab('original-tab', { kind: 'agent', regionId: 'original-region', workspaceId: 'workspace', sessionId: original.id, phase: 'attached' })
const healthyTab = createWorkbenchTab('healthy-tab', { kind: 'agent', regionId: 'healthy-region', workspaceId: 'workspace', sessionId: healthy.id, phase: 'attached' })
const diagnostic = 'Original operation receipt is unavailable.\nFull diagnostic: exact request and recovery facts remain readable.'
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [original, healthy], timelines: Object.fromEntries([original, healthy].map(session => [session.id, { agentSessionId: session.id, revision: 0, items: [] }])), recoveryCandidates: [] })
  useAppStore.setState({ ...initial, loading: true }, true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  await act(async () => { root.render(<App />) })
  for (let attempt = 0; attempt < 30 && useAppStore.getState().loading; attempt += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  expect(useAppStore.getState().loading, 'The actual App must finish initialization').toBe(false)
  expect(container.querySelector('main.main-shell')).not.toBeNull()
  await act(async () => useAppStore.setState({ sessions: [original, healthy],
    tabs: { [originalTab.id]: originalTab, [healthyTab.id]: healthyTab },
    layouts: { workspace: createWorkspaceLayout('original-group', [healthyTab.id, originalTab.id]) },
    activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    agentComposerDrafts: { original: 'Original draft', healthy: 'Healthy draft' },
    environmentWarning: undefined, runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [],
    displacedAgentSessionIds: [], error: null, lastError: null, errorNoticeContext: null, notificationEvents: [], noticeReadReceipts: {} }))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  vi.restoreAllMocks(); useAppStore.setState(initial, true)
})

it('retains independent failures behind one window entry without recreating a bottom notification strip', async () => {
  await act(async () => {
    useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: original.control })
    useAppStore.getState().reportError('Independent storage receipt failed')
  })
  expect(container.querySelectorAll('.global-system-notices__trigger')).toHaveLength(1)
  expect(container.querySelector('.main-shell__notices')).toBeNull()
  expect(container.querySelector('.error-notice')).toBeNull()
  expect(container.querySelector('.remote-core-upgrade-notices')).toBeNull()
  expect(notificationEventRows(container), JSON.stringify(useAppStore.getState().notificationEvents.map(event => event.message))).toHaveLength(2)
  expect(notificationTrigger(container).getAttribute('aria-label')).toBe('System notifications: 2 unread, 0 current, 2 recent events')
  expect(notificationTrigger(container).getAttribute('aria-expanded')).toBe('false')
  expect(notificationEventRows(container).map(row => row.textContent).join('\n')).toContain(diagnostic)
})

it('keeps repeated observations read while distinct subjects and Runs remain independent', async () => {
  await act(async () => useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: original.control }))
  const firstId = notificationEventRows(container)[0]!.dataset.eventId!
  await toggleNotificationCenter(container, 'open'); await toggleNotificationCenter(container, 'closed')
  const receipts = useAppStore.getState().noticeReadReceipts
  await act(async () => useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: original.control }))
  expect(notificationEventRows(container)).toHaveLength(1)
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  expect(receipts['global:events']?.[firstId]).toBe('read')
  expect(notificationTrigger(container).getAttribute('aria-label')).toBe('System notifications: 0 unread, 0 current, 1 recent events')
  await act(async () => {
    useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: healthy.control })
    useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: { ...original.control, run: { runId: 'replacement-run' } } })
  })
  expect(notificationEventRows(container)).toHaveLength(3)
  expect(new Set(notificationEventRows(container).map(row => row.dataset.eventId)).size).toBe(3)
  expect(notificationTrigger(container).getAttribute('aria-label')).toBe('System notifications: 2 unread, 0 current, 3 recent events')
  expect(notificationTrigger(container).getAttribute('aria-expanded')).toBe('false')
})

it('preserves acknowledged identities through a new window observation before the same failure reappears', async () => {
  await act(async () => useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: original.control }))
  await toggleNotificationCenter(container, 'open'); await toggleNotificationCenter(container, 'closed')
  const receipts = useAppStore.getState().noticeReadReceipts
  await act(async () => useAppStore.setState({ notificationEvents: [], error: null, loading: true }))
  await act(async () => useAppStore.setState({ loading: false }))
  expect(useAppStore.getState().noticeReadReceipts['global:events']).toEqual(receipts['global:events'])
  await act(async () => useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: original.control }))
  expect(notificationEventRows(container)).toHaveLength(1)
  expect(notificationTrigger(container).getAttribute('aria-label')).toBe('System notifications: 0 unread, 0 current, 1 recent events')
})

it('hydrates actual saved reading facts without persisting diagnostic bodies or reviving unread events', async () => {
  const options = useAppStore.persist.getOptions()
  const legacyId = JSON.stringify(['process-degraded', null, original.control.hostId, 'agent', original.id,
    original.control.run.runId, null, null, null, diagnostic])
  const saved = new Map([[options.name, JSON.stringify({ state: {
    noticeReadReceipts: { 'global:events': { [legacyId]: legacyId } }
  }, version: options.version })]])
  useAppStore.persist.setOptions({ storage: createJSONStorage(() => ({
    getItem: name => saved.get(name) ?? null,
    setItem: (name, value) => { saved.set(name, value) }, removeItem: name => { saved.delete(name) }
  }))! })
  try {
    await act(async () => { await useAppStore.persist.rehydrate() })
    await act(async () => useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: original.control }))
    const event = useAppStore.getState().notificationEvents[0]!
    expect(notificationTrigger(container).getAttribute('aria-label')).toBe('System notifications: 0 unread, 0 current, 1 recent events')
    expect(event.message).toBe(diagnostic)
    expect(useAppStore.getState().noticeReadReceipts['global:events']?.[event.id]).toBe('read')
    const persisted = saved.get(options.name)!
    expect(persisted).not.toContain(diagnostic)
    expect(JSON.parse(persisted).state).not.toHaveProperty('notificationEvents')
    expect(event.id).toMatch(/^sha256:[a-f0-9]{64}$/)
  } finally { useAppStore.persist.setOptions(options) }
})

it('hydrates an acknowledged native owner and keeps current failures through ordinary history clearing', async () => {
  const options = useAppStore.persist.getOptions()
  const context = { kind: 'indeterminate' as const, cause: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' as const, subject: original.control }
  const canonical = JSON.stringify(['indeterminate', context.cause, original.control.hostId, 'agent', original.id,
    original.control.run.runId, null, null, null, diagnostic])
  const legacy = { 'global:workflow': { current: JSON.stringify([null, 'indeterminate', canonical]) } }
  await act(async () => { useAppStore.setState(options.merge!({ noticeReadReceipts: legacy }, useAppStore.getState()), true) })
  await act(async () => useAppStore.getState().reportError(diagnostic, context))
  const owned = useAppStore.getState().notificationEvents[0]!
  expect(currentNotificationRows(container).find(row => row.dataset.noticeId === owned.id)?.textContent).toContain(diagnostic)
  expect(notificationTrigger(container).getAttribute('aria-label')).toBe('System notifications: 0 unread, 1 current, 0 recent events')
  await act(async () => useAppStore.getState().reportError('Independent event after identity failure'))
  await toggleNotificationCenter(container, 'open'); await toggleNotificationCenter(container, 'closed')
  await act(async () => useAppStore.getState().clearReadNotificationEvents())
  expect(useAppStore.getState().notificationEvents).toEqual([owned])
  expect(notificationEventRows(container)).toHaveLength(0)
  expect(currentNotificationRows(container).find(row => row.dataset.noticeId === owned.id)).toBeDefined()
})

it('acknowledges and clears only read events while current problems, healthy Sessions, drafts and focus remain', async () => {
  await act(async () => {
    useAppStore.setState({ environmentWarning: 'Original shell observation is incomplete' })
    useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: original.control })
  })
  const before = useAppStore.getState()
  const input = document.createElement('textarea'); container.append(input); input.value = 'Unsent local selection'; input.focus(); input.setSelectionRange(2, 7)
  await toggleNotificationCenter(container, 'open'); await toggleNotificationCenter(container, 'closed')
  await act(async () => useAppStore.getState().reportError('Unread independent event'))
  const clear = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Clear read events')!
  expect(clear, 'Read history must have an explicit clear action').toBeDefined()
  await act(async () => clear.click())
  expect(notificationEventRows(container)).toHaveLength(1)
  expect(notificationEventRows(container)[0]!.textContent).toContain('Unread independent event')
  expect(currentNotificationRows(container)).toHaveLength(1)
  expect(currentNotificationRows(container)[0]!.textContent).toContain('Original shell observation is incomplete')
  const after = useAppStore.getState()
  expect(after.environmentWarning).toBe(before.environmentWarning)
  expect(after.sessions).toBe(before.sessions); expect(after.sessions.find(session => session.id === healthy.id)).toBe(healthy)
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts); expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect([document.activeElement === input, input.value, input.selectionStart, input.selectionEnd]).toEqual([true, 'Unsent local selection', 2, 7])
})

it('keeps a current Provider observation distinct from an older same-text event on another subject', async () => {
  await act(async () => {
    useAppStore.getState().reportError(diagnostic, { kind: 'indeterminate', subject: original.control })
    useAppStore.getState().reportError(diagnostic, { kind: 'indeterminate', startupProviderCatalog: { warningMessage: diagnostic } })
  })
  expect(notificationEventRows(container)).toHaveLength(1)
  expect(currentNotificationRows(container)).toHaveLength(1)
  expect(currentNotificationRows(container)[0]!.textContent).toContain(diagnostic)
  await toggleNotificationCenter(container, 'open'); await toggleNotificationCenter(container, 'closed')
  await act(async () => useAppStore.getState().clearReadNotificationEvents())
  expect(notificationEventRows(container)).toHaveLength(0)
  expect(currentNotificationRows(container)).toHaveLength(1)
  expect(useAppStore.getState()).toMatchObject({ error: diagnostic, errorDismissed: false,
    errorNoticeContext: { startupProviderCatalog: { warningMessage: diagnostic } } })
})

it('retains the active startup producer while ordinary events remain independently readable after its real settlement', async () => {
  const startupMessage = 'Original Provider catalog read did not complete'
  const startupContext = { kind: 'indeterminate' as const, startupProviderCatalog: { warningMessage: startupMessage } }
  await act(async () => useAppStore.setState({ error: startupMessage, lastError: startupMessage,
    errorNoticeContext: startupContext, errorDismissed: true }))
  await act(async () => useAppStore.getState().reportError(diagnostic))
  expect(useAppStore.getState().errorNoticeContext).toBe(startupContext)
  expect(useAppStore.getState()).toMatchObject({ error: startupMessage, lastError: startupMessage, errorDismissed: true })
  expect(currentNotificationRows(container)).toHaveLength(1)
  expect(notificationEventRows(container)).toHaveLength(1)
  expect(notificationEventRows(container)[0]!.textContent).toContain(diagnostic)
  await toggleNotificationCenter(container, 'open'); await toggleNotificationCenter(container, 'closed')
  const receipts = useAppStore.getState().noticeReadReceipts
  await act(async () => useAppStore.getState().reportError(diagnostic))
  expect(useAppStore.getState().errorNoticeContext).toBe(startupContext)
  expect(useAppStore.getState()).toMatchObject({ error: startupMessage, lastError: startupMessage, errorDismissed: true })
  expect(notificationEventRows(container)).toHaveLength(1)
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  await act(async () => {
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
      type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() }
    } })
    await vi.waitFor(() => expect(useAppStore.getState().errorNoticeContext).toBeNull())
  })
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null })
  expect(currentNotificationRows(container)).toHaveLength(0)
  expect(notificationEventRows(container)).toHaveLength(1)
  expect(notificationEventRows(container)[0]!.textContent).toContain(diagnostic)
  expect(useAppStore.getState().noticeReadReceipts['global:events']).toEqual(receipts['global:events'])
})

it('reopens complete diagnostics, copies their original content and navigates the original Session', async () => {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await act(async () => useAppStore.getState().reportError(diagnostic, { kind: 'process-degraded', subject: original.control }))
  const row = notificationEventRows(container)[0]!
  const details = row.querySelector<HTMLDetailsElement>('details')!
  expect(details.open).toBe(false)
  await toggleNotificationCenter(container, 'open')
  expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)
  await act(async () => { details.open = true })
  expect(row.querySelector('[aria-label^="Complete details:"]')?.textContent).toContain(diagnostic)
  const nestedToggle = new Event('toggle', { bubbles: true })
  Object.defineProperty(nestedToggle, 'newState', { value: 'closed' })
  await act(async () => { details.dispatchEvent(nestedToggle) })
  expect(notificationTrigger(container).getAttribute('aria-expanded')).toBe('true')
  expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(1)
  await act(async () => row.querySelector<HTMLButtonElement>('.notification-item__original button')!.click())
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(diagnostic)
  expect(row.textContent).toContain('Copied')
  const before = useAppStore.getState()
  await act(async () => row.querySelector<HTMLButtonElement>('.notification-item__action')!.click())
  expect(useAppStore.getState().layouts.workspace!.groups[0]!.activeTabId).toBe(originalTab.id)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().tabs[originalTab.id]!.regions['original-region']).toEqual(before.tabs[originalTab.id]!.regions['original-region'])
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(notificationEventRows(container)).toHaveLength(1)
})
