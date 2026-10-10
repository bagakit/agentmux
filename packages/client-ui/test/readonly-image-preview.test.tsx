// @vitest-environment happy-dom
import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryResourceReadResult, AgentSessionHistoryResourceRequest } from '@agentmux/core'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import { ConversationImage } from '../src/components/ConversationImage.js'
import { ConversationResourceImage } from '../src/components/ConversationResourceImage.js'
import { markdownImageReferences, pastedMarkdownImageReference } from '../src/lib/conversation-image-references.js'
import { parseAgentMarkdown } from '../src/lib/agent-markdown.js'
import { useVisibleWork } from '../src/lib/use-visible-work.js'

const pasted = fixturePath('.agentmux/pasted/recall.png'), nativePath = 'recorded-image', dataUrl = 'data:image/png;base64,original-image'
const source = { providerId: 'codex' as const, nativeSessionId: 'original-native' }
const request: AgentSessionHistoryResourceRequest = { source, recordId: 'original-record', turnId: 'original-turn', partIndex: 2, expectedReference: nativePath }
const part = { kind: 'resource' as const, resourceType: 'image' as const, reference: nativePath, label: 'Original recorded image' }
const record = { source, recordId: request.recordId, turnId: 'original-turn' }
const platform = (ownerDocument = document): ClientUiPlatform => ({ ownerDocument, copyText: async () => true, overlayContainer: () => ownerDocument.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null })
function response(input = request): AgentSessionHistoryResourceReadResult { return { agentSessionId: 'original-agent', source: input.source,
  recordId: input.recordId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }), partIndex: input.partIndex, reference: input.expectedReference,
  result: { status: 'read', mimeType: 'image/png', dataBase64: 'original-image', byteLength: 8 } } }
type Observation = { target: Element; callback: IntersectionObserverCallback; disconnected: boolean; realm: Document }
const observations: Observation[] = [], mounts: { root: Root; host: HTMLElement }[] = [], frames: HTMLIFrameElement[] = []
function installObserver(owner: Document) {
  const view = owner.defaultView!
  Object.defineProperty(view, 'IntersectionObserver', { configurable: true, value: class {
    callback: IntersectionObserverCallback; own: Observation[] = []
    constructor(callback: IntersectionObserverCallback) { this.callback = callback }
    observe(target: Element) { const item = { target, callback: this.callback, disconnected: false, realm: owner }; this.own.push(item); observations.push(item) }
    disconnect() { this.own.forEach(item => { item.disconnected = true }) }
  } })
}
async function reveal(owner = document, intersecting = true) {
  await act(async () => { for (const item of [...observations]) if (item.realm === owner && !item.disconnected) item.callback([{ target: item.target, isIntersecting: intersecting } as IntersectionObserverEntry], {} as IntersectionObserver) })
}
async function visibility(owner: Document, value: 'visible' | 'hidden') {
  Object.defineProperty(owner, 'visibilityState', { configurable: true, value })
  await act(async () => owner.dispatchEvent(new Event('visibilitychange')))
}
function secondary() { const frame = document.createElement('iframe'); document.body.append(frame); frames.push(frame); const owner = frame.contentDocument!; installObserver(owner); return owner }
async function render(children: ReactNode, owner = document) {
  const host = owner.createElement('div'); owner.body.append(host); const root = createRoot(host); mounts.push({ root, host })
  await act(async () => root.render(<ClientUiProvider platform={platform(owner)}>{children}</ClientUiProvider>))
  return { host, root, draw: async (next: ReactNode, nextOwner = owner) => act(async () => root.render(<ClientUiProvider platform={platform(nextOwner)}>{next}</ClientUiProvider>)) }
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); observations.length = 0; installObserver(document) })
afterEach(async () => {
  for (const { root, host } of mounts.splice(0)) { await act(async () => root.unmount()); host.remove() }
  frames.splice(0).forEach(frame => frame.remove()); Reflect.deleteProperty(document, 'visibilityState')
  window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it('ordinary readOnly has no image IO or actions even when image ports are supplied', async () => {
  const read = vi.fn(async () => ({ dataUrl })), image = vi.fn(() => <i>Host image</i>), http = vi.fn(), file = vi.fn()
  const { host } = await render(<AgentMarkdown readOnly documentMode outline content={`# Title\n\n@${pasted}\n\n![image](${pasted}) [site](https://example.invalid) [file](file.txt) [anchor](#title) note[^x]\n\n[^x]: Note`}
    readPastedImage={read} renderImage={image} openHttpLink={http} openWorkspaceFile={file} />)
  await reveal(); expect(read).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled()
  expect(host.querySelectorAll('img, button, a, [tabindex]')).toHaveLength(0); expect(host.textContent).toContain(pasted)
})
it('explicit pasted token preview waits for its own viewport and never mounts image controls', async () => {
  const read = vi.fn(async () => ({ dataUrl }))
  const { host } = await render(<AgentMarkdown readOnly readOnlyImages content={`Original **prose** @${pasted}`} readPastedImage={read} />)
  expect(read).not.toHaveBeenCalled(); expect(host.textContent).toContain(pasted)
  await reveal(); expect(read).toHaveBeenCalledExactlyOnceWith(pasted); expect(host.querySelector('img')?.getAttribute('src')).toBe(dataUrl)
  expect(host.querySelectorAll('button, a')).toHaveLength(0); expect(document.querySelector('[role="dialog"]')).toBeNull()
  const body = host.querySelector('strong')!, range = document.createRange(); range.selectNodeContents(body); window.getSelection()!.addRange(range)
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(host.querySelector('strong')).toBe(body); expect(window.getSelection()!.toString()).toBe('prose')
  expect(host.textContent).toContain(pasted); expect(host.textContent).toContain('could not be decoded'); expect(host.querySelector('button')).toBeNull()
})
it('Markdown pasted images use the same whole-href helper while unrelated hrefs stay references', async () => {
  const read = vi.fn(async () => ({ dataUrl }))
  const { host } = await render(<AgentMarkdown readOnly readOnlyImages content={`![Original](${pasted}) ![external](https://example.invalid/picture.png) ![file](relative.png)`} readPastedImage={read} />)
  await reveal(); expect(read).toHaveBeenCalledExactlyOnceWith(pasted); expect(host.querySelectorAll('img')).toHaveLength(1)
  expect(host.querySelector('img')?.getAttribute('alt')).toBe('Original'); expect(host.querySelectorAll('button,a')).toHaveLength(0)
  expect(pastedMarkdownImageReference(`prefix${pasted}`)).toBeUndefined(); expect(pastedMarkdownImageReference(`https://example.invalid${pasted}`)).toBeUndefined()
  expect(pastedMarkdownImageReference(pasted, 'Original')).toEqual({ path: pasted, text: pasted, label: 'Original' })
})
it('the opt-in collector follows actual image rendering without changing ordinary gallery semantics', () => {
  const another = fixturePath('.agentmux/pasted/another.png'), linkOnly = fixturePath('.agentmux/pasted/link-only.png'), fenced = fixturePath('.agentmux/pasted/fenced.png')
  const content = `![md](${pasted})\n\n@${another}\n\n[![linked](${pasted})](https://example.invalid) [@${linkOnly}](https://example.invalid)\n\n\`\`\`text\n@${fenced}\n\`\`\``
  const blocks = parseAgentMarkdown(content)
  expect(markdownImageReferences(content, blocks, false, () => false)).toEqual([{ path: another, text: `@${another}`, kind: 'image' }])
  expect(markdownImageReferences(content, blocks, false, () => false, { readOnlyImages: true })).toEqual([{ path: pasted, text: pasted, label: 'md' }, { path: another, text: `@${another}`, kind: 'image' }])
})
it('a supplied native image renderer remains the exact resource owner within read-only Markdown', async () => {
  const read = vi.fn(async (input: AgentSessionHistoryResourceRequest) => response(input)), open = vi.fn()
  const { host } = await render(<AgentMarkdown readOnly readOnlyImages content="![Original](recorded-image) [site](https://example.invalid)"
    openHttpLink={open} renderImage={(href) => href === nativePath ? <ConversationResourceImage part={part} partIndex={2} record={record} readResource={read} interactive={false} /> : undefined} />)
  await reveal(); expect(read).toHaveBeenCalledExactlyOnceWith(request); expect(host.querySelector('img')?.getAttribute('src')).toBe(dataUrl)
  expect(host.querySelector('button')).toBeNull(); expect(open).not.toHaveBeenCalled()
})
it('a mismatched native resource keeps its exact reference and reason without a retry or gallery', async () => {
  const read = vi.fn(async (input: AgentSessionHistoryResourceRequest) => ({ ...response(input), recordId: 'foreign-record' }))
  const { host } = await render(<ConversationResourceImage part={part} partIndex={2} record={record} readResource={read} interactive={false} />)
  await reveal(); expect(read).toHaveBeenCalledExactlyOnceWith(request); expect(host.querySelector('img')).toBeNull()
  expect(host.textContent).toContain(nativePath); expect(host.textContent).toContain('another recorded resource'); expect(host.querySelector('button')).toBeNull()
})
it('active false and a hidden image viewport reject late bytes while retaining an already loaded image', async () => {
  let finish!: (value: { dataUrl: string }) => void
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ dataUrl })
  const view = (active: boolean) => <ConversationImage active={active} interactive={false} text={pasted} path={pasted} readImage={read} />
  const { host, draw } = await render(view(false)); await reveal(); expect(read).not.toHaveBeenCalled()
  await draw(view(true)); await reveal(); expect(read).toHaveBeenCalledTimes(1)
  await reveal(document, false); await act(async () => finish({ dataUrl: 'data:image/png;base64,late' })); expect(host.querySelector('img')).toBeNull()
  await reveal(); expect(read).toHaveBeenCalledTimes(2); const image = host.querySelector('img')!; expect(image.getAttribute('src')).toBe(dataUrl)
  await draw(view(false)); await draw(view(true)); await reveal(); expect(read).toHaveBeenCalledTimes(2); expect(host.querySelector('img')).toBe(image)
})
it('each passive image requires its own intersection rather than a long parent body', async () => {
  const second = fixturePath('.agentmux/pasted/second.png'), read = vi.fn(async () => ({ dataUrl }))
  const { host } = await render(<AgentMarkdown readOnly readOnlyImages content={`@${pasted}\n\n@${second}`} readPastedImage={read} />)
  const first = observations.find(item => item.target.textContent === `@${pasted}`)!, next = observations.find(item => item.target.textContent === `@${second}`)!
  expect(first).toBeDefined(); expect(next).toBeDefined()
  await act(async () => first.callback([{ target: first.target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(read).toHaveBeenCalledExactlyOnceWith(pasted); expect(host.querySelectorAll('img')).toHaveLength(1)
})
it('a secondary visible document loads even while the primary document is hidden', async () => {
  const owner = secondary(); await visibility(document, 'hidden'); await visibility(owner, 'visible')
  const read = vi.fn(async () => ({ dataUrl })), { host } = await render(<ConversationImage interactive={false} text={pasted} path={pasted} readImage={read} />, owner)
  await reveal(document); expect(read).not.toHaveBeenCalled(); await reveal(owner)
  expect(read).toHaveBeenCalledExactlyOnceWith(pasted); expect(host.querySelector('img')).not.toBeNull()
})
it('a hidden secondary document cannot borrow primary visibility or late source bytes', async () => {
  const owner = secondary(); await visibility(owner, 'hidden')
  let finish!: (value: { dataUrl: string }) => void
  const read = vi.fn(() => new Promise<{ dataUrl: string }>(resolve => { finish = resolve }))
  const { host } = await render(<ConversationImage interactive={false} text={pasted} path={pasted} readImage={read} />, owner)
  await reveal(owner); expect(read).not.toHaveBeenCalled(); await visibility(owner, 'visible'); expect(read).toHaveBeenCalledTimes(1)
  await visibility(owner, 'hidden'); await act(async () => finish({ dataUrl })); expect(host.querySelector('img')).toBeNull()
})
it('retained nodes rebind their actual realm when the existing platform document changes', async () => {
  const owner = secondary(); await visibility(owner, 'hidden')
  function Probe() { const work = useVisibleWork<HTMLSpanElement>(); return <span ref={work.ref} data-work={work.visible}>Retained content</span> }
  const { host, root } = await render(<Probe />); await reveal(); const node = host.firstElementChild!; expect(node.getAttribute('data-work')).toBe('true')
  const old = observations.find(item => item.target === node)!
  owner.body.append(owner.adoptNode(host))
  await act(async () => root.render(<ClientUiProvider platform={platform(owner)}><Probe /></ClientUiProvider>)); await reveal(owner)
  expect(host.firstElementChild).toBe(node); expect(node.ownerDocument).toBe(owner); expect(node.getAttribute('data-work')).toBe('false'); expect(old.disconnected).toBe(true)
  await act(async () => old.callback([{ target: node, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)); expect(node.getAttribute('data-work')).toBe('false')
  await visibility(owner, 'visible'); expect(node.getAttribute('data-work')).toBe('true')
})
it('standalone visible-work consumers retain their own document without requiring a platform', async () => {
  function Probe() { const work = useVisibleWork<HTMLSpanElement>(); return <span ref={work.ref} data-work={work.visible}>Plain content</span> }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); mounts.push({ host, root })
  await act(async () => root.render(<Probe />)); await reveal(); expect(host.firstElementChild?.getAttribute('data-work')).toBe('true')
})

it('a secondary viewport fallback uses its own window bounds without a primary observer', async () => {
  const owner = secondary(), mainWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  Object.defineProperty(owner.defaultView!, 'IntersectionObserver', { configurable: true, value: undefined })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1 })
  Object.defineProperty(owner.defaultView!, 'innerWidth', { configurable: true, value: 400 })
  vi.spyOn(owner.defaultView!.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(10, 10, 20, 20))
  try {
    const read = vi.fn(async () => ({ dataUrl })), { host } = await render(<ConversationImage interactive={false} text={pasted} path={pasted} readImage={read} />, owner)
    expect(read).toHaveBeenCalledExactlyOnceWith(pasted); expect(host.querySelector('img')).not.toBeNull()
  } finally { if (mainWidth) Object.defineProperty(window, 'innerWidth', mainWidth) }
})
