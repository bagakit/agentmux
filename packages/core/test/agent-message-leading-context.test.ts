import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixtureDay, fixtureClock } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { composeAgentLaunchPrompt, composeOutboundMessage } from '../src/agent-outbound-message.js'
import { parseAgentMuxMessagePrefix, renderAgentMuxMessageEnvelope } from '../src/agent-message-render.js'
import { projectSessionUserMessages } from '../src/session-user-messages.js'

const sender = 'origin-session'
const wrap = (body: string) => renderAgentMuxMessageEnvelope({ messageId: 'original-message', sender: { kind: 'agent-session', agentSessionId: sender }, senderSessionId: sender, body })
const context = composeOutboundMessage({ amux: 'Application note with <literal> & a quoted <amux:a2a> example.' })
const packet = (`<bagakit-msg type="note" name="Declared writer" time="${fixtureDay(1)}T${fixtureClock(10, 0, 0)}Z">\nOriginal <cite from="source" ref="entry:1">quoted &amp; exact</cite>\nTail  \n</bagakit-msg>`)

describe('leading application contexts compose with the shared source grammar', () => {
  it.each(['\n', '\r\n'])('reads the actual launch producer without changing %j authored body bytes', newline => {
    const body = `${newline}${newline}  Original <body> & text  ${newline}last${newline}`
    const wire = wrap(body)
    const input = composeAgentLaunchPrompt(wire, true, 'Independent launch note.').text
    const parsed = parseAgentMuxMessagePrefix(input)!
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({ sourceLabel: `Agent ${sender}`, declaredAgentSessionId: sender, declaredMessageId: 'original-message' })
    expect(parsed.declaredContexts).toHaveLength(1)
    expect(input).toBe(parsed.declaredContexts![0]!.raw + '\n\n' + wire)
    expect(Buffer.from(parsed.body)).toEqual(Buffer.from(body))
  })

  it('keeps every raw context span and ignores escaped examples within them', () => {
    const second = composeOutboundMessage({ amux: '<amux>literal</amux>\n<amux:a2a from="example">literal</amux:a2a>' })
    const body = '\n\n# Original tail\n    indented  \n'
    const parsed = parseAgentMuxMessagePrefix(context + '\r\n\r\n' + second + '\n\n' + wrap(body))!
    expect(parsed.declaredContexts).toEqual([{ raw: context }, { raw: second }])
    expect(parsed.declaredAgentSessionId).toBe(sender)
    expect(parsed.body).toBe(body)
  })

  it.each([false, true])('reuses complete bagakit packet semantics with A2A=%j', a2a => {
    const wire = a2a ? wrap(packet) : packet
    const original = parseAgentMuxMessagePrefix(wire)!
    const parsed = parseAgentMuxMessagePrefix(context + '\n\n' + wire)!
    expect(parsed).toEqual({ ...original, declaredContexts: [{ raw: context }] })
    expect(parsed.packet!.parts).toEqual([
      { kind: 'text', text: '\nOriginal ' },
      { kind: 'citation', from: 'source', reference: 'entry:1', text: 'quoted & exact' },
      { kind: 'text', text: '\nTail  \n' }
    ])
  })

  it.each([
    '', '\n\nplain tail  \n', '\n\n    ' + wrap('indented example'), '\n\n> ' + wrap('quoted example'),
    '\n\n```text\n' + wrap('code') + '\n```', '\n\n<amux:a2a from="unfinished"',
    '\n\n[Message from Agent obsolete]\noriginal body', '\n\n<bagakit-msg type="note">incomplete'
  ])('leaves unrecognized tail unchanged after complete contexts', tail => {
    expect(parseAgentMuxMessagePrefix(context + tail)).toEqual({ sourceLabel: '', declaredAgentSessionId: null, declaredContexts: [{ raw: context }], body: tail })
  })

  it.each([
    '<amux>unclosed', '<amux from="other">body</amux>', '<amux><nested>body</nested></amux>',
    '<amux><!-- comment -->body</amux>', context + '\n\n<amux>unclosed',
    context + '\n\n<amux from="other">body</amux>', '> ' + context, '    ' + context, '```xml\n' + context + '\n```'
  ])('does not hide invalid, quoted or code-leading input', input => {
    expect(parseAgentMuxMessagePrefix(input + '\n\n' + wrap('original body'))).toBeNull()
  })

  it.each(['claude', 'codex'] as const)('never authenticates %s native declarations or overwrites a recorded author', providerId => {
    const input = context + '\n\n' + wrap('original body')
    const messages = projectSessionUserMessages({ agentSessionId: 'recipient', historyPage: {
      agentSessionId: 'recipient', source: { providerId, nativeSessionId: 'native-session' }, nextCursor: null,
      items: [{ id: 'native-record', kind: 'user-message', contentParts: [{ kind: 'text', text: input }] }]
    }, timeline: { agentSessionId: 'recipient', revision: 1, items: [{ id: 'captured-record', agentSessionId: 'recipient',
      kind: 'user_message', status: 'complete', source: 'user', title: 'Original submission', content: input, authorAgentSessionId: 'recorded-agent', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) }] } })
    expect(messages.map(message => message.author)).toEqual([{ kind: 'unknown' }, { kind: 'agent', agentSessionId: 'recorded-agent' }])
    expect(messages.map(message => message.content)).toEqual([input, input])
    expect(messages.map(message => message.rawId)).toEqual(['native-record', 'captured-record'])
    expect(parseAgentMuxMessagePrefix(messages[0]!.content)?.declaredAgentSessionId).toBe(sender)
  })
})
