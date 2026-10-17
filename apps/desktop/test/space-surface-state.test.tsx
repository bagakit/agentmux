// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { SurfaceState } from '../src/renderer/src/components/SurfaceState'
import { ServiceWindowNotice } from '../src/renderer/src/components/ServiceWindowNotice'
import { FullPageLoadingSurface } from '../src/renderer/src/components/FullPageLoadingSurface'
import { WorkbenchEmptyState } from '../src/renderer/src/components/WorkbenchEmptyState'

let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('a custom work body keeps its heading, explanation, action and details without becoming a live status region', async () => {
  const action = vi.fn()
  await act(async () => root.render(<SurfaceState title="Original work" description="The original scope is retained."
    body={<input aria-label="Work draft" defaultValue="Unsent request" />}
    actions={<button onClick={action}>Continue here</button>}
    details={{ summary: 'Original facts', content: <p>Exact source remains available.</p> }} />))
  expect(container.querySelector('.surface-state__title')?.textContent).toBe('Original work')
  expect(container.querySelector('.surface-state__description')?.textContent).toBe('The original scope is retained.')
  const input = container.querySelector<HTMLInputElement>('[aria-label="Work draft"]')!
  expect(input.value).toBe('Unsent request')
  expect(input.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull()
  const button = container.querySelector<HTMLButtonElement>('.surface-state__actions button')!
  expect(button).not.toBeNull()
  await act(async () => button.click())
  expect(action).toHaveBeenCalledOnce()
  expect(container.querySelector('details')?.textContent).toContain('Exact source remains available.')
})

it.each(['surface', 'inline'] as const)('the real service notice supplies %s geometry and preserves all three original facts', async layout => {
  const retry = vi.fn()
  const notice = { kind: 'indeterminate' as const, notice: { step: 'Original display retained',
    mode: 'The exact occurrence is not confirmed.', restore: 'Choose its original location.' } }
  await act(async () => root.render(<ServiceWindowNotice notice={notice} layout={layout}
    actions={<button onClick={retry}>Open original location</button>} />))
  const surface = container.querySelector(`.service-window > .surface-state--${layout}`)
  expect(surface).not.toBeNull()
  for (const fact of Object.values(notice.notice)) expect(surface!.textContent).toContain(fact)
  expect(surface!.closest('[role="status"]')?.getAttribute('aria-live')).toBe('polite')
  expect(surface!.querySelector('.surface-state__activity')).toBeNull()
  expect(surface!.querySelector('[aria-busy="true"], [data-icon-animation]')).toBeNull()
  const button = surface!.querySelector<HTMLButtonElement>('.surface-state__actions button')!
  await act(async () => button.click())
  expect(retry).toHaveBeenCalledOnce()
})

it('the retained full-page consumer does not invent waiting and keeps recovery actions before detail and recap', async () => {
  await act(async () => root.render(<FullPageLoadingSurface scope="region" phase="parked"
    title="Original Session retained" detail="Its original location is still unconfirmed."
    actions={<button>Recover original</button>} supplement={<p data-original-recap>Original conversation recap</p>}
    details={{ summary: 'Original source', content: <p>Retained identity</p> }} />))
  const stage = container.querySelector('.full-page-loading > .surface-state')!
  expect(stage).not.toBeNull()
  expect(stage.querySelector('.surface-state__title')?.textContent).toBe('Original Session retained')
  expect(stage.querySelector('.full-page-loading__waiting, .surface-state__activity, [data-icon-animation]')).toBeNull()
  expect(stage.parentElement?.getAttribute('aria-busy')).toBe('false')
  const actions = stage.querySelector('.surface-state__actions')!
  expect(actions.textContent).toBe('Recover original')
  for (const selector of ['.full-page-loading__detail', '[data-original-recap]', 'details']) {
    const reading = stage.querySelector(selector)!
    expect(reading).not.toBeNull()
    expect(actions.compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
})

it('the confirmed Mote start keeps identity and its original action in the shared surface', async () => {
  const create = vi.fn()
  await act(async () => root.render(<WorkbenchEmptyState name="Original Mote" heading="What’s on your mind?"
    description="Keep the original discussion target." action={<button onClick={create}>New discussion</button>} />))
  const surface = container.querySelector('.workbench-empty-state.surface-state')!
  expect(surface).not.toBeNull()
  expect(surface.querySelector('.surface-state__eyebrow')?.textContent).toBe('Original Mote')
  expect(surface.querySelector('.surface-state__description')?.textContent).toBe('Keep the original discussion target.')
  const button = surface.querySelector<HTMLButtonElement>('button')!
  expect(button.closest('[role="status"]')).toBeNull()
  await act(async () => button.click())
  expect(create).toHaveBeenCalledOnce()
})
