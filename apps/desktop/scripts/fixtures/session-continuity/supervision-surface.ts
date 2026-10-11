import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Actual controls on the original private Native workface; process durability is a separate scenario. */
export async function verifySupervisionSurface({ runtime, store, spatial, win, client, ids, phase, evidence, result, state, wait, delay }: any) {
  assert.equal(phase, 'seed')
  const original = ids.working.sessionId, evaluate = (source: string) => win.webContents.executeJavaScript(source)
  const originalRoot = async () => {
    const session = (await store.load()).find((one: any) => one.agentSessionId === original)
    const pointer = session?.continuity, id = pointer?.intentOperationId ?? pointer?.operationId
    return session?.continuityOperations?.[id]
  }
  const root = await wait('actual startup recovery pauses after a confirmed native exit', async () => {
    const value = await originalRoot()
    return value?.supervision?.phase === 'paused' ? value : null
  }, 30000)
  assert.equal(root.supervision.attemptCount, 1); assert.equal(root.supervision.attemptLimit, 1)
  assert.equal(root.supervision.process.state, 'exited'); assert.equal(root.supervision.process.exitCode, 7)
  assert.ok(result.calls.some((call: any) => call.operation === 'recover' && call.args[0].agentSessionId === original && call.args[3]?.trigger === 'startup'))
  await wait('Renderer consumes the exact paused original intent', async () => {
    const projected = (await state()).sessions.find((one: any) => one.id === original)
    return projected?.continuityOperations?.[root.operationId]?.supervision?.phase === 'paused'
  })
  const initial = await state(), graph = await spatial.readForLayout()
  assert.ok(graph?.graph?.tabs?.length || Object.keys(initial.tabs).length === 2)
  const stable = (value: any) => ({ tabs: value.tabs, layouts: value.layouts, drafts: value.drafts })
  const click = async (label: string) => await evaluate(`(()=>{const region=document.querySelector('[data-workbench-region-id="continuity-working"]');const button=[...region.querySelectorAll('.continuity-supervision button')].find(one=>one.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw Error('Original control unavailable: '+${JSON.stringify(label)});button.click()})()`)
  const open = async () => {
    await evaluate(`(()=>{const button=document.querySelector('[data-workbench-region-id="continuity-working"] .continuity-supervision .service-disclosure__trigger');if(!button)throw Error('Original supervision disclosure unavailable');if(button.getAttribute('aria-expanded')!=='true')button.click()})()`)
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  }
  const frames: any[] = []
  const capture = async (name: string, width: number) => {
    win.setSize(width, 880); await delay(100); await open()
    const healthyTerminal = await wait('original healthy Terminal has a readable native frame', async () => {
      const value = await evaluate('window.continuityTerminalState("healthy")')
      return value?.observation?.liveReady && value.observation.visible && value.text.includes('codex-ready:') ? value : false
    })
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const snapshot = await state(), file = name + '.png', bytes = (await win.capturePage()).toPNG()
    await fs.writeFile(path.join(evidence, file), bytes)
    frames.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), width,
      originalRun: snapshot.sessions.find((one: any) => one.id === original)?.control.run,
      healthyTerminal, draft: snapshot.drafts[original], dom: snapshot.dom })
    assert.deepEqual(stable(snapshot), stable(initial), 'Controls cannot replace the original workface or unsent drafts')
  }
  await capture('supervision-paused-wide', 1320)
  await capture('supervision-paused-narrow', 920)
  win.setSize(1320, 880); await delay(80); await open()
  await evaluate(`(()=>{const input=document.querySelector('[data-workbench-region-id="continuity-working"] input[aria-label="Additional recovery attempts"]');if(!input)throw Error('Original attempt budget unavailable');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'1');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  // Suppress only the first Main reply after the actual metadata owner commits.
  // The original request stays pending; no Core receipt or lifecycle fact is fabricated.
  const control = runtime.controlContinuity.bind(runtime)
  let held: any
  runtime.controlContinuity = async (hostId: string, packet: any) => {
    const value = await control(hostId, packet)
    if (!held && packet.agentSessionId === original && packet.action === 'continue') {
      held = { packet: structuredClone(packet), receipt: structuredClone(value.result.receipt) }
      return await new Promise(() => {})
    }
    return value
  }
  try {
    await click('Continue recovery')
    await wait('the exact continuation is committed but its reader remains unconfirmed', async () => held)
    const continued = await originalRoot(), pendingState = await state()
    assert.equal(continued.supervision.phase, 'retry-wait')
    assert.equal(continued.supervision.attemptLimit, 2)
    assert.ok(continued.supervision.nextAttemptAt > Date.now())
    const bucket = JSON.stringify(['local', original])
    assert.deepEqual(pendingState.continuityControlIntents[bucket][held.packet.operationId].request, held.packet)
    await capture('supervision-unconfirmed-wide', 1320)
    await capture('supervision-unconfirmed-narrow', 920)
    await open(); await click('Cancel automatic recovery')
    const cancelled = await wait('independent original cancellation reaches the actual Core owner', async () => {
      const value = await originalRoot()
      return value?.supervision?.phase === 'cancelled' ? value : false
    })
    assert.deepEqual((await state()).continuityControlIntents[bucket][held.packet.operationId].request, held.packet)
    const controls = Object.values(cancelled.supervision.controlOperations) as any[]
    const cancellation = controls.find(one => one.request.action === 'cancel')
    assert.ok(cancellation); assert.notEqual(cancellation.request.operationId, held.packet.operationId)
    assert.equal(cancellation.outcome, 'cancelled')
    await wait('Renderer consumes cancellation', async () => (await state()).sessions.find((one: any) => one.id === original)?.continuityOperations?.[root.operationId]?.supervision?.phase === 'cancelled')
    await open(); await click('Check original continue control')
    await wait('same original continuation receipt settles independently', async () => !(await state()).continuityControlIntents[bucket]?.[held.packet.operationId])
    const samePacketReads = result.calls.filter((call: any) => call.operation === 'control-continuity' && call.args[1].operationId === held.packet.operationId)
    assert.equal(samePacketReads.length, 2)
    assert.ok(samePacketReads.every((call: any) => JSON.stringify(call.args[1]) === JSON.stringify(held.packet)))
    assert.deepEqual(samePacketReads[1].result.result.receipt, held.receipt)
    await wait('historical receipt feedback has settled before reopening its disclosure', async () => evaluate("document.querySelector('[data-workbench-region-id=continuity-working] .continuity-supervision')?.textContent.includes('Earlier continue request receipt confirmed; current recovery status is shown above.')"))
    await capture('supervision-cancelled-wide', 1320)
    const runs = await client().listRuns(), healthy = runs.find((one: any) => one.runId === ids.healthy.run.runId)
    assert.equal(healthy.state, 'running')
    await evaluate('document.querySelector("[data-workbench-region-id=continuity-working] .service-disclosure__details:popover-open")?.hidePopover()')
    await evaluate('window.capabilityFocusHealthy()')
    const body = 'supervision-surface-healthy-input'
    for (const character of body) win.webContents.sendInputEvent({ type: 'char', keyCode: character })
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    const output = await wait('healthy raw input is consumed through the actual Terminal', async () => {
      const replay = await client().readRunReplay(ids.healthy.run)
      const value = Buffer.concat(replay.replay.map((chunk: any) => Buffer.from(chunk.dataBytes))).toString('utf8')
      return value.includes('codex-submit:' + body + ':accepted') ? value : null
    })
    assert.equal(output.split('codex-submit:' + body + ':accepted').length - 1, 1)
    assert.deepEqual(stable(await state()), stable(initial))
    result.supervision = { kind: 'surface', healthy: { runId: healthy.runId, pid: healthy.pid }, original: { sessionId: original, rootOperationId: root.operationId, nativeTarget: root.nativeTarget },
      frames, controls: { continued: held.receipt, cancelled: cancellation, originalPacketRetained: true, samePacketReadback: true },
      healthyInput: { runId: healthy.runId, pid: healthy.pid, body, consumedOnce: true }, spatial: await spatial.readForLayout() }
    await evaluate('window.continuityFlush()')
  } finally { runtime.controlContinuity = control }
}
