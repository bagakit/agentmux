import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserInputHistorySnapshot, BrowserInputHistoryTarget } from '../src/shared/contracts'
import { BrowserAddressInput, type BrowserAddressInputHandle } from '../src/renderer/src/components/BrowserAddressInput'
import { api } from '../src/renderer/src/lib/api'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readStyleSheet } from './helpers/styles'

const target: BrowserInputHistoryTarget = { kind: 'browser', browserId: 'page', profileId: 'profile' }
const snapshot: BrowserInputHistorySnapshot = { scope: { workspaceId: 'resource', profileId: 'profile' }, entries: [
  { text: 'https://example.test/?q=original#part', submittedAt: _reshape_fixtureEpoch(0, 0, 2) }, { text: 'original search', submittedAt: _reshape_fixtureEpoch(0, 0, 1) }
] }
let container: HTMLDivElement, root: Root
const submitted = vi.fn(), notice = vi.fn(), deferredFailure = vi.fn(), regionContextMenu = vi.fn()
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function Input({ scope = target, initial = '' }: { scope?: BrowserInputHistoryTarget | null; initial?: string }) {
  const [value, setValue] = useState(initial), ref = useRef<BrowserAddressInputHandle>(null)
  return <div onContextMenu={regionContextMenu}><form onSubmit={event => { event.preventDefault(); ref.current?.submit() }}>
    <BrowserAddressInput ref={ref} aria-label="Address" value={value} historyTarget={scope} onValueChange={setValue}
      onSubmit={submitted} onHistoryNotice={notice} onDeferredHistoryFailure={deferredFailure} />
    <button type="submit">Navigate</button><output data-draft>{value}</output></form><button id="outside">Outside</button></div>
}
async function mount(scope: BrowserInputHistoryTarget | null = target, initial = '') { await act(async () => root.render(<Input scope={scope} initial={initial} />)) }
function field() { const result = container.querySelector<HTMLInputElement>('input'); expect(result).not.toBeNull(); return result! }
async function activate() { await act(async () => { field().focus(); field().click() }) }
async function key(key: string, extra: KeyboardEventInit = {}) { await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))) }
async function fill(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value); field().dispatchEvent(new Event('input', { bubbles: true })) }) }
function historyTexts() { return [...document.querySelectorAll<HTMLButtonElement>('.browser-address-history__delete')].map(button => button.getAttribute('aria-label')!.slice('Remove input '.length)) }
function popup() { return document.querySelector<HTMLElement>('[aria-label="Browser input history"]') }
async function click(selector: string) { const element = document.querySelector<HTMLButtonElement>(selector); expect(element).not.toBeNull(); await act(async () => element!.click()) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.clearAllMocks()
  vi.spyOn(api.browser, 'listInputHistory').mockResolvedValue(snapshot)
  vi.spyOn(api.browser, 'recordInputHistory').mockResolvedValue({ ...snapshot, outcome: 'recorded' })
  vi.spyOn(api.browser, 'removeInputHistory').mockResolvedValue({ ...snapshot, entries: [snapshot.entries[1]!] })
  vi.spyOn(api.browser, 'clearInputHistory').mockResolvedValue({ ...snapshot, entries: [] })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); vi.restoreAllMocks() })

it('programmatic focus prepares the original input without reading history or opening a portal', async () => {
  await mount(target, 'kept draft')
  await act(async () => field().focus())
  expect(document.activeElement).toBe(field())
  expect(field().value).toBe('kept draft')
  expect(field().getAttribute('aria-expanded')).toBe('false')
  expect(popup()).toBeNull()
  expect(api.browser.listInputHistory).not.toHaveBeenCalled()
  await act(async () => container.querySelector<HTMLButtonElement>('#outside')!.focus())
  await act(async () => field().focus())
  expect(popup()).toBeNull()
  expect(api.browser.listInputHistory).not.toHaveBeenCalled()
})

it('keyboard intent opens suggestions from a quietly focused field without navigating or replacing its draft', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValue(pending.promise)
  await mount(target, 'kept draft')
  await act(async () => field().focus())
  await key('ArrowDown')
  expect(field().getAttribute('aria-expanded')).toBe('true')
  expect(popup()?.textContent).toContain('Reading input history')
  await act(async () => pending.resolve(snapshot))
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
  expect(field().value).toBe('kept draft')
  expect(submitted).not.toHaveBeenCalled()
  await key('ArrowDown'); await key('Enter')
  expect(submitted).toHaveBeenCalledExactlyOnceWith(snapshot.entries[0]!.text)
})

it('uses the actual Main list, portal and keyboard selection to submit the original query and fragment', async () => {
  await mount(); await activate()
  expect(api.browser.listInputHistory).toHaveBeenCalledExactlyOnceWith(target)
  expect(popup()?.closest('[data-overlay-host]')).not.toBeNull()
  expect(historyTexts()).toEqual(snapshot.entries.map(entry => entry.text))
  await key('ArrowDown'); await key('Enter')
  expect(field().value).toBe(snapshot.entries[0]!.text)
  expect(submitted).toHaveBeenCalledExactlyOnceWith(snapshot.entries[0]!.text)
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.entries[0]!.text)
  expect(popup()).toBeNull()
})

it('mouse selection submits the original search and ArrowUp initially selects the final result', async () => {
  await mount(); await activate(); await key('ArrowUp')
  expect(document.querySelector('[role="option"][aria-selected="true"] .browser-address-history__choose')?.getAttribute('aria-label')).toBe('Open recent input original search')
  const choices = [...document.querySelectorAll<HTMLButtonElement>('.browser-address-history__choose')]
  expect(choices).toHaveLength(2); await act(async () => choices[1]!.click())
  expect(submitted).toHaveBeenCalledExactlyOnceWith('original search')
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith(target, 'original search')
})

it('Escape invalidates a real deferred suggestion read and the late reply cannot reopen the popup', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValue(pending.promise)
  await mount(); await activate(); await key('Escape')
  await act(async () => pending.resolve(snapshot))
  expect(document.activeElement).toBe(field()); expect(popup()).toBeNull(); expect(field().getAttribute('aria-expanded')).toBe('false')
  expect(api.browser.listInputHistory).toHaveBeenCalledTimes(1)
})

it('opens on explicit activation before history settles, offers recent input beside the current URL, then filters only edits', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValue(pending.promise)
  await mount(target, 'https://different.test/current'); await activate()
  expect(popup()?.textContent).toContain('Reading input history')
  expect(field().getAttribute('aria-expanded')).toBe('true')
  await act(async () => pending.resolve(snapshot))
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
  expect(field().value).toBe('https://different.test/current')
  expect(submitted).not.toHaveBeenCalled(); expect(api.browser.recordInputHistory).not.toHaveBeenCalled()
  await fill('original search')
  expect(historyTexts()).toEqual(['original search'])
})

it('clicking the already focused field reopens suggestions after Escape and shows failures without blocking navigation', async () => {
  await mount(target, 'kept input'); await activate(); await key('Escape')
  vi.mocked(api.browser.listInputHistory).mockRejectedValueOnce(new Error('offline history'))
  await act(async () => field().click())
  expect(popup()?.textContent).toContain('offline history')
  expect(document.activeElement).toBe(field()); expect(field().value).toBe('kept input')
  await key('Enter')
  expect(submitted).toHaveBeenCalledExactlyOnceWith('kept input')
})

it('keeps filtering an edited draft after focus leaves and returns', async () => {
  await mount(target, 'https://different.test/current'); await activate(); await fill('original search')
  await act(async () => container.querySelector<HTMLButtonElement>('#outside')!.focus())
  expect(popup()).toBeNull()
  await activate()
  expect(field().value).toBe('original search')
  expect(historyTexts()).toEqual(['original search'])
  expect(submitted).not.toHaveBeenCalled(); expect(api.browser.recordInputHistory).not.toHaveBeenCalled()
})

it('typing during a real deferred suggestion read keeps the draft and selection while confirming the actual nonempty history', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValue(pending.promise)
  await mount(); await activate(); await fill('original'); field().setSelectionRange(2, 4)
  expect(popup()?.textContent).toContain('Reading input history')
  expect(popup()?.textContent).not.toContain('No saved input yet')
  await act(async () => pending.resolve(snapshot))
  expect(field().value).toBe('original'); expect([field().selectionStart, field().selectionEnd]).toEqual([2, 4])
  expect(historyTexts()).toEqual(['original search', snapshot.entries[0]!.text])
  expect(popup()?.textContent).not.toContain('No saved input yet'); expect(document.activeElement).toBe(field())
})

it('composition cancels the pending list and Enter never submits a preedit; completion writes exactly the real IME value', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValue(pending.promise)
  await mount(); await activate()
  await act(async () => field().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await fill('搜索'); await key('Enter', { isComposing: true })
  await act(async () => pending.resolve(snapshot))
  expect(popup()).toBeNull(); expect(submitted).not.toHaveBeenCalled(); expect(api.browser.recordInputHistory).not.toHaveBeenCalled()
  await act(async () => field().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '搜索' })))
  await key('Enter')
  expect(submitted).toHaveBeenCalledExactlyOnceWith('搜索'); expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith(target, '搜索')
})

it('focus may enter deletion controls, then leaving the portal closes it without stealing focus', async () => {
  await mount(); await activate()
  const clear = popup()!.querySelector<HTMLButtonElement>('header button')!
  await act(async () => clear.focus()); expect(popup()).not.toBeNull()
  const outside = container.querySelector<HTMLButtonElement>('#outside')!
  await act(async () => outside.focus()); expect(popup()).toBeNull(); expect(document.activeElement).toBe(outside)
})

it('single and all deletion use the exact Main-confirmed scope and keep the current draft', async () => {
  await mount(); await activate(); await fill('original')
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.browser-address-history__delete')].find(button => button.getAttribute('aria-label') === 'Remove input ' + snapshot.entries[0]!.text)!.click())
  expect(api.browser.removeInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.scope, snapshot.entries[0]!.text)
  expect(field().value).toBe('original')
  expect(historyTexts()).toEqual(['original search'])
  await click('.browser-address-history header button')
  expect(api.browser.clearInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.scope)
  expect(popup()?.textContent).toContain('No saved input yet'); expect(field().value).toBe('original'); expect(submitted).not.toHaveBeenCalled()
})

it('late old-Profile read cannot expose or delete old history in the new Profile', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValueOnce(pending.promise)
  await mount(); await activate(); await fill('old draft')
  await mount({ ...target, profileId: 'new-profile' })
  await act(async () => pending.resolve(snapshot))
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0); expect(popup()).toBeNull(); expect(field().value).toBe('old draft')
  expect(api.browser.removeInputHistory).not.toHaveBeenCalled(); expect(api.browser.clearInputHistory).not.toHaveBeenCalled()
})

it('save rejection never delays human form navigation and remains explicit even after unmount', async () => {
  const pending = deferred<never>(); vi.mocked(api.browser.recordInputHistory).mockReturnValue(pending.promise)
  await mount(target, 'submitted input')
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(submitted).toHaveBeenCalledExactlyOnceWith('submitted input')
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith(target, 'submitted input')
  await act(async () => root.render(null)); await act(async () => pending.reject(new Error('disk unavailable')))
  expect(deferredFailure).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('disk unavailable'))
})

it('read and deletion failures retain data and draft with a persistent local warning', async () => {
  vi.mocked(api.browser.listInputHistory).mockRejectedValueOnce(new Error('read unavailable'))
  await mount(); await activate(); await fill('original')
  expect(popup()?.textContent).toContain('read unavailable'); expect(popup()?.textContent).toContain('not loaded')
  expect(popup()?.textContent).not.toContain('No saved input yet')
  await click('p[role="status"] button')
  vi.mocked(api.browser.removeInputHistory).mockRejectedValueOnce(new Error('delete unavailable'))
  await click('.browser-address-history__delete')
  expect(popup()?.textContent).toContain('delete unavailable')
  expect(historyTexts()).toHaveLength(2); expect(field().value).toBe('original')
})

it('userinfo rejection is announced while original input navigates; no draft-only input is recorded', async () => {
  vi.mocked(api.browser.recordInputHistory).mockResolvedValueOnce({ ...snapshot, outcome: 'url-userinfo' })
  await mount(); await fill('https://user:pass@example.test/path'); expect(api.browser.recordInputHistory).not.toHaveBeenCalled()
  await key('Enter')
  expect(submitted).toHaveBeenCalledExactlyOnceWith('https://user:pass@example.test/path')
  expect(notice).toHaveBeenLastCalledWith(expect.stringContaining('login information was not saved'))
})

it('input right-click stops the Region menu while preserving default native text editing', async () => {
  await mount(); await activate()
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => field().dispatchEvent(event))
  expect(event.defaultPrevented).toBe(false); expect(regionContextMenu).not.toHaveBeenCalled(); expect(popup()).toBeNull()
})

it('the actual nonempty popup rules style its mounted portal with an opaque product token and local keyboard focus', async () => {
  await mount(); await activate()
  const sourceRoot = process.env.AGENTMUX_HISTORY_UI_SOURCE_ROOT ?? process.cwd()
  const css = await readFile(resolve(sourceRoot, 'apps/desktop/src/renderer/src/styles/browser.css'), 'utf8')
  const style = document.createElement('style'); style.textContent = css; document.head.append(style)
  try {
    const rules = [...style.sheet!.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText.startsWith('.browser-address-history'))
    expect(rules.length).toBeGreaterThan(0)
    const host = rules.find(rule => rule.selectorText === '.browser-address-history')
    expect(host).toBeDefined(); expect(popup()?.matches(host!.selectorText)).toBe(true)
    expect(host!.style.background).toBe('var(--surface-2)')
    expect(host!.style.pointerEvents).toBe('auto'); expect(host!.style.position).toBe('fixed')
    const focus = rules.find(rule => rule.selectorText === '.browser-address-history button:focus-visible')
    expect(focus).toBeDefined()
    const focusDeclarations = [...css.matchAll(/\.browser-address-history button:focus-visible\s*\{([^}]+)\}/g)]
    expect(focusDeclarations).toHaveLength(1); expect(focusDeclarations[0]![1]).toContain('outline: 1px solid var(--focus-line)')
    expect(popup()!.querySelectorAll('button').length).toBeGreaterThan(0)
    const tokens = readStyleSheet('./tokens.css')
    const surface = [...tokens.matchAll(/--surface-2:\s*(#[0-9a-f]{6});/gi)]
    expect(surface.length).toBeGreaterThan(0)
  } finally { style.remove() }
})

async function nativeEdit(text: string, inputType = 'insertText') {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), text)
    field().setSelectionRange(text.length, text.length)
    field().dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: text.slice(-1) }))
  })
}
const appearance = { url: snapshot.entries[0]!.text, title: 'Reference notes', faviconDataUrl: 'data:image/png;base64,aGVsbG8=' }

it('[address-suggestions] selected suffix is not the human draft and Enter adopts the exact original input once', async () => {
  await mount(); await activate(); await nativeEdit('https://ex')
  expect(field().value).toBe(snapshot.entries[0]!.text)
  expect([field().selectionStart, field().selectionEnd]).toEqual([10, snapshot.entries[0]!.text.length])
  expect(container.querySelector('output')!.textContent).toBe('https://ex')
  expect(submitted).not.toHaveBeenCalled(); expect(api.browser.recordInputHistory).not.toHaveBeenCalled()
  await key('Enter')
  expect(submitted).toHaveBeenCalledExactlyOnceWith(snapshot.entries[0]!.text)
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.entries[0]!.text)
})

it.each(['Escape', 'Tab', 'ArrowRight', 'End'])('[address-suggestions] %s keeps its native editing meaning without navigating', async action => {
  await mount(); await activate(); await nativeEdit('https://ex')
  const event = new KeyboardEvent('keydown', { key: action, bubbles: true, cancelable: true })
  await act(async () => field().dispatchEvent(event))
  const accepted = action === 'ArrowRight' || action === 'End'
  expect(field().value).toBe(accepted ? snapshot.entries[0]!.text : 'https://ex')
  expect(container.querySelector('output')!.textContent).toBe(field().value)
  if (action === 'Tab') expect(event.defaultPrevented).toBe(false)
  expect(submitted).not.toHaveBeenCalled(); expect(api.browser.recordInputHistory).not.toHaveBeenCalled()
})

it.each(['deleteContentBackward', 'insertFromPaste', 'historyUndo'])('[address-suggestions] %s withdraws completion without immediately reinserting it', async inputType => {
  await mount(); await activate(); await nativeEdit('https://ex')
  await nativeEdit('https://ex', inputType)
  expect(field().value).toBe('https://ex'); expect(container.querySelector('output')!.textContent).toBe('https://ex')
  expect(submitted).not.toHaveBeenCalled()
})

it('[address-suggestions] arbitrary selection edits dismiss the suffix while retaining the human selection', async () => {
  await mount(); await activate(); await nativeEdit('https://ex')
  await act(async () => { field().setSelectionRange(2, 4); document.dispatchEvent(new Event('selectionchange', { bubbles: true })) })
  expect(field().value).toBe('https://ex'); expect([field().selectionStart, field().selectionEnd]).toEqual([2, 4])
})

it('[address-suggestions] composition replaces a selected suffix with the actual IME value and never submits preedit', async () => {
  await mount(); await activate(); await nativeEdit('https://ex')
  await act(async () => field().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await nativeEdit('https://ex中文', 'insertCompositionText'); await key('Enter', { isComposing: true })
  expect(submitted).not.toHaveBeenCalled(); expect(popup()).toBeNull()
  await act(async () => field().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
  await key('Enter'); expect(submitted).toHaveBeenCalledExactlyOnceWith('https://ex中文')
})

it('[address-suggestions] saved artwork gives a real title, URL and visible match without querying pages', async () => {
  const inspect = vi.spyOn(api.browser, 'listTargets'), capture = vi.spyOn(api.browser, 'getRecoveryPreview')
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ ...snapshot, entries: [{ ...snapshot.entries[0]!, appearance }] })
  await mount(); await activate(); await fill('Reference')
  expect(popup()!.textContent).toContain('Reference notes'); expect(popup()!.textContent).toContain(appearance.url)
  expect(popup()!.querySelector('mark')?.textContent).toBe('Reference')
  expect(popup()!.querySelector('img')?.getAttribute('src')).toBe(appearance.faviconDataUrl)
  expect(inspect).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled()
  await nativeEdit('R'); await nativeEdit('Re'); await nativeEdit('Ref')
  expect(api.browser.listInputHistory).toHaveBeenCalledTimes(1)
})

it('[address-suggestions] malformed explicit input remains available as its original submission, with no fake search or deletion', async () => {
  await mount(); await activate(); await fill('https://')
  const action = [...document.querySelectorAll('[role="option"]')].find(row => !row.querySelector('.browser-address-history__delete'))!
  expect(action.textContent).toContain('Open address'); expect(action.textContent).not.toContain('Search the web')
  await act(async () => action.querySelector<HTMLButtonElement>('button')!.click())
  expect(submitted).toHaveBeenCalledExactlyOnceWith('https://')
})

it('[address-suggestions] keyboard removal targets only the selected original history, preserving the unaccepted query', async () => {
  await mount(); await activate(); await nativeEdit('https://ex')
  await key('Delete', { shiftKey: true })
  expect(api.browser.removeInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.scope, snapshot.entries[0]!.text)
  expect(field().value).toBe('https://ex'); expect(submitted).not.toHaveBeenCalled()
  await fill('a new query'); await key('ArrowDown'); await key('Delete', { shiftKey: true })
  expect(api.browser.removeInputHistory).toHaveBeenCalledTimes(1)
})

it('[address-suggestions] a later exact favicon replaces a failed image without inheriting its hidden state', async () => {
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ ...snapshot, entries: [{ ...snapshot.entries[0]!, appearance }] })
  await mount(); await activate()
  const failed = popup()!.querySelector<HTMLImageElement>('img')!
  await act(async () => failed.dispatchEvent(new Event('error'))); expect(failed.hidden).toBe(true)
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ ...snapshot, entries: [{ ...snapshot.entries[0]!, appearance: { ...appearance, faviconDataUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' } }] })
  await key('Escape'); await activate()
  const updated = popup()!.querySelector<HTMLImageElement>('img')!
  expect(updated).not.toBe(failed); expect(updated.hidden).toBe(false)
  expect(api.browser.listInputHistory).toHaveBeenCalledTimes(2)
})

it('[address-appearance] closed and redirected pages retain their stored title and icon while selecting the original input', async () => {
  const redirectedAppearance = { url: 'https://example.test/redirected', title: 'Archived reference notes', faviconDataUrl: appearance.faviconDataUrl }
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ ...snapshot, entries: [
    { ...snapshot.entries[0]!, appearance: redirectedAppearance }, snapshot.entries[1]!
  ] })
  const targets = vi.spyOn(api.browser, 'listTargets'), preview = vi.spyOn(api.browser, 'getRecoveryPreview')
  await mount(target, 'https://elsewhere.test/')
  await activate(); await fill('Archived')
  expect(historyTexts()).toEqual([snapshot.entries[0]!.text])
  const row = popup()!.querySelector('.browser-address-history__delete')!.closest('[role="option"]')!
  expect(row.textContent).toContain(redirectedAppearance.title)
  expect(row.textContent).toContain(redirectedAppearance.url)
  expect(row.querySelector('img')?.getAttribute('src')).toBe(redirectedAppearance.faviconDataUrl)
  expect(row.querySelector('mark')?.textContent).toBe('Archived')
  expect(targets).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled()
  await key('ArrowUp'); await key('Enter')
  expect(submitted).toHaveBeenCalledExactlyOnceWith(snapshot.entries[0]!.text)
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.entries[0]!.text)
})

it('[address-appearance] stored title survives missing artwork and a bad image keeps the visible type glyph', async () => {
  vi.mocked(api.browser.listInputHistory).mockResolvedValue({ ...snapshot, entries: [
    { ...snapshot.entries[0]!, appearance: { url: appearance.url, title: 'Saved notes' } },
    { text: 'https://another.test/', submittedAt: snapshot.entries[1]!.submittedAt, appearance: { url: 'https://another.test/', title: 'Another notes', faviconDataUrl: appearance.faviconDataUrl } }
  ] })
  await mount(); await activate()
  const rows = [...popup()!.querySelectorAll('[role="option"]')]
  expect(rows[0]!.textContent).toContain('Saved notes')
  expect(rows[0]!.querySelector('img')).toBeNull()
  expect(rows[0]!.querySelector('.browser-address-history__icon svg')).not.toBeNull()
  const failed = rows[1]!.querySelector<HTMLImageElement>('img')!
  await act(async () => failed.dispatchEvent(new Event('error')))
  expect(failed.hidden).toBe(true)
  expect(rows[1]!.querySelector('.browser-address-history__icon svg')).not.toBeNull()
})

it('[address-suggestions] selecting the last history and removing it never targets the first original entry', async () => {
  await mount(); await activate(); await key('ArrowUp'); await key('Delete', { shiftKey: true })
  expect(api.browser.removeInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.scope, 'original search')
  expect(submitted).not.toHaveBeenCalled(); expect(field().value).toBe('')
})
