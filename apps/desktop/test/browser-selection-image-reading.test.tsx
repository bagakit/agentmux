const { fixtureEpoch: _batchFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserInputContext, BrowserInputImageReference } from '@agentmux/core/browser-input-context'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationInputText } from '../../../packages/client-ui/src/components/ConversationInputText'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { fixturePath } from '../../../test/fixture-values.mjs'

const transport = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  return { exact: vi.fn(), pathOnly: vi.fn() }
})
vi.mock('../src/renderer/src/lib/api', async original => {
  const actual = await original<typeof import('../src/renderer/src/lib/api')>()
  return { ...actual, api: { ...actual.api, browser: { ...actual.api.browser, readSelectionImage: transport.exact },
    ui: { ...actual.api.ui, readPastedImage: transport.pathOnly } } }
})
const path = fixturePath('.agentmux/pasted/selected.png')
const reference: BrowserInputImageReference = { hostId: 'original-host', path, mimeType: 'image/png', width: 80, height: 40, sha256: 'a'.repeat(64) }
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lPkAAAAASUVORK5CYII='
function context(image = reference): BrowserInputContext {
  return { kind: 'browser', version: 1, capturedAt: _batchFixtureEpoch(0, 0, 1),
    browser: { hostId: image.hostId, browserId: 'original-browser', navigationId: 'original-navigation' },
    page: { url: 'https://example.invalid/original', title: 'Original page' },
    selection: { kind: 'region', capturedAt: _batchFixtureEpoch(0, 0, 1), source: { hostId: image.hostId, browserId: 'original-browser', navigationId: 'original-navigation', association: 'observed-during' }, attachment: image } }
}
type Observation = { target: Element; owner: Document; callback: IntersectionObserverCallback; disconnected: boolean }
const observations: Observation[] = [], frames: HTMLIFrameElement[] = []
let host: HTMLElement, root: Root
function observer(owner: Document) {
  Object.defineProperty(owner.defaultView!, 'IntersectionObserver', { configurable: true, value: class {
    own: Observation[] = []
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { const item = { target, owner, callback: this.callback, disconnected: false }; this.own.push(item); observations.push(item) }
    disconnect() { for (const item of this.own) item.disconnected = true }
  } })
}
async function reveal(owner = host.ownerDocument) {
  // The common disclosure and a passive ConversationImage each observe their own DOM.
  for (let pass = 0; pass < 3; pass++) await act(async () => {
    for (const item of [...observations]) if (!item.disconnected && item.owner === owner)
      item.callback([{ target: item.target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
  })
}
async function draw(content: ReactNode, owner = host.ownerDocument) {
  await act(async () => root.render(<DesktopClientUiProvider document={owner}>{content}</DesktopClientUiProvider>))
}
function message(image = reference, active = true) {
  return <ConversationMessage messageId="original-input" contentBoundary="body" recordedIdentity
    speaker={{ role: 'unknown', id: 'unknown' }} content="Original opinion" inputContext={context(image)} inputContextSource="host-capture" active={active} />
}
async function disclosure(open: boolean) {
  const details = host.querySelector<HTMLDetailsElement>('.conversation-browser-context')!
  expect(details).not.toBeNull()
  await act(async () => { details.open = open; details.dispatchEvent(new Event('toggle')) })
}
async function visibility(owner: Document, value: 'hidden' | 'visible') {
  Object.defineProperty(owner, 'visibilityState', { configurable: true, value })
  await act(async () => owner.dispatchEvent(new Event('visibilitychange')))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); observer(document); observations.length = 0
  transport.exact.mockReset().mockResolvedValue({ dataUrl: png }); transport.pathOnly.mockReset().mockResolvedValue({ dataUrl: png })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); frames.splice(0).forEach(frame => frame.remove())
  Reflect.deleteProperty(document, 'visibilityState'); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('reads the exact saved image only from an expanded visible original message', async () => {
  await draw(message()); await reveal()
  expect(transport.exact, 'A closed context must not read its image').not.toHaveBeenCalled()
  await draw(message(reference, false)); await disclosure(true); await reveal()
  expect(transport.exact).not.toHaveBeenCalled()
  await draw(message()); await reveal()
  expect(transport.exact).toHaveBeenCalledExactlyOnceWith(reference)
  expect(transport.pathOnly).not.toHaveBeenCalled()
  expect(host.querySelector('img')?.getAttribute('src')).toBe(png)
  expect(host.querySelector('.conversation-browser-context')?.getAttribute('data-browser-context-source')).toBe('host-capture')
  expect(host.textContent).toContain('Original opinion'); expect(host.textContent).toContain(path)
  await act(async () => host.querySelector<HTMLButtonElement>('.md-conversation-image')!.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await disclosure(false)
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(host.querySelector('img')).toBeNull()
})

it('keeps ordinary read-only content inert and permits only passive images with the existing opt-in', async () => {
  const view = (allowed: boolean) => <ConversationInputText text="Original opinion" inputContext={context()} readOnly readOnlyImages={allowed} />
  await draw(view(false)); await disclosure(true); await reveal()
  expect(transport.exact, 'Read-only without the image opt-in must have zero image IO').not.toHaveBeenCalled()
  await draw(view(true)); await reveal()
  expect(transport.exact).toHaveBeenCalledExactlyOnceWith(reference)
  expect(host.querySelector('img')).not.toBeNull()
  expect(host.querySelector('.md-conversation-image')).toBeNull(); expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('binds bytes to the complete reference when the same display path changes Host, hash or dimensions', async () => {
  let original!: (value: { dataUrl: string }) => void
  transport.exact.mockImplementationOnce(() => new Promise(resolve => { original = resolve }))
  await draw(message()); await disclosure(true); await reveal()
  expect(transport.exact).toHaveBeenCalledTimes(1)
  const next = { ...reference, hostId: 'other-host', sha256: 'b'.repeat(64), width: 160, height: 80 }
  const paints: (string | null)[] = []
  function CommitProbe() { useLayoutEffect(() => { paints.push(host.querySelector('img')?.getAttribute('src') ?? null) }); return null }
  transport.exact.mockResolvedValueOnce(null)
  await draw(<>{message(next)}<CommitProbe /></>); await reveal()
  expect(transport.exact, 'The exact changed image reference must reach its original Host reader').toHaveBeenLastCalledWith(next)
  expect(paints).not.toContain(png)
  await act(async () => original({ dataUrl: png }))
  expect(host.querySelector('img')).toBeNull(); expect(host.textContent).toContain('not readable')
  expect(transport.pathOnly).not.toHaveBeenCalled()
})

it('does not resurrect a closed or hidden image from a late read and keeps retry on the original reference', async () => {
  let finish!: (value: { dataUrl: string }) => void
  transport.exact.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await draw(message()); await disclosure(true); await reveal()
  await visibility(document, 'hidden')
  await act(async () => finish({ dataUrl: png }))
  expect(host.querySelector('img')).toBeNull(); expect(document.querySelector('[role="dialog"]')).toBeNull()
  await visibility(document, 'visible'); await reveal()
  expect(transport.exact).toHaveBeenCalledTimes(2)
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(host.textContent).toContain('could not be decoded')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Retry image"]')!.click())
  expect(transport.exact).toHaveBeenCalledTimes(3)
  for (const call of transport.exact.mock.calls) expect(call).toEqual([reference])
})

it('keeps missing-adapter and missing-digest references readable without path-only fallback', async () => {
  const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
    bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  await draw(<ClientUiProvider platform={platform}>{message()}</ClientUiProvider>); await disclosure(true); await reveal()
  expect(host.textContent).toContain(path); expect(host.textContent).toContain('unavailable in this client')
  expect(transport.exact).not.toHaveBeenCalled()
  const { sha256: _digest, ...legacy } = reference
  await draw(message(legacy)); await reveal()
  expect(host.textContent).toContain(path); expect(host.textContent).toContain('digest was not recorded')
  expect(transport.exact).not.toHaveBeenCalled(); expect(transport.pathOnly).not.toHaveBeenCalled()
})

it('uses the actual presentation document and does not carry a pending image across its move', async () => {
  let finish!: (value: { dataUrl: string }) => void
  transport.exact.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await draw(message()); await disclosure(true); await reveal()
  const frame = document.createElement('iframe'); document.body.append(frame); frames.push(frame)
  const owner = frame.contentDocument!; observer(owner); await visibility(owner, 'hidden')
  owner.body.append(owner.adoptNode(host)); await draw(message(), owner)
  await act(async () => finish({ dataUrl: png })); await reveal(owner)
  expect(host.querySelector('img')).toBeNull(); expect(transport.exact).toHaveBeenCalledTimes(1)
  await visibility(document, 'hidden'); await visibility(owner, 'visible'); await reveal(owner)
  expect(transport.exact).toHaveBeenCalledTimes(2); expect(host.querySelector('img')?.ownerDocument).toBe(owner)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
