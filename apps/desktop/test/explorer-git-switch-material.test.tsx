const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/hooks/useWorkspaceBranches', () => ({ useWorkspaceBranches: () => ({ snapshot: null, loading: false, error: null, refresh: async () => true }) }))
vi.mock('../src/renderer/src/hooks/useGitStatus', () => ({ useGitStatus: () => ({ status: null, loading: false, error: null, refresh: async () => true }) }))
vi.mock('../src/renderer/src/hooks/useGitAheadBehind', () => ({ useGitAheadBehind: () => ({ facts: null }) }))
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const workspace = { id: 'one', name: 'Project', hostId: 'local', path: _hygiene_fixturePath("repo"), branch: 'main', kind: 'folder' as const }
const changes = new Set<EventListenerOrEventListenerObject>()
let reduced = false
const animations = vi.fn(() => ({ cancel: vi.fn() }))
const nav = () => dom.container.querySelector<HTMLElement>('.source-control-switch')!
const lens = () => nav().querySelector<HTMLElement>('[data-liquid-selection]')!
const tabs = () => [...nav().querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const selected = () => tabs().find(button => button.getAttribute('aria-selected') === 'true')!
const key = async (button: HTMLElement, name: string) => act(async () => {
  button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: name }))
})
beforeEach(() => {
  reduced = false; changes.clear(); animations.mockClear()
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, activeWorkspaceId: workspace.id,
    workspaceTool: 'files-branches', projectRailOpen: true, explorerCollapsed: { one: true }, sessions: [], tabs: {}, layouts: {} })
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const media = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation(query => query !== '(prefers-reduced-motion: reduce)' ? media(query) : {
    get matches() { return reduced }, media: query, onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => { if (listener) changes.add(listener) },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => { if (listener) changes.delete(listener) },
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true
  } as MediaQueryList)
  // Layout is supplied by the browser in Native; the mounted boundary uses known tab rectangles.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const index = ['branches', 'changes', 'history'].indexOf(this.getAttribute('data-git-view') ?? '')
    return new DOMRect(index < 0 ? 0 : index * 100, 0, index < 0 ? 300 : 100, 28)
  })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function () { return [this.getBoundingClientRect()] as unknown as DOMRectList })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(28)
  if (!HTMLElement.prototype.animate) Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: () => ({ cancel() {} }) })
  vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(animations as unknown as HTMLElement['animate'])
})

describe('actual Explorer Git switch material', () => {
  it('connects one Settings lens to the three original buttons and keeps keyboard selection and focus', async () => {
    await dom.render(<SurfaceToolDock workspace={workspace} />)
    expect(nav()).not.toBeNull()
    expect(tabs().map(button => button.textContent)).toEqual(['Branches', 'Changes', 'History'])
    expect(tabs().map(button => button.dataset.gitView)).toEqual(['branches', 'changes', 'history'])
    expect(nav().querySelectorAll('[data-liquid-selection]')).toHaveLength(1)
    const surface = lens()
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    expect(surface.hidden).toBe(false)
    expect(surface.dataset.liquidSelection).toBe('branches')
    for (const [name, view] of [['ArrowRight', 'changes'], ['End', 'history'], ['Home', 'branches']] as const) {
      await key(selected(), name)
      expect(selected().dataset.gitView).toBe(view)
      expect(document.activeElement).toBe(selected())
      expect(selected().tabIndex).toBe(0)
      expect(lens()).toBe(surface)
      expect(surface.dataset.liquidSelection).toBe(view)
    }
    expect(animations).toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Keep my draft')
  })

  it('pauses decoration when the actual dock is hidden or motion is reduced and restores the original selection', async () => {
    await dom.render(<SurfaceToolDock workspace={workspace} />)
    await key(selected(), 'End')
    await dom.render(<SurfaceToolDock workspace={workspace} visible={false} />)
    expect(lens().hidden).toBe(true)
    expect(lens().dataset.liquidPaused).toBe('true')
    expect(lens().dataset.liquidSelection).toBe('history')
    await dom.render(<SurfaceToolDock workspace={workspace} visible />)
    expect(lens().hidden).toBe(false)
    animations.mockClear()
    await act(async () => {
      reduced = true
      for (const listener of changes) typeof listener === 'function' ? listener(new Event('change')) : listener.handleEvent(new Event('change'))
    })
    await key(selected(), 'Home')
    expect(lens().dataset.liquidSelection).toBe('branches')
    expect(lens().dataset.liquidPaused).toBe('true')
    expect(animations).not.toHaveBeenCalled()
  })

  it('connects the compact material, transparent selected foreground and system contrast alternatives', async () => {
    await dom.render(<SurfaceToolDock workspace={workspace} />)
    const css = readFileSync(resolve('apps/desktop/src/renderer/src/styles/source-control.css'), 'utf8')
    const sheet = new CSSStyleSheet(); sheet.replaceSync(css)
    expect(sheet.cssRules.length).toBeGreaterThan(20)
    const rule = (selector: string) => [...sheet.cssRules].find(item => item instanceof CSSStyleRule && item.selectorText === selector) as CSSStyleRule
    expect(rule(`.${nav().className}`)).toBeDefined()
    expect(rule('.source-control-switch').style.getPropertyValue('backdrop-filter')).toContain('var(--material-control-blur)')
    expect(rule('.source-control-switch').style.getPropertyValue('padding')).toBe('var(--sp-1)')
    expect(rule('.source-control-switch button').style.height).toBe('24px')
    expect(rule('.source-control-switch button').style.fontSize).toBe('var(--fs-meta)')
    expect(rule('.source-control-switch button.selected').style.background).toBe('transparent')
    expect(css).toContain('@media (forced-colors: active)')
    expect(css).toContain('HighlightText')
    expect(css).toContain('prefers-reduced-transparency: reduce')
    expect(css).toContain('prefers-contrast: more')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toMatch(/:focus-visible[^}]+outline/s)
  })
})
