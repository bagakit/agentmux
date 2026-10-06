// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { ConversationNativeThread } from '@agentmux/client-ui/components/ConversationNativeThread'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { projectConversationRecords } from '@agentmux/client-ui/conversation-records'
import { buildNativeContinuationPrompt } from '@agentmux/client-ui/native-continuation'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'

const body = '<environment_context>\n<timezone>Example/Zone</timezone>\n</environment_context>'
const page: AgentSessionHistoryPage = {
  agentSessionId: 'reader', source: { providerId: 'codex', nativeSessionId: 'native-reader' }, nextCursor: null,
  items: [
    { id: 'system', kind: 'system-message', title: 'Runtime context', contentParts: [{ kind: 'text', text: body }] },
    { id: 'user', kind: 'user-message', contentParts: [{ kind: 'text', text: body }] },
    { id: 'answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Ready for the next task.' }] }
  ]
}
const describeSpeaker = createSpeakerResolver({ currentSession: { id: 'reader', label: 'Agent', providerId: 'codex' } })
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

it.each([ConversationView, ConversationNativeThread])('renders Provider system records through the shared conversation consumer', async View => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const continueConversation = vi.fn()
  await act(async () => root.render(<View page={page} sessionId="reader" describeSpeaker={describeSpeaker} onContinue={continueConversation} />))
  const system = container.querySelector<HTMLElement>('[data-native-record-id="system"]')!
  expect(system).not.toBeNull()
  expect(system.querySelector('[data-speaker-role="system"]')).not.toBeNull()
  expect(system.querySelector('.conversation-avatar--system')?.getAttribute('aria-label')).toBe('codex')
  expect(system.querySelector('.log-turn__system-title')?.textContent).toBe('codex · Runtime context')
  expect(system.querySelector('.log-turn__body')).toBeNull()
  expect(system.querySelector('[title*="Continue"]')).toBeNull()
  const toggle = system.querySelector<HTMLButtonElement>('.log-turn__system-toggle')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  toggle.focus(); expect(document.activeElement).toBe(toggle)
  await act(async () => system.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(body)
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(system.querySelector('.log-turn__body')?.textContent).toContain('Example/Zone')
  expect(system.querySelector('.log-turn__body')?.id).toBe(toggle.getAttribute('aria-controls'))
  await act(async () => toggle.click())
  expect(system.querySelector('.log-turn__body')).toBeNull()
  expect(container.querySelector('[data-native-record-id="user"] [data-speaker-role="system"]')).toBeNull()
  expect(container.querySelector('[data-native-record-id="answer"] [data-speaker-role="agent"]')).not.toBeNull()
  expect(continueConversation).not.toHaveBeenCalled()
})

it('keeps system records in source order without adding them to user input or changing their exact text', () => {
  const records = projectConversationRecords({ agentSessionId: 'reader', historyPage: page })
  expect(records.map(record => [record.rawId, record.kind])).toEqual([
    ['system', 'system-message'], ['user', 'user-message'], ['answer', 'assistant-message']
  ])
  expect(records[0]!.speaker).toEqual({ role: 'system', id: 'codex' })
  expect(records[0]!.input).toBeUndefined()
  expect(records[0]!.contentParts).toBe(page.items[0]!.contentParts)
  expect(projectSessionUserMessages({ agentSessionId: 'reader', historyPage: page }).map(message => message.rawId)).toEqual(['user'])
  expect(describeSpeaker({ role: 'system', id: 'agentmux' }).name).toBe('AgentMux')
  expect(describeSpeaker({ role: 'system', id: page.source.providerId }).name).toBe('codex')
  expect(buildNativeContinuationPrompt(page, page.items[1]!)).toBe(
    `Continue this conversation from the selected point.\n\nRecorded system context: ${body}\n\nInput: ${body}`)
})

it.each([ConversationView, ConversationNativeThread])('reads and copies complete system resources with the original record identity', async View => {
  const exact = body.repeat(3000), bytes = Buffer.from(JSON.stringify({ kind: 'text', text: exact }))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const record = { source: { providerId: 'fixture-provider', nativeSessionId: 'original-native-session' },
    recordId: 'original-record', turnId: 'original-turn' }
  const part = { kind: 'resource', resourceType: 'text', reference: 'original:content',
    content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256 } } as const
  const read = vi.fn<NonNullable<ComponentProps<typeof ConversationView>['readHistoryResource']>>(async input => {
    const offset = input.offsetBytes ?? 0, chunk = bytes.subarray(offset, offset + (input.maxBytes ?? 128 * 1024))
    return { agentSessionId: 'original-core-session', ...record, partIndex: input.partIndex, reference: part.reference,
      result: { status: 'fragment', encoding: 'json-utf8', dataBase64: chunk.toString('base64'), byteLength: chunk.length,
        offsetBytes: offset, totalBytes: bytes.length, sha256, nextOffsetBytes: offset + chunk.length === bytes.length ? null : offset + chunk.length } }
  })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const resourcePage: AgentSessionHistoryPage = { agentSessionId: 'original-core-session', source: record.source, nextCursor: null,
    items: [{ id: record.recordId, turnId: record.turnId, kind: 'system-message', contentParts: [part] }] }
  await act(async () => root.render(<View page={resourcePage} sessionId={resourcePage.agentSessionId} readHistoryResource={read}
    describeSpeaker={() => ({ name: 'Unrelated host label' })} />))
  expect(container.querySelector('.log-turn__system-title')?.textContent).toBe('fixture-provider · System record')
  expect(read).not.toHaveBeenCalled()
  await act(async () => container.querySelector<HTMLButtonElement>('[title="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(exact)
  expect(read.mock.calls[0]?.[0]).toEqual({ ...record, partIndex: 0, expectedReference: part.reference,
    offsetBytes: 0, maxBytes: 128 * 1024 })
  expect(read.mock.calls.length).toBeGreaterThan(1)
  await act(async () => container.querySelector<HTMLButtonElement>('.log-turn__system-toggle')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('.conversation-resource-text button')!.click())
  expect(container.querySelector('.conversation-resource-text .log-turn__text')?.textContent).toContain('Example/Zone')
})
