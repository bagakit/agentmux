// @vitest-environment happy-dom
import { act, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { COMPOSER_KEYBOARD_BINDINGS, matchComposerShortcut } from '@agentmux/client-ui/composer-keyboard'
import { composerDOM } from './helpers/composer-dom-fixture'
import { KeyboardShortcutsPane } from '../src/renderer/src/components/settings/KeyboardShortcutsPane'

const dom = composerDOM()
const editor = () => dom.container.querySelector<HTMLElement>('[role="textbox"]')!
async function press(key: string, options: KeyboardEventInit = {}, target = editor()) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  await act(async () => { target.dispatchEvent(event) })
  return event
}

it('real shared editor keeps ordinary sending, immediate steering, IME and native newline distinct', async () => {
  const submit = vi.fn(), queue = vi.fn(), interrupt = vi.fn(), changed = vi.fn()
  function OwnedComposer() {
    const [value, setValue] = useState('first line')
    return <AgentComposer value={value} onChange={value => { changed(value); setValue(value) }} disabled={false}
      placeholder="Message" primaryAction="stop" onSubmit={submit} onQueue={queue} onInterrupt={interrupt} />
  }
  await dom.render(<OwnedComposer />)
  expect((await press('Enter')).defaultPrevented).toBe(true)
  expect(queue).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled()
  for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { metaKey: true, ctrlKey: true }, { metaKey: true, altKey: true }]) {
    expect((await press('Enter', modifiers)).defaultPrevented).toBe(true)
  }
  expect(submit).toHaveBeenCalledTimes(4); expect(queue).toHaveBeenCalledOnce(); expect(interrupt).not.toHaveBeenCalled()
  await press('Enter', { altKey: true })
  expect(queue).toHaveBeenCalledTimes(2)
  await press('Enter', { isComposing: true }); await press('Enter', { keyCode: 229 })
  expect(submit).toHaveBeenCalledTimes(4); expect(queue).toHaveBeenCalledTimes(2)
  changed.mockClear()
  editor().focus()
  // Execute the inventory's chord through the real editor. A stale declaration must fail here,
  // even though the editor's default keymap (rather than the Composer matcher) inserts the newline.
  const newline = COMPOSER_KEYBOARD_BINDINGS.find(binding => binding.id === 'message-tool.newline')!.chord
  await press(newline.key === 'enter' ? 'Enter' : newline.key, { shiftKey: newline.shift, altKey: newline.alt, metaKey: newline.primary })
  expect(changed).toHaveBeenCalled()
  expect(changed.mock.lastCall![0]).toContain('\n')
  expect(submit).toHaveBeenCalledTimes(4); expect(queue).toHaveBeenCalledTimes(2); expect(interrupt).not.toHaveBeenCalled()
})

it('real shared editor routes arrows to suggestions first and otherwise to this Agent history', async () => {
  const history = vi.fn((_direction: 'older' | 'newer', _draft: string, _caret: number) => 'remembered'), select = vi.fn(), submit = vi.fn()
  await dom.render(<AgentComposer value="/r" onChange={() => {}} disabled={false} placeholder="Message"
    commands={[{ text: '/review', description: 'Review' }, { text: '/retry', description: 'Retry' }]}
    onHistoryRecall={history} onSelectSuggestion={select} onSubmit={submit} />)
  await press('ArrowDown')
  expect(document.activeElement?.textContent).toContain('/review')
  await press('ArrowUp', {}, document.activeElement as HTMLElement)
  expect(document.activeElement?.textContent).toContain('/retry')
  await press('Enter', {}, document.activeElement as HTMLElement)
  expect(select).toHaveBeenCalledWith('/retry', 'command'); expect(submit).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled()
  await press('Escape')
  expect(dom.container.querySelector('[role="listbox"]')).toBeNull()
  expect(document.activeElement).toBe(editor())
  await dom.render(<AgentComposer value="draft" onChange={() => {}} disabled={false} placeholder="Message" onHistoryRecall={history} />)
  await press('ArrowUp'); await press('ArrowDown')
  expect(history.mock.calls.map(call => call[0])).toEqual(['older', 'newer'])
  await press('ArrowUp', { altKey: true }); await press('ArrowDown', { shiftKey: true })
  expect(history).toHaveBeenCalledTimes(2)
})

it('the shared matcher retains all four IME evidence forms and leaves modified history keys to the editor', () => {
  const key = { key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
  for (const marker of [{ isComposing: true }, { keyCode: 229 }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
    expect(matchComposerShortcut({ ...key, ...marker })).toBeNull()
  }
  expect(matchComposerShortcut(key)).toBe('message-tool.send')
  for (const modifier of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
    expect(matchComposerShortcut({ ...key, key: 'ArrowUp', ...modifier })).toBeNull()
  }
})

it('real shared editor expands a keyword at the caret and leaves normal Tab focus traversal alone', async () => {
  const change = vi.fn(), select = vi.fn(() => 'expanded prompt')
  await dom.render(<AgentComposer value="review" onChange={change} disabled={false} placeholder="Message"
    promptKeywords={[{ text: 'review', description: 'Review' }]} onSelectSuggestion={select} />)
  const input = editor() as HTMLElement & { editor: import('@tiptap/core').Editor }
  input.focus()
  await act(async () => { input.editor.commands.setTextSelection(input.editor.state.doc.content.size - 1) })
  expect((await press('Tab')).defaultPrevented).toBe(true)
  expect(change).toHaveBeenCalledWith('expanded prompt')
  expect(select).toHaveBeenCalledWith('review', 'keyword')
  await dom.render(<AgentComposer value="ordinary" onChange={change} disabled={false} placeholder="Message" />)
  expect((await press('Tab')).defaultPrevented).toBe(false)
})

it('both the global inventory and the filtered Message Tool settings render the actual shared keys and searchable conditions', async () => {
  await dom.render(<KeyboardShortcutsPane />)
  expect(dom.container.querySelector('[data-shortcut-group="message-tool"] h3')?.textContent).toBe('Message Tool')
  const binding = (id: string) => dom.container.querySelector(`[data-binding-id="${id}"]`)!
  expect([...binding('message-tool.send').querySelectorAll('kbd')].map(key => key.textContent)).toEqual(['Enter'])
  expect(binding('message-tool.send-immediately').textContent).toContain('Does not interrupt')
  expect(binding('message-tool.previous').textContent).toContain('this Agent’s history')
  await dom.render(<KeyboardShortcutsPane group="message-tool" />)
  expect(dom.container.querySelectorAll('[data-binding-id]')).toHaveLength(7)
  expect(dom.container.querySelector('h3')).toBeNull()
  expect(dom.container.querySelector('[data-shortcut-group="terminal"]')).toBeNull()
  const search = dom.container.querySelector<HTMLInputElement>('input[aria-label="Find a command or shortcut"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'steer')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-binding-id]')].map(row => row.dataset.bindingId)).toEqual(['message-tool.send-immediately'])
})
