// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const editor = () => dom.container.querySelector<HTMLElement>('[role="textbox"]')! as HTMLElement & { editor: Editor }

it('a standalone Session input adapter never discovers or manages connections without host input context', async () => {
  const connection = vi.spyOn(api.connections, 'call').mockRejectedValue(new Error('No connection owner is installed for this standalone input'))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(editor()).not.toBeNull()
  expect(editor().getAttribute('contenteditable')).toBe('true')
  await act(async () => { editor().focus(); editor().editor.commands.insertContent(' Continue') })
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, composerSession('unrelated-input')] })))
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible={false} />)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(connection).not.toHaveBeenCalled()
  expect(dom.container.querySelector('.conversation-sharing-notice')).toBeNull()
  expect(dom.container.textContent).not.toContain('Connect group')
  expect(dom.draft()).toContain('Continue')
})

it('generic host input context updates through the real rich composer without taking its selection, focus, IME or draft', async () => {
  const connection = vi.spyOn(api.connections, 'call').mockRejectedValue(new Error('Generic input context has no connection capability'))
  await dom.render(<AgentSessionComposer sessionId="agent-1" inputContext={<span data-input-context="first">Review context</span>} />)
  const original = editor(), rich = original.editor, draft = dom.draft()
  const slot = dom.container.querySelector('[data-input-context="first"]')!
  expect(slot).not.toBeNull()
  expect(dom.container.querySelector('[data-agent-composer]')).not.toBeNull()
  expect(slot.compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  await act(async () => { original.focus(); rich.commands.setTextSelection({ from: 2, to: 6 }); original.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })) })
  const selection = rich.state.selection.toJSON()
  await dom.render(<AgentSessionComposer sessionId="agent-1" inputContext={<span data-input-context="next">Updated review context</span>} />)
  expect(dom.container.querySelector('[data-input-context="next"]')?.textContent).toBe('Updated review context')
  expect(dom.container.querySelector('[data-input-context="first"]')).toBeNull()
  expect(editor()).toBe(original); expect(editor().editor).toBe(rich)
  expect(document.activeElement).toBe(original); expect(rich.view.composing).toBe(true)
  expect(rich.state.selection.toJSON()).toEqual(selection); expect(dom.draft()).toBe(draft)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(dom.container.querySelector('[data-input-context]')).toBeNull()
  expect(editor()).toBe(original); expect(dom.draft()).toBe(draft)
  expect(connection).not.toHaveBeenCalled()
  await act(async () => original.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })))
})
