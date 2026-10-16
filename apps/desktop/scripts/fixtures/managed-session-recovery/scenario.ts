import { app } from 'electron'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Real private Native actor / RuntimeController / mounted App, across three Electron generations. */
export async function verifyManagedSessionRecovery({ runtime, store, spatial, win, client, ids, phase, privateRoot, evidence, result, state, wait, delay }: any) {
  const isolation = Object.fromEntries(['home', 'appData', 'userData', 'sessionData', 'cache'].map(key => [key, app.getPath(key as any)]))
  for (const directory of Object.values(isolation)) assert.ok(String(directory).startsWith(privateRoot + path.sep), 'Every Electron data path belongs to the private fixture')
  assert.equal(process.env.HOME, path.join(privateRoot, 'home'))
  const id = ids.working.sessionId, evaluate = (source: string) => win.webContents.executeJavaScript(source)
  const session = async () => (await state()).sessions.find((one: any) => one.id === id)
  const events = async () => (await fs.readFile(path.join(privateRoot, 'managed-native.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(one => one.sid === id)
  const identity = async (targetId = id) => { const one = (await store.load()).find((one: any) => one.agentSessionId === targetId), run = (await client().listRuns()).find((run: any) => run.runId === one.run.runId); return { sid: targetId, run: one.run, nativeHandle: one.nativeHandle, actorId: one.nativeActor?.actorId, pid: run?.pid, state: run?.state, ...(one.retiredAt === undefined ? {} : { retiredAt: one.retiredAt }) } }
  const stable = (value: any) => ({ tabs: value.tabs, layouts: value.layouts, focus: value.focus, drafts: value.drafts, activeWorkspaceId: value.activeWorkspaceId })
  const frames: any[] = []
  const capture = async (name: string, width = 1320) => {
    win.setSize(width, 880); await delay(120)
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const bytes = (await win.capturePage()).toPNG(), file = name + '.png'
    await fs.writeFile(path.join(evidence, file), bytes)
    frames.push({ file, width, sha256: createHash('sha256').update(bytes).digest('hex'), dom: (await state()).dom })
  }
  const nativeFile = path.join(privateRoot, 'codex/sessions/rollout-' + id + '.jsonl')
  const openRestart = async () => {
    const focus = await evaluate(`(()=>{const region=document.querySelector('[data-workbench-region-id="continuity-working"]');if(!region)throw Error('Original Region missing');region.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}));return region.dataset.workbenchRegionId})()`)
    await wait('actual Restart Session menu item', async () => evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')].find(one=>one.textContent.includes('Restart Session')))`))
    await evaluate(`(()=>{[...document.querySelectorAll('[role="menuitem"]')].find(one=>one.textContent.includes('Restart Session')).click()})()`)
    await wait('actual restart confirmation', async () => evaluate(`Boolean(document.querySelector('.confirmation-dialog [data-confirm-label="Restart Session"]'))`))
    return focus
  }
  const expectedPath = path.join(privateRoot, 'managed-expected.json')
  const previous = phase === 'seed' ? undefined : JSON.parse(await fs.readFile(expectedPath, 'utf8'))
  await wait('original managed frontend attached', async () => (await session())?.terminalFrontend?.state === 'attached', 30000)
  await wait('original private TTY rendered', async () => {
    const one = await evaluate('window.continuityTerminalState("working")')
    return one?.observation?.visible && one.text.includes('codex-ready:') ? one : false
  }, 30000)
  const initial = await state(), before = await identity(), healthy = await identity(ids.healthy.sessionId)
  assert.equal(before.state, 'running'); assert.equal(healthy.state, 'running')
  const originalNative = previous?.originalNative ?? await fs.readFile(nativeFile, 'utf8')
  assert.ok(originalNative.includes('continuity-body-7f41') && originalNative.includes('Recorded decision:'), 'Retained native conversation must be nonempty')
  assert.ok((await fs.readFile(nativeFile, 'utf8')).startsWith(originalNative), 'Original native context bytes survive Electron restart')
  assert.ok(before.actorId, 'Actual managed launch actor must be authoritative')
  if (previous) {
    assert.deepEqual(stable(initial), previous.stable, 'Same original workface, focus and drafts survive Electron restart')
    assert.deepEqual(healthy, previous.healthy, 'Unrelated healthy Session keeps the exact original Run, process and native actor')
    assert.deepEqual(before, previous.identity, 'Same Session / Run / native actor survive an Electron restart')
    assert.equal((await events()).filter(one => one.kind === 'frontend-start').length, previous.frontendStarts, 'Hydration must not spawn a replacement frontend')
    assert.deepEqual(await spatial.readForLayout(), previous.spatial, 'Durable original spatial graph survives before and after hydration')
  }
  result.managed = { passed: false, before, healthy, isolation, frames, initial: stable(initial) }
  await capture(phase + '-managed-workface')
  if (phase === 'seed') {
    const frontend = JSON.parse(await fs.readFile(path.join(privateRoot, 'frontend-' + id + '.json'), 'utf8'))
    // This is a private fixture's exact own TUI PID. The backend actor is deliberately left alive.
    assert.ok(frontend.pid > 1); process.kill(frontend.pid, 'SIGTERM')
    const detached = await wait('Core and actual mounted Session expose detached frontend', async () => {
      const one = await session(); return one?.terminalFrontend?.state === 'detached' && one.processState === 'running' ? one : false
    }, 30000)
    result.managed.detached = detached.terminalFrontend
    assert.equal(detached.terminalFrontend.backendState, 'running')
    assert.deepEqual(await identity(), before, 'Frontend exit preserves same Run, PID and actor')
    await wait('actual Resume control', async () => evaluate(`Boolean([...document.querySelectorAll('[data-workbench-region-id="continuity-working"] button')].find(one=>one.textContent.trim()==='Resume'&&!one.disabled))`))
    await capture('managed-disconnected-wide'); await capture('managed-disconnected-narrow', 920)
    win.setSize(1320, 880); await delay(80)
    result.managed.detachedRestartOrigin = await openRestart()
    assert.equal(result.calls.some((one: any) => one.operation === 'restart'), false, 'Opening confirmation cannot interrupt the backend')
    await capture('managed-disconnected-restart-confirmation-wide'); await capture('managed-disconnected-restart-confirmation-narrow', 920)
    await evaluate('document.querySelector(".confirmation-dialog__cancel").click()')
    await wait('cancel closes only the confirmation', async () => !await evaluate('Boolean(document.querySelector(".confirmation-dialog"))'))
    assert.deepEqual(await identity(), before, 'Cancel retains the original backend Run')
    win.setSize(1320, 880); await delay(80)
    const callsBefore = result.calls.length
    await evaluate(`(()=>{const button=[...document.querySelectorAll('[data-workbench-region-id="continuity-working"] button')].find(one=>one.textContent.trim()==='Resume');if(!button)throw Error('Original Resume missing');button.click()})()`)
    await wait('Resume reconnects original managed frontend', async () => (await session())?.terminalFrontend?.state === 'attached', 30000)
    await wait('original Resume operation actually completes', async () => result.calls.slice(callsBefore).some((one: any) => one.operation === 'recover' && one.finished && one.result?.session?.id === id), 30000)
    assert.deepEqual(await identity(), before, 'Resume must keep exact SID / Run / actor / PID / native handle')
    const starts = (await events()).filter(one => one.kind === 'frontend-start')
    assert.equal(starts.length, 2)
    assert.ok(starts[1].args.includes('resume')); assert.ok(starts[1].args.includes(before.nativeHandle.sessionId))
    assert.equal(starts[1].args.includes('Managed unknown delivery sentinel'), false)
    assert.equal(result.calls.slice(callsBefore).some((one: any) => ['submit-prompt', 'send', 'write', 'paste', 'stop'].includes(one.operation)), false, 'Resume must not submit old input or stop backend')
    assert.deepEqual(stable(await state()), stable(initial), 'Resume preserves workface and independent unsent drafts')
    result.managed.reconnected = await identity(); await capture('managed-resumed-wide')
  }
  if (phase === 'restore') {
    // Open the actual Focus context menu and select the production restart action.
    result.managed.restartOrigin = await openRestart()
    assert.equal(result.calls.some((one: any) => one.operation === 'restart'), false, 'Opening confirmation cannot interrupt work')
    await capture('managed-restart-confirmation-wide'); await capture('managed-restart-confirmation-narrow', 920)
    win.setSize(1320, 880); await delay(80)
    await evaluate(`document.querySelector('.confirmation-dialog [data-confirm-label="Restart Session"]').click()`)
    const restarted = await wait('actual Restart Session completes with a new Run', async () => {
      const one = await session(); return one?.processState === 'running' && one.control.run.runId !== before.run.runId && one.terminalFrontend?.state === 'attached' ? await identity() : false
    }, 45000)
    assert.equal(restarted.sid, before.sid); assert.deepEqual(restarted.nativeHandle, before.nativeHandle)
    assert.notEqual(restarted.run.runId, before.run.runId); assert.notEqual(restarted.actorId, before.actorId); assert.equal(restarted.retiredAt, undefined)
    const old = (await client().listRuns()).find((one: any) => one.runId === before.run.runId)
    assert.notEqual(old?.state, 'running', 'Original private Run must actually stop')
    assert.deepEqual(stable(await state()), stable(initial), 'Restart preserves original workface, focus and drafts')
    await wait('original Restart receipt and confirmation settle', async () => result.calls.some((one: any) => one.operation === 'restart' && one.finished && one.result?.phase === 'restarted') && !await evaluate('Boolean(document.querySelector(".confirmation-dialog"))'), 20000)
    const restartCalls = result.calls.filter((one: any) => one.operation === 'restart')
    assert.equal(restartCalls.length, 1); assert.equal(restartCalls[0].result.phase, 'restarted')
    assert.equal(restartCalls[0].args[0].agentSessionId, id)
    result.managed.restarted = restarted; result.managed.restartReceipt = restartCalls[0].result
    await capture('managed-restarted-wide')
  }
  if (phase === 'seed') {
    result.managed.unknownInput = await evaluate('window.managedSendUnknown()')
    result.managed.unknownInput.receipt = await wait('real dispatched Native input loses only its original admission response', async () => { const receipt = await evaluate('window.managedInspectUnknown(' + JSON.stringify(result.managed.unknownInput) + ')'); result.managed.lastInputInspection = receipt; return receipt?.status === 'unknown' && receipt.admission?.admission?.native?.outcome === 'unknown' ? receipt : false }, 30000)
    assert.equal((await events()).filter(one => one.kind === 'applied-input-response-lost').length, 1)
  } else {
    result.managed.unknownInput = previous.unknownInput
    const receipt = await evaluate('window.managedInspectUnknown(' + JSON.stringify(previous.unknownInput) + ')')
    assert.deepEqual(receipt, previous.unknownInput.receipt, 'Exact original unknown receipt survives Electron restart')
  }
  const readOriginal = () => evaluate('window.managedInspectUnknown(' + JSON.stringify(result.managed.unknownInput) + ')')
  // Open the actual production mailbox: it reads the durable Core journal, never a seeded queue.
  await evaluate(`(()=>{const mailbox=document.querySelector('[data-workbench-region-id="continuity-working"] .composer-mailbox');if(!mailbox)throw Error('Original mailbox missing');mailbox.showPopover()})()`)
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await evaluate(`document.querySelector('[data-workbench-region-id="continuity-working"] .composer-mailbox [role="tab"][id$="-user-tab"]').click()`)
  await wait('actual mailbox consumes original dispatched unknown input', async () => evaluate(`document.querySelector('[data-workbench-region-id="continuity-working"] .composer-mailbox')?.textContent.includes('Managed unknown delivery sentinel')`), 20000)
  result.managed.mailbox = await evaluate(`document.querySelector('[data-workbench-region-id="continuity-working"] .composer-mailbox')?.textContent`)
  await evaluate(`document.querySelector('[data-workbench-region-id="continuity-working"] .composer-mailbox').hidePopover()`)

  // Native witnesses are generated inside the launched CLI. No prompt is carried on reconnect/restart.
  const launches = (await events()).filter(one => one.kind === 'frontend-start')
  assert.equal((await events()).filter(one => one.kind === 'applied-input-response-lost').length, 1, 'Unknown original input is never replayed by Resume, Restart or hydration')
  assert.deepEqual(await readOriginal(), result.managed.unknownInput.receipt, 'Lifecycle actions cannot rewrite original unknown input facts')
  assert.ok(launches.slice(1).every(one => !one.args.includes('Managed unknown delivery sentinel')))
  await evaluate('window.continuityFlush()')
  assert.deepEqual(await identity(ids.healthy.sessionId), healthy, 'Resume and Restart cannot change an unrelated healthy Run')
  result.managed.after = await identity(); result.managed.final = stable(await state())
  await fs.writeFile(expectedPath, JSON.stringify({ stable: result.managed.final, identity: result.managed.after, healthy,
    spatial: await spatial.readForLayout(), frontendStarts: launches.length, unknownInput: result.managed.unknownInput, originalNative }))
  assert.ok((await fs.readFile(nativeFile, 'utf8')).startsWith(originalNative), 'Reconnect and Restart preserve the original native conversation bytes')
  result.managed.originalNativeSha256 = createHash('sha256').update(originalNative).digest('hex')
  result.managed.nativeEvents = await events(); result.managed.passed = true
}
