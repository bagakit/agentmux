// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownCodeBlock } from '../src/components/MarkdownCodeBlock.js'

type Pending = { id: string; source: string; deliver(event: { data: { id: string; result: { html?: string; error?: string } } }): void }
const pending: Pending[] = [], workers: Array<{ terminate: ReturnType<typeof vi.fn> }> = []
let host: HTMLDivElement, root: Root, foreground: boolean
let observers: Array<{ target: Element | null; callback: IntersectionObserverCallback }>
const source = '{"count":1,"name":"raw"}', tokens = '<span class="hljs-punctuation">{</span>"count":<span class="hljs-number">1</span>,"name":<span class="hljs-string">"raw"</span>}'
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  pending.length = 0; workers.length = 0; observers = []; foreground = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => foreground ? 'visible' : 'hidden')
  vi.stubGlobal('IntersectionObserver', class {
    target: Element | null = null
    constructor(public callback: IntersectionObserverCallback) { observers.push(this) }
    observe(target: Element) { this.target = target; this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() { this.target = null }
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('Worker', class {
    onmessage: ((event: { data: { id: string; result: { html?: string; error?: string } } }) => void) | null = null
    onerror = null; onmessageerror = null
    terminate = vi.fn()
    postMessage = vi.fn(({ id, input }: { id: string; input: { source: string } }) => pending.push({ id, source: input.source, deliver: this.onmessage! }))
    constructor() { workers.push(this) }
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { getSelection()?.removeAllRanges(); root.unmount() }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const draw = (code = source, language = 'json', visible = true) => act(async () => root.render(<MarkdownCodeBlock code={code} language={language} visible={visible} readOnly />))
const deliver = (job: Pending, result: { html?: string; error?: string }) => act(async () => job.deliver({ data: { id: job.id, result } }))
async function select(node: Node, start = 0, end = node.textContent!.length) {
  const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end)
  await act(async () => { getSelection()!.removeAllRanges(); getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')) })
  return range
}
const viewport = (value: boolean) => act(async () => { for (const observer of observers) if (observer.target) observer.callback([{ target: observer.target, isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver) })
const visibility = (value: boolean) => act(async () => { foreground = value; document.dispatchEvent(new Event('visibilitychange')) })

it('defers late same-source token markup while preserving the raw Text node and exact Range, then applies after release', async () => {
  await draw()
  expect(pending).toHaveLength(1)
  const node = host.querySelector('code')!.firstChild!, range = await select(node, 2, 9), selected = range.toString()
  await deliver(pending[0]!, { html: tokens })
  expect(host.querySelector('.hljs-number')).toBeNull()
  expect(host.querySelector('code')!.firstChild).toBe(node); expect(getSelection()!.getRangeAt(0)).toBe(range)
  expect(range.startContainer).toBe(node); expect(range.startOffset).toBe(2); expect(range.endContainer).toBe(node); expect(range.endOffset).toBe(9); expect(range.toString()).toBe(selected)
  await draw()
  expect(host.querySelector('code')!.firstChild).toBe(node); expect(pending).toHaveLength(1)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(host.querySelector('.hljs-number')?.textContent).toBe('1'); expect(host.querySelector('code')!.textContent).toBe(source)
})

it('retains selected colored nodes through ordinary updates, viewport exit and document hiding without recoloring the same source', async () => {
  await draw(); await deliver(pending[0]!, { html: tokens })
  const node = host.querySelector('.hljs-string')!.firstChild!, range = await select(node, 1, 4)
  await draw()
  expect(host.querySelector('.hljs-string')!.firstChild).toBe(node); expect(range.toString()).toBe('raw')
  await viewport(false); await visibility(false)
  expect(host.querySelector('.hljs-string')!.firstChild).toBe(node); expect(range.startContainer).toBe(node); expect(range.toString()).toBe('raw')
  await viewport(true); await visibility(true)
  expect(host.querySelector('.hljs-string')!.firstChild).toBe(node); expect(getSelection()!.getRangeAt(0)).toBe(range); expect(pending).toHaveLength(1)
})

it('keeps same-source colored DOM cached while unselected and offscreen', async () => {
  await draw(); await deliver(pending[0]!, { html: tokens })
  const node = host.querySelector('.hljs-number')!
  await viewport(false)
  expect(host.querySelector('.hljs-number')).toBe(node)
  await viewport(true)
  expect(host.querySelector('.hljs-number')).toBe(node); expect(pending).toHaveLength(1)
})

it('cancels unfinished work while hidden and resumes that original source; late stopped jobs cannot publish', async () => {
  await draw(); const stopped = pending[0]!
  await visibility(false)
  expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  await deliver(stopped, { html: '<span>obsolete</span>' })
  expect(host.querySelector('code')!.textContent).toBe(source)
  await visibility(true)
  expect(pending).toHaveLength(2); expect(pending[1]!.source).toBe(source)
  await deliver(pending[1]!, { html: tokens })
  expect(host.querySelector('.hljs-number')).not.toBeNull()
})

it('an explicit Format/source edit or language change proceeds despite an old code selection', async () => {
  await draw(); const old = pending[0]!, oldNode = host.querySelector('code')!.firstChild!
  await select(oldNode, 2, 9)
  const formatted = '{\n  "count": 1,\n  "name": "raw"\n}'
  await draw(formatted)
  expect(host.querySelector('code')!.textContent).toBe(formatted); expect(pending).toHaveLength(2)
  await deliver(old, { html: '<span>old source</span>' })
  expect(host.querySelector('code')!.textContent).toBe(formatted)
  await deliver(pending[1]!, { html: formatted })
  const current = host.querySelector('code')!.firstChild!
  await select(current)
  await draw(formatted, 'unknown-language')
  expect(host.querySelector('code')!.textContent).toBe(formatted); expect(pending).toHaveLength(3)
  await deliver(pending[2]!, {})
  expect(host.querySelector('code')!.textContent).toBe(formatted)
})

it('keeps an accurate worker error visible while the unchanged raw code is selected', async () => {
  await draw(); const node = host.querySelector('code')!.firstChild!, range = await select(node, 2, 9)
  await deliver(pending[0]!, { error: 'Worker unavailable. Original source shown.' })
  expect(host.querySelector('[role="alert"]')!.textContent).toBe('Worker unavailable. Original source shown.')
  expect(host.querySelector('code')!.firstChild).toBe(node); expect(range.startContainer).toBe(node)
  await visibility(false); await visibility(true)
  expect(pending).toHaveLength(2)
  await deliver(pending[1]!, { html: tokens })
  expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.querySelector('code')!.firstChild).toBe(node)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(host.querySelector('.hljs-number')).not.toBeNull()
})
