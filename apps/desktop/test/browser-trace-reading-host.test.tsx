// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BrowserTraceReadingHost } from '../src/renderer/src/components/BrowserTraceReadingHost'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
let source: HTMLElement
beforeEach(() => {
  source = document.createElement('section'); source.innerHTML = '<div class="browser-toolbar"></div>'
  document.body.append(source)
})
afterEach(() => source.remove())
const anchor = () => source

it('keeps the same dock footprint when its reader closes during an observed operation', async () => {
  let reopened = 0
  await dom.render(<BrowserTraceReadingHost mode="docked" open held visible anchor={anchor} onReopen={() => reopened++}><p>Original trace</p></BrowserTraceReadingHost>)
  const original = dom.container.querySelector('aside')!
  await dom.render(<BrowserTraceReadingHost mode="docked" open={false} held visible anchor={anchor} onReopen={() => reopened++}><p>Original trace</p></BrowserTraceReadingHost>)
  expect(dom.container.querySelector('aside')).toBe(original)
  expect(original.hidden).toBe(false); expect(original.style.display).not.toBe('none')
  expect(original.textContent).not.toContain('Original trace')
  await act(async () => original.querySelector('button')!.click()); expect(reopened).toBe(1)
  await dom.render(<BrowserTraceReadingHost mode="docked" open={false} held={false} visible anchor={anchor} onReopen={() => {}}>Trace</BrowserTraceReadingHost>)
  expect(dom.container.querySelector('aside')).toBeNull()
})

it('places an active reader outside the Browser flow and leaves the original stage untouched', async () => {
  const stage = document.createElement('div'); stage.dataset.nativeBrowserStage = 'original'; source.append(stage)
  await dom.render(<BrowserTraceReadingHost mode="floating" open held visible anchor={anchor} onReopen={() => {}}><p>Live trace</p></BrowserTraceReadingHost>)
  expect(source.isConnected).toBe(true)
  const panel = document.querySelector('[role="dialog"][aria-label="Browser activity trace"]')!
  expect(panel).not.toBeNull(); expect(source.contains(panel)).toBe(false)
  expect(stage.parentElement).toBe(source)
  await dom.render(<BrowserTraceReadingHost mode="floating" open held visible={false} anchor={anchor} onReopen={() => {}}>Trace</BrowserTraceReadingHost>)
  expect(document.querySelector('[role="dialog"][aria-label="Browser activity trace"]')).toBeNull()
})

it('does not resurrect a closed idle dock when a later Agent operation starts', async () => {
  const render = (open: boolean, held: boolean) => dom.render(<BrowserTraceReadingHost mode="docked" open={open} held={held} visible anchor={anchor} onReopen={() => {}}>Trace</BrowserTraceReadingHost>)
  await render(true, false); expect(dom.container.querySelector('aside')).not.toBeNull()
  await render(false, false); expect(dom.container.querySelector('aside')).toBeNull()
  await render(false, true); expect(dom.container.querySelector('aside')).toBeNull()
  await render(true, true); expect(dom.container.querySelector('aside')).not.toBeNull()
  await render(false, true); expect(dom.container.querySelector('aside')).not.toBeNull()
  await render(false, false); expect(dom.container.querySelector('aside')).toBeNull()
  await render(false, true); expect(dom.container.querySelector('aside')).toBeNull()
})
