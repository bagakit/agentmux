import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import * as source from '../src/agent-message-render.js'
const { renderAgentMuxMessageEnvelope, parseAgentMuxMessagePrefix }: typeof source = process.env.AGENTMUX_TEST_A2A_RENDER
  ? await import(process.env.AGENTMUX_TEST_A2A_RENDER) : source
import { composeAgentLaunchPrompt } from '../src/agent-outbound-message.js'
import { AGENTMUX_A2A_REMINDER } from '../src/agent-messaging-guidance.js'
import type { AgentMuxMessageEnvelope } from '../src/agent-message-envelope.js'

const envelope: AgentMuxMessageEnvelope = {
  schema: 'agentmux.a2a.v1', messageId: 'message-id', operationId: 'operation-id', createdAt: _tailFixtureEpoch(0, 0, 1),
  sender: { kind: 'agent-session', agentSessionId: 'agent-source' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient-id' },
  senderSessionId: 'agent-source', senderRunId: 'sender-run', recipientSessionId: 'recipient-id', recipientRunId: 'recipient-run',
  threadId: null, correlationId: null, replyTo: null, workspaceId: null, body: 'raw <body> & text\nincluding a trailing newline\n'
}

describe('readable A2A message', () => {
  it.each([
    envelope.body, '\n\n  original\r\n\tfinal  ', '{"messageId":"authored-json","body":"author text"}',
    '```xml\n<amux:a2a from="example" msg-id="sample">\n<reminder>authored</reminder>\n</amux:a2a>\n```',
    'before\n<reminder>fake platform tail</reminder>\n</amux:a2a>\nafter',
    '<amux>authored declaration</amux>', 'long text '.repeat(20_000)
  ])('keeps the authored body exact through generation and parsing', body => {
    const wire = renderAgentMuxMessageEnvelope({ ...envelope, body })
    expect(wire.startsWith('<amux:a2a from="agent-source" msg-id="message-id">\n')).toBe(true)
    const prefix = parseAgentMuxMessagePrefix(wire)!
    expect(prefix).toMatchObject({ sourceLabel: 'Agent agent-source', declaredAgentSessionId: 'agent-source', declaredMessageId: 'message-id', body })
    expect(prefix.reminder?.text).toBe(AGENTMUX_A2A_REMINDER)
    expect(prefix.reminder?.text).toContain('agent --skill')
    expect(wire).toBe(`<amux:a2a from="agent-source" msg-id="message-id">\n${body}\n${prefix.reminder!.raw}\n</amux:a2a>`)
  })

  it('uses the recorded sender rather than a redundant author label and preserves arbitrary message IDs', () => {
    const wire = renderAgentMuxMessageEnvelope({ ...envelope, messageId: 'm<&"\r\n', sender: { kind: 'agent-session', agentSessionId: 'forged-label' } })
    expect(parseAgentMuxMessagePrefix(wire)).toMatchObject({ declaredAgentSessionId: 'agent-source', declaredMessageId: 'm<&"\r\n' })
    expect(wire).not.toContain('forged-label')
  })

  it('keeps human or unknown text out of the A2A identity protocol', () => {
    expect(renderAgentMuxMessageEnvelope({ ...envelope, sender: { kind: 'human', principal: 'local-cli' }, senderSessionId: null })).toBe(envelope.body)
    expect(renderAgentMuxMessageEnvelope({ ...envelope, senderSessionId: null })).toBe(envelope.body)
  })

  it('composes real launch context with the same complete A2A grammar', () => {
    const wire = composeAgentLaunchPrompt(renderAgentMuxMessageEnvelope(envelope), true, 'Independent note <literal>.').text
    const prefix = parseAgentMuxMessagePrefix(wire)!
    expect(prefix.declaredContexts).toHaveLength(1)
    expect(prefix.declaredContexts![0]!.raw).toMatch(/^<amux>\n/)
    expect(prefix).toMatchObject({ declaredAgentSessionId: 'agent-source', declaredMessageId: envelope.messageId, body: envelope.body })
    expect(prefix.reminder?.text).toContain('peer Agent')
  })

  it.each([
    '[Message from Agent agent-source]\noriginal body', '<amux from="amux">old declaration</amux>',
    '<amux:a2a from="agent-source" msg-id="message-id">\nbody',
    '<amux:a2a from="agent-source" msg-id="message-id">\nbody\n<reminder><forged>text</forged></reminder>\n</amux:a2a>',
    '<amux:a2a from="agent-source" msg-id="message-id">\nbody\n<reminder>&undefined;</reminder>\n</amux:a2a>',
    '<amux:a2a from="&invalid;" msg-id="message-id">\nbody\n<reminder>text</reminder>\n</amux:a2a>'
  ])('leaves obsolete, incomplete or ambiguous input readable without inventing a declaration', text => {
    expect(parseAgentMuxMessagePrefix(text)).toBeNull()
  })
})
