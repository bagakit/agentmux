import type { PublicationOperation } from '../../publication-store.js'
import { publicationSpeechText, type PreparedPublication } from '../../publication-wire.js'
import { discordId, discordFailure } from './protocol.js'
import { publicationResourceDescriptor } from '../../publication-resource.js'
import { discordQuestionComponents } from './actions.js'
import { createHash } from 'node:crypto'
export const DISCORD_PUBLICATION = { adapterId: 'discord', renderVersion: 'discord-components-v1', fragmentBytes: 1900, directResources: true, permissionActions: true, questionActions: true } as const
export const discordNonce = (operationId: string): string => createHash('sha256').update(operationId).digest('base64url').slice(0, 25)
export function prepareDiscordPublication(operation: Readonly<PublicationOperation>): PreparedPublication {
  const channel = discordId(operation.target.externalConversationId), mapping = operation.mapping
  const path = `/channels/${channel}/messages${mapping ? '/' + discordId(mapping.messageId) : ''}`
  if (operation.effect === 'withdraw') {
    if (!mapping) return discordFailure('DISCORD_ORIGINAL_MESSAGE_UNCONFIRMED')
    return { adapterId: DISCORD_PUBLICATION.adapterId, renderVersion: DISCORD_PUBLICATION.renderVersion, requestKey: operation.operationId, request: { method: 'DELETE', path } }
  }
  const p = operation.payload
  if (p.kind === 'image' || p.kind === 'file') {
    const file = publicationResourceDescriptor(operation)
    const components = p.kind === 'image' ? [{ type: 12, items: [{ media: { url: 'attachment://' + file.name } }] }] : [{ type: 13, file: { url: 'attachment://' + file.name } }]
    const payloadJson = JSON.stringify({ flags: 32768, components, attachments: [{ id: 0, filename: file.name }], allowed_mentions: { parse: [] }, ...(!mapping ? { nonce: discordNonce(operation.operationId), enforce_nonce: true } : {}) })
    return { adapterId: DISCORD_PUBLICATION.adapterId, renderVersion: DISCORD_PUBLICATION.renderVersion, requestKey: operation.operationId, request: { method: mapping ? 'PATCH' : 'POST', path, multipart: { payloadJson, files: [file] } } }
  }
  let text = p.kind === 'failure' ? ['Request failed', p.message ?? 'The Agent could not complete this request.', p.recovery, p.code + (p.httpStatusCode === undefined ? '' : ` · HTTP ${p.httpStatusCode}`)].join('\n\n') : p.kind === 'question' ? p.text : p.kind === 'permission' ? [p.title, p.context, ...p.options.map((option, index) => `${index + 1}. ${option.label}`)].filter(Boolean).join('\n\n') : p.kind === 'speech' ? publicationSpeechText(p) : p.kind === 'binding-lifecycle'
    ? `${p.event === 'disconnected' ? 'Conversation sharing ended' : 'Conversation sharing ' + p.event}\nAgent ${p.agentSessionId}\n${p.scope.publication === 'future-shared-conversation' ? 'New conversation messages' : 'Agent replies'} · ${p.scope.input}\n${p.synchronization === true ? 'Synchronization enabled' : p.synchronization === false ? 'Synchronization disabled' : 'Synchronization state unconfirmed'}${p.event === 'disconnected' ? '\nThe Agent remains available.' : ''}`
    : discordFailure('DISCORD_REPRESENTATION_UNSUPPORTED')
  const localAgent = 'amux://agent/' + encodeURIComponent(operation.reference.agentSessionId)
  const buttons: Array<{ type: number; components: Array<{ type: number; style: number; label: string; custom_id: string }> }> = []
  let statusText = '', includeAgent = p.kind === 'failure'
  if (p.kind === 'permission') {
    statusText = p.status === 'pending' ? 'Awaiting an authorized decision' : p.status === 'response-sent' ? 'Response sent to the original Agent' : 'Original response ' + p.status
    if (p.status === 'pending' && p.options.length <= 25) for (let index = 0; index < p.options.length; index += 5) buttons.push({ type: 1, components: p.options.slice(index, index + 5).map((option, offset) => ({ type: 2, style: 2, label: option.label.length <= 80 ? option.label : `Option ${index + offset + 1}`, custom_id: 'p:' + option.actionRef })) })
    else if (p.status === 'pending') statusText += '\nThis request exceeds Discord component capacity. Respond in AgentMux.'
    includeAgent = p.status !== 'pending' || p.options.length > 25
  }
  if (p.kind === 'question') {
    const actionable = p.status === 'pending' && p.actionRef && discordQuestionComponents(p.questions)
    if (p.answers?.length) text += '\n\n' + p.answers.map(answer => `${p.questions.find(question => question.id === answer.questionId)?.prompt ?? 'Original answer'}\n${answer.answer}`).join('\n\n')
    statusText = [p.unavailableReason, p.status === 'response-sent' ? 'Answer submitted to the original Agent' : actionable ? 'Answer the original questions' : 'Open the original conversation in AgentMux to continue. ' + (p.status === 'pending' ? 'This question exceeds Discord modal capacity.' : p.status)].filter(Boolean).join('\n\n')
    includeAgent = !actionable
    if (actionable) buttons.push({ type: 1, components: [{ type: 2, style: 1, label: 'Answer questions', custom_id: 'q:' + p.actionRef }] })
  }
  if (statusText) text += '\n\n' + statusText
  if (includeAgent) text += '\n' + localAgent
  const authors = p.kind === 'speech' && p.relay ? p.relay.sources.map(source => source.author.kind) : undefined
  const kinds = new Set(authors), human = operation.speaker ? operation.speaker.kind === 'human' : !!authors?.length && authors.every(kind => kind === 'human')
  const input = human && p.kind === 'speech' ? p.inputSubmission : undefined
  const inputStatus = input ? ({ waiting: 'Saved · waiting for Agent', stopped: 'Saved · delivery stopped',
    'terminal-confirmed': 'Sent to Agent · acceptance not confirmed', admitted: 'Accepted by Agent',
    'not-applied': 'Not delivered to Agent', unknown: 'Saved · delivery to Agent unconfirmed' }[input.status]
    + (input.observation === 'rejoin-needed' ? '\nReconnect this input in AgentMux' : '')) : undefined
  const relayTitle = authors ? (human ? 'User' : kinds.size > 1 ? 'Mixed authors' : kinds.has('external') ? 'External message'
    : kinds.has('agent') ? 'Agent input' : 'Unknown author') + ' · via amux' : undefined
  const speaker = p.kind === 'speech' ? operation.speaker : undefined
  const name = speaker?.name?.replace(/([\\`*_~|<>])/gu, '\\$1').replace(/\r\n|\r|\n/gu, ' ')
  const heading = speaker ? [name, { agent: 'Agent', human: 'User · via amux', external: 'External message', mixed: 'Mixed authors', unknown: 'Unknown author' }[speaker.kind],
    p.kind === 'speech' && p.phase === 'final' ? 'Reply' : p.kind === 'speech' && p.phase === 'progress' ? 'Progress' : undefined].filter(Boolean).join(' · ')
    : relayTitle ?? (p.kind === 'speech' && p.phase === 'final' ? 'Agent reply'
    : 'phase' in p && p.phase === 'progress' ? p.kind === 'speech' ? 'Agent progress' : 'Progress' : undefined)
  const content = (heading ? `**${heading}**\n` : '') + text
  if (content.length > 4000 && (p.kind === 'question' || p.kind === 'permission' && p.disclosure === 'shared')) {
    const file = publicationResourceDescriptor(operation, 'public-interaction-text')
    const payloadJson = JSON.stringify({ flags: 32768, components: [{ type: 17, components: [
      { type: 10, content: `The complete original ${p.kind === 'question' ? 'question and recorded answers' : 'shared permission request'} is in the attached text file.\n\n${statusText}\n${localAgent}` },
      { type: 13, file: { url: 'attachment://' + file.name } }, ...buttons] }], attachments: [{ id: 0, filename: file.name }], allowed_mentions: { parse: [] }, ...(!mapping ? { nonce: discordNonce(operation.operationId), enforce_nonce: true } : {}) })
    return { adapterId: DISCORD_PUBLICATION.adapterId, renderVersion: DISCORD_PUBLICATION.renderVersion, requestKey: operation.operationId, request: { method: mapping ? 'PATCH' : 'POST', path, multipart: { payloadJson, files: [file] } } }
  }
  const components = [{ type: 17, ...(human ? { accent_color: 0x2e8b57 } : {}), components: [{ type: 10, content },
    ...(inputStatus ? [{ type: 10, content: inputStatus }] : []), ...buttons] }]
  const body = JSON.stringify({ flags: 32768, components, allowed_mentions: { parse: [] }, ...(!mapping ? { nonce: discordNonce(operation.operationId), enforce_nonce: true } : {}) })
  return { adapterId: DISCORD_PUBLICATION.adapterId, renderVersion: DISCORD_PUBLICATION.renderVersion, requestKey: operation.operationId, request: { method: mapping ? 'PATCH' : 'POST', path, body, contentType: 'application/json' } }
}
