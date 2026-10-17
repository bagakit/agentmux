// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

it('positions an active reader after its enclosing surface ref is reattached by the same commit', async () => {
  let surface: HTMLElement | null = null
  const locate = () => surface
  function EnclosingSurface({ open, revision = 0 }: { open: boolean; revision?: number }) {
    return <section ref={node => { surface = node }} data-revision={revision}><div className="browser-toolbar" />
      <BrowserTraceReadingHost mode="floating" open={open} held visible anchor={locate} onReopen={() => {}}>Original trace</BrowserTraceReadingHost>
    </section>
  }
  await dom.render(<EnclosingSurface open={false} />)
  await dom.render(<EnclosingSurface open />)
  await vi.waitFor(() => {
    const panel = document.querySelector<HTMLElement>('[aria-label="Browser activity trace"]')!
    expect(panel).not.toBeNull(); expect(panel.style.visibility).toBe('visible')
    expect(panel.style.left).not.toBe(''); expect(panel.style.top).not.toBe('')
  })
  await dom.render(<EnclosingSurface open revision={1} />)
  expect(document.querySelector<HTMLElement>('[aria-label="Browser activity trace"]')!.style.visibility).toBe('visible')
})
