import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as sourceConversation from '../src/conversation.js'
import { projectSessionUserMessages } from '../src/session-user-messages.js'
import { conversationNativeInputWitness, conversationRevision } from '../src/conversation-stream.js'
import { parseAgentSessionHistoryReadPage } from '../src/session-history-read-codec.js'
import { createNativeInputCorrelation } from '../src/native-input-correlation.js'
import { externalConversationAuthor } from '../src/external-conversation.js'
import { paginatedFixture, user, source, turn, jsonl } from './helpers/codex-paginated.js'
import { createHistoryQueryFixture } from './helpers/session-history-query.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentPromptInputKey } from '../src/agent-prompt-condition.js'
import type { AgentInputMailboxItem } from '../src/agent-input-mailbox.js'
import type { AgentMuxMessageEnvelope, AgentMuxMessageIdentity } from '../src/agent-message-envelope.js'
import type { AgentExternalMessageAuthor } from '../src/external-author.js'
import type { AgentSessionHistoryItem, AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '../src/types.js'

const { projectSessionInputs, projectConversationReading, sessionInputMailboxAuthor } = process.env.AGENTMUX_INPUTS_COMPILED === '1'
  ? await import('../dist/conversation.js') : sourceConversation

const cleanup: Array<() => Promise<unknown>> = []
beforeEach(() => { vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', undefined) })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const ref = { hostId: 'route', sourceHostId: 'origin', agentSessionId: 'session' }
const key = { kind: 'prompt', agentSessionId: ref.agentSessionId, expectedRun: { runId: 'run' }, submissionId: 'original' } satisfies AgentPromptInputKey
const captured: AgentTimelineItem = { id: 'captured-original', agentSessionId: ref.agentSessionId, kind: 'user_message', status: 'complete', source: 'user',
  title: 'Original', content: 'same body', createdAt: 1, updatedAt: 1, publicContent: 'confirmed', authorHuman: true, inputRef: key }
const native: AgentSessionHistoryItem = { id: 'native-original', kind: 'user-message', turnId: turn, contentParts: [{ kind: 'text', text: 'same body' }],
  conversation: { nativeInput: { source, turnId: turn, semanticItemId: 'semantic-original', clientCorrelation: createNativeInputCorrelation(key) }, adoptedInput: { key } } }
const journal = (inputKey: AgentPromptInputKey = key): AgentInputMailboxItem => ({ kind: 'submission', key: inputKey, record: null, recordedAt: 1, sequence: 1 })
const external: AgentExternalMessageAuthor = { kind: 'external', connectionId: 'connection', actor: { application: { domain: 'example.test', appId: 'app' }, idType: 'user-id', userId: 'external-user' },
  externalConversationId: 'room', externalMessageId: 'external-message', bindingId: 'binding', bindingRevision: 1, grantId: 'grant', grantRevision: 1 }
function envelope(sender: AgentMuxMessageIdentity, messageId = 'message'): AgentMuxMessageEnvelope {
  return { schema: 'agentmux.a2a.v1', messageId, operationId: `operation-${messageId}`, createdAt: 1, sender,
    recipient: { kind: 'agent-session', agentSessionId: ref.agentSessionId }, threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
    senderSessionId: sender.kind === 'agent-session' ? sender.agentSessionId : null, senderRunId: null, recipientSessionId: ref.agentSessionId, recipientRunId: key.expectedRun.runId, body: 'same body' }
}
function reading(nativeItems = [native], capturedItems = [captured]) {
  const projected = projectConversationReading({ agentSessionId: ref.agentSessionId, routeHostId: ref.hostId,
    historyPage: { agentSessionId: ref.agentSessionId, sourceHostId: ref.sourceHostId, source, items: nativeItems, nextCursor: null },
    timeline: { agentSessionId: ref.agentSessionId, sourceHostId: ref.sourceHostId, revision: 1, items: capturedItems } })
  return { inputs: projected.inputs, records: projected.timeline.records,
    messages: projected.originalRecords.flatMap(record => record.input ? [record.input] : []) }
}

it('joins native, captured and original receipt once and keeps exact message objects and journal identities', () => {
  const f = reading(), mailbox = journal(), before = structuredClone({ ...f, mailbox })
  const grouped = projectSessionInputs({ ...ref, ...f, mailbox: [mailbox] })
  expect(grouped).toHaveLength(1)
  expect(grouped[0]!.messages).toHaveLength(2); expect(grouped[0]!.mailbox[0]).toBe(mailbox)
  expect(grouped[0]!.primary).toBe(f.messages.find(message => message.source.kind === 'native'))
  expect(grouped[0]!.author).toEqual({ kind: 'human' })
  expect({ ...f, mailbox }).toEqual(before)
  expect(projectSessionInputs({ ...ref, messages: [f.messages.find(message => message.source.kind === 'captured')!], mailbox: [mailbox] })[0]!.id).toBe(grouped[0]!.id)
  expect(projectSessionInputs({ ...ref, messages: [f.messages.find(message => message.source.kind === 'native')!], mailbox: [mailbox] })).toHaveLength(1)
})

it('retains equal bodies as distinct complete keys and refuses foreign Host, Session, Run and input kinds', () => {
  const f = reading([], [captured]), message = f.messages[0]!
  const others: AgentPromptInputKey[] = [
    { ...key, submissionId: 'another' }, { ...key, expectedRun: { runId: 'other-run' } }, { ...key, agentSessionId: 'other-session' },
    { kind: 'message', agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, messageId: key.submissionId }
  ]
  for (const other of others) expect(projectSessionInputs({ ...ref, messages: [message], mailbox: [journal(other)] })).toHaveLength(2)
  expect(projectSessionInputs({ ...ref, sourceHostId: 'foreign-origin', messages: [message], mailbox: [journal()] })).toHaveLength(2)
  expect(projectSessionInputs({ hostId: ref.hostId, agentSessionId: ref.agentSessionId, messages: [message], mailbox: [journal()] })).toHaveLength(2)
  expect(projectSessionInputs({ hostId: ref.sourceHostId, agentSessionId: ref.agentSessionId, messages: [message], mailbox: [journal()] })).toHaveLength(2)
  const repeated = reading([], [captured, { ...captured, id: 'second-capture', inputRef: others[0]! }])
  expect(projectSessionInputs({ ...ref, ...repeated })).toHaveLength(2)
})

it('compares original authors structurally when query and canonical fields arrive in different orders', () => {
  const f = reading([], [{ ...captured, authorAgentSessionId: 'peer' }])
  const message: AgentSessionUserMessage = { ...f.messages[0]!, author: { agentSessionId: 'peer', kind: 'agent' } }
  const groups = projectSessionInputs({ ...ref, messages: [message], inputs: f.inputs })
  expect(groups).toHaveLength(1); expect(groups[0]!.author).toEqual({ kind: 'agent', agentSessionId: 'peer' })
  expect(groups[0]!.primary).toBe(message)
})

it('joins public captured attribution with its original full journal sender without changing either object', () => {
  const inputKey = { kind: 'message', agentSessionId: ref.agentSessionId, expectedRun: key.expectedRun, messageId: 'message' } as const
  const publicAuthor = externalConversationAuthor(external)
  const f = reading([], [{ ...captured, inputRef: inputKey, authorHuman: undefined, authorExternal: publicAuthor }])
  const item = { kind: 'controlled', recordedAt: 1, sequence: 1, receipt: null, message: envelope(external),
    intent: { key: inputKey, admissionIntent: { kind: 'manual-actor', expectedRun: key.expectedRun }, execution: 'immediate',
      source: { kind: 'message', messageId: 'message', originalControlOperationId: 'operation-message' } } } satisfies AgentInputMailboxItem
  const before = structuredClone({ f, item })
  const groups = projectSessionInputs({ ...ref, ...f, mailbox: [item] })
  expect(groups).toHaveLength(1)
  expect(groups[0]!.author).toBe(f.messages[0]!.author)
  expect(groups[0]!.author).toEqual(publicAuthor)
  expect(groups[0]!.messages[0]).toBe(f.messages[0]); expect(groups[0]!.mailbox[0]).toBe(item)
  expect(item.message.sender).toBe(external); expect(sessionInputMailboxAuthor(item)).toBe(external)
  expect({ f, item }).toEqual(before)
  for (const changed of [
    { ...external, connectionId: 'other-connection' },
    { ...external, actor: { ...external.actor, userId: 'other-user' } },
    { ...external, actor: { ...external.actor, application: { ...external.actor.application, appId: 'other-app' } } },
    { ...external, externalConversationId: 'other-room' }, { ...external, externalMessageId: 'other-message' },
    { ...external, bindingId: 'other-binding' }, { ...external, bindingRevision: 2 }
  ]) {
    const conflict = projectSessionInputs({ ...ref, ...f, mailbox: [{ ...item, message: envelope(changed) }] })
    expect(conflict).toHaveLength(1); expect(conflict[0]!.author).toEqual({ kind: 'unknown' })
    expect(conflict[0]!.messages[0]).toBe(f.messages[0])
  }
})

it('preserves journal-only human, agent, external, platform and unknown authors and keeps conflicts unknown', () => {
  const human = { kind: 'controlled', recordedAt: 1, sequence: 1, receipt: null,
    intent: { key, admissionIntent: { kind: 'manual-actor', expectedRun: key.expectedRun }, execution: 'immediate', source: { kind: 'prompt', prompt: 'same body', authorHuman: true } } } satisfies AgentInputMailboxItem
  const message = (sender: AgentMuxMessageIdentity): AgentInputMailboxItem => ({ ...human, message: envelope(sender), intent: { ...human.intent,
    key: { kind: 'message', agentSessionId: ref.agentSessionId, expectedRun: key.expectedRun, messageId: 'message' },
    source: { kind: 'message', messageId: 'message', originalControlOperationId: 'operation-message' } } })
  const launch: AgentInputMailboxItem = { kind: 'submission', key, recordedAt: 1, sequence: 1, record: { agentSessionId: ref.agentSessionId, run: key.expectedRun,
    launch: { input: { submissionId: key.submissionId, prompt: 'same body' }, prompt: 'same body', message: { authorAgentSessionId: 'peer' },
      digest: 'digest', delivery: 'launch', lifecycleOperationId: 'launch', state: 'launch-carried', key } } }
  const notice: AgentInputMailboxItem = { kind: 'submission', key, recordedAt: 1, sequence: 1, record: { agentSessionId: ref.agentSessionId, run: key.expectedRun,
    admission: { operationId: key.submissionId, submissionId: key.submissionId, inputKey: key, startByte: 0, endByte: 1,
      intent: { run: key.expectedRun, ownerInstanceId: 'owner', prompt: 'notice wire', plan: { kind: 'single-phase', data: 'notice wire' },
        message: { a2aNotificationId: key.submissionId, systemContext: 'notice wire' } } } } }
  const rows: Array<[AgentInputMailboxItem, sourceConversation.ConversationAuthor]> = [
    [human, { kind: 'human' }], [message({ kind: 'agent-session', agentSessionId: 'peer' }), { kind: 'agent', agentSessionId: 'peer' }],
    [message(external), external], [launch, { kind: 'agent', agentSessionId: 'peer' }], [notice, { kind: 'system' }],
    [message({ kind: 'human', principal: 'local-cli' }), { kind: 'unknown' }], [journal(), { kind: 'unknown' }]
  ]
  for (const [item, author] of rows) {
    expect(sessionInputMailboxAuthor(item)).toEqual(author)
    const groups = projectSessionInputs({ ...ref, messages: [], mailbox: [item] })
    expect(groups).toHaveLength(1); expect(groups[0]!.primary).toBeNull(); expect(groups[0]!.mailbox[0]).toBe(item); expect(groups[0]!.author).toEqual(author)
  }
  for (const mutate of [
    (item: typeof notice) => { item.record!.admission!.inputKey = { ...key, submissionId: 'foreign' } },
    (item: typeof notice) => { item.record!.admission!.inputKey = { ...key, agentSessionId: 'foreign' } },
    (item: typeof notice) => { item.record!.admission!.inputKey = { ...key, expectedRun: { runId: 'foreign' } } },
    (item: typeof notice) => { item.record!.agentSessionId = 'foreign' },
    (item: typeof notice) => { item.record!.run = { runId: 'foreign' } },
    (item: typeof notice) => { item.record!.admission!.intent!.run = { runId: 'foreign' } },
    (item: typeof notice) => { item.record!.admission!.intent!.message!.a2aNotificationId = 'foreign' },
    (item: typeof notice) => { item.record!.admission!.intent!.message!.systemContext = 'edited wire' },
    (item: typeof notice) => { item.record!.admission!.intent!.message!.userContent = 'authored body' }
  ]) { const unrelated = structuredClone(notice); mutate(unrelated); expect(sessionInputMailboxAuthor(unrelated)).toEqual({ kind: 'unknown' }) }
  const authoredNotice = structuredClone(notice); authoredNotice.record!.admission!.intent!.message!.authorHuman = true
  expect(sessionInputMailboxAuthor(authoredNotice)).toEqual({ kind: 'human' })
  const capturedAgent = reading([], [{ ...captured, authorAgentSessionId: 'peer' }])
  expect(projectSessionInputs({ ...ref, ...capturedAgent, mailbox: [human] })[0]!.author).toEqual({ kind: 'unknown' })
})

it('uses queried original relation facts without needing latest canonical rows or admitting their unmatched bodies', () => {
  const f = reading(), capture = f.messages.find(message => message.source.kind === 'captured')!
  expect(projectSessionInputs({ ...ref, messages: f.messages, mailbox: [journal()] })).toHaveLength(1)
  const only = projectSessionInputs({ ...ref, messages: [capture], inputs: f.inputs, mailbox: [journal()] })
  expect(only).toHaveLength(1); expect(only[0]!.primary).toBe(capture); expect(only[0]!.messages).toEqual([capture])
  expect(projectSessionInputs({ ...ref, messages: [], inputs: f.inputs })).toEqual([])
})

it('requires qualified native adoption and accounts for every queried candidate and retained event witness', () => {
  const second = structuredClone(native); second.id = 'second-native'; second.conversation!.nativeInput!.semanticItemId = 'second-semantic'
  delete second.conversation!.adoptedInput
  const f = reading([native, second]), groups = projectSessionInputs({ ...ref, ...f, mailbox: [journal()] })
  expect(groups).toHaveLength(3)
  expect(groups.find(group => group.mailbox.length)?.messages.map(message => message.source.kind)).toEqual(['captured'])
  const first = reading(), witnessed = structuredClone(first.inputs)
  witnessed[0]!.event.inputAdoption = { witnesses: [conversationNativeInputWitness(f.records.find(record => record.original.item === second)!)!] }
  expect(projectSessionInputs({ ...ref, messages: first.messages, inputs: witnessed, mailbox: [journal()] })).toHaveLength(2)
  const bare = structuredClone(native); delete bare.conversation!.nativeInput
  expect(projectSessionInputs({ ...ref, ...reading([bare]), mailbox: [journal()] })).toHaveLength(2)
  const token = structuredClone(native); delete token.conversation!.adoptedInput
  expect(projectSessionInputs({ ...ref, ...reading([token]), mailbox: [journal()] })).toHaveLength(2)
  for (const incorrect of [
    { ...native, turnId: 'foreign-turn' },
    { ...native, conversation: { ...native.conversation, nativeInput: { ...native.conversation!.nativeInput!, source: { ...source, nativeSessionId: 'foreign-native' } } } },
    { ...native, conversation: { ...native.conversation, adoptedInput: { key: { ...key, agentSessionId: 'foreign-session' } } } }
  ]) expect(projectSessionInputs({ ...ref, ...reading([incorrect]), mailbox: [journal()] })).toHaveLength(2)
})

it('invalidates old query proof on current original revision changes or withdrawal, preserving every query body', () => {
  const original = reading(), changed = structuredClone(native)
  delete changed.conversation!.adoptedInput
  changed.contentParts = [{ kind: 'text', text: 'new current body outside query' }]
  const current = reading([changed])
  const groups = projectSessionInputs({ ...ref, messages: original.messages, inputs: current.inputs, mailbox: [journal()] })
  expect(groups).toHaveLength(2); expect(groups.flatMap(group => group.messages)).toEqual(expect.arrayContaining(original.messages))
  expect(groups.flatMap(group => group.messages).every(message => message.content === 'same body')).toBe(true)
  const changedCapture = reading([native], [{ ...captured, inputRef: { ...key, submissionId: 'withdrawn-key' } }])
  const capture = original.messages.find(message => message.source.kind === 'captured')!
  expect(projectSessionInputs({ ...ref, messages: [capture], inputs: changedCapture.inputs, mailbox: [journal()] })).toHaveLength(2)
  const revised = reading([{ ...native, contentParts: [{ kind: 'text', text: 'same relation, new original version' }] }])
  expect(projectSessionInputs({ ...ref, messages: original.messages, inputs: revised.inputs, mailbox: [journal()] })).toHaveLength(2)
  const foreignCanonical = original.inputs.map(entity => ({ ...entity, hostId: 'different-route' }))
  const withoutFacts = original.messages.map(({ conversation: _conversation, inputRef: _inputRef, ...message }) => message)
  expect(projectSessionInputs({ ...ref, messages: withoutFacts, inputs: foreignCanonical })).toHaveLength(2)
})

it('reuses exact same-event edges and keeps foreign targets, cycles and unknown source boundaries separate', () => {
  const target = { hostId: ref.sourceHostId, agentSessionId: ref.agentSessionId, source: { kind: 'native' as const, ...source, recordId: native.id } }
  const bare = structuredClone(native); delete bare.conversation
  const original = { ...captured, conversation: { sameEvent: target } }; delete original.inputRef
  expect(projectSessionInputs({ ...ref, ...reading([bare], [original]) })).toHaveLength(1)
  expect(projectSessionInputs({ ...ref, ...reading([bare], [{ ...original, conversation: { sameEvent: { ...target, hostId: 'foreign' } } }]) })).toHaveLength(2)
  const f = reading([bare], [original])
  expect(projectSessionInputs({ ...ref, messages: f.messages.map(({ sourceRecord: _sourceRecord, ...message }) => message) })).toHaveLength(2)
  const secondTarget = { ...target, source: { ...target.source, recordId: 'second-native' } }
  expect(projectSessionInputs({ ...ref, ...reading([
    { ...bare, conversation: { sameEvent: secondTarget } },
    { ...bare, id: 'second-native', conversation: { sameEvent: target } }
  ], []) })).toHaveLength(2)
  const primary = f.messages.find(message => message.source.kind === 'native')!
  const foreign: AgentSessionUserMessage = { ...primary, id: 'foreign-native', rawId: 'foreign-native',
    source: { kind: 'native', providerId: 'another-provider', nativeSessionId: 'another-session', recordId: 'foreign-native' },
    sourceRecord: { record: { ...target, source: { kind: 'native', providerId: 'another-provider', nativeSessionId: 'another-session', recordId: 'foreign-native' } }, revision: 'd'.repeat(64) },
    conversation: { sameEvent: target } }
  expect(projectSessionInputs({ ...ref, messages: [primary, foreign] })).toHaveLength(2)
})

it('preserves original captured stream versions and exports only confirmed user input keys and small relation facts', () => {
  const unconfirmed = { ...captured, id: 'unconfirmed' }; delete unconfirmed.publicContent
  const revision = 'b'.repeat(64), items = [captured, unconfirmed, { ...captured, id: 'hook', source: 'native-hook' as const }]
  const timeline: AgentTimelineSnapshot = { agentSessionId: ref.agentSessionId, sourceHostId: ref.sourceHostId, revision: 1, items,
    stream: { epoch: 'epoch', sequence: 3, revision: 1, origin: 'beginning' as const, gaps: [], positions: items.map((item, index) => ({ id: item.id, sequence: index + 1, firstSequence: index + 1, revision })) } }
  const messages = projectSessionUserMessages({ agentSessionId: ref.agentSessionId, timeline })
  expect(messages.map(message => message.inputRef)).toEqual([key, undefined, undefined])
  expect(messages[0]!.sourceRecord!.revision).toBe(revision); expect(revision).not.toBe(conversationRevision(captured))
  const { sourceHostId: _host, ...withoutHost } = timeline, { stream: _stream, ...withoutStream } = timeline
  expect(projectSessionUserMessages({ agentSessionId: ref.agentSessionId, timeline: withoutHost })[0]!.sourceRecord).toBeUndefined()
  expect(projectSessionUserMessages({ agentSessionId: ref.agentSessionId, timeline: withoutStream })[0]!.sourceRecord).toBeUndefined()
})

async function adoptionFixture() {
  const compiled = process.env.AGENTMUX_INPUTS_COMPILED === '1', f = await paginatedFixture([], 'paginated', compiled); cleanup.push(f.close)
  const inputKey: AgentPromptInputKey = { ...key, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run }
  const token = createNativeInputCorrelation(inputKey), plan = { kind: 'native-rpc' as const, protocolId: 'protocol', actorId: 'actor', sourceId: JSON.stringify(['codex', source.nativeSessionId]), threadId: source.nativeSessionId, operation: 'start-or-steer' as const, clientCorrelation: token }
  const admission = { submissionId: key.submissionId, operationId: key.submissionId, inputKey, transport: 'native' as const, acknowledged: true,
    intent: { run: f.session.run, ownerInstanceId: 'owner', prompt: 'same body', plan, execution: 'immediate' as const, message: { userContent: 'same body', authorHuman: true as const }, admissionIntent: { kind: 'native-conversation' as const, source, expectedRun: f.session.run } },
    native: { plan, outcome: 'admitted' as const, turnId: turn } }
  const next = { ...f.session, promptCompletionAdmission: admission }; await f.store.compareAndSwap(f.session, next); Object.assign(f.session, next)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { ...captured, agentSessionId: f.session.agentSessionId, inputRef: inputKey } })
  const row = user('semantic-original', [{ type: 'text', text: 'same body' }]); row.payload.item.client_id = token
  await appendFile(f.transcriptPath, jsonl([row]))
  const core = compiled ? await import('../dist/index.js') : await import('../src/index.js')
  expect(f.client.agentMessageQueuePath()).toBe(join(f.root, 'global-messages.ndjson'))
  const queue = new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()); await queue.recordInputSubmission(inputKey, 1)
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  return { ...f, inputKey, rpc, queue }
}

it('real Store, native Provider, strict public RPC and compiled CLI retain original history and journal relationships', async () => {
  const f = await adoptionFixture(), scope = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const capturedPage = await f.rpc.call('agent.history', { ...scope, source: 'captured', kind: 'user-message' })
  const nativePage = await f.rpc.call('agent.history', { ...scope, source: 'native', kind: 'user-message' })
  const mailbox = await f.rpc.call('agent.input.ls', scope)
  const messages = [...capturedPage.userMessages!, ...nativePage.userMessages!], items = mailbox.items.flatMap(entry => entry.kind === 'item' ? [entry.item] : [])
  expect(capturedPage.userMessages![0]!.inputRef).toEqual(f.inputKey)
  expect(nativePage.userMessages![0]!.conversation!.adoptedInput).toEqual({ key: f.inputKey })
  expect(capturedPage.userMessages![0]!.sourceRecord!.revision).toBe((await f.store.readCapturedHistory(f.session.agentSessionId, {})).records[0]!.revision)
  const groups = projectSessionInputs({ ...scope, sourceHostId: capturedPage.sourceHostId!, messages, mailbox: items })
  expect(groups).toHaveLength(1); expect(groups[0]!.messages).toHaveLength(2); expect(groups[0]!.mailbox).toHaveLength(1)
  for (const mutate of [
    (message: AgentSessionUserMessage) => { message.inputRef = { ...f.inputKey, agentSessionId: 'foreign-session' } },
    (message: AgentSessionUserMessage) => { Object.assign(message.inputRef!, { extra: true }) },
    (message: AgentSessionUserMessage) => { message.publicContent = 'unknown' },
    (message: AgentSessionUserMessage) => { message.conversation = { ...message.conversation, observes: {} } as never }
  ]) { const bad = structuredClone(capturedPage); mutate(bad.userMessages![0]!); expect(() => parseAgentSessionHistoryReadPage(bad, { ...scope, source: 'captured', kind: 'user-message' })).toThrow() }
  for (const mutate of [
    (message: AgentSessionUserMessage) => { message.conversation!.nativeInput!.source.providerId = 'foreign-provider' },
    (message: AgentSessionUserMessage) => { message.conversation!.nativeInput!.source.nativeSessionId = 'foreign-native-session' },
    (message: AgentSessionUserMessage) => { message.conversation!.nativeInput!.turnId = 'foreign-turn' },
    (message: AgentSessionUserMessage) => { message.conversation!.adoptedInput!.key.agentSessionId = 'foreign-session' },
    (message: AgentSessionUserMessage) => { message.conversation!.sameEvent = { ...message.sourceRecord!.record, hostId: 'foreign-host' } }
  ]) { const retained = structuredClone(nativePage); mutate(retained.userMessages![0]!); expect(parseAgentSessionHistoryReadPage(retained, { ...scope, source: 'native', kind: 'user-message' }).userMessages).toEqual(retained.userMessages) }
  const capturedNative = structuredClone(capturedPage)
  capturedNative.userMessages![0]!.conversation = nativePage.userMessages![0]!.conversation!
  expect(parseAgentSessionHistoryReadPage(capturedNative, { ...scope, source: 'captured', kind: 'user-message' }).userMessages).toEqual(capturedNative.userMessages)
  if (process.env.AGENTMUX_INPUTS_COMPILED === '1') {
    for (const source of ['captured', 'native']) {
      const result = await runCompiledObjectCli(['agent', 'history', '--host', 'local', '--session', f.session.agentSessionId, '--source', source, '--kind', 'user-message'], objectCliEnvironment(f.root))
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).result.userMessages).toEqual((source === 'captured' ? capturedPage : nativePage).userMessages)
    }
    const result = await runCompiledObjectCli(['agent', 'input', 'ls', '--host-id', 'local', '--session', f.session.agentSessionId], objectCliEnvironment(f.root))
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).result.items).toEqual(mailbox.items)
  }
  // Read durable message envelopes through the same strict public mailbox boundary.
  for (const sender of [{ kind: 'agent-session', agentSessionId: 'peer' }, external, { kind: 'human', principal: 'local-cli' }] as const) {
    const original = envelope(sender, `journal-${sender.kind}`)
    await f.queue.append({ ...original, recipient: { kind: 'agent-session', agentSessionId: f.session.agentSessionId },
      recipientSessionId: f.session.agentSessionId, recipientRunId: f.session.run.runId, execution: 'immediate' },
    { admissionIntent: { kind: 'manual-actor', expectedRun: f.session.run }, inputEnvironment: { providerId: f.session.providerId, executorId: f.session.executorId } })
  }
  const journalPage = await f.rpc.call('agent.input.ls', scope)
  const journalItems = journalPage.items.flatMap(entry => entry.kind === 'item' && entry.item.kind === 'controlled' ? [entry.item] : [])
  const journalGroups = projectSessionInputs({ ...scope, sourceHostId: capturedPage.sourceHostId!, messages: [], mailbox: journalItems })
  expect(journalGroups).toHaveLength(3)
  expect(journalGroups.map(group => group.author)).toEqual([{ kind: 'unknown' }, external, { kind: 'agent', agentSessionId: 'peer' }])
}, 30_000)

it.each(['claude', 'pi'] as const)('real %s history and exact captured same-event keep raw resource, source and original query extent', async provider => {
  const f = await createHistoryQueryFixture(cleanup, provider), scope = f.reference
  const nativePage = await f.client.readAgentSessionHistory({ ...scope, source: 'native', query: 'input 4' })
  const message = nativePage.userMessages![0]!, item = { ...f.captured(10, 'matching capture'), publicContent: 'confirmed' as const,
    inputRef: { ...key, agentSessionId: scope.agentSessionId, expectedRun: f.session.run }, conversation: { sameEvent: message.sourceRecord!.record } }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: scope.agentSessionId, item })
  const capturedPage = await f.client.readAgentSessionHistory({ ...scope, source: 'captured', query: 'matching capture' })
  const messages = [...nativePage.userMessages!, ...capturedPage.userMessages!]
  expect(projectSessionInputs({ ...scope, sourceHostId: nativePage.sourceHostId!, messages })).toHaveLength(1)
  expect(messages.map(message => message.rawId)).toEqual(['record-4', 'captured-10'])
  const foreign = { ...f.captured(11, 'retained foreign relation body'), conversation: { sameEvent: { ...message.sourceRecord!.record, hostId: 'foreign-host' } } }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: scope.agentSessionId, item: foreign })
  const foreignRead = { ...scope, source: 'captured' as const, kind: 'user-message' as const, query: foreign.content! }
  const foreignPage = parseAgentSessionHistoryReadPage(await f.client.readAgentSessionHistory(foreignRead), foreignRead)
  expect(foreignPage.userMessages![0]!.content).toBe(foreign.content)
  expect(foreignPage.userMessages![0]!.conversation).toEqual(foreign.conversation)
  const separate = projectSessionInputs({ ...scope, sourceHostId: foreignPage.sourceHostId!, messages: [message, ...foreignPage.userMessages!] })
  expect(separate).toHaveLength(2); expect(separate.flatMap(group => group.messages).map(message => message.content)).toEqual([message.content, foreign.content])
  await expect(f.store.applyTimelineMutation({ type: 'append', agentSessionId: scope.agentSessionId,
    item: { ...foreign, publicContent: 'confirmed', inputRef: { ...key, agentSessionId: 'foreign-session' } } })).rejects.toThrow('Timeline input identity')
  await f.noControls()
})
