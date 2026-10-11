import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Exercise the original automatic intent before its first Native Start through mounted controls. */
export async function verifyInitialWaitSurface({ store, spatial, win, client, ids, phase, evidence, result, state, wait, delay }: any) {
  assert.equal(phase, 'seed')
  const original = ids.working.sessionId, evaluate = (source: string) => win.webContents.executeJavaScript(source)
  const current = async () => (await store.load()).find((one: any) => one.agentSessionId === original)
  const root = await wait('startup persists an unstarted delayed intent', async () => {
    const session = await current(), operation = session?.continuityOperations?.[session.continuity?.operationId]
    return operation?.supervision?.attemptCount === 0 && operation.reason === 'active-delay' ? operation : false
  })
  assert.equal(root.kind, 'pending'); assert.equal(root.supervision.activeAttemptOperationId, root.operationId)
  assert.equal(root.newRun, undefined); assert.ok(root.nextActionAt > Date.now())
  assert.deepEqual(root.previousRun, ids.working.run)
  await wait('mounted Store consumes the exact original zero-count intent', async () =>
    (await state()).sessions.find((one: any) => one.id === original)?.continuityOperations?.[root.operationId]?.supervision?.attemptCount === 0)
  const initial = await state(), healthyBefore = (await client().listRuns()).find((one: any) => one.runId === ids.healthy.run.runId)
  assert.equal(healthyBefore.state, 'running')
  const stable = (value: any) => ({ tabs: value.tabs, layouts: value.layouts, drafts: value.drafts })
  const frames: any[] = []
  win.setSize(920, 880); await delay(100)
  const capture = async (name: string) => {
    await evaluate(`(()=>{const button=document.querySelector('[data-workbench-region-id="continuity-working"] .continuity-supervision .service-disclosure__trigger');if(!button)throw Error('Original waiting disclosure unavailable');if(button.getAttribute('aria-expanded')!=='true')button.click()})()`)
    const terminal = await wait('the independent healthy Terminal retains its native frame', async () => {
      const value = await evaluate('window.continuityTerminalState("healthy")')
      return value?.observation?.visible && value.observation.liveReady && value.text.includes('codex-ready:') ? value : false
    })
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const snapshot = await state(), bytes = (await win.capturePage()).toPNG(), file = name + '.png'
    await fs.writeFile(path.join(evidence, file), bytes)
    frames.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), width: 920, healthyTerminal: terminal,
      originalRun: snapshot.sessions.find((one: any) => one.id === original)?.control.run, draft: snapshot.drafts[original], dom: snapshot.dom })
    assert.deepEqual(stable(snapshot), stable(initial), 'Waiting controls preserve the original layout and independent drafts')
  }
  await capture('initial-recovery-waiting-narrow')
  assert.ok(frames[0].dom.includes('Waiting for initial recovery')); assert.ok(frames[0].dom.includes('No recovery attempt has started.'))
  assert.ok(!frames[0].dom.includes('Additional recovery attempts'))
  await evaluate(`(()=>{const region=document.querySelector('[data-workbench-region-id="continuity-working"]');const button=[...region.querySelectorAll('.continuity-supervision button')].find(one=>one.textContent.trim()==='Cancel automatic recovery');if(!button||button.disabled)throw Error('Initial cancellation unavailable');button.click()})()`)
  const cancelled = await wait('actual Core commits cancellation of the original initial wait', async () => {
    const session = await current(), operation = session?.continuityOperations?.[root.operationId]
    return operation?.supervision?.phase === 'cancelled' ? operation : false
  })
  assert.equal(cancelled.supervision.attemptCount, 0); assert.equal(cancelled.newRun, undefined); assert.equal(cancelled.nextActionAt, undefined)
  const receipts = Object.values(cancelled.supervision.controlOperations) as any[]
  assert.equal(receipts.length, 1); const receipt = receipts[0]
  assert.equal(receipt.request.action, 'cancel'); assert.equal(receipt.outcome, 'cancelled')
  assert.equal(receipt.request.intentOperationId, root.operationId); assert.deepEqual(receipt.request.expectedRun, root.previousRun)
  await wait('mounted Store consumes the original cancellation receipt', async () =>
    (await state()).sessions.find((one: any) => one.id === original)?.continuityOperations?.[root.operationId]?.supervision?.phase === 'cancelled')
  await capture('initial-recovery-cancelled-narrow')
  assert.ok(frames[1].dom.includes('Automatic recovery cancelled'))
  const runs = await client().listRuns(), healthy = runs.find((one: any) => one.runId === ids.healthy.run.runId)
  assert.equal(healthy.state, 'running'); assert.equal(healthy.pid, healthyBefore.pid)
  assert.deepEqual((await current()).run, root.previousRun)
  const calls = result.calls.filter((one: any) => one.operation === 'control-continuity')
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].args[1], receipt.request); assert.deepEqual(calls[0].result.result.receipt, receipt)
  result.supervision = { kind: 'initial-wait', original: { sessionId: original, rootOperationId: root.operationId },
    before: root, after: cancelled, receipt, frames, healthy: { runId: healthy.runId, pid: healthy.pid }, spatial: await spatial.readForLayout() }
  await evaluate('window.continuityFlush()')
}
