// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { expect, it, vi } from 'vitest'
import { InlineComposer, documentDraft } from '../src/renderer/src/components/InlineComposer'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()

function richInput() {
  const element = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')
  expect(element).not.toBeNull()
  expect(element!.editor).toBeDefined()
  return { element: element!, editor: element!.editor }
}

it('updates the CSS attribute owner and accessible name on the same empty editor', async () => {
  const change = vi.fn()
  const render = (placeholder: string, label: string) => dom.render(<InlineComposer value="" disabled={false}
    placeholder={placeholder} aria-label={label} onValueChange={change} onKeyDown={() => {}} />)
  await render('Send to restore this Agent…', 'Restore message')
  const original = richInput()
  expect(original.element.getAttribute('data-placeholder')).toBe('Send to restore this Agent…')
  await render('Ask, steer, or paste a command…', 'Restore message')
  expect(richInput()).toEqual(original)
  expect(original.element.getAttribute('data-placeholder')).toBe('Ask, steer, or paste a command…')
  await render('Ask, steer, or paste a command…', 'Message the Agent')
  expect(richInput()).toEqual(original)
  expect(original.element.getAttribute('aria-label')).toBe('Message the Agent')
  expect(documentDraft(original.editor.getJSON())).toBe('')
  expect(change).not.toHaveBeenCalled()
})

it('keeps the document, selection, composition, scroll and undo during a hint update', async () => {
  let draft = 'alpha omega'
  const change = vi.fn((value: string) => { draft = value })
  const key = vi.fn()
  const render = (placeholder: string) => dom.render(<InlineComposer value={draft} disabled={false}
    placeholder={placeholder} aria-label="Message" onValueChange={change} onKeyDown={key} />)
  await render('Send to restore this Agent…')
  const original = richInput()
  await act(async () => {
    original.editor.commands.insertContentAt(7, 'new ')
    original.editor.commands.setTextSelection({ from: 2, to: 5 })
    original.element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  })
  expect(draft).toBe('alpha new omega')
  expect(original.editor.view.composing).toBe(true)
  const doc = original.editor.state.doc
  const selection = original.editor.state.selection.toJSON()
  const scroller = original.element
  scroller.scrollTop = 27
  const writes = change.mock.calls.length
  expect(writes).toBeGreaterThan(0)
  await render('Ask, steer, or paste a command…')
  expect(richInput()).toEqual(original)
  expect(original.element.getAttribute('data-placeholder')).toBe('Ask, steer, or paste a command…')
  expect(original.editor.state.doc).toBe(doc)
  expect(documentDraft(original.editor.getJSON())).toBe('alpha new omega')
  expect(original.editor.state.selection.toJSON()).toEqual(selection)
  expect(original.editor.view.composing).toBe(true)
  expect(scroller.scrollTop).toBe(27)
  expect(change).toHaveBeenCalledTimes(writes)
  await act(async () => original.element.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true
  })))
  expect(key).not.toHaveBeenCalled()
  await act(async () => original.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await vi.waitFor(() => expect(original.editor.view.composing).toBe(false))
  await act(async () => { expect(original.editor.commands.undo()).toBe(true) })
  expect(documentDraft(original.editor.getJSON())).toBe('alpha omega')
  expect(draft).toBe('alpha omega')
})

it.each(['', 'Keep my draft'])('converges with the real Session Store after restore with draft %j', async (draft) => {
  const send = vi.fn()
  const restore = vi.fn()
  const interrupt = vi.fn()
  const session = composerSession()
  useAppStore.setState({
    agentComposerDrafts: { 'agent-1': draft },
    sessions: [{ ...session, processState: 'exited', status: { state: 'disconnected', source: 'run-process', observedAt: 1 } }],
    send, recoverSession: restore, interrupt
  })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const original = richInput()
  expect(original.element.getAttribute('data-placeholder')).toBe('Send to restore this Agent…')
  await act(async () => useAppStore.setState({ sessions: [session] }))
  expect(richInput()).toEqual(original)
  expect(original.element.getAttribute('data-placeholder')).toBe('Ask, steer, or paste a command…')
  await act(async () => useAppStore.setState({
    sessions: [{ ...session, status: { state: 'working', source: 'native-hook', observedAt: 2 } }]
  }))
  expect(richInput()).toEqual(original)
  expect(original.element.getAttribute('data-placeholder')).toBe('Ask, steer, or paste a command…')
  expect(dom.container.querySelector('[aria-label="Interrupt the current turn"]')).not.toBeNull()
  expect(documentDraft(original.editor.getJSON())).toBe(draft)
  expect(dom.draft()).toBe(draft)
  expect(send).not.toHaveBeenCalled()
  expect(restore).not.toHaveBeenCalled()
  expect(interrupt).not.toHaveBeenCalled()
})
