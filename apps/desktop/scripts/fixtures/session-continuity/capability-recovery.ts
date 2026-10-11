import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

/** A second scenario on the existing private native restart harness, not a replacement client. */
export async function verifyCapabilityRecovery({ runtime, store, spatial, win, client, ids, phase, privateRoot, evidence, result, state, wait, delay, config }: any) {
  const original = ids.working.sessionId, healthyId = ids.healthy.sessionId, retiredId = ids.idle.sessionId
  const evaluate = (source: string) => win.webContents.executeJavaScript(source)
  const readOutput = async (run: any) => {
    const replay = await client().readRunReplay(run)
    return Buffer.concat(replay.replay.map((chunk: any) => Buffer.from(chunk.dataBytes))).toString('utf8')
  }
  const stableView = (value: any) => ({ tabs: value.tabs, layouts: value.layouts, drafts: value.drafts,
    focus: value.focus, activeWorkspaceId: value.activeWorkspaceId })
  if (phase === 'seed') {
    const session = (await state()).sessions.find((one: any) => one.id === original)
    assert.ok(session && !session.nativeHandle)
    await wait('native composer before controlled natural exit', async () => (await readOutput(session.control.run)).includes('codex-ready:'))
    await runtime.write(session.control, 'exit', 'user'); await delay(80); await runtime.write(session.control, '\r', 'user')
    await wait('authoritative original native exit', async () => (await client().listRuns()).find((one: any) => one.runId === session.control.run.runId)?.state === 'exited')
    await evaluate('window.capabilityRecheck()')
  }
  const missing = await wait('original exited projection', async () => {
    const value = await state(), session = value.sessions.find((one: any) => one.id === original)
    return session?.processState === 'exited' ? session : false
  })
  assert.equal(missing.control.run.runId, ids.working.run.runId)
  assert.equal(missing.nativeHandle, undefined)
  // One explicit restore asks the original Core owner; it must refuse before Provider invocation.
  const refusal = await evaluate('window.capabilityRequestOriginalRestore()')
  assert.equal(refusal?.kind, 'unavailable')
  assert.equal(refusal.reason, 'native-handle-unavailable')
  await wait('actual original recheck button', async () => (await state()).dom.includes('Re-read original'))
  const before = await state(), runsBefore = await client().listRuns(), callsBefore = result.calls.length
  await evaluate(`(()=>{const region=document.querySelector('[data-workbench-region-id="continuity-working"]');const button=[...region.querySelectorAll('button')].find(one=>one.textContent.trim()==='Re-read original');if(!button||button.disabled)throw new Error('Original recheck is unavailable');button.click()})()`)
  await wait('Store Main Core original refresh completion', async () => result.calls.slice(callsBefore).some((one: any) => one.operation === 'refresh' && one.finished))
  const after = await state(), calls = result.calls.slice(callsBefore)
  assert.ok(calls.some((one: any) => one.operation === 'refresh' && one.args[0].agentSessionId === original))
  assert.equal(calls.some((one: any) => ['recover', 'write', 'submit-prompt', 'stop'].includes(one.operation)), false)
  assert.deepEqual((await client().listRuns()).map((one: any) => ({ runId: one.runId, state: one.state })), runsBefore.map((one: any) => ({ runId: one.runId, state: one.state })))
  assert.deepEqual(stableView(after), stableView(before))
  assert.equal(after.sessions.find((one: any) => one.id === original)?.control.run.runId, missing.control.run.runId)
  assert.ok(after.dom.includes('Agent process exited') && after.dom.includes('Exit code 0.'))
  assert.ok(after.dom.includes('Recovery identity is unconfirmed'))
  result.capability = { originalRecheck: { sessionId: original, run: missing.control.run, noNativeIdentityInvented: true,
    sameOriginalWorkface: true, zeroLifecycleOrInput: true, calls }, rawInput: [] }
  const outputCallsBefore = result.calls.length
  await evaluate(`(()=>{const region=document.querySelector('[data-workbench-region-id="continuity-working"]');const button=[...region.querySelectorAll('button')].find(one=>one.textContent.trim()==='Read original output');if(!button||button.disabled)throw new Error('Retained original output is unavailable');button.click()})()`)
  const retainedTerminal = await wait('original output in the actual read-only Terminal', async () => {
    const terminal = await evaluate("window.continuityTerminalState('working')")
    return terminal?.observation?.runId === missing.control.run.runId && terminal.observation.readOnly === true &&
      terminal.observation.acceptsInput === false && terminal.text.includes('codex-ready:') ? terminal : false
  })
  assert.equal(result.calls.slice(outputCallsBefore).some((one: any) => ['recover', 'write', 'paste', 'send', 'submit-prompt', 'stop', 'resize'].includes(one.operation)), false)
  assert.deepEqual((await client().listRuns()).map((one: any) => ({ runId: one.runId, state: one.state })), runsBefore.map((one: any) => ({ runId: one.runId, state: one.state })))
  result.capability.originalOutput = { runId: retainedTerminal.observation.runId, readOnly: true, acceptsInput: false, retainedBytesRead: true, zeroLifecycleInputOrResize: true }
  await evaluate(`(()=>{const region=document.querySelector('[data-workbench-region-id="continuity-working"]');const button=[...region.querySelectorAll('button')].find(one=>one.textContent.trim()==='Back to recovery');if(!button)throw new Error('Original recovery surface cannot be reopened');button.click()})()`)
  await wait('return to the same recovery surface', async () => (await state()).dom.includes('Read original output'))
  const rawInput = async (label: string) => {
    const body = 'capability-' + phase + '-' + label
    await evaluate('window.capabilityFocusHealthy()')
    for (const character of body) win.webContents.sendInputEvent({ type: 'char', keyCode: character })
    await delay(100)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    const output = await wait('native raw input consumed ' + label, async () => {
      const value = await readOutput(ids.healthy.run)
      return value.includes('codex-submit:' + body + ':accepted') ? value : false
    })
    assert.equal(output.split('codex-submit:' + body + ':accepted').length - 1, 1)
    const healthy = (await client().listRuns()).find((one: any) => one.runId === ids.healthy.run.runId)
    assert.equal(healthy.state, 'running')
    result.capability.rawInput.push({ body, runId: healthy.runId, pid: healthy.pid, consumedOnce: true })
    await delay(120)
  }
  await rawInput('before-observation-failure')
  // The failure is injected only at the exact SDK metadata observation boundary.
  // Native input/attachments and all authoritative Runtime facts remain real.
  const coreClient = client(), refresh = coreClient.refreshAgentSession.bind(coreClient)
  coreClient.refreshAgentSession = async (id: string, ...args: any[]) => {
    if (id === healthyId) throw new Error('Controlled original metadata observation is unavailable')
    return await refresh(id, ...args)
  }
  try {
    const failed = await evaluate('window.capabilityRecheckHealthy().then(()=>null,error=>String(error))')
    assert.match(failed, /Controlled original metadata observation is unavailable/u)
    assert.equal((await state()).sessions.find((one: any) => one.id === healthyId)?.processState, 'running')
    await rawInput('after-observation-failure')
    result.capability.observationFailure = { boundary: 'original SDK metadata observation', failure: failed, healthyInputPreserved: true }
  } finally { coreClient.refreshAgentSession = refresh }
  if (phase === 'seed') await evaluate('window.capabilityRetireOriginal()')
  const retired = await wait('original retirement remains durable', async () => (await store.loadRetiredAgentSessions()).find((one: any) => one.agentSessionId === retiredId))
  const retiredBefore = retired
  const retirementRead = await runtime.refresh({ kind: 'agent', hostId: 'local', agentSessionId: retiredId, run: ids.idle.run }, config).then(() => 'unexpected success', (error: any) => error.code ?? error.message)
  assert.notEqual(retirementRead, 'unexpected success')
  assert.deepEqual((await store.loadRetiredAgentSessions()).find((one: any) => one.agentSessionId === retiredId), retired)
  assert.equal((await store.load()).some((one: any) => one.agentSessionId === retiredId), false)
  assert.deepEqual(retired.run, retiredBefore.run)
  result.capability.retirement = { sessionId: retiredId, retiredAt: retired.observedAt, readResult: retirementRead, noResurrection: true }
  await evaluate('window.continuityFlush()')
  result.finalSpatial = await spatial.readForLayout()
  const final = await state()
  assert.equal(final.drafts[original], 'Unsent working draft remains intact')
  assert.equal(final.drafts[healthyId], 'Unsent healthy draft remains intact')
  assert.equal((final.queues[original]?.some((one: any) => one.status === 'sending') ?? false), false)
  const expectedFile = path.join(privateRoot, 'capability-expected.json')
  if (phase === 'seed') await fs.writeFile(expectedFile, JSON.stringify({ ...stableView(final), spatial: result.finalSpatial }))
  else {
    const expected = JSON.parse(await fs.readFile(expectedFile, 'utf8'))
    assert.deepEqual(stableView(final), stableView(expected))
    assert.deepEqual(result.finalSpatial, expected.spatial)
  }
  result.initial = before
  result.capability.final = stableView(final)
  await fs.writeFile(path.join(evidence, phase + '-workface.png'), (await win.capturePage()).toPNG())
}
