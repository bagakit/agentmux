// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDesktopFocusSuccessReceipt } from '../../../packages/core/src/desktop-focus-parser'
import { captureDesktopInput, desktopInputPreserved, installDesktopPresentationOwner, type DesktopInputCapture } from '../src/renderer/src/lib/desktop-presentation'
import type { AppConfig } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState()
let host: HTMLDivElement, composer: HTMLDivElement, input: HTMLTextAreaElement

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({})
  })
  host = document.createElement('div')
  host.setAttribute('data-pmo-teams-topic-floating', '')
  composer = document.createElement('div'); composer.className = 'composer__editor'
  input = document.createElement('textarea'); input.value = 'Original unsent draft'
  composer.append(input); host.append(composer); document.body.append(host)
  input.focus(); input.setSelectionRange(2, 7)
})
afterEach(() => {
  host.remove(); vi.restoreAllMocks()
  useAppStore.setState(initial, true); window.localStorage.clear()
})

describe('original Desktop input preservation facts', () => {
  it('observes the original generic EditContext text owner while ordinary focusable divs remain non-input', () => {
    host.removeAttribute('data-pmo-teams-topic-floating')
    composer.className = 'monaco-editor'
    const contextHost = document.createElement('div'); contextHost.tabIndex = 0
    composer.append(contextHost); contextHost.focus()
    expect(captureDesktopInput({}).element).toBeNull()
    vi.spyOn(contextHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 0))
    vi.spyOn(contextHost, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 0, 0)] as unknown as DOMRectList)
    Object.defineProperty(contextHost, 'editContext', { value: {}, configurable: true })
    const before = captureDesktopInput({}), after = captureDesktopInput({})
    expect(before.element).toBe(contextHost)
    expect(before.fact).toMatchObject({ provenance: 'observed', scope: 'main', ownerKind: 'editor', connected: true, visible: true, inert: false })
    expect(desktopInputPreserved(before, after)).toBe(true)
    expect(document.activeElement).toBe(contextHost)
    contextHost.style.display = 'none'
    expect(captureDesktopInput({}).fact.visible).toBe(false)
    contextHost.style.display = ''
    host.setAttribute('inert', '')
    expect(captureDesktopInput({}).fact.inert).toBe(true)
    expect(captureDesktopInput({}).fact.visible).toBe(false)
  })
  it.each(['main', 'floating', 'overlay'] as const)('confirms unchanged observed %s input without changing its draft or caret', scope => {
    host.removeAttribute('data-pmo-teams-topic-floating')
    if (scope === 'floating') host.setAttribute('data-pmo-teams-topic-floating', '')
    if (scope === 'overlay') host.setAttribute('role', 'dialog')
    const before = captureDesktopInput({}), after = captureDesktopInput({})
    expect(before.fact).toMatchObject({ provenance: 'observed', scope, ownerKind: 'composer' })
    expect(desktopInputPreserved(before, after)).toBe(true)
    expect(document.activeElement).toBe(input)
    expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['Original unsent draft', 2, 7])
  })

  it('does not confirm the same composer element after its actual floating scope becomes main', () => {
    const before = captureDesktopInput({})
    host.removeAttribute('data-pmo-teams-topic-floating')
    const after = captureDesktopInput({})
    expect(before.element).toBe(after.element)
    expect(before.fact.scope).toBe('floating'); expect(after.fact.scope).toBe('main')
    expect(desktopInputPreserved(before, after)).toBe(false)
  })

  it('does not confirm the same element after its actual input owner changes from composer to editor', () => {
    const before = captureDesktopInput({})
    composer.className = 'monaco-editor'
    const after = captureDesktopInput({})
    expect(before.element).toBe(after.element)
    expect(before.fact.ownerKind).toBe('composer'); expect(after.fact.ownerKind).toBe('editor')
    expect(desktopInputPreserved(before, after)).toBe(false)
  })

  // These explicitly controlled snapshot facts are not an observed native unknown-owner claim.
  it.each(['unknown', 'unavailable'] as const)('does not upgrade the %s before snapshot from the same observed after element', provenance => {
    const actual = captureDesktopInput({})
    const before: DesktopInputCapture = { ...actual, fact: { ...actual.fact, provenance } }
    expect(before.element).toBe(actual.element)
    expect(desktopInputPreserved(before, actual)).toBe(false)
  })

  it.each(['unknown', 'unavailable'] as const)('does not confirm the %s after snapshot', provenance => {
    const before = captureDesktopInput({})
    const after: DesktopInputCapture = { ...before, fact: { ...before.fact, provenance } }
    expect(desktopInputPreserved(before, after)).toBe(false)
  })

  it('keeps the original disconnected, hidden, inert and replaced-element refusals', () => {
    const before = captureDesktopInput({})
    for (const facts of [{ connected: false }, { visible: false }, { inert: true }]) {
      const after: DesktopInputCapture = { ...before, fact: { ...before.fact, ...facts } }
      expect(desktopInputPreserved(before, after)).toBe(false)
    }
    expect(desktopInputPreserved(before, { ...before, element: document.createElement('textarea') })).toBe(false)
  })

  it('does not label an absent input element as preserved', () => {
    input.blur()
    const before = captureDesktopInput({})
    expect(before.element).toBeNull()
    expect(desktopInputPreserved(before, before)).toBe(false)
  })

  it('returns an honest partial receipt from the actual Store caller when one element crosses scope', async () => {
    const config: AppConfig = { version: 9, hosts: [], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    useAppStore.setState({ ...initial, config, loading: false, mainSurface: 'workbench', tabs: {}, layouts: {},
      workbenchSpaceSelection: null })
    const before = useAppStore.getState()
    // This finite Store fixture does not claim App initialization or disk durability.
    vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
    const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
    const target = document.createElement('main'); target.dataset.desktopSurface = 'focus'; document.body.append(target)
    const disposeOwner = installDesktopPresentationOwner(() => ({ loading: false, overlays: { settings: false, quickSwitcher: false }, floating: null }))
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.mainSurface === 'agents') host.removeAttribute('data-pmo-teams-topic-floating')
    })
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'same-element-scope-receipt',
        operation: 'focus', target: { kind: 'surface', surface: 'focus' }, inputPolicy: 'preserve' })
      if (result.operation !== 'focus') throw new Error('Expected original focus receipt')
      expect(result.input.before).toMatchObject({ provenance: 'observed', scope: 'floating', ownerKind: 'composer' })
      expect(result.input.after).toMatchObject({ provenance: 'observed', scope: 'main', ownerKind: 'composer' })
      expect(document.activeElement).toBe(input)
      expect(result.input.outcome).toBe('unavailable')
      expect(result.partial).toBe(true)
      expect(result.issues?.some(issue => issue.code === 'DESKTOP_PRESENTATION_PARTIAL')).toBe(true)
      const { operation, ...body } = result
      expect(parseDesktopFocusSuccessReceipt({ schemaVersion: 5, requestId: 'same-element-scope-receipt', ok: true,
        operation, result: body })).toMatchObject({ result: { input: { outcome: 'unavailable' }, partial: true } })
      expect(() => parseDesktopFocusSuccessReceipt({ schemaVersion: 5, requestId: 'incorrect-preserved', ok: true,
        operation, result: { ...body, input: { ...body.input, outcome: 'preserved' } } })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['Original unsent draft', 2, 7])
      expect(useAppStore.getState().sessions).toBe(before.sessions)
      expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    } finally { unsubscribe(); disposeOwner(); target.remove() }
  })
})
