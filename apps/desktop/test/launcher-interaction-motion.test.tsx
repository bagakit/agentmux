// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-warm-view /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { allStyleRules } from './helpers/styles'

const dom = composerDOM()
const launcherBefore = useLauncherState.getState()
const motionRules = [...allStyleRules().matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => {
    const name = /animation:\s*([\w-]+)/.exec(match[2]!)?.[1]
    return /\.(?:launcher-environment__panel|launch-refine__panel)\[data-state=/.test(match[1]!) && Boolean(name) && name !== 'none'
  })
const token = /--dur-enter:\s*([\d.]+(?:ms|s))/.exec(allStyleRules())?.[1]
const mediaListeners = new Set<EventListenerOrEventListenerObject>()
let reduced = false, style: HTMLStyleElement

beforeEach(() => {
  reduced = false
  mediaListeners.clear()
  useLauncherState.setState({ sections: {}, drafts: { 'region:region': { browser: 'kept browser', note: 'kept note' } }, executors: {}, persistenceIssue: null })
  // happy-dom does not expand animation shorthand. Derive supported longhands from the actual
  // product rules so the original Radix Presence still owns retention/completion; no native frames
  // are claimed here. Native Renderer qualification separately proves real timing and pixels.
  style = document.createElement('style')
  style.textContent = motionRules.map(match => {
    const name = /animation:\s*([\w-]+)/.exec(match[2]!)?.[1]
    return `${match[1]} { animation-name: ${name}; animation-duration: ${token}; }`
  }).join('\n')
  document.head.append(style)
  const originalMedia = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation(query => query === '(prefers-reduced-motion: reduce)' ? {
    get matches() { return reduced }, media: query, onchange: null,
    addEventListener: (_type, listener) => { if (listener) mediaListeners.add(listener) },
    removeEventListener: (_type, listener) => { if (listener) mediaListeners.delete(listener) },
    addListener() {}, removeListener() {}, dispatchEvent: () => true
  } as MediaQueryList : originalMedia(query))
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('agent-picks')) return new DOMRect(0, 0, 300, 40)
    if (this.hasAttribute('data-executor-id')) return new DOMRect(this.dataset.executorId === 'codex' ? 0 : 140, 0, 120, 32)
    if (this.classList.contains('liquid-selection')) {
      const x = Number(/translate3d\(([\d.]+)/.exec(this.style.transform)?.[1] ?? 0)
      return new DOMRect(x, 0, 120, 32)
    }
    return originalRect.call(this)
  })
  const originalRects = HTMLElement.prototype.getClientRects
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    if (this.closest('.agent-picks') && !this.hidden) return [this.getBoundingClientRect()] as unknown as DOMRectList
    return originalRects.call(this)
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('agent-picks') ? 40 : 0 })
  vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(() => ({ cancel: vi.fn() }) as unknown as Animation)
})
afterEach(async () => { style.remove(); await act(async () => useLauncherState.setState(launcherBefore, true)) })

async function render(visible = true, active = true) {
  await dom.render(<WorkbenchPresentationContext value={{ active, retainedRegionId: active ? null : 'region' }}>
    <NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={visible} />
  </WorkbenchPresentationContext>)
}
async function mount() {
  const session = { ...composerSession('warm-shell'), kind: 'terminal' as const, providerId: null,
    control: { kind: 'terminal' as const, hostId: 'local', runId: 'same-warm-run', run: { runId: 'same-warm-run' } } }
  useAppStore.setState({ config: { ...composerConfig, executors: { ...composerConfig.executors,
    review: { ...composerConfig.executors.codex!, label: 'Review Agent' } } },
    activeWorkspaceId: 'workspace', tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    agentComposerDrafts: { region: '完整请求\nkeep the second line' }, launcherNameDrafts: { region: { agentName: 'Keep name', tabName: 'Keep tab' } },
    executorDetections: {}, providerCatalog: [], hostChecks: {}, recoveryCandidates: [],
    prewarmTerminal: vi.fn(), detectExecutors: vi.fn().mockResolvedValue(undefined),
    warmTerminal: { key: warmTerminalKey('local', '/repo'), ownerLauncherId: 'region:region', session, ready: Promise.resolve(session) } })
  await render()
}
async function clickPortal(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}
async function finish(panel: HTMLElement, name = 'launcher-panel-out') {
  await act(async () => panel.dispatchEvent(new AnimationEvent('animationend', { bubbles: true, animationName: name })))
}
async function reduce(value: boolean) {
  await act(async () => {
    reduced = value
    for (const listener of [...mediaListeners]) {
      const event = new Event('change')
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
  })
}
const lens = () => dom.container.querySelector<HTMLElement>('.agent-picks [data-liquid-selection]')!

describe('the original mounted Launcher interaction and motion owners', () => {
  it('derives nonempty Presence motion and duration from the actual imported product stylesheet', () => {
    expect(motionRules).toHaveLength(2)
    expect(token).toBe('120ms')
    expect(style.textContent).toContain('animation-name: launcher-panel-in')
    expect(style.textContent).toContain('animation-name: launcher-panel-out')
  })

  it('native Agent buttons immediately select through the original owner and retain one shared lens and input', async () => {
    await mount()
    expect(lens()).toBeNull()
    await dom.click('[aria-label="Expand Agents"]')
    const surface = lens(), input = dom.container.querySelector('[aria-label="Agent prompt"]')
    const buttons = [...dom.container.querySelectorAll<HTMLButtonElement>('.agent-picks > button[data-executor-id]')]
    expect(buttons.map(button => button.dataset.executorId)).toEqual(['codex', 'review'])
    expect(surface).not.toBeNull()
    expect(surface.hidden).toBe(false)
    expect(surface.getAttribute('aria-hidden')).toBe('true')
    expect(surface.dataset.liquidSelection).toBe('codex')
    await dom.hover('button[data-executor-id="review"]')
    expect(useLauncherState.getState().executors.workspace).toBeUndefined()
    await act(async () => { buttons[1]!.focus(); buttons[1]!.click() })
    expect(document.activeElement).toBe(buttons[1])
    expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    expect(buttons[1]!.querySelector('.agent-pick__check')).not.toBeNull()
    expect(useLauncherState.getState().executors.workspace).toBe('review')
    expect(lens()).toBe(surface)
    expect(surface.dataset.liquidSelection).toBe('review')
    expect(dom.container.querySelector('[aria-label="Agent prompt"]')).toBe(input)
    expect(dom.draft('region')).toBe('完整请求\nkeep the second line')
    await dom.click('[aria-label="Collapse Agents"]')
    expect(lens()).toBeNull()
    expect(dom.container.querySelector('[aria-label="Expand Agents"]')?.textContent).toContain('Review Agent')
  })

  it('Host exits become inert immediately, return focus once, and release on actual Radix completion without stealing the next input', async () => {
    await mount()
    await dom.click('[aria-label="Expand Agents"]')
    await dom.click('[aria-label="Runtime environment"]')
    const panel = document.querySelector<HTMLElement>('.launcher-environment__panel')!
    expect(panel.dataset.state).toBe('open')
    expect(panel.hasAttribute('inert')).toBe(false)
    await clickPortal('[aria-label="Close runtime environment"]')
    expect(panel.isConnected).toBe(true)
    expect(panel.dataset.state).toBe('closed')
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(dom.container.querySelector('[aria-label="Runtime environment"]'))
    const input = dom.container.querySelector<HTMLElement>('.tiptap')!
    await act(async () => input.focus())
    await finish(panel)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(panel.isConnected).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(useAppStore.getState().warmTerminal?.session?.control.run.runId).toBe('same-warm-run')
  })

  it('Options rapid reopening ignores an old exit and its original name draft and current focus stay intact', async () => {
    await mount()
    await dom.click('[aria-label="Expand Agents"]')
    await dom.click('[aria-label="Launch options"]')
    const panel = document.querySelector<HTMLElement>('.launch-refine__panel')!
    const name = panel.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!
    expect(name.value).toBe('Keep name')
    await clickPortal('[aria-label="Close launch options"]')
    expect(panel.hasAttribute('inert')).toBe(true)
    await dom.click('[aria-label="Launch options"]')
    expect(document.querySelector('.launch-refine__panel')).toBe(panel)
    expect(panel.dataset.state).toBe('open')
    expect(panel.hasAttribute('inert')).toBe(false)
    await finish(panel)
    expect(panel.isConnected).toBe(true)
    expect(panel.querySelector('[aria-label="Agent name"]')).toBe(name)
    expect(name.value).toBe('Keep name')
    expect(useAppStore.getState().launcherNameDrafts.region).toEqual({ agentName: 'Keep name', tabName: 'Keep tab' })
  })

  it.each([{ visible: false, active: true }, { visible: true, active: false }])('retained presentations stop the shared lens and release Portals without clearing facts: $visible/$active', async ({ visible, active }) => {
    await mount()
    await dom.click('[aria-label="Expand Agents"]')
    await dom.click('[aria-label="Launch options"]')
    expect(document.querySelector('.launch-refine__panel')).not.toBeNull()
    await render(visible, active)
    expect(lens().hidden).toBe(true)
    expect(lens().dataset.liquidPaused).toBe('true')
    expect(dom.container.querySelector('.launch-surface')?.getAttribute('data-motion-active')).toBe('false')
    expect(document.querySelector('.launch-refine__panel')).toBeNull()
    await render()
    expect(document.querySelector('.launch-refine__panel')).toBeNull()
    await dom.click('[aria-label="Runtime environment"]')
    await render(visible, active)
    expect(document.querySelector('.launcher-environment__panel')).toBeNull()
    expect(useLauncherState.getState().drafts['region:region']).toEqual({ browser: 'kept browser', note: 'kept note' })
    expect(dom.draft('region')).toBe('完整请求\nkeep the second line')
    expect(useAppStore.getState().warmTerminal?.session?.control.run.runId).toBe('same-warm-run')
  })

  it('document visibility releases an exiting Portal and stops decoration while keeping the original work surface', async () => {
    await mount()
    await dom.click('[aria-label="Expand Agents"]')
    await dom.click('[aria-label="Runtime environment"]')
    await clickPortal('[aria-label="Close runtime environment"]')
    expect(document.querySelector('.launcher-environment__panel')).not.toBeNull()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(document.querySelector('.launcher-environment__panel')).toBeNull()
    expect(lens().dataset.liquidPaused).toBe('true')
    expect(dom.container.querySelector('[data-original-warm-view]')).not.toBeNull()
    hidden.mockReturnValue(false)
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(lens().hidden).toBe(false)
    expect(useAppStore.getState().warmTerminal?.session?.control.run.runId).toBe('same-warm-run')
  })

  it.each(['120ms', '.12s'])('Browser saves collapse now and releases its visual exit at the real token duration: %s', async duration => {
    await mount()
    await dom.click('[aria-label="Expand Browser"]')
    dom.container.querySelector<HTMLElement>('.launcher-browser')!.style.setProperty('--dur-enter', duration)
    vi.useFakeTimers()
    try {
      await dom.click('[aria-label="Collapse Browser"]')
      expect(useLauncherState.getState().sections.workspace!.browser).toBe('collapsed')
      expect(dom.container.querySelector('.launcher-browser')?.getAttribute('data-closing')).toBe('true')
      expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Browser address or search"]')?.disabled).toBe(true)
      await act(async () => { vi.advanceTimersByTime(119) })
      expect(dom.container.querySelector('[aria-label="Browser address or search"]')).not.toBeNull()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(dom.container.querySelector('[aria-label="Browser address or search"]')).toBeNull()
      expect(useLauncherState.getState().drafts['region:region']!.browser).toBe('kept browser')
    } finally { vi.useRealTimers() }
  })

  it('a newly reduced or hidden Browser exit releases immediately, preserving its durable preference and all drafts', async () => {
    await mount()
    await dom.click('[aria-label="Expand Browser"]')
    dom.container.querySelector<HTMLElement>('.launcher-browser')!.style.setProperty('--dur-enter', '120ms')
    await dom.click('[aria-label="Collapse Browser"]')
    expect(dom.container.querySelector('.launcher-browser')?.getAttribute('data-closing')).toBe('true')
    await reduce(true)
    expect(dom.container.querySelector('[aria-label="Browser address or search"]')).toBeNull()
    await dom.click('[aria-label="Expand Browser"]')
    await dom.click('[aria-label="Collapse Browser"]')
    expect(dom.container.querySelector('[aria-label="Browser address or search"]')).toBeNull()
    expect(useLauncherState.getState().sections.workspace!.browser).toBe('collapsed')
    expect(useLauncherState.getState().drafts['region:region']).toEqual({ browser: 'kept browser', note: 'kept note' })
  })
})
