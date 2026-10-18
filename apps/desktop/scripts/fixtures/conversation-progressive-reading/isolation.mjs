import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'

/** Another real Core Session has no Tab or Region in the original App. */
export async function exerciseIsolation({ runtime, core, store, config, privateRoot, phase, read, click, until, appendRow, scene, original }) {
  const file = path.join(privateRoot, 'unrelated.json')
  let unrelated
  if (phase === 'seed') {
    const { session } = await runtime.launchAgent({ hostId: 'local', executorId: 'codex', workspacePath: config.workspaces[0].path }, config)
    const stored = await until(async () => {
      const value = await store.readMetadata(session.id)
      return value?.nativeHandle?.kind === 'provider' && value.nativeHandle.transcriptPath ? value : null
    }, 'Unrelated original native handle')
    unrelated = { sessionId: session.id, runId: session.control.run.runId, nativeSessionId: stored.nativeHandle.sessionId }
    await fs.writeFile(file, JSON.stringify(unrelated), { flag: 'wx' })
  } else unrelated = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.notEqual(unrelated.sessionId, original.sessionId)
  assert.notEqual(unrelated.runId, original.runId)
  const originalRuns = await core.listRuns()
  assert.ok(originalRuns.some(run => run.runId === unrelated.runId && run.state === 'running'))
  const complete = async () => {
    let pending, cursor
    for (let index = 0; index < 100; index++) {
      const page = await core.readAgentConversation({ hostId: 'local', agentSessionId: unrelated.sessionId, limit: 100, maxBytes: 4 * 1024 * 1024, ...(cursor ? { cursor } : {}) })
      const result = consumeConversationWindowPage(page, pending)
      if (result.kind === 'complete') return result.snapshot
      pending = result.pending; cursor = page.nextCursor
      assert.ok(cursor, 'Original unrelated assembly requires its exact continuation')
    }
    throw new Error('Unrelated original frame did not finish')
  }
  const receiptFor = snapshot => ({ sessionId: snapshot.window.checkpoint.agentSessionId, window: { id: snapshot.window.id, revision: snapshot.window.revision },
    nativeCut: snapshot.window.checkpoint.frontier.cuts.find(cut => cut.kind === 'native')?.checkpoint.cursor,
    nativeIds: snapshot.units.flatMap(unit => unit.records.flatMap(record => record.reference?.source.kind === 'native' ? [record.reference.source.recordId] : [])) })
  let before = receiptFor(await complete())
  const appendUnrelated = async suffix => {
    const stored = await store.readMetadata(unrelated.sessionId)
    assert.equal(stored.nativeHandle.kind, 'provider'); assert.equal(stored.nativeHandle.sessionId, unrelated.nativeSessionId)
    const row = appendRow(scene, `unrelated-${phase}-${suffix}`)
    await fs.appendFile(stored.nativeHandle.transcriptPath, JSON.stringify(row) + '\n')
    const observed = await until(async () => {
      const next = receiptFor(await complete())
      return next.nativeIds.includes(row.payload.id) && next.nativeCut !== before.nativeCut ? next : null
    }, 'Exact unrelated record reaches the original Core read')
    assert.equal(observed.sessionId, unrelated.sessionId)
    before = observed
    return { recordId: row.payload.id, observed }
  }
  const settled = enabled => until(() => read(`(()=>{const c=readingProof.consumer();return c&&c.gates.enabled===${enabled}&&!c.inFlight&&!c.loading&&!readingProof.inFlightCalls().length&&${enabled ? 'true' : '!c.watch.bound&&!c.watch.binding'}?c:null})()`), 'Original consumer and the explicit visibility action settle')
  const counts = () => read('({reads:readingProof.events.filter(e=>e.type==="read-start").length,heavyMounts:readingProof.metrics.heavyMounts.length})')
  const frameSample = () => read('new Promise(resolve=>{let n=0;function next(){if(++n===12)resolve(true);else requestAnimationFrame(next)}requestAnimationFrame(next)})')
  const identity = consumer => ({ consumerId: consumer.consumerId, readingIdentity: consumer.readingIdentity,
    accepted: consumer.accepted && { id: consumer.accepted.id, revision: consumer.accepted.revision, checkpoint: consumer.accepted.checkpoint }, watch: consumer.watch })
  const settleAction = async enabled => { await settled(enabled); await frameSample(); return settled(enabled) }
  const sample = async name => {
    const beforeConsumer = identity(await settled(name === 'visible'))
    const start = await counts(), source = await appendUnrelated(name)
    await frameSample()
    const afterConsumer = identity(await settled(name === 'visible'))
    const end = await counts(), delta = { reads: end.reads - start.reads, heavyMounts: end.heavyMounts - start.heavyMounts }
    assert.deepEqual(delta, { reads: 0, heavyMounts: 0 }, 'Unrelated output adds no original reading or heavy presentation work')
    assert.deepEqual(afterConsumer, beforeConsumer, 'Unrelated output cannot replace or invalidate the original reading consumer')
    return { before: start, after: end, delta, source, consumer: { before: beforeConsumer, after: afterConsumer } }
  }
  await settleAction(true)
  const visible = await sample('visible')
  const anchor = await read(`(()=>{const feed=document.querySelector('.activity-feed'),bounds=feed.getBoundingClientRect();const leaf=[...feed.querySelectorAll('[data-native-record-id]')].find(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>bounds.top&&r.top<bounds.bottom});if(!leaf)throw new Error('No visible original native leaf');window.isolationOriginal=leaf;return {id:leaf.dataset.nativeRecordId,top:leaf.getBoundingClientRect().top}})()`)
  await click('document.querySelector("[aria-label=\\"Show Terminal\\"]")')
  const hiddenConsumer = await settleAction(false)
  const hidden = await sample('hidden')
  await click('document.querySelector("[aria-label=\\"Show Activity\\"]")')
  await settled(true); await frameSample()
  const restored = await read('({sameNode:isolationOriginal.isConnected,id:isolationOriginal.dataset.nativeRecordId,top:isolationOriginal.getBoundingClientRect().top})')
  assert.equal(restored.sameNode, true); assert.equal(restored.id, anchor.id)
  assert.ok(Math.abs(restored.top - anchor.top) <= 2, 'Reopening keeps the original visible native leaf')
  return { unrelated, visible, hidden, hiddenConsumer, anchor, restored, observationFrames: 12,
    boundary: 'Actual Terminal/Activity controls and another real original Core Session; counters sampled after exact native read receipts. The bounded frame interval is reported, not a universal idle guarantee.' }
}
