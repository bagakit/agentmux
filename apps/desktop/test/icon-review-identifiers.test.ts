// @vitest-environment happy-dom
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { Window } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'vite'
import { isObjectId } from '@agentmux/identity'
import { iconReviewConfig } from '../scripts/icon-review/dev.mjs'

const key = 'agentmux.icon-review.v1'
const legacy = { event_id: '7c1a7e94-c8a0-4535-8d72-e3f143ca438d', at: new Date(0).toISOString(), action: 'retained-original', payload: { original: true } }
const imported = { event_id: '3a1830d3-aee1-441c-bcfa-0f6976024277', at: new Date(1).toISOString(), action: 'retained-import' }
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); vi.unstubAllGlobals() })
type History = { event_id: string; at: string; action: string; [key: string]: unknown }
type Review = { ready: boolean; buildPacket(): { history: History[]; edits: unknown[]; source_snapshot: string; generated_at: string }; exportTheme(): string }
function review(win: any): Review { return win.iconReview }
function documentFor(html: string, document: any) {
  const parsed = new DOMParser().parseFromString(html.replace(/<link[^>]*>|<script[^>]*><\/script>/g, ''), 'text/html')
  parsed.querySelectorAll('link,script').forEach(node => node.remove()); document.documentElement.innerHTML = parsed.documentElement.innerHTML
}
function edit(win: any, value: string) {
  const field = win.document.querySelector('[name="note"]') as HTMLTextAreaElement
  expect(field, 'The actual inspector edit field must exist').not.toBeNull(); field.value = value; field.dispatchEvent(new win.Event('input', { bubbles: true }))
}
async function fileImport(win: any, text: string) {
  const input = win.document.getElementById('import-file'), file = new win.File([text], 'original-review.json', { type: 'application/json' })
  if (!file.text) Object.defineProperty(file, 'text', { value: async () => text })
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  const before = review(win).buildPacket().history.length; input.dispatchEvent(new win.Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(review(win).buildPacket().history.length).toBeGreaterThan(before))
}
async function bootPublished(raw?: string) {
  const directory = process.env.AGENTMUX_ICON_ID_SITE
  if (!directory) throw Error('The real production build is required for icon history consumption')
  const [html, app, catalogText, manifest] = await Promise.all(['index.html', 'app.js', 'catalog.json', 'review-manifest.json'].map(name => readFile(join(directory, name), 'utf8')))
  const win = new Window({ url: 'http://localhost/' }), catalog = JSON.parse(catalogText)
  documentFor(html, win.document)
  const stored = raw ?? JSON.stringify({ schema: key, pageId: catalog.pageId, snapshot: 'retained-source-snapshot', edits: {}, history: [legacy], unresolved: [], preview: { themeId: 'graphite', mode: 'light' } })
  win.localStorage.setItem(key, stored)
  const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  win.matchMedia = media as any
  const context = createContext({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, console, crypto, structuredClone,
    matchMedia: media, getComputedStyle: win.getComputedStyle.bind(win), setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, performance,
    TextEncoder, TextDecoder, URL, URLSearchParams, Blob, Event: win.Event, CustomEvent: win.CustomEvent, HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node,
    MutationObserver: win.MutationObserver, requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    fetch: async (url: string) => new Response(url.endsWith('catalog.json') ? catalogText : manifest, { status: 200 }) })
  expect(new Script('typeof process').runInContext(context)).toBe('undefined')
  new Script(app, { filename: 'published-icon-review.js' }).runInContext(context)
  clean.push(async () => { win.dispatchEvent(new win.Event('pagehide')); await win.happyDOM.close() })
  await vi.waitFor(() => expect(review(win)?.ready, win.document.getElementById('inventory-content')?.textContent).toBe(true))
  return win
}

it('the published tool creates shared IDs for all six actual history actions and retains imported and reloaded original history and live event time', async () => {
  const began = Date.now(), win = await bootPublished()
  expect(review(win).buildPacket().history[0]).toEqual(legacy)
  edit(win, 'Original manual review')
  win.document.getElementById('restore-role').click()
  edit(win, 'Retained manual review')
  await fileImport(win, review(win).exportTheme())
  const packet = review(win).buildPacket()
  await fileImport(win, JSON.stringify({ ...packet, edits: [], history: [legacy, imported] }))
  expect(review(win).buildPacket().history.filter(event => event.event_id === legacy.event_id)).toEqual([legacy])
  expect(review(win).buildPacket().history.find(event => event.event_id === imported.event_id)).toEqual(imported)
  win.document.getElementById('draft-summary').click(); win.document.getElementById('reset-all').click(); win.document.getElementById('confirm-reset').click()
  const final = review(win).buildPacket(), fresh = final.history.filter(event => ![legacy.event_id, imported.event_id].includes(event.event_id))
  expect(new Set(fresh.map(event => event.action))).toEqual(new Set(['source-refresh', 'edit', 'restore', 'import-theme', 'import', 'restore-all']))
  for (const event of fresh) { expect(isObjectId(event.event_id), 'New history ' + event.action + ' must use shared object IDs').toBe(true); expect(Date.parse(event.at)).toBeGreaterThanOrEqual(began); expect(Date.parse(event.at)).toBeLessThanOrEqual(Date.now()) }
  expect(new Set(final.history.map(event => event.event_id)).size).toBe(final.history.length)
  expect(final.edits).toEqual([])
  const reloaded = await bootPublished(win.localStorage.getItem(key)!)
  expect(review(reloaded).buildPacket().history).toEqual(final.history)
  expect(review(reloaded).buildPacket().generated_at).toBe(final.generated_at)
}, 20000)

it('the real Vite development module resolves the shared component and creates an actual editable history event', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'icon-id-dev-')), server = await createServer({ ...iconReviewConfig({ port: 0 }), cacheDir })
  clean.push(async () => { await server.close(); await rm(cacheDir, { recursive: true, force: true }) })
  await server.listen(); const origin = server.resolvedUrls!.local[0]!, nativeFetch = globalThis.fetch
  const html = await nativeFetch(origin).then(response => response.text())
  documentFor(html, document); localStorage.removeItem(key); (window as any).iconReview = undefined
  const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('matchMedia', media); window.matchMedia = media as any
  vi.stubGlobal('fetch', (url: string) => nativeFetch(new URL(url, origin)))
  const transformed = await server.transformRequest('/app.js')
  expect(transformed?.code).toContain('mintObjectId')
  expect(transformed?.code).toContain('identity')
  await server.ssrLoadModule(resolve('apps/desktop/scripts/icon-review/app.js'))
  await vi.waitFor(() => expect(review(window)?.ready, document.getElementById('inventory-content')?.textContent).toBe(true), { timeout: 10000 })
  edit(window, 'Live development review')
  const event = review(window).buildPacket().history.at(-1)!
  expect(event.action).toBe('edit'); expect(isObjectId(event.event_id)).toBe(true)
}, 20000)
