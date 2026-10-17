import { app } from 'electron'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** A failed real child TUI is recovered only by the next production App startup. */
export async function verifyFrontendStartupRecovery({ store, spatial, win, client, ids, phase, privateRoot, evidence, result, state, wait, delay }: any) {
  const isolation = Object.fromEntries(['home', 'appData', 'userData', 'sessionData', 'cache'].map(key => [key, app.getPath(key as any)]))
  for (const directory of Object.values(isolation)) assert.ok(String(directory).startsWith(privateRoot + path.sep))
  assert.equal(process.env.HOME, path.join(privateRoot, 'home'))
  const id = ids.working.sessionId
  const evaluate = (source: string) => win.webContents.executeJavaScript(source)
  const session = async () => (await state()).sessions.find((one: any) => one.id === id)
  const events = async () => (await fs.readFile(path.join(privateRoot, 'managed-native.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(one => one.sid === id)
  const identity = async (targetId = id) => {
    const one = (await store.load()).find((one: any) => one.agentSessionId === targetId)
    const run = (await client().listRuns()).find((run: any) => run.runId === one.run.runId)
    return { sid: targetId, run: one.run, nativeHandle: one.nativeHandle, actorId: one.nativeActor?.actorId, pid: run?.pid, state: run?.state }
  }
  const stable = (value: any) => ({ tabs: value.tabs, layouts: value.layouts, focus: value.focus, drafts: value.drafts, activeWorkspaceId: value.activeWorkspaceId })
  const frames: any[] = []
  const capture = async (name: string) => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const bytes = (await win.capturePage()).toPNG(), file = name + '.png'
    await fs.writeFile(path.join(evidence, file), bytes)
    frames.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), dom: (await state()).dom })
  }
  const expectedPath = path.join(privateRoot, 'managed-expected.json')
  const previous = phase === 'seed' ? undefined : JSON.parse(await fs.readFile(expectedPath, 'utf8'))
  result.managed = { passed: false, kind: 'frontend-startup', isolation, frames }
  if (previous) {
    // The fresh Main reads the original durable Session before Renderer startup.
    // Frontend facts are reobserved through the surviving Provider control owner.
    const original = result.before.find((one: any) => one.agentSessionId === id)
    assert.deepEqual(original.run, previous.identity.run)
    assert.deepEqual(result.spatialBefore, previous.spatial)
    await wait('production startup dispatch targets the original failed managed frontend', async () => result.calls.some((one: any) =>
      one.operation === 'recover' && one.args[0]?.agentSessionId === id && one.args[3]?.trigger === 'startup'), 30000)
  }
  await wait('cold startup attaches the original managed frontend', async () => (await session())?.terminalFrontend?.state === 'attached', 30000)
  await wait('actual original TTY renders after startup', async () => {
    const one = await evaluate('window.continuityTerminalState("working")')
    return one?.observation?.visible && one.text.includes('codex-ready:') ? one : false
  }, 30000)
  if (previous) await wait('attached frontend no longer displays a generic restored-context check', async () =>
    evaluate(`![...document.querySelectorAll('[data-workbench-region-id="continuity-working"] .continuity-supervision')].some(one=>one.textContent.includes('Checking restored context'))`), 10000)
  const initial = await state(), before = await identity(), healthy = await identity(ids.healthy.sessionId)
  assert.equal(before.state, 'running'); assert.equal(healthy.state, 'running'); assert.ok(before.actorId)
  const nativeFile = path.join(privateRoot, 'codex/sessions/rollout-' + id + '.jsonl')
  const originalNative = previous?.originalNative ?? await fs.readFile(nativeFile, 'utf8')
  assert.ok(originalNative.includes('continuity-body-7f41') && originalNative.includes('Recorded decision:'))
  assert.ok((await fs.readFile(nativeFile, 'utf8')).startsWith(originalNative))
  result.managed.before = before; result.managed.healthy = healthy
  if (previous) {
    assert.deepEqual(before, previous.identity, 'Cold startup preserves Session / Run / backend PID / actor / native target')
    assert.deepEqual(healthy, previous.healthy, 'Unrelated healthy Session keeps its original process and Run')
    assert.deepEqual(stable(initial), previous.stable, 'Cold startup restores the original tabs, split Regions, focus and unsent drafts')
    assert.deepEqual(await spatial.readForLayout(), previous.spatial)
    const launches = (await events()).filter(one => one.kind === 'frontend-start')
    assert.equal(launches.length, previous.frontendStarts + 1, 'Exactly one frontend reconnect is consumed per new startup')
    assert.ok(launches.at(-1).args.includes('resume'))
    assert.ok(launches.at(-1).args.includes(before.nativeHandle.sessionId))
    assert.notEqual((await session()).terminalFrontend.frontendId, previous.failedFrontend.frontendId)
    if (previous.exhaustedIntent) {
      const stored = (await store.load()).find((one: any) => one.agentSessionId === id)
      const original = stored.continuityOperations[previous.exhaustedIntent.operationId]
      assert.deepEqual(original.supervision, previous.exhaustedIntent.supervision, 'A new startup cannot reset the exhausted original intent or its budget')
      assert.notEqual(stored.continuity.operationId, original.operationId)
    }
    result.managed.recoveredFrom = previous.failedFrontend
    result.managed.startupCalls = result.calls.filter((one: any) => one.operation === 'recover' && one.args[0]?.agentSessionId === id)
  }
  await capture(phase + '-frontend-startup-attached')
  if (phase === 'seed') {
    result.managed.unknownInput = await evaluate('window.managedSendUnknown()')
    result.managed.unknownInput.receipt = await wait('actual original Native input applied with response lost', async () => {
      const receipt = await evaluate('window.managedInspectUnknown(' + JSON.stringify(result.managed.unknownInput) + ')')
      return receipt?.status === 'unknown' && receipt.admission?.admission?.native?.outcome === 'unknown' ? receipt : false
    }, 30000)
  } else {
    result.managed.unknownInput = previous.unknownInput
    assert.deepEqual(await evaluate('window.managedInspectUnknown(' + JSON.stringify(previous.unknownInput) + ')'), previous.unknownInput.receipt,
      'The original unknown input receipt remains unchanged after automatic recovery')
  }
  const beforeFailureEvents = await events()
  assert.equal(beforeFailureEvents.filter(one => one.kind === 'backend-start').length, 1, 'Startup never starts a replacement backend')
  assert.equal(beforeFailureEvents.filter(one => one.kind === 'applied-input-response-lost').length, 1, 'Unknown input is consumed exactly once across real restarts')
  assert.ok(beforeFailureEvents.filter(one => one.kind === 'frontend-start').slice(1).every(one => !one.args.includes('Managed unknown delivery sentinel')))
  assert.equal(result.calls.some((one: any) => ['restart', 'stop', 'send', 'write', 'paste'].includes(one.operation)), false, 'Startup recovery cannot stop the backend or replay old terminal input')
  if (phase !== 'seed') assert.equal(result.calls.some((one: any) => one.operation === 'submit-prompt'), false, 'Startup cannot repeat the original prompt')
  if (phase !== 'reconnect') {
    const frontend = JSON.parse(await fs.readFile(path.join(privateRoot, 'frontend-' + id + '.json'), 'utf8'))
    assert.ok(frontend.pid > 1)
    const exitCode = phase === 'seed' ? 23 : 31
    const diagnostic = phase === 'seed'
      ? 'Private startup routing request timed out while loading the retained workspace.\n'
      : 'Private startup listener connection refused; transport endpoint unavailable.'
    await fs.writeFile(path.join(privateRoot, 'frontend-failure-' + id + '.json'), JSON.stringify({ pid: frontend.pid, exitCode, diagnostic }))
    const detached = await wait('real nonzero frontend exit reaches Core and mounted App', async () => {
      const one = await session()
      return one?.terminalFrontend?.state === 'detached' && one.terminalFrontend.exitCode === exitCode && one.processState === 'running' ? one : false
    }, 30000)
    result.managed.failedFrontend = detached.terminalFrontend
    assert.equal(detached.terminalFrontend.backendState, 'running')
    assert.deepEqual(await identity(), before, 'A real failed frontend preserves its original backend and identity')
    await capture(phase + '-frontend-startup-detached')
    if (phase === 'restore') {
      result.managed.exhaustedIntent = await wait('the original startup attempt pauses at its own retry budget', async () => {
        const one = (await store.load()).find((one: any) => one.agentSessionId === id)
        return one.continuity?.supervision?.phase === 'paused' && one.continuity.supervision.reason === 'frontend-retry-budget-exhausted' ? one.continuity : false
      }, 30000)
      assert.equal(result.managed.exhaustedIntent.supervision.attemptCount, 1)
      assert.equal(result.managed.exhaustedIntent.supervision.attemptLimit, 1)
    }
    await delay(160)
    assert.equal((await events()).filter(one => one.kind === 'frontend-start').length, beforeFailureEvents.filter(one => one.kind === 'frontend-start').length,
      'A live failure cannot invent a new startup or silently replace the manual recovery policy')
  }
  await evaluate('window.continuityFlush()')
  assert.deepEqual(stable(await state()), stable(initial))
  assert.deepEqual(await identity(ids.healthy.sessionId), healthy)
  assert.ok((await fs.readFile(nativeFile, 'utf8')).startsWith(originalNative))
  result.managed.after = await identity()
  result.managed.nativeEvents = await events()
  result.managed.originalNativeSha256 = createHash('sha256').update(originalNative).digest('hex')
  await fs.writeFile(expectedPath, JSON.stringify({ stable: stable(await state()), identity: before, healthy,
    spatial: await spatial.readForLayout(), frontendStarts: result.managed.nativeEvents.filter(one => one.kind === 'frontend-start').length,
    failedFrontend: result.managed.failedFrontend, exhaustedIntent: result.managed.exhaustedIntent, unknownInput: result.managed.unknownInput, originalNative }))
  result.managed.passed = true
}
