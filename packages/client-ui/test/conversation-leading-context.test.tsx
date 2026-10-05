// @vitest-environment happy-dom
import { fixtureIso } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composeOutboundMessage } from '@agentmux/core/agent-outbound-message'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage.js'
import { speakerOfUserMessage, type ConversationSpeaker } from '../src/lib/conversation-speaker.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'

const { markdownInputs } = vi.hoisted(() => ({ markdownInputs: [] as string[] }))
vi.mock('../src/components/AgentMarkdown.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/components/AgentMarkdown.js')>()
  return { ...actual, AgentMarkdown: (props: Parameters<typeof actual.AgentMarkdown>[0]) => {
    markdownInputs.push(props.content)
    return <actual.AgentMarkdown {...props} />
  } }
})

const context = composeOutboundMessage({ amux: 'Original <application> context & escaped [Message from Agent example].' })
const header = '[Message from Agent declared-agent]'
const body = '\n\n# Original **body**\n\n    indented code  \n'
const raw = context + '\n\n' + header + '\n' + body
let element: HTMLDivElement, root: Root
const copy = vi.fn<ClientUiPlatform['copyText']>(async () => true)
const readDetails = vi.fn(() => ({ sessionId: 'declared-agent', label: 'Current declared Agent', providerId: 'codex', createdAt: 1, goals: [] }))
const describe = vi.fn((speaker: ConversationSpeaker) => ({ name: speaker.id === 'declared-agent' ? 'Current declared Agent' : 'Recorded Agent', readDetails }))
const platform: ClientUiPlatform = {
  copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ speaker }) => <span data-avatar-role={speaker.role} data-avatar-id={speaker.id} />,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  copy.mockClear(); describe.mockClear(); readDetails.mockClear(); markdownInputs.length = 0
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => {
  await act(async () => root.unmount()); element.remove(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals()
})
async function render(content: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{content}</ClientUiProvider>)) }
function find(selector: string, parent: ParentNode = element): HTMLElement {
  const found = parent.querySelector<HTMLElement>(selector); expect(found, `Actual mounted ${selector}`).not.toBeNull(); return found!
}
async function click(selector: string) { await act(async () => find(selector).click()) }
function card(props: Partial<ConversationMessageProps> = {}) {
  return <ConversationMessage messageId="original-record" content={raw} speaker={{ role: 'unknown', id: 'unknown' }}
    conversationSessionId="recipient" inputSource={{ kind: 'native', providerId: 'codex', nativeSessionId: 'native-session', recordId: 'original-record' }}
    describeSpeaker={describe} status="complete" {...props} />
}

it.each(['claude', 'codex'] as const)('reads a projected %s native record as a declared Agent while its recorded author stays unknown', async providerId => {
  const message = projectSessionUserMessages({ agentSessionId: 'recipient', historyPage: {
    agentSessionId: 'recipient', source: { providerId, nativeSessionId: 'native-session' }, nextCursor: null,
    items: [{ id: 'original-record', kind: 'user-message', contentParts: [{ kind: 'text', text: raw }] }]
  } })[0]!
  await render(card({ speaker: speakerOfUserMessage(message), inputSource: message.source, content: message.contentParts }))
  expect(find('.log-turn__who').textContent).toContain('Current declared Agent')
  expect(find('.log-turn__meta').textContent).toContain('Declared source')
  expect(find('[data-avatar-role]').dataset.avatarId).toBe('declared-agent')
  expect(find('.log-turn__declared-context pre').textContent).toBe(context)
  expect(element.querySelectorAll('.log-turn__declared-context')).toHaveLength(1)
  expect(find('.md-heading').textContent).toBe('# Original body')
  expect(find('pre code').textContent).toBe('indented code  ')
  expect(find('.log-turn__body').textContent).not.toContain(header)
  expect(readDetails).not.toHaveBeenCalled()
  await click('[aria-label="Message details"]')
  expect(find('.conversation-input-details__body').textContent).toContain('Not recorded · source declared in message')
  expect(find('.conversation-input-details__body').textContent).toContain('This lookup does not authenticate its author')
  expect(find('.conversation-input-details__body').textContent).toContain('original-record')
  expect(message.author).toEqual({ kind: 'unknown' })
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(raw, expect.any(Function))
})

it('retains authored leading body newlines in the actual Markdown input and preserves reading DOM across status updates', async () => {
  await render(card())
  // Observe the real Markdown consumer's input, then delegate to its actual rendering.
  const plainBody = '\n\nOriginal plain body  \n'
  const plainRaw = context + '\n\n' + header + '\n' + plainBody
  await render(card({ content: plainRaw }))
  const paragraph = find('.log-turn__body .md-input p')
  expect(markdownInputs).toContain(plainBody)
  expect(paragraph.textContent).toContain('Original plain body')
  const selection = window.getSelection()!, range = document.createRange()
  range.selectNodeContents(paragraph); selection.removeAllRanges(); selection.addRange(range)
  const selectedText = selection.toString(), node = selection.anchorNode
  const disclosure = find('.log-turn__declared-context') as HTMLDetailsElement
  disclosure.open = true
  await render(card({ content: plainRaw, status: 'streaming' }))
  expect(find('.log-turn__body .md-input p')).toBe(paragraph)
  expect(find('.log-turn__declared-context')).toBe(disclosure)
  expect(disclosure.open).toBe(true)
  expect(selection.anchorNode).toBe(node)
  expect(selection.toString()).toBe(selectedText)
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(plainRaw, expect.any(Function))
})

it('keeps the captured Agent authoritative over a different declaration and copies every original byte', async () => {
  const message = projectSessionUserMessages({ agentSessionId: 'recipient', timeline: { agentSessionId: 'recipient', revision: 1,
    items: [{ id: 'captured', agentSessionId: 'recipient', kind: 'user_message', status: 'complete', source: 'user', title: 'Original submission', content: raw,
      authorAgentSessionId: 'recorded-agent', createdAt: 1, updatedAt: 1 }] } })[0]!
  await render(card({ speaker: speakerOfUserMessage(message), inputSource: message.source, content: message.contentParts }))
  expect(find('.log-turn__who').textContent).toContain('Recorded Agent')
  expect(find('[data-avatar-role]').dataset.avatarId).toBe('recorded-agent')
  expect(element.textContent).not.toContain('Declared source')
  expect(find('.log-turn__declared-source').textContent).toBe('Message header: Agent declared-agent')
  await click('[aria-label="Message details"]')
  const facts = find('.conversation-input-details__facts')
  expect([...facts.querySelectorAll('dt')].map(label => [label.textContent, label.nextElementSibling?.textContent])).toContainEqual(['Recorded author', 'agent'])
  expect(message.author).toEqual({ kind: 'agent', agentSessionId: 'recorded-agent' })
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(raw, expect.any(Function))
})

it('uses the existing declared packet reading, explicit source marker, original contexts and raw Copy', async () => {
  const packet = ("<bagakit-msg type=\"note\" name=\"Packet writer\" time=\"" + fixtureIso() + "\">Original <cite from=\"document\" ref=\"entry:1\">quoted &amp; exact</cite> tail</bagakit-msg>")
  const input = context + '\n\n' + header + '\n' + packet
  await render(card({ content: input }))
  expect(find('.log-turn__meta').textContent).toContain('Declared source')
  expect(find('.log-turn__citation').textContent).toContain('quoted & exact')
  expect(find('.log-turn__citation-ref').textContent).toBe('entry:1')
  expect(find('.log-turn__declared-context pre').textContent).toBe(context)
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(input, expect.any(Function))
})

it('retains the declared source when complete native text is explicitly expanded and keeps its exact resource identity and Copy', async () => {
  const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: raw })), hash = createHash('sha256').update(bytes).digest('hex')
  const record = { source: { providerId: 'codex', nativeSessionId: 'native-session' }, recordId: 'original-record', turnId: 'original-turn' }
  const part = { kind: 'resource', resourceType: 'text', reference: 'original:content',
    content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256: hash } } as const
  const read = vi.fn<NonNullable<ConversationMessageProps['readHistoryResource']>>(async input => ({
    agentSessionId: 'recipient', ...record, partIndex: input.partIndex, reference: part.reference,
    result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'), byteLength: bytes.length,
      offsetBytes: 0, totalBytes: bytes.length, sha256: hash, nextOffsetBytes: null }
  }))
  await render(card({ content: [part], nativeResourceRecord: record, readHistoryResource: read,
    inputSource: { kind: 'native', ...record.source, recordId: record.recordId } }))
  expect(read).not.toHaveBeenCalled()
  await click('.conversation-resource-text button')
  expect(read).toHaveBeenCalledExactlyOnceWith({ ...record, partIndex: 0, expectedReference: part.reference, offsetBytes: 0, maxBytes: 128 * 1024 })
  expect(find('.conversation-resource-text .log-turn__declared-source').textContent).toBe('Message header: Agent declared-agent')
  expect(find('.conversation-resource-text .log-turn__declared-context pre').textContent).toBe(context)
  expect(markdownInputs).toContain(body)
  expect(find('.log-turn__who').textContent).toBe('You')
  await click('[aria-label="Message details"]')
  expect(find('.conversation-input-details__facts').textContent).toContain('Not recorded · shown as You')
  await click('.conversation-resource-text__controls button')
  expect(copy).toHaveBeenCalledExactlyOnceWith(raw, expect.any(Function))
})

it.each(['    ', '> ', '```text\n'])('does not promote a %j quoted or code sender after valid contexts', async prefix => {
  const tail = prefix + header + '\nLiteral example' + (prefix.startsWith('```') ? '\n```' : '')
  await render(card({ content: context + '\n\n' + tail }))
  expect(find('.log-turn__who').textContent).toBe('You')
  expect(find('[data-avatar-role]').dataset.avatarRole).toBe('human')
  expect(element.textContent).not.toContain('Declared source')
  expect(find('.log-turn__body').textContent).toContain(header)
})

it('keeps incomplete declarations literal and ordinary native input on its existing You display default', async () => {
  const incomplete = '<amux from="amux">Unclosed\n\n' + header + '\nOriginal body'
  await render(card({ content: incomplete }))
  expect(element.querySelector('.log-turn__declared-context')).toBeNull()
  expect(find('.log-turn__body').textContent).toContain('<amux from="amux">')
  expect(find('.log-turn__body').textContent).toContain(header)
  await render(card({ content: 'Ordinary original native input' }))
  expect(find('.log-turn__who').textContent).toBe('You')
  await click('[aria-label="Message details"]')
  expect(find('.conversation-input-details__facts').textContent).toContain('Not recorded · shown as You')
})
