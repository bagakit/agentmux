// @vitest-environment happy-dom
import { act, useLayoutEffect, type ComponentProps } from 'react'
import { appendFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { BrowserRecoverySurface } from '../src/renderer/src/components/BrowserRecoverySurface'
import type { WorkbenchBrowserPresentation } from '../src/renderer/src/components/BrowserPresentationStage'
import type { BrowserSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState()
let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, page: BrowserSnapshot
let firstCommitFacts: boolean[]
function record(value: unknown): void {
  if (process.env.BROWSER_RECOVERY_FACTS) appendFileSync(process.env.BROWSER_RECOVERY_FACTS, JSON.stringify(value) + '\n')
}
function Frame({ visible, released, aliasVisible }: { visible: boolean; released: boolean; aliasVisible?: boolean }) {
  const presentations: WorkbenchBrowserPresentation[] | undefined = aliasVisible === undefined ? undefined : [{
    occurrence: { presentationId: 'original-occurrence', location: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' } },
    stageHostId: 'original-stage', visible: aliasVisible, active: true, yieldToFocusRing: false,
    target: { hostId: 'original-stage', active: true, visible: aliasVisible, surface: 'survey' }
  }]
  useLayoutEffect(() => {
    if (visible || aliasVisible) firstCommitFacts.push(Boolean(container.querySelector('.browser-recovery')))
  })
  return <BrowserPane tab={{ ...page, kind: 'browser', browserId: page.id, regionId: 'region', workspaceId: 'workspace' }}
    visible={visible} released={released} {...(presentations ? { presentations } : {})} />
}
function render(visible: boolean, released = true, aliasVisible?: boolean) {
  return act(async () => root.render(<Frame visible={visible} released={released} {...(aliasVisible === undefined ? {} : { aliasVisible })} />))
}
function address(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')
  expect(input).not.toBeNull()
  return input!
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  page = await api.browser.create('original-browser', 'https://recovery.example.invalid/original', 'workspace')
  page = { ...page, error: 'Original recovery diagnostic', title: 'Original page' }
  const config = await api.config.get()
  useAppStore.setState({ ...initial, config, toolsOpen: false }, true)
  container = document.createElement('div')
  document.body.append(container)
  root = createClientUiRoot(container)
  firstCommitFacts = []
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'setBounds').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'release').mockImplementation(async (browserId, navigationId) => ({
    browserId, navigationId, status: 'released', reasons: []
  }))
  vi.spyOn(api.browser, 'restore').mockImplementation(() => new Promise<BrowserSnapshot>(() => {}))
  vi.spyOn(api.browser, 'registerPresentation').mockResolvedValue({ leaseId: 'original-lease' })
  vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})

it('delays unseen recovery DOM while the actual Browser owner releases and Content still hides native geometry', async () => {
  await render(false)
  expect(api.browser.release).toHaveBeenCalledExactlyOnceWith(page.id, page.navigationId)
  expect(api.browser.restore).not.toHaveBeenCalled()
  expect(container.querySelector('.browser-surface')).not.toBeNull()
  expect(container.querySelector('.browser-stage')).not.toBeNull()
  expect(address().value).toBe(page.url)
  await vi.waitFor(() => expect(api.browser.setBounds).toHaveBeenCalledWith(page.id, null))
  const initialRecoveryDOM = container.querySelectorAll('.browser-recovery').length
  record({ case: 'unseen-recovery', initialRecoveryDOM, originalRelease: true, originalAddressAndStage: true, nativeHideConsumed: true })
  expect(initialRecoveryDOM, 'Only unseen recovery chrome waits; its Browser resource consumers must still execute').toBe(0)
})

it('shows in the first visible layout commit and preserves recovery state, address DOM and pending restore across warm hiding', async () => {
  await render(false)
  const input = address(), stage = container.querySelector('.browser-stage')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Preserved address draft 中文')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  input.setSelectionRange(3, 8)
  await render(true)
  expect(firstCommitFacts[0], 'The first visible parent layout commit must already contain the original recovery controls').toBe(true)
  const recovery = container.querySelector('.browser-recovery')!
  expect(recovery).not.toBeNull()
  expect(container.querySelector('.browser-stage')).toBe(stage)
  expect(address()).toBe(input)
  expect(input.value).toBe('Preserved address draft 中文')
  expect(input.selectionStart).toBe(3)
  expect(input.selectionEnd).toBe(8)
  const details = recovery.querySelector('details')!
  details.open = true
  await act(async () => recovery.querySelector<HTMLButtonElement>('[aria-label="Copy page address"]')!.click())
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(page.url)
  expect(recovery.textContent).toContain('Address copied')
  await render(false)
  expect(container.querySelector('.browser-recovery'), 'Visited recovery DOM must remain mounted while hidden').toBe(recovery)
  expect(details.open).toBe(true)
  expect(recovery.textContent).toContain('Address copied')
  await render(true)
  expect(container.querySelector('.browser-recovery')).toBe(recovery)
  expect(details.open).toBe(true)
  expect(address()).toBe(input)
  await render(true, false)
  expect(api.browser.restore).toHaveBeenCalledExactlyOnceWith(page.id, {
    workspaceId: 'workspace', profileId: page.profileId, mode: page.mode, viewport: page.viewport
  })
  await render(false, false)
  await render(true, false)
  expect(api.browser.restore).toHaveBeenCalledTimes(1)
  expect(container.querySelector('.browser-recovery')).toBe(recovery)
  expect(address()).toBe(input)
  expect(input.value).toBe('Preserved address draft 中文')
  expect(input.selectionStart).toBe(3)
  expect(input.selectionEnd).toBe(8)
  expect(details.open).toBe(true)
  expect(recovery.textContent).toContain('Address copied')
  record({ case: 'first-show-and-warm-state', firstVisibleLayout: firstCommitFacts[0], sameRecoveryDOM: true,
    detailsAndCopyFeedbackWarm: true, sameAddressAndStageDOM: true, originalDraftSelection: true, exactPendingRestoreWarm: true })
})

it('uses the visible alias in the initial commit while the actual presentation Stage retains its original lease', async () => {
  await render(false, false, true)
  expect(firstCommitFacts[0], 'A visible alias must not inherit the original owner false visibility').toBe(true)
  expect(container.querySelector('.browser-recovery')).not.toBeNull()
  await vi.waitFor(() => expect(api.browser.registerPresentation).toHaveBeenCalledTimes(1))
  expect(api.browser.registerPresentation).toHaveBeenCalledWith(expect.objectContaining({ browserId: page.id,
    occurrence: { presentationId: 'original-occurrence', location: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' } } }))
  const stage = container.querySelector('[data-browser-presentation-id="original-occurrence"]')
  expect(stage).not.toBeNull()
  await render(false, false, false)
  await render(false, false, true)
  expect(container.querySelector('[data-browser-presentation-id="original-occurrence"]')).toBe(stage)
  expect(api.browser.registerPresentation).toHaveBeenCalledTimes(1)
  expect(api.browser.removePresentation).not.toHaveBeenCalled()
  expect(api.browser.release).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(api.browser.updatePresentation).toHaveBeenCalledWith('original-lease', { visible: false }))
  record({ case: 'actual-alias-and-lease', firstAliasLayout: firstCommitFacts[0], nonemptyLeaseRegistration: true,
    originalOccurrence: true, sameStageDOM: true, noLeaseRestartOrRemoval: true, actualHiddenGeometryUpdate: true })
})

it('keeps the default caller eager and preserves both local failed-image states with its visited DOM', async () => {
  const props: ComponentProps<typeof BrowserRecoverySurface> = {
    url: page.url, title: page.title, heading: 'Browser parked', description: 'Original page is retained', error: page.error,
    faviconDataUrl: 'data:image/png;base64,AA==', busy: false,
    preview: { status: 'available', preview: {
      scope: { browserId: page.id, workspaceId: 'workspace', mode: 'normal', profileId: 'default' },
      url: page.url, title: 'Previous page', navigationId: page.navigationId, capturedAt: 1,
      image: { dataUrl: 'data:image/jpeg;base64,AA==', width: 120, height: 80 }
    } },
    onCopy: async text => { await api.ui.writeClipboardText(text); return true }, onEditAddress: vi.fn(), onRetry: vi.fn()
  }
  await act(async () => root.render(<BrowserRecoverySurface {...props} />))
  const recovery = container.querySelector('.browser-recovery')
  expect(recovery, 'Omitted visibility must preserve the previous eager surface contract').not.toBeNull()
  const images = [...container.querySelectorAll('img')]
  expect(images).toHaveLength(2)
  await act(async () => { for (const image of images) image.dispatchEvent(new Event('error')) })
  expect(container.querySelectorAll('img')).toHaveLength(0)
  expect(container.textContent).toContain('The previous preview could not be displayed')
  await act(async () => root.render(<BrowserRecoverySurface {...props} visible={false} />))
  expect(container.querySelector('.browser-recovery')).toBe(recovery)
  await act(async () => root.render(<BrowserRecoverySurface {...props} visible />))
  expect(container.querySelector('.browser-recovery')).toBe(recovery)
  expect(container.querySelectorAll('img')).toHaveLength(0)
  expect(container.textContent).toContain('The previous preview could not be displayed')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy page address"]')!.click())
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(page.url)
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Edit address')!.click())
  expect(props.onEditAddress).toHaveBeenCalledOnce()
  record({ case: 'default-and-failed-images', omittedVisibilityEager: true, twoRealImagesFailed: true,
    bothFailedImageStatesWarm: true, sameRecoveryDOM: true, originalCopyAndEditControls: true })
})
