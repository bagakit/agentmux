import { fixtureClock, fixtureDay } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { composeAgentLaunchPrompt, composeOutboundMessage } from '../src/agent-outbound-message.js'
import { parseAgentMuxMessagePrefix } from '../src/agent-message-render.js'
import { projectSessionUserMessages } from '../src/session-user-messages.js'

const sender = 'origin-session'
const header = `[Message from Agent ${sender}]`
const context = composeOutboundMessage({ amux: 'Application note with <literal> & a quoted [Message from Agent example].' })
const packet = ("<bagakit-msg type=\"note\" name=\"Declared writer\" time=\"" + (fixtureDay(1) + "T" + fixtureClock(10, 0, 0) + "Z") + "\">\nOriginal <cite from=\"source\" ref=\"entry:1\">quoted &amp; exact</cite>\nTail  \n</bagakit-msg>")

describe('leading application contexts compose with the existing source grammar', () => {
  it.each(['\n', '\r\n'])('reads the actual launch producer with %j sender newline without changing the authored body', newline => {
    const body = `${newline}${newline}  Original <body> & text  ${newline}last${newline}`
    const input = composeAgentLaunchPrompt(header + newline + body, true, 'Independent launch note.').text
    const parsed = parseAgentMuxMessagePrefix(input)!
    expect(parsed).not.toBeNull()
    expect(parsed.sourceLabel).toBe(`Agent ${sender}`)
    expect(parsed.declaredAgentSessionId).toBe(sender)
    expect(parsed.declaredContexts).toHaveLength(1)
    expect(parsed.declaredContexts![0]!.raw).toContain('&lt;canonical Session ID&gt;')
    expect(input).toBe(parsed.declaredContexts![0]!.raw + '\n\n' + header + newline + body)
    expect(Buffer.from(parsed.body)).toEqual(Buffer.from(body))
  })

  it('keeps every raw context span and ignores escaped example headers within them', () => {
    const second = composeOutboundMessage({ amux: '[Message from Agent misleading-example]\n<amux from="amux">literal</amux>' })
    const body = '\n\n# Original tail\n    indented  \n'
    const parsed = parseAgentMuxMessagePrefix(context + '\r\n\r\n' + second + '\n\n' + header + '\n' + body)!
    expect(parsed.declaredContexts).toEqual([{ raw: context }, { raw: second }])
    expect(parsed.declaredAgentSessionId).toBe(sender)
    expect(parsed.body).toBe(body)
  })

  it.each(['', header + '\r\n'])('reuses the complete packet grammar after contexts and prefix %j', prefix => {
    const original = parseAgentMuxMessagePrefix(prefix + packet)!
    expect(original.packet).toBeDefined()
    const parsed = parseAgentMuxMessagePrefix(context + '\n\n' + prefix + packet)!
    expect(parsed).toEqual({ ...original, declaredContexts: [{ raw: context }] })
    expect(parsed.packet!.parts).toEqual([
      { kind: 'text', text: '\nOriginal ' },
      { kind: 'citation', from: 'source', reference: 'entry:1', text: 'quoted & exact' },
      { kind: 'text', text: '\nTail  \n' }
    ])
  })

  it('keeps an unverified process label as a declaration without inventing a Session ID', () => {
    const parsed = parseAgentMuxMessagePrefix(context + '\n\n[Message from unverified local process]\nOriginal body\n')!
    expect(parsed.sourceLabel).toBe('unverified local process')
    expect(parsed.declaredAgentSessionId).toBeNull()
    expect(parsed.body).toBe('Original body\n')
  })

  it.each([
    '', '\n\nplain tail  \n', '\n\n    ' + header + '\nindented example',
    '\n\n> ' + header + '\nquoted example', '\n\n```text\n' + header + '\ncode\n```',
    '\n\n' + header, '\n\n' + header + '\n',
    '\n\n' + header + '\n<bagakit-msg type="note">incomplete',
    '\n\n<bagakit-msg type="note" name="Invalid" time="not-a-time">body</bagakit-msg>'
  ])('leaves unrecognized or incomplete tail %j unchanged after complete contexts', tail => {
    expect(parseAgentMuxMessagePrefix(context + tail)).toEqual({
      sourceLabel: '', declaredAgentSessionId: null, declaredContexts: [{ raw: context }], body: tail
    })
  })

  it.each([
    '<amux from="amux">unclosed', '<amux from="other">body</amux>',
    '<amux from="amux"><nested>body</nested></amux>',
    '<amux from="amux"><!-- comment -->body</amux>',
    context + '\n\n<amux from="amux">unclosed', context + '\n\n<amux from="other">body</amux>',
    '> ' + context, '    ' + context, '```xml\n' + context + '\n```'
  ])('does not hide invalid, quoted, or code-leading input %j', input => {
    expect(parseAgentMuxMessagePrefix(input + '\n\n' + header + '\noriginal body')).toBeNull()
  })

  it.each(['claude', 'codex'] as const)('does not authenticate %s native input or overwrite a captured author', providerId => {
    const input = context + '\n\n' + header + '\noriginal body'
    const messages = projectSessionUserMessages({ agentSessionId: 'recipient', historyPage: {
      agentSessionId: 'recipient', source: { providerId, nativeSessionId: 'native-session' }, nextCursor: null,
      items: [{ id: 'native-record', kind: 'user-message', contentParts: [{ kind: 'text', text: input }] }]
    }, timeline: { agentSessionId: 'recipient', revision: 1, items: [{ id: 'captured-record', agentSessionId: 'recipient',
      kind: 'user_message', status: 'complete', source: 'user', title: 'Original submission', content: input, authorAgentSessionId: 'recorded-agent', createdAt: 1, updatedAt: 1 }] } })
    expect(messages.map(message => message.author)).toEqual([{ kind: 'unknown' }, { kind: 'agent', agentSessionId: 'recorded-agent' }])
    expect(messages.map(message => message.content)).toEqual([input, input])
    expect(messages.map(message => message.rawId)).toEqual(['native-record', 'captured-record'])
    expect(parseAgentMuxMessagePrefix(messages[0]!.content)?.declaredAgentSessionId).toBe(sender)
  })
})
