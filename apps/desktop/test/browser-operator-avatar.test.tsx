// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentProviderIcon } from '@agentmux/client-ui/components/AgentProviderIcon'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const testDirectory = dirname(fileURLToPath(import.meta.url))
const avatarCss = readFileSync(resolve(testDirectory, '../src/renderer/src/styles/agent-avatar.css'), 'utf8')
const sharedAvatarCss = readFileSync(resolve(testDirectory, '../../../packages/client-ui/src/styles/agent-avatar-face.css'), 'utf8')
const baseCss = readFileSync(resolve(testDirectory, '../src/renderer/src/styles/base.css'), 'utf8')
import { GRAPHITE_THEME } from '../../../packages/client-ui/src/theme/catalog'
import { updateIconSprite, removeIconSprite } from '../../../packages/client-ui/src/theme/icon-sprite'
import { ResolvedAgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { browserOperatorAvatarKey, prepareBrowserOperatorAvatar, readBrowserOperatorAvatar,
  type BrowserOperatorAvatarInput } from '../src/renderer/src/lib/browser-operator-avatar'

const colors = { mark: '#8b949e', enamel: '#101216', badge: '#f1f2f3', badgeBackground: '#24272b' }
const svgSources: string[] = [], imageSources: string[] = []
let png: string, decode: (image: HTMLImageElement) => Promise<void>
function encodedPng(width = 64, height = 64, byteLength = 48) {
  const bytes = new Uint8Array(byteLength)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); const view = new DataView(bytes.buffer)
  view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12); view.setUint32(16, width); view.setUint32(20, height)
  return 'data:image/png;base64,' + btoa(String.fromCharCode(...bytes))
}
function input(overrides: Partial<BrowserOperatorAvatarInput> = {}): BrowserOperatorAvatarInput {
  return { document, providerId: 'codex', colors, ...overrides }
}
function xml(source: string): Document { return new DOMParser().parseFromString(source, 'image/svg+xml') }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const style = document.createElement('style'); style.dataset.avatarProof = ''; style.textContent = baseCss + sharedAvatarCss + avatarCss; document.head.append(style)
  updateIconSprite(document, GRAPHITE_THEME, GRAPHITE_THEME.variants.dark.colors.text)
  png = encodedPng(); svgSources.length = 0; imageSources.length = 0
  decode = async () => {}
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function () {
    imageSources.push(this.src)
    if (this.src.startsWith('data:image/svg+xml,')) svgSources.push(decodeURIComponent(this.src.split(',').slice(1).join(',')))
    Object.defineProperties(this, { naturalWidth: { configurable: true, value: 64 }, naturalHeight: { configurable: true, value: 64 } })
    return decode(this)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function () {
    expect(this.width).toBe(64); expect(this.height).toBe(64)
    return png
  })
})
afterEach(() => { document.querySelectorAll('style[data-avatar-proof]').forEach(node => node.remove()); removeIconSprite(document); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('projects the mounted resolved SVG face with the same Provider paths, badge and enamel definition', async () => {
  const appearance = { tint: '#69b787', badge: 'shield' as const }, face = input({ appearance })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  try {
    await act(async () => root.render(<ResolvedAgentAvatar label="Original Agent" providerId="codex" appearance={appearance} />))
    const result = await prepareBrowserOperatorAvatar(face)
    expect(result.status).toBe('ready'); expect(svgSources).toHaveLength(1)
    const svg = xml(svgSources[0]!)
    const paths = [...host.querySelectorAll('.agent-provider-icon path')].map(node => node.getAttribute('d'))
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) expect([...svg.querySelectorAll('path')].some(node => node.getAttribute('d') === path)).toBe(true)
    const filters = [...svg.querySelectorAll('feMorphology')].map(node => [node.getAttribute('operator'), node.getAttribute('radius')])
    expect(filters).toEqual([...host.querySelectorAll('feMorphology')].map(node => [node.getAttribute('operator'), node.getAttribute('radius')]))
    expect(svg.querySelector('[data-avatar-badge="shield"] path')).not.toBeNull()
    const badge = host.querySelector<HTMLElement>('.agent-avatar__badge')!
    const circle = svg.querySelector('circle')!
    const badgeStyle = getComputedStyle(badge)
    const width = parseFloat(badgeStyle.width), inset = parseFloat(badgeStyle.getPropertyValue('--mark-inset'))
    expect(width).toBeGreaterThan(0)
    expect(Number(circle.getAttribute('r')) * 2 + Number(circle.getAttribute('stroke-width'))).toBe(width)
    expect(Number(circle.getAttribute('cx'))).toBe(18 - inset - width / 2)
    expect(Number(circle.getAttribute('cy'))).toBe(inset + width / 2)
    expect(svg.querySelector('g[filter="url(#browser-avatar-enamel)"]')).not.toBeNull()
    expect(svg.querySelector('feFlood[result="rimColor"]')?.getAttribute('flood-color')).toBe(appearance.tint)
    expect(svg.querySelector('feFlood[result="backingColor"]')?.getAttribute('flood-color')).toBe(colors.enamel)
    expect(svg.querySelector('use,foreignObject,script,img,span')).toBeNull()
    expect(host.querySelector('.agent-avatar__status')).toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})

it('inlines only the original bundled PNG selected by the same Provider artwork', async () => {
  const face = input({ providerId: 'gemini', colors: { ...colors, mark: '#86aacc' } })
  const markup = new DOMParser().parseFromString(renderToStaticMarkup(<AgentProviderIcon providerId="gemini" />), 'text/html')
  const original = markup.querySelector('img')?.getAttribute('src')
  expect(original).toBeTruthy(); expect(readBrowserOperatorAvatar(face)).toBeUndefined()
  const result = await prepareBrowserOperatorAvatar(face)
  expect(result).toMatchObject({ status: 'ready', avatar: { width: 64, height: 64, byteLength: 48 } })
  expect(imageSources).toHaveLength(2); expect(imageSources[0]).toContain(original!)
  expect(xml(svgSources[0]!).querySelector('image')?.getAttribute('href')).toBe(png)
  expect(readBrowserOperatorAvatar(face)).toBe(result.status === 'ready' ? result.avatar : null)
})

it('returns immediately with one shared inflight generation and publishes ready only after decoding', async () => {
  let finish!: () => void
  decode = () => new Promise<void>(resolve => { finish = resolve })
  const face = input({ colors: { ...colors, mark: '#8b94ab' } })
  expect(readBrowserOperatorAvatar(face)).toBeUndefined(); expect(imageSources).toEqual([])
  const first = prepareBrowserOperatorAvatar(face), second = prepareBrowserOperatorAvatar(face)
  expect(second).toBe(first); expect(readBrowserOperatorAvatar(face)).toBeUndefined()
  await vi.waitFor(() => expect(imageSources).toHaveLength(1))
  expect(readBrowserOperatorAvatar(face)).toBeUndefined()
  finish(); const ready = await first
  expect(ready.status).toBe('ready'); expect(readBrowserOperatorAvatar(face)).toBe(ready.status === 'ready' ? ready.avatar : null)
  await prepareBrowserOperatorAvatar(face); expect(imageSources).toHaveLength(1)
})

it('keeps the frozen theme artwork and keys new badge, tint, palette and semantic geometry separately', async () => {
  const original = input({ appearance: { badge: 'spark', tint: '#123456' }, colors: { ...colors, mark: '#778899' } })
  const key = browserOperatorAvatarKey(original)
  expect(browserOperatorAvatarKey(input({ ...original, appearance: { ...original.appearance, tint: '#abcdef' } }))).not.toBe(key)
  expect(browserOperatorAvatarKey(input({ ...original, colors: { ...original.colors, mark: '#112233' } }))).not.toBe(key)
  const work = prepareBrowserOperatorAvatar(original)
  updateIconSprite(document, { ...GRAPHITE_THEME, icons: { 'avatar.badge-spark': { kind: 'paths', paths: [{ d: 'M2 2h20v20H2Z', fill: 'none' }] } } }, '#112233')
  expect(browserOperatorAvatarKey(original)).not.toBe(key)
  expect(await work).toMatchObject({ status: 'ready' })
  expect(xml(svgSources[0]!).querySelector('path[d="M2 2h20v20H2Z"]')).toBeNull()
  expect(readBrowserOperatorAvatar(original)).toBeUndefined()
  expect(await prepareBrowserOperatorAvatar(original)).toMatchObject({ status: 'ready' })
  expect(xml(svgSources[1]!).querySelector('path[d="M2 2h20v20H2Z"]')).not.toBeNull()
})

it('keeps unknown providers on the real themed Agent fallback rather than another Provider', async () => {
  const face = input({ providerId: 'custom-provider', colors: { ...colors, mark: '#445566' } })
  expect(await prepareBrowserOperatorAvatar(face)).toMatchObject({ status: 'ready' })
  expect(xml(svgSources[0]!).querySelector('[data-semantic-icon="object.agent"] path')).not.toBeNull()
  expect(imageSources).toHaveLength(1)
})

it('reports a resource failure without caching a fake image and allows the same presentation to retry', async () => {
  const face = input({ providerId: 'gemini', colors: { ...colors, mark: '#8899aa' } })
  decode = async () => { throw new Error('Original packaged image unavailable') }
  expect(await prepareBrowserOperatorAvatar(face)).toMatchObject({ status: 'failed', message: expect.stringContaining('name remains visible') })
  expect(readBrowserOperatorAvatar(face)).toBeUndefined()
  decode = async () => {}
  expect(await prepareBrowserOperatorAvatar(face)).toMatchObject({ status: 'ready' })
})

it.each([{ width: 32, bytes: 48 }, { width: 64, bytes: 65_537 }])('rejects actual encoded geometry or bytes outside the PNG projection', async ({ width, bytes }) => {
  const face = input({ colors: { ...colors, mark: `#${width.toString(16).padStart(2, '0')}aabb` } })
  png = encodedPng(width, 64, bytes)
  expect(await prepareBrowserOperatorAvatar(face)).toMatchObject({ status: 'failed' })
  expect(readBrowserOperatorAvatar(face)).toBeUndefined()
})

it('bounds a stalled decode and retains a name fallback without an automatic retry', async () => {
  vi.useFakeTimers()
  try {
    const face = input({ colors: { ...colors, mark: '#223344' } })
    decode = () => new Promise<void>(() => {})
    const work = prepareBrowserOperatorAvatar(face)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(await work).toMatchObject({ status: 'failed' })
    expect(readBrowserOperatorAvatar(face)).toBeUndefined()
    const attempted = imageSources.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(imageSources).toHaveLength(attempted)
  } finally { vi.useRealTimers() }
})

it('does not borrow another document or substitute a default when its original artwork is unavailable', async () => {
  const live = input({ colors: { ...colors, mark: '#445577' } })
  expect(await prepareBrowserOperatorAvatar(live)).toMatchObject({ status: 'ready' })
  const closed = input({ ...live, document: document.implementation.createHTMLDocument('Detached original') })
  expect(readBrowserOperatorAvatar(closed)).toBeUndefined()
  expect(await prepareBrowserOperatorAvatar(closed)).toMatchObject({ status: 'failed' })
  const missing = input({ ...live, appearance: { badge: 'flame' } })
  document.getElementById('agentmux-icon-avatar.badge-flame')!.remove()
  expect(await prepareBrowserOperatorAvatar(missing)).toMatchObject({ status: 'failed' })
  expect(readBrowserOperatorAvatar(missing)).toBeUndefined()
  expect(readBrowserOperatorAvatar(live)).toBeDefined()
})
