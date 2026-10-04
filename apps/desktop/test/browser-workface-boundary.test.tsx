import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, Fragment, useState } from 'react'
import { createPortal } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchBrowserPresentation } from '../src/renderer/src/components/BrowserPresentationStage'
import { installDesktopPresentationOwner, readDesktopPresentation } from '../src/renderer/src/lib/desktop-presentation'
import { workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'

async function settle() { await act(async () => { await new Promise(done => setTimeout(done, 15)) }) }
async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await settle()
}
function button(host: Element, text: string) { return [...host.querySelectorAll('button')].find(node => node.textContent === text) ?? null }
async function edit(host: Element, value: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it.each(['render', 'commit'] as const)('contains an actual Browser %s fault in its primary occurrence and keeps another workface usable', async kind => {
  await fixture(false, async f => {
    await f.render(kind); await settle()
    expect(f.primary.textContent).toContain('Browser view could not display')
    expect(f.primary.textContent).toContain(`Injected Browser ${kind} failure`)
    expect(f.primary.querySelector<HTMLInputElement>('input')?.value).toBe(f.browser.url)
    await click(f.healthy.querySelector('button'))
    expect(f.healthy.textContent).toContain('Healthy workface 1')
    expect(useAppStore.getState().tabs['original-tab']?.regions['original-region']).toBe(f.browser)
    f.assertNoPageOperation()
    f.clearFault(); await click(button(f.primary, 'Retry Browser view'))
    expect(f.primary.textContent).not.toContain('Browser view could not display')
    expect(f.primary.querySelector('.browser-toolbar')).not.toBeNull()
    f.assertNoPageOperation()
  })
})

it.each(['render', 'commit'] as const)('places an actual Browser %s fault at its exact visible Survey occurrence rather than its parked primary', async kind => {
  await fixture(true, async f => {
    await f.render(kind); await settle()
    expect(f.survey.textContent).toContain('Browser view could not display')
    expect(f.survey.textContent).toContain(`Injected Browser ${kind} failure`)
    expect(f.survey.querySelectorAll('.browser-surface')).toHaveLength(1)
    expect(f.wrong.childElementCount).toBe(0)
    f.clearFault(); await click(button(f.survey, 'Retry Browser view'))
    expect(f.survey.textContent).not.toContain('Browser view could not display')
    expect(f.survey.querySelector('.browser-toolbar')).not.toBeNull()
    f.assertNoPageOperation()
  })
})

it('attaches the failed original Browser to a late exact Survey slot and does not revive it after unmount', async () => {
  await fixture(true, async f => {
    f.survey.remove()
    await f.render('render'); await settle()
    expect(f.survey.childElementCount).toBe(0)
    await act(async () => document.body.append(f.survey)); await settle()
    expect(f.survey.textContent).toContain('Browser view could not display')
    await act(async () => f.root.render(null)); await settle()
    f.survey.remove(); document.body.append(f.survey); await settle()
    expect(f.survey.childElementCount).toBe(0)
    f.assertNoPageOperation()
  })
})

it('retains the original address draft across a render fault and uses the edited fallback draft when only the Renderer retries', async () => {
  await fixture(true, async f => {
    await f.render(); await settle()
    await edit(f.survey, 'original unsent query')
    await f.render('render'); await settle()
    expect(f.survey.querySelector<HTMLInputElement>('input')?.value).toBe('original unsent query')
    await edit(f.survey, 'preserved fallback query')
    f.clearFault(); await click(button(f.survey, 'Retry Browser view'))
    expect(f.survey.querySelector<HTMLInputElement>('input')?.value).toBe('preserved fallback query')
    expect(useAppStore.getState().tabs['original-tab']?.regions['original-region']).toBe(f.browser)
    expect(f.survey.textContent).not.toContain('Browser view could not display')
    f.assertNoPageOperation()
  })
})

it('tracks the same original Browser URL while unedited and preserves its edited draft across a later real snapshot', async () => {
  await fixture(true, async f => {
    await f.render('render'); await settle(); f.clearFault()
    const next = { ...f.browser, url: 'https://changed.example/', navigationId: 'next-real-navigation' }
    await f.render(undefined, next); await settle()
    expect(f.survey.querySelector<HTMLInputElement>('input')?.value).toBe(next.url)
    expect(f.survey.textContent).toContain('Browser view could not display')
    await edit(f.survey, 'original unsent fallback draft')
    const later = { ...next, url: 'https://later.example/', navigationId: 'later-real-navigation' }
    await f.render(undefined, later); await settle()
    expect(f.survey.querySelector<HTMLInputElement>('input')?.value).toBe('original unsent fallback draft')
    expect(f.survey.textContent).toContain(later.url)
    f.assertNoPageOperation()
  })
})

it('discards a different Browser identity failure and draft without touching either original page owner', async () => {
  await fixture(true, async f => {
    await f.render('render'); await settle(); await edit(f.survey, 'first Browser unsent draft')
    f.clearFault()
    const next = { ...f.browser, id: 'next-browser', browserId: 'next-browser', url: 'https://second.example/', navigationId: 'next-navigation' }
    await f.render(undefined, next); await settle()
    expect(f.survey.textContent).not.toContain('Browser view could not display')
    expect(f.survey.querySelector<HTMLInputElement>('input')?.value).toBe(next.url)
    expect(f.survey.querySelector<HTMLInputElement>('input')?.value).not.toBe('first Browser unsent draft')
    f.assertNoPageOperation()
  })
})

it('keeps the exact original primary observation unique while its secondary fallback is visible', async () => {
  await fixture(true, async f => {
    const main = document.createElement('main'); main.dataset.desktopSurface = 'space'; document.body.append(main)
    f.primary.hidden = false; f.primary.dataset.workbenchPrimaryTabId = 'original-tab'
    f.primary.dataset.workbenchPrimaryReference = workbenchRegionProjectionSlotId('primary', f.reference)
    f.primary.dataset.workbenchRegionId = f.reference.regionId; main.append(f.primary)
    const release = installDesktopPresentationOwner(() => ({ loading: false, overlays: { settings: false, quickSwitcher: false }, floating: null }))
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 320))
    try {
      await f.render('render'); await settle()
      expect(document.querySelectorAll('[data-workbench-primary-tab-id="original-tab"]')).toHaveLength(1)
      expect(readDesktopPresentation({ surface: 'space', mainSurface: 'workbench', goalId: null, space: {
        spaceId: null, zoneId: null, workspaceId: f.reference.displayWorkspaceId, tabId: f.reference.tabId,
        groupId: f.reference.groupId, regionId: f.reference.regionId, topicId: null
      } }, useAppStore.getState().tabs).presentation.state).toBe('main-visible')
      expect(f.survey.textContent).toContain('Browser view could not display')
    } finally { release(); rect.mockRestore(); document.body.append(f.primary); main.remove() }
  })
})

it('leaves the fault through the original external URL or Space without reloading, recreating or replaying Browser operations', async () => {
  await fixture(true, async f => {
    await f.render('render'); await settle()
    await edit(f.survey, 'unsubmitted fallback query')
    const external = vi.spyOn(api.ui, 'openExternal').mockResolvedValue(undefined)
    const closeSplit = vi.fn()
    try {
      await f.render('render', f.browser, closeSplit); await settle()
      await click(button(f.survey, 'Open original page externally'))
      expect(external).toHaveBeenCalledWith(f.browser.url)
      external.mockRejectedValueOnce(new Error("Error invoking remote method 'ui:openExternal': Error: External handler declined this page"))
      await click(button(f.survey, 'Open original page externally'))
      expect(f.survey.querySelector('[role="alert"]')?.textContent).toBe('External open failed: External handler declined this page')
      await click(f.survey.querySelector('[aria-label="Close split"]'))
      expect(closeSplit).toHaveBeenCalledOnce()
      await click(button(f.survey, 'Return to Space'))
      expect(useAppStore.getState().mainSurface).toBe('workbench')
      expect(f.survey.textContent).toContain('temporary screenshot, selection and tool state may need reopening')
      f.assertNoPageOperation()
    } finally { external.mockRestore() }
  })
})

function HealthyWorkface() { const [count, setCount] = useState(0); return <button onClick={() => setCount(count + 1)}>Healthy workface {count}</button> }
async function fixture(secondary: boolean, check: (f: {
  root: ReturnType<typeof createClientUiRoot>; primary: HTMLElement; survey: HTMLElement; wrong: HTMLElement; healthy: HTMLElement;
  browser: Parameters<typeof BrowserPane>[0]['tab']; reference: WorkbenchBrowserPresentation['occurrence']['location'];
  render(kind?: 'render' | 'commit', browser?: Parameters<typeof BrowserPane>[0]['tab'], close?: () => void): Promise<void>;
  clearFault(): void; assertNoPageOperation(): void
}) => Promise<void>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), config = await api.config.get()
  const workspace = { id: 'original-workspace', hostId: 'local', path: _hygiene_fixturePath("source-fixture"), name: 'Research', kind: 'folder' as const }
  const snapshot = await api.browser.create('original-browser', 'https://example.invalid/', workspace.id)
  const browser = { ...snapshot, kind: 'browser' as const, browserId: snapshot.id, regionId: 'original-region', workspaceId: workspace.id,
    error: 'Page load failed in the existing fixture', loading: false }
  const activity = browser.activity
  let fault: 'render' | 'commit' | undefined
  Object.defineProperty(browser, 'activity', { configurable: true, get() { if (fault === 'render') throw new Error('Injected Browser render failure'); return activity } })
  const tab = createWorkbenchTab('original-tab', browser)
  const reference = { displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: tab.id, regionId: browser.regionId }
  const make = (surface: 'space' | 'survey'): WorkbenchBrowserPresentation => ({ occurrence: { presentationId: surface + '-original', location: reference },
    stageHostId: surface + '-original-slot', visible: surface === (secondary ? 'survey' : 'space'), active: true, yieldToFocusRing: false,
    target: { hostId: surface + '-original-host', surface, active: true, reference } })
  const presentations = secondary ? [make('space'), make('survey')] : [make('space')]
  useAppStore.setState({ ...initial, config: { ...config, workspaces: [workspace] }, mainSurface: secondary ? 'survey' : 'workbench', tabs: { [tab.id]: tab },
    layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) }, toolsOpen: false }, true)
  const pageOperations = ['create', 'restore', 'close', 'reload', 'navigate', 'runScript', 'activatePresentation', 'armPresentationCapture'] as const
  const calls = pageOperations.map(name => vi.spyOn(api.browser, name))
  const subscribe = vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => {
    if (fault === 'commit') throw new Error('Injected Browser commit failure')
    return () => {}
  })
  const registrations = [vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => ({ leaseId: request.occurrence.presentationId + '-lease' })),
    vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined), vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)]
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const primary = document.createElement('div'); primary.hidden = secondary; document.body.append(primary)
  const root = createClientUiRoot(primary), healthy = document.createElement('div'), survey = document.createElement('div'), wrong = document.createElement('div')
  survey.id = 'survey-original-slot'; wrong.id = 'wrong-survey-slot'; document.body.append(healthy, survey, wrong)
  const render = async (kind?: 'render' | 'commit', current = browser, close?: () => void) => {
    fault = kind
    try {
      await act(async () => root.render(createElement(Fragment, null,
        createPortal(createElement(HealthyWorkface), healthy),
        createElement(BrowserPane, { tab: current, presentations, visible: !secondary,
          presentationTargetId: 'space-original-host', onRegionClose: close,
          renderPresentationFrame: content => createElement('section', { 'data-workbench-region-id': browser.regionId }, content) }))))
    } catch (error) {
      // A loaded missing-boundary mutant lets this exact injected fault escape React.
      // Still assert the real DOM below; unrelated setup/runtime failures cannot count as target RED.
      const errors = error instanceof AggregateError ? error.errors : [error]
      if (!kind || !errors.every(cause => cause instanceof Error && cause.message === `Injected Browser ${kind} failure`)) throw error
    }
  }
  try {
    await check({ root, primary, survey, wrong, healthy, browser, reference, render, clearFault: () => { fault = undefined },
      assertNoPageOperation: () => calls.forEach(call => expect(call).not.toHaveBeenCalled()) })
  } finally {
    fault = undefined
    await act(async () => root.unmount())
    primary.remove(); healthy.remove(); survey.remove(); wrong.remove(); useAppStore.setState(initial, true)
    calls.forEach(call => call.mockRestore()); registrations.forEach(call => call.mockRestore()); subscribe.mockRestore(); consoleError.mockRestore(); vi.unstubAllGlobals()
  }
}
