import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SelectionIndicator } from '../src/components/SelectionIndicator.js'

let host: HTMLDivElement, root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const dimensions = { offsetWidth: 'width', offsetHeight: 'height', offsetLeft: 'left', offsetTop: 'top' } as const
  for (const [property, dimension] of Object.entries(dimensions)) {
    vi.spyOn(window.HTMLElement.prototype, property as keyof typeof dimensions, 'get').mockImplementation(function (this: HTMLElement) {
      return Number(this.dataset[dimension] ?? 0)
    })
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(current: 'overview' | 'decisions' | null, withDecisions = true) {
  await act(async () => root.render(<nav aria-label="Reading position">
    <SelectionIndicator />
    <button type="button" aria-current={current === 'overview' ? 'location' : 'false'} data-left={8} data-top={5} data-width={70} data-height={28}>Overview</button>
    {withDecisions ? <button type="button" aria-current={current === 'decisions' ? 'location' : 'false'} data-left={8} data-top={38} data-width={127} data-height={31}>Original decisions</button> : null}
    <div><button type="button" aria-current="page" data-left={200} data-top={5} data-width={40} data-height={28}>Nested navigation</button></div>
  </nav>))
  return host.querySelector<HTMLSpanElement>('.selection-indicator')!
}

it('follows the current item across rows without taking the native button focus', async () => {
  const indicator = await render('overview')
  expect(indicator.style.transform).toBe('translate(8px, 5px)')
  expect(indicator.getAttribute('aria-hidden')).toBe('true')
  const focused = host.querySelector<HTMLButtonElement>('nav > button')!
  focused.focus()
  expect(await render('decisions')).toBe(indicator)
  await vi.waitFor(() => expect(indicator.style.transform).toBe('translate(8px, 38px)'))
  expect(indicator.style.width).toBe('127px')
  expect(indicator.style.height).toBe('31px')
  expect(document.activeElement).toBe(focused)
})

it('hides for a removed or absent direct current item and resumes at the next real item', async () => {
  const indicator = await render('decisions')
  expect(indicator.hidden).toBe(false)
  await render('decisions', false)
  await vi.waitFor(() => expect(indicator.hidden).toBe(true))
  await render(null)
  expect(indicator.hidden).toBe(true)
  await render('overview')
  await vi.waitFor(() => expect(indicator.hidden).toBe(false))
  expect(indicator.style.transform).toBe('translate(8px, 5px)')
})
