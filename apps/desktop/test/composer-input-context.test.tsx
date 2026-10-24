// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
beforeEach(() => {
  const matches = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (selector) { return selector === ':popover-open' ? false : matches.call(this, selector) })
})
const editor = () => dom.container.querySelector<HTMLElement>('[role="textbox"]')! as HTMLElement & { editor: Editor }

it('a standalone Session input adapter never discovers or manages connections or conversation-sync presentation', async () => {
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


it('original pending feedback remains above the rich composer without taking its selection, focus, IME or draft', async () => {
  const connection = vi.spyOn(api.connections, 'call').mockRejectedValue(new Error('Pending input has no connection capability'))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const original = editor(), rich = original.editor, draft = dom.draft()
  await act(async () => { original.focus(); rich.commands.setTextSelection({ from: 2, to: 6 }); original.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })) })
  const selection = rich.state.selection.toJSON()
  const pending = { operationId: 'retained-original', runId: 'run-agent-1', text: 'Original pending input', status: 'deferred' as const, promptCondition: null, errorCode: 'AGENT_EXECUTION_NOT_REQUESTED' }
  await act(async () => useAppStore.setState({ agentSteerQueues: { 'agent-1': [pending] } }))
  const strip = document.querySelector('.composer-pending:not([hidden])')!
  expect(strip).not.toBeNull()
  expect(strip.getAttribute('data-operation-id')).toBe(pending.operationId)
  expect(strip.closest('[data-agent-composer]')).toBeNull()
  expect(dom.container.querySelector('.conversation-sharing-notice')).toBeNull()
  expect(editor()).toBe(original); expect(editor().editor).toBe(rich)
  expect(document.activeElement).toBe(original); expect(rich.view.composing).toBe(true)
  expect(rich.state.selection.toJSON()).toEqual(selection); expect(dom.draft()).toBe(draft)
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([pending])
  expect(connection).not.toHaveBeenCalled()
  await act(async () => original.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })))
})
