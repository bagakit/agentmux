import { fixtureIso as _tailFixtureIso } from "../../../../../test/fixture-values.mjs"
import { renderAgentMuxMessageEnvelope } from '@agentmux/core/agent-message-render'
import { composeOutboundMessage } from '@agentmux/core/agent-outbound-message'

export const packet = ("<bagakit-msg type=\"agent-v1\" name=\"Review team\" time=\"" + _tailFixtureIso().replace('.000Z', 'Z') + "\">\n**Original quote** &amp; context\n<cite from=\"User\" ref=\"message-7\">Keep both original IDs.</cite>\nContinue here.\n</bagakit-msg>")
export const authoredBody = '**Original task**\n\nKeep the original input and its exact identity.\n\n```xml\n<reminder>This code belongs to the sender.</reminder>\n```'
export function wire(body = packet, messageId = 'review:0') {
  return renderAgentMuxMessageEnvelope({ messageId, sender: { kind: 'agent-session', agentSessionId: 'reviewer' }, senderSessionId: 'reviewer', body })
}
export const context = composeOutboundMessage({ amux: 'Original project context. Keep the current task and its authorization.' })
export const complete = context + '\n\n' + wire()
export const plain = wire(authoredBody, 'review:1')
export const incomplete = '<amux:a2a from="reviewer" msg-id="unfinished">\n**Unfinished original input** remains readable.'
export const quoted = '```xml\n' + wire('Quoted protocol example.', 'example') + '\n```'
export const resourceWire = context + '\n\n' + wire(packet.replace('Continue here.', 'Complete resource evidence.\n\n' + 'Original source text and retained evidence. '.repeat(320)), 'review:resource')
export const source = { providerId: 'claude', nativeSessionId: 'native-main' }
export const recordId = 'deferred-input'
export const reference = 'original:input-resource'
