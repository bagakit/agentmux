// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { sessionStopReceipt } from './helpers/session-stop-receipt'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const initial = useAppStore.getState()
const original = composerSession('linked-agent')
const reference = { displayWorkspaceId: 'workspace', groupId: 'browser-group', tabId: 'browser-tab', regionId: 'browser-region' }
let root: ReturnType<typeof createClientUiRoot>, host: HTMLDivElement, browser: BrowserWorkbenchSurface

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const page = await api.browser.create('linked-agent-page', 'https://example.test', 'workspace')
  browser = { ...page, kind: 'browser', browserId: page.id, regionId: reference.regionId, workspaceId: 'workspace',
    control: { owner: 'human', activeOperationId: null, revision: 1, inputIsolation: 'inactive',
      agent: { hostId: original.control.hostId, agentSessionId: original.control.agentSessionId } } }
  const tab = createWorkbenchTab(reference.tabId, browser)
  useAppStore.setState({ ...initial, config: { ...composerConfig, browser: { ...composerConfig.browser, agentAutomation: true } },
    sessions: [original], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout(reference.groupId, [tab.id]) },
    agentNames: { [original.id]: 'Linked researcher' }, activeWorkspaceId: 'workspace', toolsOpen: false, error: null }, true)
  vi.spyOn(api.sessions, 'stop').mockImplementation(async (control, id) => control.kind === 'agent' ? sessionStopReceipt(control, id!) : undefined)
  vi.spyOn(api.browser, 'stopOperationById').mockResolvedValue(null)
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'listTargets').mockResolvedValue({ targets: [{ ...page, control: browser.control }], warnings: [] })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
  document.getElementById('agentmux-window-overlay-host')?.remove()
})
async function mount() {
  await act(async () => root.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference }}>
    <BrowserPane tab={browser} visible />
  </WorkbenchPresentationContext.Provider>))
}
async function openMenu() {
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="Browser activity:"]')!
  expect(trigger).not.toBeNull()
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  return trigger
}
function item(label: string) {
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(candidate => candidate.textContent === label)
  expect(entry, label).toBeDefined()
  return entry!
}
async function confirm(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`[role="dialog"] [data-confirm-label="${label}"]`)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

it('the actual Browser toolbar stops its exact linked Host/Session/Run and keeps the page', async () => {
  const decoy = { ...original, id: 'same-id-other-host', hostId: 'other-host', control: { ...original.control, hostId: 'other-host' } }
  useAppStore.setState({ sessions: [decoy, original] })
  await mount(); const trigger = await openMenu()
  expect(trigger.title).toContain('Linked researcher')
  await act(async () => item('Stop Agent').click())
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Linked researcher')
  await confirm('Stop Agent')
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(original.control, expect.any(String))
  expect(api.browser.stopOperationById).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[reference.tabId]!.regions[reference.regionId]).toEqual(browser)
})

it.each(['interrupted', 'exited'] as const)('offers Close Agent for a confirmed %s Run', async processState => {
  useAppStore.setState({ sessions: [{ ...original, processState }] })
  await mount(); await openMenu()
  await act(async () => item('Close Agent').click())
  await confirm('Close Agent')
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(original.control, expect.any(String))
})

it.each(['missing', 'other-host'] as const)('keeps %s linked Agent facts unconfirmed and offers an explicit association check', async reason => {
  useAppStore.setState({ sessions: reason === 'missing' ? []
    : [{ ...original, hostId: 'other-host', control: { ...original.control, hostId: 'other-host' } }] })
  await mount(); const trigger = await openMenu()
  expect(trigger.title).toContain('Linked Agent observation unconfirmed')
  expect([...document.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent)).not.toContain('Stop Agent')
  expect([...document.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent)).not.toContain('Close Agent')
  await act(async () => item('Check Agent association').click())
  expect(api.browser.listTargets).toHaveBeenCalledExactlyOnceWith('workspace')
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs[reference.tabId]!.regions[reference.regionId]?.kind).toBe('browser')
})

it('retains the exact Stop capability when this Run observation is unavailable without calling its state ended', async () => {
  useAppStore.setState({ sessions: [{ ...original, processState: 'interrupted', runUnobserved: true }] })
  await mount(); const trigger = await openMenu()
  expect(trigger.title).toContain('Linked Agent observation unconfirmed')
  expect(item('Check Agent association')).toBeDefined()
  await act(async () => item('Stop Agent').click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('current state is unknown')
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('already ended')
  await confirm('Stop Agent')
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(original.control, expect.any(String))
})

it('an unconfirmed Stop remains readable from this Browser even without an Agent Region', async () => {
  vi.mocked(api.sessions.stop).mockRejectedValue(Object.assign(new Error('The original Runtime did not answer.'), { code: 'SESSION_STOP_TIMEOUT' }))
  await mount(); await openMenu(); await act(async () => item('Stop Agent').click()); await confirm('Stop Agent')
  const feedback = host.querySelector<HTMLButtonElement>('.agent-operation-feedback__label')
  expect(feedback?.textContent).toContain('未确认')
  await act(async () => feedback!.click())
  expect(document.querySelector('.agent-operation-feedback__popover')?.textContent).toContain('核对原操作')
  expect(api.sessions.stop).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().tabs[reference.tabId]!.regions[reference.regionId]?.kind).toBe('browser')
})
