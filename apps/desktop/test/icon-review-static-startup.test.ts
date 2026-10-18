// @vitest-environment happy-dom
import {execFileSync} from 'node:child_process'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {createContext, Script} from 'node:vm'
import {expect, it, vi} from 'vitest'

it('starts the real published icon workbench bundle without Node globals', async () => {
  const out = await mkdtemp(join(tmpdir(), 'agentmux-icon-static-startup-'))
  try {
    execFileSync(process.execPath, ['apps/desktop/scripts/icon-review/build.mjs', '--out', out], {cwd: resolve('.'), stdio: 'pipe'})
    const html = await readFile(join(out, 'index.html'), 'utf8')
    const app = await readFile(join(out, 'app.js'), 'utf8')
    const catalog = await readFile(join(out, 'catalog.json'), 'utf8')
    const manifest = await readFile(join(out, 'review-manifest.json'), 'utf8')
    const page = new DOMParser().parseFromString(html.replace(/<link[^>]*>|<script[^>]*><\/script>/g, ''), 'text/html')
    page.querySelectorAll('link,script').forEach(node => node.remove())
    document.documentElement.innerHTML = page.documentElement.innerHTML
    const media = () => ({matches: false, addEventListener() {}, removeEventListener() {}})
    const originalMedia = window.matchMedia
    window.matchMedia = media as typeof window.matchMedia
    const context = createContext({window, document, navigator, localStorage, console, crypto, structuredClone,
      matchMedia: media, getComputedStyle: window.getComputedStyle.bind(window),
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, performance,
      TextEncoder, TextDecoder, URL, URLSearchParams, Event, CustomEvent, HTMLElement, Element, Node, MutationObserver,
      IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
      requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      fetch: async (url: string) => new Response(url.endsWith('catalog.json') ? catalog : manifest, {status: 200})})
    try {
      expect(new Script('typeof process').runInContext(context)).toBe('undefined')
      let startupError: unknown
      try { new Script(app, {filename: 'published-icon-review.js'}).runInContext(context) }
      catch (error) { startupError = error }
      expect(startupError, 'The actual browser entry must execute without Node globals').toBeUndefined()
      const review = () => (window as unknown as {iconReview?: {ready: boolean; buildPacket(): {summary: {total_roles: number}}}}).iconReview
      await vi.waitFor(() => expect(review()?.ready, `Published page: ${document.getElementById('inventory-content')!.textContent}`).toBe(true))
      expect(JSON.parse(catalog).roles.length).toBeGreaterThan(0)
      expect(document.querySelectorAll('[data-glyph]').length).toBeGreaterThan(0)
      document.getElementById('view-motion')!.click()
      expect(document.querySelectorAll('[data-motion-glyph]').length).toBe(JSON.parse(catalog).customGlyphs.length)
      expect(document.querySelectorAll('[data-motion-glyph]').length).toBeGreaterThan(0)
      document.getElementById('view-mote')!.click()
      await vi.waitFor(() => expect(document.querySelector('#mote-preview .mote-companion__rig')).not.toBeNull())
      document.getElementById('view-future')!.click()
      expect(document.querySelector('#mote-preview')).toBeNull()
      expect(document.querySelectorAll('[data-future-glyph]')).toHaveLength(7)
      expect(await readFile(join(out, 'mote-identity.css'), 'utf8')).toContain('.mote-companion__gaze')
    } finally { window.matchMedia = originalMedia }
  } finally { await rm(out, {recursive: true, force: true}) }
}, 30000)
