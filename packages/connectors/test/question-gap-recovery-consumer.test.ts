import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { consumeJsonReadEntry, type ConversationUnit, type JsonReadAssembly } from '@agentmux/core/conversation'
import { savedQuestionEvent, savedQuestionFixture, savedQuestionId, savedQuestionJsonl, savedQuestionReply } from '../../core/test/helpers/codex-saved-question.js'
import { ConnectionHost } from '../src/connection-host.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { PublicationStore, type PublicationBoundary } from '../src/publication-store.js'
import { feishuConfig } from './fixtures/feishu.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const questionGap = 'CONVERSATION_QUESTION_TARGET_UNREAD'
function replyWithTargets(questionIds: string[]) {
  const reply = savedQuestionReply(), [open, body, close] = reply.payload.content[0]!.text.split('\n')
  const answer = JSON.parse(body!)[0]
  reply.payload.content[0]!.text = [open, JSON.stringify(questionIds.map(questionItemId => ({ ...answer, questionItemId }))), close].join('\n')
  return reply
}

async function fixture() {
  const saved = await savedQuestionFixture([], { unifiedCapturedRead: true }); cleanup.push(saved.close)
  const options = { databasePath: join(saved.root, 'connections.sqlite'), secrets: { resolve: async () => null } }
  let connections = new ConnectionHost(options)
  cleanup.push(() => connections.close())
  const port = createPublicationConversationPort(() => [{ hostId: 'local', client: saved.client }]), signal = new AbortController().signal
  const ref = { hostId: 'local', agentSessionId: saved.session.agentSessionId }, start = await port.checkpoint(ref, signal)
  const boundary: PublicationBoundary = { bindingId: 'original-question-coverage', revision: 1,
    connectionId: feishuConfig.connectionId, application: feishuConfig.application, executionHostId: ref.hostId,
    agentSessionId: ref.agentSessionId, externalConversationId: 'original-question-room',
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, sourceFrontier: start.checkpoint,
    sourceCheckpoints: start.checkpoint.frontier.cuts.flatMap(cut => cut.kind === 'native' ? [cut.checkpoint] : []) }
  let store = new PublicationStore(connections.database), after = store.checkpoint(boundary, start.sourceHostId)
  const accepted: ConversationUnit[] = []
  async function readOriginalChanges() {
    const current: ConversationUnit[] = []
    for (let batch = 0; batch < 4; batch++) {
      const units: ConversationUnit[] = []; let cursor: string | undefined, pending: JsonReadAssembly | undefined
      let page: Awaited<ReturnType<typeof port.changes>>
      do {
        page = await port.changes({ ...ref, checkpoint: after, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) }, signal)
        for (const entry of page.items) {
          const read = consumeJsonReadEntry({ entry, scopeKey: JSON.stringify(after), ...(pending ? { pending } : {}), maxTotalBytes: 32 * 1024 * 1024 })
          if (read.kind === 'pending') pending = read.pending
          else { pending = undefined; units.push(read.value) }
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      expect(pending).toBeUndefined(); accepted.push(...units); current.push(...units)
      store.commitPage(boundary, after, page!, () => true, { units, resolvedText: new Map() }); after = page!.checkpoint
      if (!page!.more) return current
    }
    throw Error('Original scoped Core changes did not finish within the fixture bound')
  }

  return { saved, boundary, accepted, readOriginalChanges, get connections() { return connections }, get store() { return store },
    reopen() { connections.close(); connections = new ConnectionHost(options); store = new PublicationStore(connections.database); after = store.checkpoint(boundary, start.sourceHostId) } }
}

it('retires only the original unread-question gap when the exact Core question is later accepted', async () => {
  const f = await fixture(), { saved, boundary, accepted, readOriginalChanges } = f
  let store = f.store

  await appendFile(saved.transcriptPath, savedQuestionJsonl([savedQuestionReply()]))
  const answerUnits = await readOriginalChanges()
  const answer = answerUnits.flatMap(unit => unit.records).find(record => record.original.kind === 'native' && record.original.item.questionAnswers?.length)
  expect(answer?.original.kind === 'native' && answer.original.item.questionAnswers?.map(item => item.questionId)).toEqual([savedQuestionId])
  const originalGap = store.coverage(boundary).gaps.find(gap => gap.code === questionGap)
  expect(originalGap).toMatchObject({ reason: 'source-gap', record: answer!.reference })
  expect(answerUnits.flatMap(unit => unit.event.relations ?? []).filter(relation => relation.kind === 'answers')).toHaveLength(1)

  await readOriginalChanges()
  expect(store.coverage(boundary).gaps).toContainEqual(originalGap)
  const wrongQuestion = savedQuestionEvent()
  wrongQuestion.payload.item.id = 'another-original-question'
  await appendFile(saved.transcriptPath, savedQuestionJsonl([wrongQuestion]))
  const wrongUnits = await readOriginalChanges()
  expect(wrongUnits.flatMap(unit => unit.records).some(record => record.original.kind === 'native' && record.original.item.questionRequest?.questions.some(question => question.id !== savedQuestionId))).toBe(true)
  expect(store.coverage(boundary).gaps).toContainEqual(originalGap)

  f.reopen(); store = f.store
  await appendFile(saved.transcriptPath, savedQuestionJsonl([savedQuestionEvent()]))
  const exactUnits = await readOriginalChanges()
  expect(exactUnits.flatMap(unit => unit.records).some(record => record.original.kind === 'native' && record.original.item.questionRequest?.questions.some(question => question.id === savedQuestionId))).toBe(true)
  const gaps = store.coverage(boundary).gaps
  const facts = { originalQuestionId: savedQuestionId, answer: { reference: answer!.reference, revision: answer!.revision },
    originalGap, wrongAcceptedRecords: wrongUnits.flatMap(unit => unit.records.map(record => record.id)),
    exactAcceptedRecords: exactUnits.flatMap(unit => unit.records.map(record => record.id)),
    questionGapRetained: gaps.some(gap => gap.gapId === originalGap!.gapId),
    answerPublicContentStillUnconfirmed: gaps.some(gap => gap.reason === 'public-content-unconfirmed' && gap.part?.record.source.recordId === answer!.reference!.source.recordId),
    platformEffects: 0, acceptedUnits: accepted.length }
  if (process.env.QUESTION_GAP_FACTS) await writeFile(process.env.QUESTION_GAP_FACTS, JSON.stringify(facts, null, 2) + '\n')
  expect(facts.answerPublicContentStillUnconfirmed).toBe(true)
  expect(gaps.map(gap => gap.gapId), 'The accepted original question must retire its reading gap without confirming the answer').not.toContain(originalGap!.gapId)
}, 20_000)


it('retains exact partial question reads across reopening until every frozen target is accepted', async () => {
  const f = await fixture()
  const second = savedQuestionEvent(); second.payload.item.id = 'second-original-call'
  const secondId = JSON.stringify(['request_user_input_async', second.payload.item.id, 0])
  const reply = replyWithTargets([savedQuestionId, secondId])
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([reply])); await f.readOriginalChanges()
  const original = f.store.coverage(f.boundary).gaps.find(gap => gap.code === questionGap)!
  expect(original).toBeDefined()
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([savedQuestionEvent()])); await f.readOriginalChanges()
  expect(f.store.coverage(f.boundary).gaps).toContainEqual(original)
  const decision = () => JSON.parse(String(f.connections.database.prepare('SELECT decision_json FROM connector_publication_decision WHERE record_id=?').get(original.gapId)!.decision_json))
  const partial = decision().questionReads
  expect(partial).toHaveLength(1); expect(partial[0].targets).toHaveLength(2); expect(partial[0].read).toHaveLength(1)
  f.reopen(); expect(decision().questionReads).toEqual(partial)
  await f.readOriginalChanges(); expect(f.store.coverage(f.boundary).gaps).toContainEqual(original)
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([second])); await f.readOriginalChanges()
  expect(f.store.coverage(f.boundary).gaps.map(gap => gap.gapId)).not.toContain(original.gapId)
  expect(decision().questionReads[0].targets).toEqual(partial[0].targets)
  expect(decision().questionReads[0].read).toHaveLength(2)
})

it('keeps a historical question gap without frozen target evidence unknown after a later current question read', async () => {
  const f = await fixture()
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([savedQuestionReply()])); await f.readOriginalChanges()
  const original = f.store.coverage(f.boundary).gaps.find(gap => gap.code === questionGap)!
  const row = f.connections.database.prepare('SELECT rowid,decision_json FROM connector_publication_decision WHERE record_id=?').get(original.gapId)!
  const { questionReads: _unavailableOriginalEvidence, ...historical } = JSON.parse(String(row.decision_json))
  // Exact pre-fix persisted shape, not a reconstruction from today's answer.
  f.connections.database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(JSON.stringify(historical), Number(row.rowid))
  f.reopen()
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([savedQuestionEvent()])); await f.readOriginalChanges()
  expect(f.store.coverage(f.boundary).gaps).toContainEqual(original)
  expect(JSON.parse(String(f.connections.database.prepare('SELECT decision_json FROM connector_publication_decision WHERE rowid=?').get(Number(row.rowid))!.decision_json))).toEqual(historical)
})

it('does not replace the frozen original target when the same answer record accepts a changed version', async () => {
  const f = await fixture()
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([savedQuestionReply()])); await f.readOriginalChanges()
  const original = f.store.coverage(f.boundary).gaps.find(gap => gap.code === questionGap)!
  const decision = () => JSON.parse(String(f.connections.database.prepare('SELECT decision_json FROM connector_publication_decision WHERE record_id=?').get(original.gapId)!.decision_json))
  const first = structuredClone(decision().questionReads[0])
  const changedQuestion = savedQuestionEvent(); changedQuestion.payload.item.id = 'changed-answer-question'
  const changedReply = replyWithTargets([JSON.stringify(['request_user_input_async', changedQuestion.payload.item.id, 0])])
  expect(changedReply.payload.content[0]!.text).not.toBe(savedQuestionReply().payload.content[0]!.text)
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([changedReply])); await f.readOriginalChanges()
  expect(decision().questionReads).toHaveLength(2)
  expect(decision().questionReads[0]).toEqual(first)
  expect(decision().questionReads[1].recordRevision).not.toBe(first.recordRevision)
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([changedQuestion])); await f.readOriginalChanges()
  expect(f.store.coverage(f.boundary).gaps).toContainEqual(original)
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([savedQuestionEvent()])); await f.readOriginalChanges()
  expect(f.store.coverage(f.boundary).gaps.map(gap => gap.gapId)).not.toContain(original.gapId)
})

it('retains an exact question accepted before the answer when another target is accepted later', async () => {
  const f = await fixture()
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([savedQuestionEvent()]))
  const earlier = await f.readOriginalChanges()
  expect(earlier.flatMap(unit => unit.records).some(record => record.original.kind === 'native' && record.original.item.questionRequest?.questions.some(question => question.id === savedQuestionId))).toBe(true)
  const later = savedQuestionEvent(); later.payload.item.id = 'later-original-call'
  const laterId = JSON.stringify(['request_user_input_async', later.payload.item.id, 0])
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([replyWithTargets([savedQuestionId, laterId])]))
  await f.readOriginalChanges()
  const original = f.store.coverage(f.boundary).gaps.find(gap => gap.code === questionGap)!
  expect(original).toBeDefined()
  await appendFile(f.saved.transcriptPath, savedQuestionJsonl([later])); await f.readOriginalChanges()
  expect(f.store.coverage(f.boundary).gaps.map(gap => gap.gapId), 'Both exact questions were accepted on their original pages').not.toContain(original.gapId)
})
