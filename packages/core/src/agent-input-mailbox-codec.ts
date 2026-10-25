import { preparedAuthorProfileFields } from './author-profile.js'
import { parseAgentInputImages } from './agent-input-resource.js'
import { agentInputContextCaptureProofFields } from './agent-input-context-capture.js'
import { AgentMuxError } from './errors.js'
import { browserInputContextFields } from './browser-input-context.js'
import { dequal } from 'dequal'
export * from './agent-input-mailbox.js'
import { consumeJsonReadEntry, type JsonReadAssembly, type JsonReadEntry } from './json-read-fragments.js'
import { parseDeliveryFailure } from './delivery-attempt.js'
import { decodeBase64, encodeBase64 } from './hosted-value.js'
import { agentInputDeliveryKey, agentInputJournalKey } from './agent-input-wait.js'
import { rpcRecord } from './rpc-data.js'
import { agentPromptInputId, validateAgentPromptInputKey, validateAgentPromptAdmissionIntent } from './agent-prompt-condition.js'
import { parseAgentInputMailboxRead, type AgentInputMailboxPage, type AgentInputMailboxRead, type AgentInputMailboxItem } from './agent-input-mailbox.js'
import { parseAgentInputSubmissionReceipt } from './agent-input-receipt-codec.js'
import { parsePromptSubmissionRecord } from './prompt-submission-record.js'
import { validateAgentMuxMessageEnvelope } from './agent-message-envelope.js'
import { messageInputWireMatches } from './agent-message-input.js'
import { normalizeMessageChannel } from './message-origin.js'
import { normalizeOperationDevice } from './operation-device.js'
const fail = (): never => { throw new AgentMuxError('The input mailbox page does not match its original scope and facts.', 'CONTROL_PROTOCOL_ERROR') }
const object = (v: unknown, fields: string[]) => rpcRecord(v, fields, 'CONTROL_PROTOCOL_ERROR')
function string(v: unknown): asserts v is string { if (typeof v !== 'string' || !v || /[\0\r\n]/u.test(v)) fail() }
function count(v: unknown): asserts v is number { if (!Number.isSafeInteger(v) || (v as number) < 0) fail() }

/** A complete original input, never an incomplete transport fragment. */
export function parseAgentInputMailboxItem(value: unknown, agentSessionId: string): AgentInputMailboxItem {
    const entry = object(value, ['kind', 'sequence', 'recordedAt', 'intent', 'message', 'receipt', 'key', 'record', 'sourceChannel', 'sourceDevice', 'failure'])
    count(entry.sequence); if (entry.sequence < 1) fail()
    if (typeof entry.recordedAt !== 'number' || !Number.isFinite(entry.recordedAt) || entry.recordedAt < 0) fail()
    if (entry.failure !== undefined) parseDeliveryFailure(entry.failure)
    let key, displaySource: Record<string, unknown> | undefined
    if (entry.kind === 'controlled') {
      if (entry.key !== undefined || entry.record !== undefined) fail()
      if (entry.sourceChannel !== undefined) normalizeMessageChannel(entry.sourceChannel)
      if (entry.sourceDevice !== undefined) normalizeOperationDevice(entry.sourceDevice)
      const intent = object(entry.intent, ['key', 'admissionIntent', 'execution', 'source'])
      key = validateAgentPromptInputKey(intent.key)
      const admission = validateAgentPromptAdmissionIntent(intent.admissionIntent)
      if (admission.kind === 'exact-condition' || admission.expectedRun.runId !== key.expectedRun.runId || intent.execution !== 'immediate') fail()
      const receipt = entry.receipt === null ? null : parseAgentInputSubmissionReceipt(entry.receipt)
      if (receipt && !dequal(receipt.key, key) || !receipt && entry.failure === undefined || receipt && entry.failure !== undefined) fail()
      const deliveryKey = receipt ? agentInputDeliveryKey(receipt.control) : key
      if (receipt?.admission?.admission && !dequal(receipt.admission.admission.intent?.admissionIntent,
        { ...admission, expectedRun: deliveryKey.expectedRun })) fail()
      const source = object(intent.source, ['kind', 'prompt', 'agentMuxNote', 'authorHuman', 'recoveryAuthorization', 'sourceChannel', 'sourceDevice', 'messageId', 'originalControlOperationId', 'inputContext', 'inputContextSource', 'inputContextCaptureProof', 'inputImages', 'authorProfile', 'promptWire', 'representation'])
      // The receipt codec already binds each same-Run retry to its original
      // logical key and typed predecessor. Only Run rebinding has manual-author
      // eligibility; a fresh transport identity alone does not change the target.
      const rebound = receipt?.control.deliveryKey && deliveryKey.expectedRun.runId !== key.expectedRun.runId
      if (rebound && admission.kind !== 'manual-actor') fail()
      if (source.kind === 'prompt') {
        if (source.representation !== undefined || rebound && source.authorHuman !== true) fail()
        if (source.authorProfile !== undefined) {
          const { authorProfile: _untrusted, ...fields } = source
          displaySource = { ...fields, ...preparedAuthorProfileFields(source.authorProfile) }
        }
        if (source.inputImages !== undefined) parseAgentInputImages(source.inputImages)
        browserInputContextFields(source)
        agentInputContextCaptureProofFields(source)
        if (source.promptWire !== undefined && (typeof source.promptWire !== 'string' || !source.promptWire.trim())) fail()
        if (key.kind !== 'prompt' || typeof source.prompt !== 'string' || source.agentMuxNote !== undefined && typeof source.agentMuxNote !== 'string' ||
          source.authorHuman !== undefined && typeof source.authorHuman !== 'boolean' ||
          source.recoveryAuthorization !== undefined && (source.recoveryAuthorization !== 'local-human' || source.authorHuman !== true || admission.kind !== 'manual-actor') ||
          source.messageId !== undefined || source.originalControlOperationId !== undefined || entry.message !== undefined || entry.sourceChannel !== undefined || entry.sourceDevice !== undefined) fail()
        if (source.sourceChannel !== undefined) normalizeMessageChannel(source.sourceChannel)
        if (source.sourceDevice !== undefined) normalizeOperationDevice(source.sourceDevice)
      } else {
        if (source.kind !== 'message' || key.kind !== 'message' || source.messageId !== key.messageId ||
          source.prompt !== undefined || source.agentMuxNote !== undefined || source.authorHuman !== undefined || source.recoveryAuthorization !== undefined || source.sourceChannel !== undefined || source.sourceDevice !== undefined || source.inputContext !== undefined || source.inputContextSource !== undefined || source.inputContextCaptureProof !== undefined || source.inputImages !== undefined || source.authorProfile !== undefined) fail()
        string(source.originalControlOperationId)
        const message = object(entry.message, ['schema', 'messageId', 'operationId', 'createdAt', 'sender', 'recipient', 'threadId', 'correlationId', 'replyTo', 'workspaceId', 'senderSessionId', 'senderRunId', 'recipientSessionId', 'recipientRunId', 'body', 'channelProfile', 'channelQuote'])
        const envelope = validateAgentMuxMessageEnvelope(message as unknown as Parameters<typeof validateAgentMuxMessageEnvelope>[0])
        if (rebound && envelope.sender.kind !== 'external') fail()
        if (!messageInputWireMatches(envelope, source)) fail()
        if (key.kind !== 'message' || envelope.messageId !== key.messageId || envelope.operationId !== source.originalControlOperationId ||
          envelope.recipientSessionId !== key.agentSessionId || envelope.recipientRunId !== key.expectedRun.runId || receipt && receipt.originalControlOperationId !== envelope.operationId) fail()
      }
    } else {
      if (entry.kind !== 'submission' || entry.intent !== undefined || entry.message !== undefined || entry.receipt !== undefined || entry.sourceChannel !== undefined || entry.sourceDevice !== undefined) fail()
      key = validateAgentPromptInputKey(entry.key)
      if (entry.record === null && entry.failure === undefined || entry.record !== null && entry.failure !== undefined) fail()
      if (entry.record !== null) {
        const record = parsePromptSubmissionRecord(entry.record)
        if (record.agentSessionId !== key.agentSessionId || record.run.runId !== key.expectedRun.runId ||
          (record.admission?.submissionId ?? record.terminalPromptSubmission?.submissionId ?? record.launch?.input.submissionId ?? record.admission?.operationId) !== agentPromptInputId(key) ||
          record.admission?.inputKey && !dequal(record.admission.inputKey, key)) fail()
      }
    }
    if (key.agentSessionId !== agentSessionId) fail()
    return (displaySource ? { ...entry, intent: { ...(entry.intent as Record<string, unknown>), source: displaySource } } : value) as AgentInputMailboxItem
}

/** Strict shared SDK transport/RPC result boundary. Membership and receipt observations are separate. */
export function parseAgentInputMailboxPage(value: unknown, request: AgentInputMailboxRead): AgentInputMailboxPage {
  const input = parseAgentInputMailboxRead(request)
  const page = object(value, ['agentSessionId', 'queueId', 'cut', 'budgetBytes', 'items', 'nextCursor', 'coverage'])
  if (page.agentSessionId !== input.agentSessionId || page.budgetBytes !== (input.maxBytes ?? 64 * 1024) || new TextEncoder().encode(JSON.stringify(value)).byteLength > Number(page.budgetBytes)) fail()
  string(page.queueId)
  const cut = object(page.cut, ['incarnation', 'throughSequence']); string(cut.incarnation); count(cut.throughSequence)
  const coverage = object(page.coverage, ['kind', 'unrecorded'])
  if (coverage.kind !== 'recorded-inputs' || coverage.unrecorded !== 'unconfirmed') fail()
  if (!Array.isArray(page.items)) return fail()
  const items = page.items as unknown[]
  if (items.length > (input.limit ?? 25)) fail()
  if (page.nextCursor !== null) { string(page.nextCursor); if (page.nextCursor.length > 131072 || !items.length) fail() }
  let previous = Infinity
  const keys = new Set<string>()
  for (const value of items) {
    const entry = object(value, ['kind', 'item', 'itemId', 'encoding', 'sha256', 'offsetBytes', 'totalBytes', 'dataBase64'])
    if (entry.kind === 'item') {
      object(value, ['kind', 'item'])
      const item = parseAgentInputMailboxItem(entry.item, input.agentSessionId), key = item.kind === 'controlled' ? item.intent.key : item.key
      if (item.sequence >= previous || item.sequence > Number(cut.throughSequence) || keys.has(agentInputJournalKey(key))) fail()
      previous = item.sequence; keys.add(agentInputJournalKey(key))
    } else {
      object(value, ['kind', 'itemId', 'encoding', 'sha256', 'offsetBytes', 'totalBytes', 'dataBase64'])
      string(entry.itemId); string(entry.sha256); string(entry.dataBase64); count(entry.offsetBytes); count(entry.totalBytes)
      if (entry.kind !== 'fragment' || entry.encoding !== 'json-utf8-base64' || !/^[a-f0-9]{64}$/u.test(entry.sha256) || entry.totalBytes < 1 || entry.totalBytes > 32 * 1024 * 1024) fail()
      const bytes = decodeBase64(entry.dataBase64)
      if (!bytes.length || encodeBase64(bytes) !== entry.dataBase64 || entry.offsetBytes + bytes.length > entry.totalBytes) fail()
    }
  }
  return value as AgentInputMailboxPage
}

/** Reuse the original JSON byte assembler; no partial body, receipt or control is exposed. */
export function consumeAgentInputMailboxEntry(input: { hostId: string; page: AgentInputMailboxPage; entry: JsonReadEntry<AgentInputMailboxItem>; pending?: JsonReadAssembly }):
  { kind: 'pending'; pending: JsonReadAssembly } | { kind: 'complete'; value: AgentInputMailboxItem } {
  const scopeKey = JSON.stringify([input.hostId, input.page.agentSessionId, input.page.queueId, input.page.cut.incarnation, input.page.cut.throughSequence])
  const result = consumeJsonReadEntry({ scopeKey, entry: input.entry, ...(input.pending ? { pending: input.pending } : {}), maxTotalBytes: 32 * 1024 * 1024 })
  if (result.kind === 'pending') return result
  const item = parseAgentInputMailboxItem(result.value, input.page.agentSessionId), key = item.kind === 'controlled' ? item.intent.key : item.key
  if (item.sequence > input.page.cut.throughSequence || input.entry.kind === 'fragment' && input.entry.itemId !== agentInputJournalKey(key)) fail()
  return { kind: 'complete', value: item }
}
