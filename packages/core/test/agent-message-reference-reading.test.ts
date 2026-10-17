import { describe, expect, it } from 'vitest'
import { composeOutboundMessage } from '../src/agent-outbound-message.js'
import { parseAgentMuxMessagePrefix as parse, renderAgentMuxMessageEnvelope as full, renderAgentMuxMessageReferences as references } from '../src/agent-message-render.js'

const records = [{ senderSessionId: 'first-source', messageId: 'first-message' }, { senderSessionId: 'second-source', messageId: 'second-message' }]
const short = (body: string) => full({ sender: { kind: 'agent-session', agentSessionId: 'first-source' }, senderSessionId: 'first-source', messageId: 'first-message', body })
const long = (body: string) => '<amux>\n' + short(body).replace(/^<amux:a2a/u, '<a2a').replace(/<\/amux:a2a>$/u, '</a2a>') + '\n</amux>'
const row = '<a2a from="first-source" msg-id="first-message" read-via="message --skill" />'
const container = (content: string) => `<amux>\n${content}\n</amux>`
const context = composeOutboundMessage({ amux: 'Separate <literal> context & text.' })

describe('A2A reference and full-content reading boundaries', () => {
  it.each([short, long])('keeps opaque content independent of nested protocol examples', format => {
    for (const body of ['', '\n  original\r\n\tlast  \n', 'arbitrary <body> & &#13; text',
      '</amux>\n</a2a>\n</amux:a2a>', '<!DOCTYPE authored>\n<?authored?>',
      'before\n<reminder>authored</reminder>\nafter', short('complete nested example'),
      long('complete nested container'), references(records), 'long content '.repeat(20_000)]) {
      const input = format(body), reading = parse(input)!
      expect(reading.kind).toBe('content')
      expect(reading.body).toBe(body)
      expect(reading.declaredAgentSessionId).toBe('first-source')
      expect(reading.declaredMessageId).toBe('first-message')
      expect(reading.references).toBeUndefined()
      const leading = parse(context + '\n\n' + input)!
      expect(leading.body).toBe(body)
      expect(leading.declaredContexts).toEqual([{ raw: context }])
    }
  })

  it('uses the canonical single-reference shorthand without inventing a notification author or body', () => {
    const wire = references(records.slice(0, 1))
    expect(wire).toBe('<amux:a2a from="first-source" msg-id="first-message" read-via="message --skill" />')
    expect(parse(wire)).toEqual({ kind: 'references', sourceLabel: '', declaredAgentSessionId: null, body: '', references: [
      { declaredAgentSessionId: 'first-source', declaredMessageId: 'first-message', readVia: 'message --skill', raw: wire }
    ] })
  })

  it('reads a single container reference and a batch without rewriting original spans or order', () => {
    const wire = references(records), reading = parse(wire)!
    expect(wire).toBe(container(row + '\n<a2a from="second-source" msg-id="second-message" read-via="message --skill" />'))
    expect(reading.kind).toBe('references')
    expect(reading.references?.map(item => [item.declaredAgentSessionId, item.declaredMessageId])).toEqual(records.map(item => [item.senderSessionId, item.messageId]))
    expect(reading.references?.map(item => item.raw).join('\n')).toBe(wire.slice('<amux>\n'.length, -'\n</amux>'.length))
    expect(parse(container(row))?.references).toEqual([reading.references![0]])
    expect(parse(context + '\n\n' + wire)).toEqual({ ...reading, declaredContexts: [{ raw: context }] })
  })

  it.each(['', 'Platform <literal> & \r exact\ntext'])('keeps an explicit %j reminder separate from the reference list', reminder => {
    const wire = references(records.slice(0, 1), reminder), reading = parse(wire)!
    expect(wire.startsWith('<amux>\n<a2a ')).toBe(true)
    expect(reading.reminder?.text).toBe(reminder)
    expect(reading.references).toHaveLength(1)
    expect(reading.references![0]!.raw).toBe(row)
    expect(reading.reminder?.raw).not.toContain('<literal>')
    expect(reading.body).toBe('')
  })

  it('does not manufacture an empty notification', () => {
    expect(references([])).toBe('')
    expect(references([], 'No original messages')).toBe('')
    expect(parse('')).toBeNull()
  })

  it('round-trips canonical identity encoding without normalizing the original values', () => {
    const original = [{ senderSessionId: 'Case:source<&"\t\r\n', messageId: ' thread:0<&"\t\r\n ' }]
    const wire = references(original)
    expect(wire).toContain('&lt;&amp;&quot;&#9;&#13;&#10;')
    expect(parse(wire)?.references?.[0]).toMatchObject({ declaredAgentSessionId: original[0]!.senderSessionId, declaredMessageId: original[0]!.messageId })
  })

  it.each([
    container(row.replace('message --skill', 'arbitrary command')),
    container(row.replace(' read-via="message --skill"', '')),
    container(row.replace(' />', '/>')),
    container(row.replace('from="first-source" msg-id="first-message"', 'msg-id="first-message" from="first-source"')),
    container(row.replace('first-message', '&#102;irst-message')),
    container(row.replace('first-message', '&unknown;')),
    container(row.replace(' />', ' extra="value" />')),
    container(row + '\n<unknown />'), container(row + '\n\n' + row),
    container(row + '\n<reminder><nested /></reminder>'),
    container(row + '\n<reminder>one</reminder>\n<reminder>two</reminder>'),
    container(row + '\n<a2a from="other" msg-id="other">\nbody\n<reminder>note</reminder>\n</a2a>'),
    container(row.replace(' />', '>\nbody\n</a2a>')),
    container('<!DOCTYPE amux>\n' + row), container('<?instruction?>\n' + row),
    container(row) + '\n', container(row) + 'authored tail',
    '<amux>\r\n' + row + '\r\n</amux>',
    '<amux:a2a from="first-source" msg-id="first-message" read-via="message --skill" />\n',
    '<amux:a2a from="first-source" msg-id="first-message" />',
    short('body').replace('msg-id="first-message">', 'msg-id="first-message" read-via="message --skill">')
  ])('retains malformed or ambiguous wire literally rather than decoding a reference: %j', wire => {
    expect(parse(wire)).toBeNull()
  })

  it.each(['    ', '> ', '```text\n'])('does not discover quoted or code-leading references with %j', prefix => {
    const wire = prefix + references(records) + (prefix.startsWith('```') ? '\n```' : '')
    expect(parse(wire)).toBeNull()
    const reading = parse(context + '\n\n' + wire)!
    expect(reading.kind).toBe('content')
    expect(reading.body).toBe('\n\n' + wire)
    expect(reading.references).toBeUndefined()
  })
})
