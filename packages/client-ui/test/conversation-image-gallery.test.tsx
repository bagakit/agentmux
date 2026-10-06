import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import { ConversationImage, type ReadPastedImage } from '../src/components/ConversationImage.js'
import { ConversationImageCollection } from '../src/components/ConversationImageCollection.js'
import { InlineComposer } from '../src/components/InlineComposer.js'
import type { PastedImage } from '../src/lib/pasted-images.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const paths = ['first.png', 'second.png', 'third.png'].map(name => fixturePath(`.agentmux/pasted/${name}`))
const data = (name: string) => ({ dataUrl: `data:image/png;base64,${name}` })
const reader = vi.fn(async (path: string) => data(String(paths.indexOf(path))))
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
const mounts: { root: Root; host: HTMLElement }[] = []
beforeEach(() => {
  reader.mockClear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1200)
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(800)
})
afterEach(async () => {
  for (const { root, host } of mounts.splice(0)) { await act(async () => root.unmount()); host.remove() }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount(content: ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); mounts.push({ root, host })
  const render = async (value: ReactNode) => { await act(async () => root.render(<ClientUiProvider platform={platform}>{value}</ClientUiProvider>)) }
  await render(content)
  return { host, render }
}
async function loadedImage() { await act(async () => { full()?.dispatchEvent(new Event('load')) }) }
async function click(element: Element) {
  expect(element).not.toBeNull()
  await act(async () => { (element as HTMLElement).focus(); (element as HTMLElement).click() })
  await loadedImage()
}
const full = () => document.querySelector<HTMLImageElement>('.md-conversation-image__full')!
const button = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
const position = () => document.querySelector('.md-conversation-image__position')?.textContent
async function key(key: string) {
  await act(async () => document.querySelector('.md-conversation-image__viewport')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
  await loadedImage()
}
function retainedError(image: HTMLImageElement): () => void {
  const field = Object.keys(image).find(key => key.startsWith('__reactProps$'))!
  return (image as unknown as Record<string, { onError(): void }>)[field]!.onError
}
const content = paths.map(path => `@${path}`).join('\n\n')
function markdown(value = content, read: ReadPastedImage = reader) { return <AgentMarkdown content={value} readPastedImage={read} /> }

it('browses rendered references in content order, deduplicates paths and resets zoom with usable navigation focus', async () => {
  const { host } = await mount(markdown(`**@${paths[0]}**\n\n@${paths[1]} and @${paths[0]}\n\n\`@${paths[2]}\``))
  const trigger = host.querySelector<HTMLButtonElement>('.md-conversation-image')!
  await act(async () => trigger.focus()); await click(trigger)
  expect(position()).toBe('1 / 3'); expect(button('Previous image').disabled).toBe(true)
  expect(reader).toHaveBeenCalledTimes(4)
  await click(button('Zoom in')); expect(full().style.transform).toContain('scale(1.25)')
  await click(button('Next image'))
  expect(full().alt).toBe(paths[1]); expect(position()).toBe('2 / 3')
  expect(full().style.transform).toContain('scale(1)')
  expect(reader.mock.calls.map(call => call[0])).toEqual([paths[0], paths[1], paths[0], paths[2], paths[1]])
  expect(document.activeElement).toBe(button('Next image'))
  await key('ArrowRight'); expect(position()).toBe('3 / 3'); expect(button('Next image').disabled).toBe(true)
  expect(document.activeElement).toBe(button('Previous image'))
  await key('ArrowLeft'); await key('ArrowLeft')
  expect(full().src).toBe(data('0').dataUrl)
  expect(reader.mock.calls.filter(call => call[0] === paths[0])).toHaveLength(2)
  await key('Escape')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(document.activeElement).toBe(trigger)
})

it('collects unsupported link fallback images while leaving handled link labels, code fences and read-only prose inert', async () => {
  const value = `@${paths[0]}\n\n[@${paths[1]}](unsupported:target)\n\n[@${paths[2]}](https://example.test/image)\n\n\`\`\`text\n@${paths[2]}\n\`\`\``
  const { host, render } = await mount(markdown(value))
  expect(host.querySelectorAll('.md-conversation-image')).toHaveLength(2)
  await click(host.querySelector('.md-conversation-image')!)
  expect(position()).toBe('1 / 2')
  await key('ArrowRight'); expect(full().alt).toBe(paths[1])
  await render(<AgentMarkdown content={value} readPastedImage={reader} readOnly />)
  expect(full()).toBeNull(); expect(host.querySelector('.md-conversation-image')).toBeNull()
})

it('keeps a streamed text append open when its image collection is unchanged, then closes on actual member changes', async () => {
  const { host, render } = await mount(markdown())
  await click(host.querySelector('.md-conversation-image')!)
  await click(button('Next image')); await click(button('Zoom in'))
  const image = full(); const calls = reader.mock.calls.length
  await render(markdown(content + '\n\nMore explanation.'))
  expect(full()).toBe(image); expect(position()).toBe('2 / 3')
  expect(full().style.transform).toContain('scale(1.25)'); expect(reader).toHaveBeenCalledTimes(calls)
  await render(markdown(`@${paths[0]}\n\n@${paths[1]}`))
  expect(full()).toBeNull()
})

it('keeps separate content and a mismatched injected reader out of the collection', async () => {
  const other = vi.fn(async () => data('other'))
  const { host } = await mount(<>{markdown(`@${paths[0]}`)}{markdown(`@${paths[1]}`)}
    <ConversationImageCollection references={paths.map(path => ({ path, text: `@${path}` }))} readImage={reader}>
      <ConversationImage path={paths[0]!} text={`@${paths[0]}`} readImage={other} />
    </ConversationImageCollection></>)
  const triggers = host.querySelectorAll('.md-conversation-image')
  await click(triggers[0]!); expect(button('Next image')).toBeNull(); await key('Escape')
  await click(triggers[2]!); expect(button('Next image')).toBeNull(); expect(full().src).toBe(data('other').dataUrl)
  expect(other).toHaveBeenCalledExactlyOnceWith(paths[0])
})

it('retains an unreadable sibling reference, retries it lazily and still reaches a healthy original', async () => {
  let fail = false
  const read = vi.fn(async (path: string) => path === paths[1] && fail ? null : data(path))
  const { host } = await mount(markdown(content, read))
  fail = true
  await click(host.querySelector('.md-conversation-image')!); await click(button('Next image'))
  expect(full()).toBeNull(); expect(document.querySelector('.md-conversation-image__state')?.textContent).toContain(`@${paths[1]}`)
  expect(button('Zoom in').disabled).toBe(true); expect(position()).toBe('2 / 3')
  await click(button('Retry image'))
  expect(full()).toBeNull(); expect(document.activeElement).toBe(document.querySelector('.md-conversation-image__viewport'))
  fail = false; await click(button('Retry image'))
  expect(document.activeElement).toBe(document.querySelector('.md-conversation-image__viewport'))
  expect(full().alt).toBe(paths[1]); expect(read.mock.calls.filter(call => call[0] === paths[1])).toHaveLength(4)
  await click(button('Previous image')); expect(full().alt).toBe(paths[0])
  expect(read.mock.calls.filter(call => call[0] === paths[0])).toHaveLength(1)
})

it('ignores obsolete selection reads and decode callbacks without poisoning another image', async () => {
  let resolve: ((image: PastedImage) => void) | undefined, defer = false
  const read = vi.fn((path: string) => defer && path === paths[1] ? new Promise<PastedImage>(done => { resolve = done }) : Promise.resolve(data(path)))
  const { host } = await mount(markdown(content, read))
  await click(host.querySelector('.md-conversation-image')!)
  const originalError = retainedError(full())
  defer = true; await click(button('Next image')); expect(full()).toBeNull()
  await key('ArrowRight'); expect(full().alt).toBe(paths[2])
  const third = full()
  await act(async () => { originalError(); resolve!(data('obsolete')) })
  expect(full()).toBe(third); expect(full().src).toBe(data(paths[2]!).dataUrl)
  const siblingError = retainedError(full())
  await key('ArrowLeft'); await key('ArrowLeft')
  await act(async () => siblingError())
  expect(full().alt).toBe(paths[0]); expect(host.querySelector('.md-conversation-image')).not.toBeNull()
})

it('does not reuse bytes or an open gallery across a same-path reader replacement', async () => {
  const replacement = vi.fn(async () => data('replacement'))
  const { host, render } = await mount(markdown())
  await click(host.querySelector('.md-conversation-image')!)
  const obsolete = retainedError(full())
  await render(markdown(content, replacement))
  expect(full()).toBeNull()
  expect(host.querySelector<HTMLImageElement>('.md-conversation-image__thumb')!.src).toBe(data('replacement').dataUrl)
  await click(host.querySelector('.md-conversation-image')!)
  await act(async () => obsolete())
  expect(full().src).toBe(data('replacement').dataUrl)
  expect(replacement.mock.calls.map(call => call[0])).toEqual(paths)
})

it('uses the actual Tiptap node views with the current source reader while preserving the editor and draft', async () => {
  const value = `Compare @${paths[0]} with @${paths[1]}`
  const changed = vi.fn(async () => data('changed-source'))
  const onValueChange = vi.fn()
  const composer = (read: ReadPastedImage) => <InlineComposer value={value} onValueChange={onValueChange} disabled={false} placeholder="Message" aria-label="Draft" onKeyDown={() => {}} readPastedImage={read} />
  const { host, render } = await mount(composer(reader))
  const editor = host.querySelector('.tiptap')
  const before = editor!.textContent
  await click(host.querySelector('.md-conversation-image')!)
  expect(position()).toBe('1 / 2'); await key('ArrowRight'); expect(full().alt).toBe(paths[1])
  const obsolete = retainedError(full())
  await render(composer(changed))
  expect(host.querySelector('.tiptap')).toBe(editor); expect(editor!.textContent).toBe(before)
  expect(full()).toBeNull(); expect(changed.mock.calls.map(call => call[0]).sort()).toEqual(paths.slice(0, 2).sort())
  expect(host.querySelector<HTMLImageElement>('.md-conversation-image__thumb')!.src).toBe(data('changed-source').dataUrl)
  await click(host.querySelector('.md-conversation-image')!)
  await act(async () => obsolete())
  expect(full().src).toBe(data('changed-source').dataUrl); expect(position()).toBe('1 / 2')
  expect(onValueChange).not.toHaveBeenCalled()
})


it('retries a sibling decode failure in place, resets its view and retains keyboard focus', async () => {
  const { host } = await mount(markdown())
  await click(host.querySelector('.md-conversation-image')!); await click(button('Next image')); await click(button('Zoom in'))
  const viewport = document.querySelector<HTMLDivElement>('.md-conversation-image__viewport')!
  const release = vi.fn()
  viewport.setPointerCapture = vi.fn(); viewport.hasPointerCapture = () => true; viewport.releasePointerCapture = release
  await act(async () => viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 200, clientY: 200 })))
  await act(async () => full().dispatchEvent(new Event('error')))
  expect(release).toHaveBeenCalledExactlyOnceWith(1)
  expect(full()).toBeNull(); expect(position()).toBe('2 / 3')
  expect(document.querySelector('.md-conversation-image__state')?.textContent).toContain('Recorded image could not be decoded.')
  expect(host.querySelectorAll('.md-conversation-image')).toHaveLength(3)
  await click(button('Retry image'))
  expect(full().style.transform).toContain('scale(1)')
  expect(document.activeElement).toBe(document.querySelector('.md-conversation-image__viewport'))
  await key('ArrowRight'); expect(full().alt).toBe(paths[2])
})
