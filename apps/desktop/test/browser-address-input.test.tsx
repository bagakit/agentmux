// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserInputHistorySnapshot, BrowserInputHistoryTarget } from '../src/shared/contracts'
import { BrowserAddressInput, type BrowserAddressInputHandle } from '../src/renderer/src/components/BrowserAddressInput'
import { api } from '../src/renderer/src/lib/api'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const target: BrowserInputHistoryTarget = { kind: 'browser', browserId: 'page', profileId: 'profile' }
const snapshot: BrowserInputHistorySnapshot = { scope: { workspaceId: 'resource', profileId: 'profile' }, entries: [
  { text: 'https://example.test/?q=original#part', submittedAt: 2 }, { text: 'original search', submittedAt: 1 }
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
    <button type="submit">Navigate</button></form><button id="outside">Outside</button></div>
}
async function mount(scope: BrowserInputHistoryTarget | null = target, initial = '') { await act(async () => root.render(<Input scope={scope} initial={initial} />)) }
function field() { const result = container.querySelector<HTMLInputElement>('input'); expect(result).not.toBeNull(); return result! }
async function focus() { await act(async () => field().focus()) }
async function key(key: string, extra: KeyboardEventInit = {}) { await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))) }
async function fill(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value); field().dispatchEvent(new Event('input', { bubbles: true })) }) }
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

it('uses the actual Main list, portal and keyboard selection to submit the original query and fragment', async () => {
  await mount(); await focus()
  expect(api.browser.listInputHistory).toHaveBeenCalledExactlyOnceWith(target)
  expect(popup()?.closest('[data-overlay-host]')).not.toBeNull()
  expect([...document.querySelectorAll('[role="option"]')].map(row => row.textContent)).toEqual(snapshot.entries.map(entry => entry.text))
  await key('ArrowDown'); await key('Enter')
  expect(field().value).toBe(snapshot.entries[0]!.text)
  expect(submitted).toHaveBeenCalledExactlyOnceWith(snapshot.entries[0]!.text)
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.entries[0]!.text)
  expect(popup()).toBeNull()
})

it('mouse selection submits the original search and ArrowUp initially selects the final result', async () => {
  await mount(); await focus(); await key('ArrowUp')
  expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe('original search')
  const choices = [...document.querySelectorAll<HTMLButtonElement>('.browser-address-history__choose')]
  expect(choices).toHaveLength(2); await act(async () => choices[1]!.click())
  expect(submitted).toHaveBeenCalledExactlyOnceWith('original search')
  expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith(target, 'original search')
})

it('Escape invalidates a real deferred focus read and the late reply cannot reopen the popup', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValue(pending.promise)
  await mount(); await focus(); await key('Escape')
  await act(async () => pending.resolve(snapshot))
  expect(document.activeElement).toBe(field()); expect(popup()).toBeNull(); expect(field().getAttribute('aria-expanded')).toBe('false')
  expect(api.browser.listInputHistory).toHaveBeenCalledTimes(1)
})

it('typing during a real deferred focus read keeps the draft and selection while confirming the actual nonempty history', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValue(pending.promise)
  await mount(); await focus(); await fill('original'); field().setSelectionRange(2, 4)
  expect(popup()?.textContent).toContain('Reading input history')
  expect(popup()?.textContent).not.toContain('No saved input yet')
  await act(async () => pending.resolve(snapshot))
  expect(field().value).toBe('original'); expect([field().selectionStart, field().selectionEnd]).toEqual([2, 4])
  expect([...document.querySelectorAll('[role="option"]')].map(row => row.textContent)).toEqual(snapshot.entries.map(entry => entry.text))
  expect(popup()?.textContent).not.toContain('No saved input yet'); expect(document.activeElement).toBe(field())
})

it('composition cancels the pending list and Enter never submits a preedit; completion writes exactly the real IME value', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValue(pending.promise)
  await mount(); await focus()
  await act(async () => field().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await fill('搜索'); await key('Enter', { isComposing: true })
  await act(async () => pending.resolve(snapshot))
  expect(popup()).toBeNull(); expect(submitted).not.toHaveBeenCalled(); expect(api.browser.recordInputHistory).not.toHaveBeenCalled()
  await act(async () => field().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '搜索' })))
  await key('Enter')
  expect(submitted).toHaveBeenCalledExactlyOnceWith('搜索'); expect(api.browser.recordInputHistory).toHaveBeenCalledExactlyOnceWith(target, '搜索')
})

it('focus may enter deletion controls, then leaving the portal closes it without stealing focus', async () => {
  await mount(); await focus()
  const clear = popup()!.querySelector<HTMLButtonElement>('header button')!
  await act(async () => clear.focus()); expect(popup()).not.toBeNull()
  const outside = container.querySelector<HTMLButtonElement>('#outside')!
  await act(async () => outside.focus()); expect(popup()).toBeNull(); expect(document.activeElement).toBe(outside)
})

it('single and all deletion use the exact Main-confirmed scope and keep the current draft', async () => {
  await mount(); await focus(); await fill('original')
  await click('.browser-address-history__delete')
  expect(api.browser.removeInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.scope, snapshot.entries[0]!.text)
  expect(field().value).toBe('original')
  expect([...document.querySelectorAll('[role="option"]')].map(row => row.textContent)).toEqual(['original search'])
  await click('.browser-address-history header button')
  expect(api.browser.clearInputHistory).toHaveBeenCalledExactlyOnceWith(target, snapshot.scope)
  expect(popup()?.textContent).toContain('No saved input yet'); expect(field().value).toBe('original'); expect(submitted).not.toHaveBeenCalled()
})

it('late old-Profile read cannot expose or delete old history in the new Profile', async () => {
  const pending = deferred<BrowserInputHistorySnapshot>(); vi.mocked(api.browser.listInputHistory).mockReturnValueOnce(pending.promise)
  await mount(); await focus(); await fill('old draft')
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
  await mount(); await focus(); await fill('original')
  expect(popup()?.textContent).toContain('read unavailable'); expect(popup()?.textContent).toContain('not loaded')
  expect(popup()?.textContent).not.toContain('No saved input yet')
  await click('p[role="status"] button')
  vi.mocked(api.browser.removeInputHistory).mockRejectedValueOnce(new Error('delete unavailable'))
  await click('.browser-address-history__delete')
  expect(popup()?.textContent).toContain('delete unavailable')
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2); expect(field().value).toBe('original')
})

it('userinfo rejection is announced while original input navigates; no draft-only input is recorded', async () => {
  vi.mocked(api.browser.recordInputHistory).mockResolvedValueOnce({ ...snapshot, outcome: 'url-userinfo' })
  await mount(); await fill('https://user:pass@example.test/path'); expect(api.browser.recordInputHistory).not.toHaveBeenCalled()
  await key('Enter')
  expect(submitted).toHaveBeenCalledExactlyOnceWith('https://user:pass@example.test/path')
  expect(notice).toHaveBeenLastCalledWith(expect.stringContaining('login information was not saved'))
})

it('input right-click stops the Region menu while preserving default native text editing', async () => {
  await mount(); await focus()
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => field().dispatchEvent(event))
  expect(event.defaultPrevented).toBe(false); expect(regionContextMenu).not.toHaveBeenCalled(); expect(popup()).toBeNull()
})

it('the actual nonempty popup rules style its mounted portal with an opaque product token and local keyboard focus', async () => {
  await mount(); await focus()
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
    const tokens = await readFile(resolve('apps/desktop/src/renderer/src/styles/tokens.css'), 'utf8')
    const surface = [...tokens.matchAll(/--surface-2:\s*(#[0-9a-f]{6});/gi)]
    expect(surface).toHaveLength(1)
  } finally { style.remove() }
})
