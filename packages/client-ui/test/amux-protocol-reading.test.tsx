// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { renderAgentMuxMessageEnvelope, renderAgentMuxMessageReferences } from '@agentmux/core/agent-message-render'
import { composeOutboundMessage } from '@agentmux/core/agent-outbound-message'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import type { ConversationSpeaker } from '../src/lib/conversation-speaker.js'

let host: HTMLDivElement, root: Root
const copy = vi.fn(async () => true), open = vi.fn(), readImage = vi.fn()
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ speaker }) => <span data-original-avatar-role={speaker.role} data-original-avatar-id={speaker.id} />,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks() })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function render(node: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
async function click(selector: string) {
  const target = host.querySelector<HTMLElement>(selector); expect(target).not.toBeNull()
  await act(async () => target!.click())
}
async function message(content: ConversationMessageProps['content'], speaker: ConversationSpeaker, extra: Partial<ConversationMessageProps> = {}) {
  await render(<ConversationMessage content={content} speaker={speaker} messageId="original-record" conversationSessionId="reader" recordedIdentity
    openHttpLink={open} readPastedImage={readImage} {...extra} />)
  if (speaker.role === 'system') await click('.log-turn__system-toggle')
}
const authors: ConversationSpeaker[] = [{ role: 'human', id: 'human' }, { role: 'unknown', id: 'unknown' },
  { role: 'agent', id: 'peer' }, { role: 'agent', id: 'reader' }, { role: 'system', id: 'original-system' }]
const full = renderAgentMuxMessageEnvelope({ messageId: 'MID', sender: { kind: 'agent-session', agentSessionId: 'declared' }, senderSessionId: 'declared', body: 'Original **message**.' })
const references = renderAgentMuxMessageReferences([{ senderSessionId: 'declared', messageId: 'MID' }])

it.each(authors)('reads the same pure protocols without changing original $role/$id authorship', async author => {
  for (const [wire, kind] of [['<amux:continue />', 'continue'], ['<amux:reaction ok />', 'reaction'],
    ['<amux:new-type value="original">&unknown; <amux:continue /></amux:new-type>', 'generic'], [full, 'a2a'], [references, 'a2a-reference']]) {
    // A different record remount is not required: identity, card and system disclosure remain local.
    await render(<div />)
    await message(wire!, author)
    expect(host.querySelectorAll('.conversation-protocol')).toHaveLength(1)
    expect(host.querySelector('.conversation-protocol')?.getAttribute('data-protocol-kind')).toBe(kind)
    expect(host.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe(author.role)
    expect(host.querySelector('[data-original-avatar-id]')?.getAttribute('data-original-avatar-id')).toBe(author.id)
    expect(host.querySelector('[data-a2a-notification-id]')).toBeNull()
    expect(open).not.toHaveBeenCalled(); expect(readImage).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled()
  }
})

it.each(authors)('retains journal body boundaries for $role/$id, including pure marker examples', async author => {
  await message('<amux:continue />', author, { contentBoundary: 'body' })
  expect(host.querySelector('.conversation-protocol')).toBeNull()
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('<amux:continue />')
})

it('keeps platform-escaped reaction examples as one context and preserves the original request', async () => {
  const wire = composeOutboundMessage({ amux: '<amux:reaction ok />', user: 'Original selected meaning.' })
  await message(wire, authors[3]!)
  expect(host.querySelectorAll('.log-turn__declared-context')).toHaveLength(1)
  expect(host.querySelector('.conversation-protocol')).toBeNull()
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('Original selected meaning.')
})

it('does not broaden a typed notice to non-reference semantics or join parts', async () => {
  await message('<amux:continue />', authors[0]!, { a2aNotificationId: 'original-notice' })
  expect(host.querySelector('.conversation-protocol')).toBeNull()
  await message([{ kind: 'text', text: 'Original ordinary text.' }, { kind: 'text', text: '<amux:continue />' }], authors[0]!)
  expect(host.querySelector('.conversation-protocol')).toBeNull()
})

it.each(['incoming', 'reply', 'question-answer'])('reads full original resources on demand and preserves their %s reading boundary', async reading => {
  const wire = '<amux:resource-type key="value">Original content.</amux:resource-type>'
  const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: wire })), sha256 = createHash('sha256').update(bytes).digest('hex')
  const record = { source: { providerId: 'codex', nativeSessionId: 'original-native' }, recordId: 'original-record' }
  const part = { kind: 'resource', resourceType: 'text', reference: 'original:text', content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256 } } as const
  const read = vi.fn<NonNullable<ConversationMessageProps['readHistoryResource']>>(async input => ({ agentSessionId: 'reader', ...record,
    partIndex: input.partIndex, reference: input.expectedReference!, result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'),
      byteLength: bytes.length, offsetBytes: 0, totalBytes: bytes.length, sha256, nextOffsetBytes: null } }))
  await message([part], reading === 'incoming' ? authors[0]! : authors[3]!, {
    nativeResourceRecord: record, readHistoryResource: read,
    ...(reading === 'question-answer' ? { questionAnswers: [{ questionId: 'original-question', answer: 'Original answer.' }] } : {})
  })
  expect(read).not.toHaveBeenCalled(); expect(host.querySelector('.conversation-protocol')).toBeNull()
  await click('.conversation-resource-text__controls button')
  expect(read).toHaveBeenCalledTimes(1)
  if (reading === 'question-answer') {
    expect(host.querySelector('[data-recorded-question-reply]')?.textContent).toContain('Original answer.')
    expect(host.querySelector('.conversation-protocol')).toBeNull()
    expect(host.querySelector('.conversation-resource-text')?.textContent).toContain(wire)
  } else expect(host.querySelector('[data-protocol-kind="generic"]')).not.toBeNull()
  await click('[aria-label="Copy complete content"]')
  expect(copy).toHaveBeenCalledWith(wire, expect.any(Function))
})
