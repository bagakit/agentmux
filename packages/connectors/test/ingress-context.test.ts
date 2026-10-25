import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseConnectionIngressRecord, type ConnectionIngressMessage } from '@agentmux/core/connections'
import type { AgentInputSubmissionReceipt, ChannelTranscriptQuote } from '@agentmux/core'
import { renderAgentMuxMessageEnvelope } from '../../core/src/agent-message-render.js'
import { IngressContextPositions } from '../src/ingress-context.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const application = { domain: 'native.example', appId: 'app' }, actor = { application, idType: 'user', userId: 'original-user' }
const source = { providerId: 'codex', nativeSessionId: 'original-native-conversation' }
const recipient = { bindingId: 'binding', bindingRevision: 1, hostId: 'local', agentSessionId: 'original-agent', source }
const base = (id: string, bindingId = 'binding') => ({ ingressId: bindingId + '-' + id, connectionId: 'connection', application,
  eventId: 'event-' + id, externalMessageId: id, externalConversationId: 'room', conversationKind: 'group', actor, body: 'Original ' + id,
  group: { target: { hostId: 'local', agentSessionId: 'original-agent', connectionId: 'connection', bindingId, bindingRevision: 1 } }, state: 'received' })
function input(id: string, records: string[], from = 'baseline', origin: ChannelTranscriptQuote['range']['origin'] = 'first-observed', bindingId = 'binding'): ConnectionIngressMessage {
  return parseConnectionIngressRecord({ ...base(id, bindingId), state: 'claimed', input: { hostId: 'local', agentSessionId: 'original-agent',
    expectedRun: { runId: 'original-run' }, operationId: 'operation-' + bindingId + '-' + id, messageId: 'message-' + bindingId + '-' + id,
    author: { kind: 'external', connectionId: 'connection', actor, externalConversationId: 'room', externalMessageId: id,
      bindingId, bindingRevision: 1, grantId: 'original-grant', grantRevision: 1 }, contextSource: source,
    admissionIntent: { kind: 'native-conversation', expectedRun: { runId: 'original-run' }, source }, channelQuote: {
      version: 1, application, externalConversationId: 'room', observedAt: 1, range: { from: { messageId: from, inclusive: origin === 'first-observed' }, throughMessageId: id, origin },
      coverage: 'complete', gaps: [], records: records.map(messageId => ({ messageId, contentType: 'text', content: 'Original ' + messageId, author: { kind: 'unknown' } })) } } }) as ConnectionIngressMessage
}
/** Only the original Core receipt observation is controlled; no native effect is executed here. */
function admitted(record: ConnectionIngressMessage): AgentInputSubmissionReceipt {
  const ref = record.input!
  return { key: { kind: 'message', agentSessionId: ref.agentSessionId, messageId: ref.messageId, expectedRun: ref.expectedRun },
    originalControlOperationId: ref.operationId, status: 'admitted', admission: { admission: { transport: 'native', acknowledged: true,
      intent: { prompt: renderAgentMuxMessageEnvelope({ sender: ref.author, body: record.body, channelQuote: ref.channelQuote! }) },
      native: { outcome: 'admitted', plan: { sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), threadId: source.nativeSessionId } } } } } as AgentInputSubmissionReceipt
}
async function fixture(baseline: unknown = base('baseline')) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-context-position-')), path = join(directory, 'original.sqlite')
  let database = new DatabaseSync(path)
  database.exec('CREATE TABLE connection_ingress_message(ingress_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, record_json TEXT NOT NULL) STRICT')
  let owner = new IngressContextPositions(database), sequence = 0
  cleanup.push(() => { database.close() }); cleanup.unshift(() => rm(directory, { recursive: true, force: true }))
  const insert = (record: unknown) => {
    const parsed = parseConnectionIngressRecord(record)
    database.prepare('INSERT INTO connection_ingress_message VALUES (?,?,?)').run(parsed.ingressId, ++sequence, JSON.stringify(parsed))
    if (parsed.kind !== 'action' && parsed.state === 'claimed') owner.claimed(parsed)
  }
  insert(baseline)
  return { insert, get owner() { return owner }, get database() { return database },
    reopen: () => { database.close(); database = new DatabaseSync(path); owner = new IngressContextPositions(database) },
    pending: () => database.prepare('SELECT ingress_id FROM connection_ingress_context_pending ORDER BY sequence').all().map(row => row.ingress_id) }
}

it('retires a late admitted input already covered by the current frozen interval without inspecting it on repeated reconciliations or regressing after reopen', async () => {
  const f = await fixture(), first = input('first', ['baseline']), second = input('second', ['baseline', 'first'])
  f.insert(first); f.insert(second)
  const originalRows = f.database.prepare('SELECT record_json FROM connection_ingress_message ORDER BY sequence').all()
  expect(f.owner.observe(second, admitted(second))).toBe(true)
  expect(f.owner.observe(first, admitted(first))).toBe(false)
  expect(f.owner.position(recipient)).toEqual({ ingressId: second.ingressId, messageId: 'second' })
  const inspect = vi.fn(async () => admitted(first))
  await f.owner.reconcile(recipient, inspect); await f.owner.reconcile(recipient, inspect)
  f.reopen(); await f.owner.reconcile(recipient, inspect)
  expect(inspect).not.toHaveBeenCalled(); expect(f.pending()).toEqual([])
  expect(f.owner.position(recipient)).toEqual({ ingressId: second.ingressId, messageId: 'second' })
  expect(f.database.prepare('SELECT record_json FROM connection_ingress_message ORDER BY sequence').all()).toEqual(originalRows)
})

it('uses an exact frozen from identity as coverage without replacing an established position', async () => {
  const f = await fixture(), first = input('first', ['baseline']), second = input('second', [], 'first', 'admitted-input')
  f.insert(first); expect(f.owner.observe(first, admitted(first))).toBe(true)
  f.insert(second); expect(f.owner.observe(second, admitted(second))).toBe(true)
  // A retained receipt index entry can be reconciled against the original accepted boundary.
  f.owner.claimed(first)
  expect(f.owner.observe(first, admitted(first))).toBe(false)
  const inspect = vi.fn(async () => admitted(first)); await f.owner.reconcile(recipient, inspect)
  expect(inspect).not.toHaveBeenCalled(); expect(f.owner.position(recipient)?.messageId).toBe('second')
})

it('retains an uncovered original receipt until its exact interval can join the current position, regardless of intake sequence', async () => {
  const f = await fixture(), later = input('later', [], 'middle', 'admitted-input'), middle = input('middle', [], 'old', 'admitted-input'), old = input('old', ['baseline'])
  f.insert(later); f.insert(middle); f.insert(old)
  expect(f.owner.observe(old, admitted(old))).toBe(true)
  expect(f.owner.observe(later, admitted(later))).toBe(false)
  expect(f.pending()).toContain(later.ingressId)
  expect(f.owner.position(recipient)?.messageId).toBe('old')
  expect(f.owner.observe(middle, admitted(middle))).toBe(true)
  expect(f.owner.observe(later, admitted(later))).toBe(true)
  expect(f.owner.position(recipient)?.messageId).toBe('later'); expect(f.pending()).toEqual([])
})

it('keeps unknown original effects inspect-only and excludes another recipient scope from reconciliation work', async () => {
  const f = await fixture(), first = input('first', ['baseline']), second = input('second', ['baseline', 'first']), other = input('first', ['baseline'], 'baseline', 'first-observed', 'other-binding')
  f.insert(first); f.insert(second); f.insert(other); expect(f.owner.observe(second, admitted(second))).toBe(true)
  const unknown = { ...admitted(first), status: 'unknown' as const }
  expect(f.owner.observe(first, unknown)).toBe(false)
  const inspect = vi.fn(async () => unknown)
  await f.owner.reconcile(recipient, inspect)
  expect(inspect).toHaveBeenCalledExactlyOnceWith(first.input!.operationId)
  expect(f.pending()).toEqual([first.ingressId, other.ingressId]); expect(f.owner.position(recipient)?.messageId).toBe('second')
})

function revision(record: ConnectionIngressMessage, configuration: number, publication?: number): ConnectionIngressMessage {
  return parseConnectionIngressRecord({ ...record, group: { ...record.group, target: { ...record.group!.target!, bindingRevision: configuration,
    ...(publication === undefined ? {} : { publicationRevision: publication }) } }, ...(record.input ? { input: { ...record.input, author: { ...record.input.author, bindingRevision: configuration } } } : {}) }) as ConnectionIngressMessage
}

it('a first-observed intake after a trigger edit establishes the exact original publication baseline before claim', async () => {
  const baseline = revision(parseConnectionIngressRecord(base('baseline')) as ConnectionIngressMessage, 2, 1)
  const f = await fixture(baseline), first = revision(input('first', ['baseline']), 3, 1)
  f.insert(first)
  const saved = f.database.prepare('SELECT record_json FROM connection_ingress_message ORDER BY sequence').all()
  expect(f.owner.observe(first, admitted(first))).toBe(true)
  expect(f.owner.position(recipient)).toEqual({ ingressId: first.ingressId, messageId: 'first' })
  const second = revision(input('second', [], 'first', 'admitted-input'), 4, 1)
  f.insert(second); expect(f.owner.observe(second, admitted(second))).toBe(true)
  f.database.exec("CREATE INDEX connection_ingress_context_origin ON connection_ingress_message(json_extract(record_json,'$.group.target.bindingId'),json_extract(record_json,'$.group.target.bindingRevision'),sequence)")
  f.reopen()
  expect(f.owner.position(recipient)?.messageId).toBe('second')
  expect(f.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='connection_ingress_context_origin'").get()).toBeUndefined()
  expect(f.database.prepare('SELECT record_json FROM connection_ingress_message ORDER BY sequence LIMIT 2').all()).toEqual(saved)
})

it('a missing frozen publication fact and another source remain independent instead of guessing a prior root', async () => {
  const f = await fixture(), first = revision(input('first', ['baseline']), 2)
  f.insert(first)
  expect(f.owner.observe(first, admitted(first))).toBe(false)
  expect(f.owner.position(recipient)).toBeNull()
  expect(f.owner.position({ ...recipient, bindingRevision: 2 })).toBeNull()
  const original = input('accepted', ['baseline']); f.insert(original)
  expect(f.owner.observe(original, admitted(original))).toBe(true)
  expect(f.owner.position({ ...recipient, source: { ...source, nativeSessionId: 'different-original-source' } })).toBeNull()
  const unknown = revision(input('unknown', [], 'accepted', 'admitted-input'), 3, 1); f.insert(unknown)
  expect(f.owner.observe(unknown, { ...admitted(unknown), status: 'unknown' })).toBe(false)
  const terminal = { ...admitted(unknown), status: 'terminal-confirmed' as const }
  expect(f.owner.observe(unknown, terminal)).toBe(false)
  expect(f.owner.position(recipient)?.messageId).toBe('accepted')
  expect(() => revision(original, 2, 3)).toThrow()
})

it('a late original native receipt across configuration revisions retires once without moving an accepted later interval backwards', async () => {
  const f = await fixture(), first = revision(input('first', ['baseline']), 2, 1), second = revision(input('second', ['baseline', 'first']), 3, 1)
  f.insert(first); f.insert(second)
  expect(f.owner.observe(second, admitted(second))).toBe(true)
  f.reopen()
  const inspect = vi.fn(async () => admitted(first))
  await f.owner.reconcile(recipient, inspect)
  expect(inspect).toHaveBeenCalledExactlyOnceWith(first.input!.operationId)
  expect(f.owner.position(recipient)?.messageId).toBe('second'); expect(f.pending()).toEqual([])
  await f.owner.reconcile(recipient, inspect); expect(inspect).toHaveBeenCalledTimes(1)
})
