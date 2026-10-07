// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { SourceFilePreview } from '../src/renderer/src/components/file-preview/SourceFilePreview'
import { ReadingFind } from '@agentmux/client-ui/components/ReadingFind'
import { readingMatches } from '@agentmux/client-ui/reading-find'
import type { AgentTimelineItem } from '../src/shared/contracts'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
const highlights = new Map<string, Highlight>()
class TestHighlight extends Set<Range> { constructor(...ranges: Range[]) { super(ranges) } }
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('CSS', { ...window.CSS, highlights, supports: () => false, escape: (text: string) => text })
  vi.stubGlobal('Highlight', TestHighlight)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); highlights.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const render = async (value: ReactNode) => { await act(async () => root.render(value)); await tick() }
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
const click = async (element: HTMLElement) => { expect(element).not.toBeNull(); await act(async () => { element.focus(); element.click() }); await tick() }
async function query(text: string, field = host.querySelector<HTMLInputElement>('input[type="search"]')!) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }); await tick()
}
const count = () => host.querySelector('output')?.textContent
function item(id: string, content: string): AgentTimelineItem {
  return { id, agentSessionId: 'reading-session', kind: 'assistant_message', title: 'Answer', content, source: 'native-hook', status: 'complete', createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) }
}
const activity = (items = [item('answer', 'alpha **beta** and alpha beta')], sessionId = 'reading-session', enabled = true) =>
  <ActivityView sessionId={sessionId} executionHostId="reader-host" items={items} capability="complete-events" conversationReading={enabled ? undefined : { enabled: false } as never} />
const file = (path = fixturePath('reading.md'), content = 'alpha **beta**\n\n[alpha beta](https://example.test/read)', visible = true, open = vi.fn()) =>
  <SourceFilePreview kind="markdown" regionId="original-file-region" workspaceId="original-workspace" workspaceRoot={fixturePath('workspace')} path={path} content={content} visible={visible} openReference={vi.fn()} openHttpLink={open} />
const current = () => [...highlights.entries()].find(([name]) => name.endsWith('-current'))?.[1].values().next().value as Range | undefined

it('finds across inline Markdown in the original Activity body, preserving text nodes, Range and the selected hit on unrelated insertions', async () => {
  await render(activity())
  await act(async () => { host.querySelector('details.activity-feed__observations')!.open = true }); await tick()
  const paragraph = host.querySelector('.log-turn__body p')!, text = paragraph.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5)
  window.getSelection()!.addRange(range)
  await click(button('Find in loaded conversation')); await query('alpha beta')
  expect(count()).toBe('1 / 2'); expect(current()?.toString()).toBe('alpha beta')
  await click(button('Next match')); expect(count()).toBe('2 / 2')
  const retained = current()!
  const viewport = host.querySelector<HTMLElement>('.activity-feed')!; viewport.scrollTop = 27
  await render(activity([item('earlier', 'alpha beta'), item('answer', 'alpha **beta** and alpha beta')]))
  expect(count()).toBe('3 / 3'); expect(current()?.startContainer).toBe(retained.startContainer)
  expect(host.querySelectorAll('.log-turn__body p')[1]).toBe(paragraph)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(range.toString()).toBe('alpha')
  expect(viewport.scrollTop).toBe(27)
})

it('reaches the original Markdown file preview, keeps exact links and returns to the actual shortcut opener', async () => {
  const open = vi.fn()
  await render(file(undefined, undefined, true, open))
  const link = host.querySelector<HTMLButtonElement>('.md-link')!; link.focus()
  await act(async () => link.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })))
  await query('alpha beta'); expect(count()).toBe('1 / 2')
  expect(current()?.toString()).toBe('alpha beta')
  link.focus()
  await act(async () => link.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(host.querySelector('input'))
  const ownShortcut = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
  await act(async () => host.querySelector('input')!.dispatchEvent(ownShortcut))
  expect(ownShortcut.defaultPrevented).toBe(true)
  await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(host.querySelector('input')).toBeNull(); expect(document.activeElement).toBe(link)
  await click(link); expect(open).toHaveBeenCalledTimes(1)
  expect(highlights.size).toBe(0)
})

it('keeps literal matches within loaded readable blocks and excludes hidden, collapsed, control, input and other-workface text', async () => {
  await render(<><ReadingFind source="scope" label="loaded body" bodySelector=".body" scrollSelector=".body"><div className="body">
    <p>a.b <strong>a.</strong>b axb</p><p>tail</p><p>head</p><p>line<br />break</p>
    <button>a.b</button><input defaultValue="a.b" /><p hidden>a.b</p><div style={{ display: 'none' }}>a.b</div>
    <details><summary>a.b</summary><p>a.b</p></details>
  </div></ReadingFind><div>a.b</div></>)
  await click(button('Find in loaded body')); await query('a.b'); expect(count()).toBe('1 / 2')
  await query('tailhead'); expect(count()).toBe('0 / 0')
  await query('linebreak'); expect(count()).toBe('0 / 0')
  await query('a.b'); await act(async () => host.querySelector('details')!.setAttribute('open', '')); await tick()
  expect(count()).toBe('1 / 3')
  expect(readingMatches(host, '[', '.body')).toHaveLength(0)
})

it('cleans highlights and rejects retained handlers across same-text file A-B-A, hidden and unmounted episodes', async () => {
  const a = fixturePath('a.md'), b = fixturePath('b.md')
  await render(file(a)); await click(button('Find in loaded Markdown preview')); await query('alpha')
  const old = button('Close find')
  const key = Object.keys(old).find(key => key.startsWith('__reactProps$'))!
  const handler = (old as unknown as Record<string, { onClick(): void }>)[key]!.onClick
  await render(file(b)); expect(host.querySelector('input[type="search"]')).toBeNull(); expect(highlights.size).toBe(0)
  await render(file(a)); await click(button('Find in loaded Markdown preview')); await query('beta')
  await act(async () => handler()); expect(count()).toBe('1 / 2')
  await render(file(a, undefined, false)); expect(highlights.size).toBe(0)
  await render(file(a)); expect(host.querySelector('input[type="search"]')).toBeNull()
})

it('does not intercept editable Ctrl+F or IME Escape/Enter and keeps separate simultaneous workface highlights', async () => {
  await render(<>{activity()}<div style={{ height: 400 }}>{file()}</div></>)
  await act(async () => { host.querySelector('details.activity-feed__observations')!.open = true }); await tick()
  await click(button('Find in loaded conversation')); await query('alpha')
  const firstNames = [...highlights.keys()]
  expect(firstNames).toHaveLength(2)
  expect(count()).toBe('1 / 2')
  await click(button('Find in loaded Markdown preview'))
  const fields = host.querySelectorAll<HTMLInputElement>('input[type="search"]'), field = fields[1]!
  await act(async () => field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  const escape = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
  await act(async () => field.dispatchEvent(escape)); expect(escape.defaultPrevented).toBe(false)
  await act(async () => field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await query('beta', field)
  expect(highlights.size).toBe(4)
  expect(firstNames.every(name => highlights.has(name))).toBe(true)
  const editable = document.createElement('textarea'); host.querySelector('.reading-find__content')!.append(editable); editable.focus()
  const find = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
  await act(async () => editable.dispatchEvent(find)); expect(find.defaultPrevented).toBe(false)
})

it('opening find is an explicit reading intent that stops the original Activity follow owner before any match navigation', async () => {
  let height = 1200
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () { return this.classList.contains('activity-feed') ? height : 0 })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return this.classList.contains('activity-feed') ? 300 : 0 })
  await render(activity())
  const viewport = host.querySelector<HTMLElement>('.activity-feed')!
  expect(viewport.scrollTop).toBe(900)
  await click(button('Find in loaded conversation'))
  height = 1800
  await render(activity([item('answer', 'alpha **beta** and alpha beta'), item('later', 'A newly loaded reply')]))
  expect(viewport.scrollTop).toBe(900)
  expect(host.querySelector('input[type="search"]')).not.toBeNull()
})

it('removes old match counts and highlights when the last original Activity body leaves the loaded window', async () => {
  await render(activity())
  await act(async () => { host.querySelector('details.activity-feed__observations')!.open = true }); await tick()
  await click(button('Find in loaded conversation')); await query('alpha beta'); expect(count()).toBe('1 / 2')
  await render(activity([])); expect(count()).toBe('0 / 0'); expect(current()).toBeUndefined()
  expect(button('Next match').disabled).toBe(true)
})

it('retains textual counts and original scroll navigation when the host has no Custom Highlight API', async () => {
  vi.stubGlobal('CSS', { supports: () => false, escape: (text: string) => text })
  await render(file()); await click(button('Find in loaded Markdown preview')); await query('alpha beta')
  expect(count()).toBe('1 / 2'); await click(button('Next match')); expect(count()).toBe('2 / 2')
  expect(highlights.size).toBe(0)
})
