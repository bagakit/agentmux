// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserControlFeedback, buildBrowserControlFeedbackScript } from '../src/main/browser-control-feedback'
import { showBrowserOperationFeedback } from '../src/main/browser-operation-feedback'
import { DEFAULT_BROWSER_AGENT_CONTROL } from '../src/shared/browser-agent-control'

const globals = globalThis as any
const state = () => globals.__agentMuxBrowserControlFeedback
const apply = (revision: number, ownerId: string, active = true) => new Function('return ' + buildBrowserControlFeedbackScript({
  revision, browserId: 'original-browser', ownerId, navigationId: 'original-navigation', active, deadline: Number.MAX_SAFE_INTEGER
}, { ...DEFAULT_BROWSER_AGENT_CONTROL, glowBlend: 'screen', glowColor: '#2299cc' }))()

afterEach(() => {
  state()?.dispose(); delete globals.__agentMuxBrowserControlFeedback
  globals.__agentMuxBrowserOperationFeedback?.cleanup(); delete globals.__agentMuxBrowserOperationFeedback
  const bridge = globals.__agentMuxBrowserOperationFeedbackBridge
  if (bridge) window.removeEventListener('message', bridge.listener)
  delete globals.__agentMuxBrowserOperationFeedbackBridge
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks()
})

describe('coordinate-free Browser ownership decoration', () => {
  it('keeps the real page and focus while decorating its exact owner', () => {
    const input = document.createElement('input'); input.value = 'Original page draft'; document.body.append(input); input.focus()
    expect(apply(1, 'one')).toBe(true)
    expect(state().host.shadowRoot).toBeNull()
    expect(state().host.style.mixBlendMode).toBe('screen')
    expect(state().host.style.background).toBe('transparent')
    expect(state().host.style.getPropertyValue('isolation')).toBe('auto')
    expect(state().host.style.getPropertyValue('contain')).toBe('none')
    expect(state().host.style.pointerEvents).toBe('none')
    expect(state().host.getAttribute('data-browser-id')).toBe('original-browser')
    expect(state().host.getAttribute('data-owner-id')).toBe('one')
    expect(state().host.hasAttribute('data-operation-id')).toBe(false)
    expect(state().shadow.querySelectorAll('button,input,a,[tabindex]')).toHaveLength(0)
    expect(state().shadow.querySelector('.amux-browser-agent-glow')).not.toBeNull()
    expect(document.activeElement).toBe(input); expect(input.value).toBe('Original page draft')
  })

  it('rejects stale ownership and prevents an old completion from erasing the next owner', () => {
    apply(1, 'one'); apply(2, 'one', false)
    expect(apply(1, 'one')).toBe(false); expect(state().host).toBeNull()
    apply(3, 'two'); const live = state().host
    expect(apply(100, 'one', false)).toBe(false); expect(state().host).toBe(live)
    expect(apply(4, 'two', false)).toBe(true); expect(state().host).toBeNull()
  })

  it('removes the document decoration on pagehide without touching page input', () => {
    apply(1, 'one'); const revision = state().revision
    window.dispatchEvent(new Event('pagehide'))
    expect(state().host).toBeNull(); expect(state().revision).toBe(revision)
  })

  it('restores the same ownership glow after website root replacement without reviving a released owner', async () => {
    apply(1, 'one'); const host = state().host, shadow = state().shadow
    document.documentElement.replaceChildren(document.createElement('head'), document.createElement('body'))
    await vi.waitFor(() => expect(host.isConnected).toBe(true))
    expect(state().host).toBe(host); expect(state().shadow).toBe(shadow)
    const oldRoot = document.documentElement, replacement = document.createElement('html')
    replacement.append(document.createElement('head'), document.createElement('body'))
    document.removeChild(oldRoot); document.appendChild(replacement)
    await vi.waitFor(() => expect(host.parentElement).toBe(replacement))
    expect(state().host).toBe(host); expect(state().shadow).toBe(shadow)
    host.remove(); apply(2, 'one', false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(host.isConnected).toBe(false); expect(state().host).toBeNull()
  })

  it('retains the same owned DOM across document visibility changes without replaying an old cue', () => {
    apply(1, 'one'); const host = state().host
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(state().host).toBe(host)
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'))
    expect(state().host).toBe(host)
    apply(2, 'one', false); expect(state().host).toBeNull()
  })
})

describe('Browser/view feedback owner lifecycle', () => {
  function owner() {
    let active = true, revision = 0, navigationId = 'one'
    let preferences = { ...DEFAULT_BROWSER_AGENT_CONTROL }
    const execute = vi.fn(async (_world: number, scripts: { code: string }[]) => new Function('return ' + scripts[0]!.code)())
    const warn = vi.fn()
    const contents = { executeJavaScriptInIsolatedWorld: execute, isDestroyed: () => false }
    const feedback = new BrowserControlFeedback({ contents, browserId: 'original-browser', ownerId: 'original-view-epoch',
      navigationId: () => navigationId,
      preferences: () => preferences, nextRevision: () => ++revision, isCurrent: () => active, warn })
    const action = showBrowserOperationFeedback({ contents, operationId: 'original-operation',
      navigationId: () => navigationId, operatorName: 'Original operator', preferences: () => preferences,
      nextRevision: () => ++revision, isCurrent: () => active, warn })
    return { feedback, action, execute, warn, setActive: (value: boolean) => { active = value },
      setNavigation: (value: string) => { navigationId = value },
      setPreferences: (value: typeof preferences) => { preferences = value } }
  }

  it('keeps ownership across action/observation clears and releases it only on the actual owner edge', async () => {
    const original = owner()
    await original.feedback.synchronize(); const live = state().host
    expect(state()).toMatchObject({ browserId: 'original-browser', ownerId: 'original-view-epoch' })
    expect(state().operationId).toBeUndefined()
    await original.action.begin('js'); await original.action.clear(); await original.action.end(true)
    expect(state().host).toBe(live)
    await original.feedback.synchronize(); expect(state().host).toBe(live)
    original.setActive(false); await original.feedback.synchronize()
    expect(state().host).toBeNull()
  })

  it('consumes saved preferences without polling or replaying an action', async () => {
    const original = owner()
    await original.feedback.synchronize(); await original.feedback.synchronize()
    expect(original.execute).toHaveBeenCalledTimes(1)
    original.setPreferences({ ...DEFAULT_BROWSER_AGENT_CONTROL, glowBlend: 'multiply', glowColor: '#cc3366' })
    await original.feedback.synchronize()
    expect(original.execute).toHaveBeenCalledTimes(2); expect(state().host.style.mixBlendMode).toBe('multiply')
    expect(globals.__agentMuxBrowserOperationFeedback).toBeUndefined()
    original.setNavigation('two'); await original.feedback.synchronize()
    expect(state().navigationId).toBe('two')
    const live = state().host
    await original.feedback.synchronize(); expect(state().host).toBe(live)
    original.setActive(false); await original.feedback.synchronize(); expect(state().host).toBeNull()
  })

  it('reconciles a new document after pagehide without creating an operation', async () => {
    const original = owner(); await original.feedback.synchronize()
    const previous = state().host
    window.dispatchEvent(new Event('pagehide')); expect(state().host).toBeNull()
    original.setNavigation('next-document'); await original.feedback.synchronize(true)
    expect(state().host).not.toBeNull(); expect(state().host).not.toBe(previous)
    expect(state().navigationId).toBe('next-document')
    expect(globals.__agentMuxBrowserOperationFeedback).toBeUndefined()
    await original.feedback.hide(); expect(state().host).toBeNull()
  })

  it('bounds a failed display observation and rejects its late script without taking control from the Agent', async () => {
    vi.useFakeTimers()
    const original = owner(); let late: (() => unknown) | undefined
    original.execute.mockImplementationOnce((_world, scripts) => new Promise(() => { late = () => new Function('return ' + scripts[0]!.code)() }))
    const observing = original.feedback.synchronize()
    await vi.advanceTimersByTimeAsync(121); await observing
    expect(original.warn).toHaveBeenCalledTimes(1); expect(late?.()).toBe(false); expect(state()).toBeUndefined()
    await original.feedback.synchronize()
    expect(state().host).not.toBeNull(); expect(original.warn).toHaveBeenCalledTimes(1)
  })

  it('does not let an old clear acknowledgement suppress cleanup of a newer active publication', async () => {
    const original = owner(); await original.feedback.synchronize()
    let release: (() => void) | undefined
    original.execute.mockImplementationOnce((_world, scripts) => {
      const result = new Function('return ' + scripts[0]!.code)()
      return new Promise(resolve => { release = () => resolve(result) })
    })
    original.setActive(false); const clearing = original.feedback.synchronize()
    original.setActive(true); await original.feedback.synchronize()
    expect(state().host).not.toBeNull()
    release!(); await clearing
    original.setActive(false); await original.feedback.synchronize()
    expect(state().host).toBeNull()
  })

  it('keeps a failed clear eligible for the next original owner observation', async () => {
    vi.useFakeTimers(); const original = owner(); await original.feedback.synchronize()
    const live = state().host
    original.execute.mockImplementationOnce(() => new Promise(() => {}))
    original.setActive(false); const clearing = original.feedback.synchronize()
    await vi.advanceTimersByTimeAsync(121); await clearing
    expect(state().host).toBe(live); expect(original.warn).toHaveBeenCalledTimes(1)
    await original.feedback.synchronize(); expect(state().host).toBeNull()
  })
})
