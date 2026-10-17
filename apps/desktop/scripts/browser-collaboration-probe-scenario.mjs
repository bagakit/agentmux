import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const q = JSON.stringify, sha = value => createHash('sha256').update(value).digest('hex')
const saved = probe => probe.cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state`)
const session = (probe, id) => probe.cdp.evaluate(`window.agentmux.sessions.snapshot().then(s=>s.sessions.find(v=>v.kind==='agent'&&v.control.agentSessionId===${q(id)}))`)
const electron = ctx => `process.getBuiltinModule('module').createRequire(${q(join(ctx.desktopRoot, 'package.json'))})('electron')`
const nativeOwner = (ctx, probe, url) => probe.main.evaluate(`(async()=>{const{BrowserWindow}=${electron(ctx)};const wins=BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()&&w.webContents.getURL().startsWith('file:'));const views=wins.flatMap(w=>w.contentView.children).filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL()===${q(url)});if(views.length!==1)return null;const v=views[0],c=v.webContents;return{contentsId:c.id,visible:v.getVisible(),bounds:v.getBounds(),storagePath:c.session.getStoragePath(),persistent:c.session.isPersistent(),document:await c.executeJavaScript('({width:innerWidth,height:innerHeight,scrollX,scrollY,screen:{width:screen.width,height:screen.height},visualViewport:visualViewport&&{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop},feedback:{operation:document.querySelectorAll("[data-agentmux-browser-operation-feedback]").length,click:document.querySelectorAll("[data-agentmux-browser-click-feedback]").length,control:document.querySelectorAll("[data-agentmux-browser-control-feedback]").length}})')}})()`)

export async function reviewCollaboration(ctx) {
  const { receipt, waitFor, click, selectors, rpc } = ctx
  receipt.collaboration = { boundary: 'Ordinary complete Desktop Main/preload/Renderer, two App processes and one private durable Runtime. Product-created spatial, Browser, Profile, draft, image, queue and Core records only; no Store setter, recovery seed or fixture flush. CDP UI input is not physical OS input. Normal quit is not crash or power-loss proof.', cases: [] }
  const result = receipt.collaboration
  let probe = ctx.probe, observer
  const previous = new Map(['HOME', 'AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'CODEX_HOME'].map(key => [key, process.env[key]]))
  try {
    ctx.setPhase('collaboration-product-create')
    const originalSpace = await probe.cdp.evaluate('window.agentmux.spatial.read()')
    const zone = originalSpace.graph.zones.find(value => value.workspaceId === ctx.workspaceId)
    assert.ok(zone, 'The product has registered the original execution Workspace')
    const agentPlace = await rpc.call('agent.open', { content: { kind: 'new-agent', executorId: 'collaboration', executionWorkspaceId: ctx.workspaceId },
      destination: { zoneId: zone.zoneId, newTab: true }, focus: true })
    result.creation = agentPlace
    assert.equal(agentPlace.outcome, 'opened', 'The original public Agent creation must close its product consumer chain')
    assert.ok(agentPlace.agent)
    const sid = agentPlace.agent.agentSessionId
    const created = { created: await probe.cdp.evaluate(`window.agentmux.sessions.creation('local',${q(sid)})`) }
    const original = await waitFor('actual original Agent and native identity', async () => {
      const value = await session(probe, sid)
      return value?.control?.run?.runId && value.nativeHandle ? value : created.created.nativeHandle && value
    })
    Object.assign(process.env, { HOME: ctx.privateHome, AGENTMUX_RUNTIME_DIRECTORY: ctx.runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(ctx.runtimeDirectory, 'state'), CODEX_HOME: join(ctx.privateHome, 'codex') })
    const { connectHostedAgentMux, connectAgentMuxRpc } = await import(pathToFileURL(join(ctx.coreRoot, 'dist/index.js')))
    // Borrow the actual existing semantic Host. Constructing a second local Core would take
    // ownership from its Hook actor and would invalidate the recovery observation itself.
    observer = await connectHostedAgentMux({ rpc: await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(ctx.runtimeDirectory, 'control.sock') } }) })
    const exact = async () => {
      const run = (await observer.listRuns()).find(value => value.runId === created.created.run.runId)
      assert.ok(run, 'The original private Run remains discoverable'); assert.equal(run.state, 'running')
      return run
    }
    const originalRun = await exact()
    const opened = await rpc.call('browser.open', { url: ctx.urls[0], destination: { kind: 'split', direction: 'right',
      region: { kind: 'region', regionId: agentPlace.to.regionId } } })
    assert.equal(opened.region.tabId, agentPlace.to.tabId, 'The Browser opens beside its original Agent in the same Tab')
    const initial = { tab: { id: opened.region.tabId }, surface: opened.region }
    const bid = initial.surface.browserId
    await ctx.nativeFrameReady(ctx.urls[0])
    const profile = await probe.cdp.evaluate('window.agentmux.browser.createProfile("Original collaboration profile")')
    await probe.cdp.evaluate(`window.agentmux.browser.switchProfile(${q(bid)},${q(profile.id)})`)
    await ctx.nativeFrameReady(ctx.urls[0])
    await probe.cdp.evaluate(`window.agentmux.browser.setViewport(${q(bid)},'tablet')`)
    const sibling = (await rpc.call('browser.open', { url: ctx.urls[1], destination: { kind: 'split', direction: 'down', region: { kind: 'region', regionId: initial.surface.regionId } } })).region
    await rpc.call('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId: initial.surface.regionId } })
    const op = randomUUID(), operator = { id: sid, name: original.label }
    const observed = await probe.cdp.evaluate(`window.agentmux.browser.runScript(${q(bid)},'return await snapshot({scope:"page",maxNodes:30});',${q(operator)},${q(op)})`)
    assert.equal(observed.report.outcome.kind, 'completed')
    const pane = `[data-workbench-region-id="${initial.surface.regionId}"]`
    await click(probe.cdp, selectors(pane + ' [aria-label="Message Browser operator"]'))
    await waitFor('real captured scene in the original discussion', () => probe.cdp.evaluate('Boolean(document.querySelector(".browser-contextual-composer__source"))'))
    const text = 'Original queued Browser opinion\n  Preserve these authored bytes and the processed image.'
    const draftText = 'Unsent original draft survives the ordinary App restart.'
    await click(probe.cdp, selectors('textarea[aria-label="Opinion for Browser operator"]'))
    await probe.cdp.call('Input.insertText', { text })
    await click(probe.cdp, selectors('.browser-opinion-selection__actions > button:first-child'))
    const editor = '[aria-label="Captured Browser image"]'
    await waitFor('actual captured-frame editor', () => probe.cdp.evaluate(`Boolean(document.querySelector(${q(editor + ' canvas[aria-label="Screenshot canvas"]')}))`))
    await click(probe.cdp, selectors(editor + ' button[aria-label="Fit image"]'))
    const box = await probe.cdp.evaluate(`(()=>{const e=document.querySelector(${q(editor + ' canvas[aria-label="Screenshot canvas"]')}),r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
    await click(probe.cdp, selectors(editor + ' button[aria-label="Crop"]'))
    const from = { x: box.x + box.width * .25, y: box.y + box.height * .25 }, to = { x: box.x + box.width * .7, y: box.y + box.height * .7 }
    await probe.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...from })
    await probe.cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...to })
    await probe.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...to })
    await click(probe.cdp, selectors(editor + ' button').concat('.filter(e=>e.textContent==="Attach processed image")'))
    const attached = await waitFor('product-persisted original processed image', async () => (await saved(probe)).browserOpinionDrafts?.[bid]?.original?.selection)
    const image = attached.scene.inputContext.selection.attachment, bytes = await readFile(image.path)
    assert.equal(sha(bytes), image.sha256)
    await click(probe.cdp, selectors('.browser-contextual-composer footer .primary-button'))
    const queued = await waitFor('same frozen opinion owned by the actual queue', async () => (await saved(probe)).agentSteerQueues?.[sid]?.find(entry => entry.text === text && entry.browserInput))
    assert.equal(queued.browserInput.capture.record.inputContext.selection.attachment.sha256, image.sha256)
    assert.equal(queued.browserRecipient.agentSessionId, sid)
    await click(probe.cdp, selectors('textarea[aria-label="Opinion for Browser operator"]'))
    await probe.cdp.call('Input.insertText', { text: draftText })
    const firstSaved = await waitFor('natural final draft and queue persistence', async () => {
      const state = await saved(probe)
      return state.browserOpinionDrafts?.[bid]?.text === draftText && state.agentSteerQueues?.[sid]?.some(entry => entry.operationId === queued.operationId) ? state : null
    })
    const graph = await probe.cdp.evaluate('window.agentmux.spatial.read()')
    assert.ok(graph.graph.tabs.length && graph.graph.regions.length >= 3)
    assert.ok(graph.graph.tabLayouts[initial.tab.id]?.activeRegionId)
    assert.ok(Object.keys(graph.graph.layouts).length)
    const firstNative = await nativeOwner(ctx, probe, ctx.urls[0])
    assert.ok(firstNative?.persistent && firstNative.visible)
    assert.deepEqual(firstNative.document.screen, { width: 768, height: 1024 }, 'The original native emulation has the configured tablet screen')
    const beforeRun = await exact()
    // A genuine operation remains in progress when the ordinary quit releases its native owners.
    const interrupted = randomUUID()
    await probe.cdp.call('Runtime.evaluate', { expression: `globalThis.__collaborationProgram=window.agentmux.browser.runScript(${q(bid)},'await waitForElement("Restart continuation marker",20000);',${q(operator)},${q(interrupted)}).catch(()=>null);null`, returnByValue: true })
    await waitFor('original active Browser operation', () => probe.cdp.evaluate(`window.agentmux.browser.getOperation(${q(interrupted)}).then(o=>['running','waiting'].includes(o?.phase))`))
    result.original = { sid, runId: originalRun.runId, pid: originalRun.pid, nativeHandle: original.nativeHandle, bid, profile, sibling, agentPlace, graph, firstNative, draft: firstSaved.browserOpinionDrafts[bid], queue: queued, image, imageBytes: bytes.length, imageSha256: sha(bytes), interrupted }
    result.firstQuit = await ctx.normalQuit(probe)
    const retained = await exact(); assert.equal(retained.pid, originalRun.pid)
    result.betweenProcesses = { runId: retained.runId, pid: retained.pid, state: retained.state, acceptedInputBytes: retained.acceptedInputBytes }
    probe = await ctx.launch('second'); ctx.retainSecond(probe)
    ctx.setPhase('collaboration-second-process-original-owners')
    const recovered = await waitFor('second process reads exact original draft, queue and Session', async () => {
      const state = await saved(probe), current = await session(probe, sid)
      return current?.control?.run?.runId === retained.runId ? { state, current } : null
    })
    const graphAfter = await probe.cdp.evaluate('window.agentmux.spatial.read()')
    for (const field of ['tabs', 'regions', 'tabLayouts', 'layouts']) assert.deepEqual(graphAfter.graph[field], graph.graph[field], 'Ordinary restart retains original ' + field)
    assert.deepEqual(recovered.state.browserOpinionDrafts[bid], firstSaved.browserOpinionDrafts[bid], 'Original draft and exact processed image survive normal quit')
    const sameQueue = recovered.state.agentSteerQueues[sid].find(entry => entry.operationId === queued.operationId)
    assert.ok(sameQueue, 'The second process keeps the exact original queued input identity')
    assert.ok(sameQueue.browserInput, 'The second process retains the frozen input capture reference')
    for (const field of ['operationId', 'text', 'browserInput', 'browserRecipient', 'runId', 'promptCondition', 'inputReceipt']) assert.deepEqual(sameQueue[field], queued[field], 'Frozen queued input keeps original ' + field)
    const afterRun = await exact(); assert.equal(afterRun.pid, originalRun.pid)
    assert.equal(afterRun.acceptedInputBytes, beforeRun.acceptedInputBytes, 'Restoring the App does not resend queued or unknown input')
    const frozen = await rpc.call('browser.input.inspect', queued.browserInput.capture.reference)
    assert.deepEqual(frozen.reference, queued.browserInput.capture.reference)
    assert.deepEqual(frozen.record, queued.browserInput.capture.record, 'Second-process public inspection reads the original immutable frozen input owner')
    const preview = await probe.cdp.evaluate(`window.agentmux.browser.readSelectionImage(${q(image)})`)
    assert.ok(preview?.dataUrl)
    assert.equal(sha(Buffer.from(preview.dataUrl.split(',')[1], 'base64')), image.sha256, 'The second process original image reader returns the same actual bytes')
    const oldSelection = await probe.cdp.evaluate(`window.agentmux.browser.readInputSelection(${q(attached.operationId)})`)
    assert.equal(oldSelection.state, 'prepared'); assert.deepEqual(oldSelection.receipt, attached)
    const oldOperation = await probe.cdp.evaluate(`window.agentmux.browser.getOperation(${q(interrupted)})`)
    assert.ok(oldOperation); assert.ok(!['running', 'waiting', 'preparing'].includes(oldOperation.phase), 'Persisted history cannot revive an ownerless active program')
    const nativeBeforeRead = await waitFor('the original restored visible native page', () => nativeOwner(ctx, probe, ctx.urls[0]))
    assert.equal(nativeBeforeRead.visible, true)
    assert.deepEqual(nativeBeforeRead.document.feedback, { operation: 0, click: 0, control: 0 }, 'The actual restored native page has no ownerless cursor, click or glow host')
    assert.equal(nativeBeforeRead.storagePath, firstNative.storagePath, 'The native restored page already owns its original Profile before any create hint')
    assert.deepEqual(nativeBeforeRead.document.screen, { width: 768, height: 1024 }, 'The original fixed tablet screen is already restored')
    for (const key of ['scrollX', 'scrollY']) assert.equal(nativeBeforeRead.document[key], firstNative.document[key], 'The original page position is restored: ' + key)
    const target = (await rpc.call('browser.targets', {})).targets.find(value => value.id === bid)
    assert.equal(target?.status, 'ready')
    // The actual owner is already live; omit Profile/Viewport hints so this idempotent read cannot repair them.
    const browser = await probe.cdp.evaluate(`window.agentmux.browser.create(${q(bid)},${q(ctx.urls[0])},${q(ctx.workspaceId)})`)
    assert.equal(browser.id, bid); assert.equal(browser.driving, false)
    assert.equal(browser.control.inputIsolation, 'inactive')
    assert.equal(browser.profileId, profile.id); assert.equal(browser.viewport, 'tablet')
    assert.equal((await nativeOwner(ctx, probe, ctx.urls[0])).contentsId, nativeBeforeRead.contentsId)
    const currentProfile = (await probe.cdp.evaluate('window.agentmux.browser.listProfiles()')).find(value => value.id === profile.id)
    assert.deepEqual(currentProfile, profile)
    assert.equal(graphAfter.graph.resources['region:' + initial.surface.regionId].profileId, profile.id)
    result.recovered = { graph: graphAfter, session: recovered.current, draft: recovered.state.browserOpinionDrafts[bid], queue: sameQueue, frozen, run: afterRun, previewSha256: image.sha256, oldSelection, oldOperation, browser, nativeBeforeRead }
    const originalIdentity = observer.runtimeIdentity()
    result.recovered.runtimeIdentity = originalIdentity
    result.cases.push({ name: 'ordinary-two-process-layout-profile-image-input-and-healthy-run', passed: true })
    // End only this private Run, without retiring its Session, then exercise the real Main/Core semantic owner.
    ctx.setPhase('collaboration-same-session-native-recovery')
    const transcript = join(ctx.privateHome, 'codex/sessions', `rollout-${sid}.jsonl`), nativeBefore = await readFile(transcript, 'utf8')
    const originalBodies = nativeBefore.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.type === 'response_item' && row.payload?.type === 'message').map(row => ({ role: row.payload.role, text: row.payload.content.map(part => part.text ?? '').join('') }))
    assert.equal(originalBodies.length, 2, 'The original native conversation is nonempty before recovery')
    await observer.stopTerminal({ runId: retained.runId })
    await waitFor('authoritative original Run ended', async () => (await observer.listRuns()).find(value => value.runId === retained.runId)?.state !== 'running')
    const sdkPath = fileURLToPath(import.meta.resolve('@ctxmux/sdk'))
    const { CtxmuxClient, CtxmuxProtocolError } = await import(pathToFileURL(sdkPath))
    const socketPath = join(ctx.runtimeDirectory, 'ctxmux.sock'), unfenced = new CtxmuxClient({ socketPath })
    const identity = await unfenced.runtimeInfo()
    for (const [nativeKey, coreKey] of [['daemonInstanceId', 'instanceId'], ['buildId', 'buildIdentity'], ['protocolGeneration', 'protocolVersion']]) {
      assert.ok(originalIdentity[coreKey] !== undefined)
      assert.equal(identity[nativeKey], originalIdentity[coreKey], 'The fault condition targets the original Host Runtime: ' + coreKey)
    }
    const sdk = new CtxmuxClient({ socketPath, expectedRuntimeIdentity: identity })
    const terminal = await sdk.status(retained.runId)
    assert.equal(terminal.id, retained.runId); assert.equal(terminal.state.type, 'exited')
    assert.equal(terminal.spec.env.AGENTMUX_AGENT_SESSION_ID, sid)
    assert.equal(await (await import('node:fs/promises')).realpath(terminal.spec.cwd), await (await import('node:fs/promises')).realpath(ctx.workspacePath))
    result.missingCondition = { runtime: identity, originalRun: terminal.id, state: terminal.state, attachments: terminal.attachments,
      originalSessionMatched: true, originalDirectoryMatched: true, sdkSha256: sha(await readFile(sdkPath)), removeAttempts: 0, confirmed: false }
    if (terminal.attachments === 0) {
      result.missingCondition.removeAttempts = 1
      try {
        await sdk.remove(retained.runId)
        try { await sdk.status(retained.runId); assert.fail('The removed original Run must have an authoritative missing result') }
        catch (error) {
          assert.ok(error instanceof CtxmuxProtocolError && error.code === 'run_not_found', 'Only the exact official missing reply qualifies run-missing')
          result.missingCondition.confirmed = true; result.missingCondition.statusCode = error.code
        }
      } catch (error) {
        if (error.code === 'ERR_ASSERTION') throw error
        result.missingCondition.failure = { name: error.name, code: error.code ?? null, message: error.message }
      }
    }
    const resumeId = randomUUID()
    const recovery = await probe.cdp.evaluate(`window.agentmux.sessions.recover(${q(recovered.current.control)},${q(ctx.workspacePath)},${q(resumeId)},{trigger:'manual',timingOverride:'on-open'})`)
    const resumed = await waitFor('same persistent Session on its actual resumed native Run', async () => {
      const value = await session(probe, sid)
      return value?.control?.run?.runId && value.control.run.runId !== retained.runId ? value : null
    })
    const nativeAfter = await waitFor('actual native resume record', async () => {
      const bytes = await readFile(transcript, 'utf8')
      return bytes.split('\n').filter(Boolean).map(JSON.parse).some(row => row.type === 'fixture_resume') ? bytes : null
    }), rows = nativeAfter.split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(nativeAfter.startsWith(nativeBefore), 'Semantic recovery preserves the original native transcript prefix')
    const resumes = rows.filter(row => row.type === 'fixture_resume')
    assert.equal(resumes.length, 1); assert.equal(resumes[0].payload.id, original.nativeHandle.sessionId)
    const output = await waitFor('original resumed Run native context readback', async () => {
      const replay = await observer.readRunReplay(resumed.control.run, 0, 'raw')
      const bytes = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString('utf8')
      return /codex-restored-context:[^\r\n]+[\r\n]/u.test(bytes) ? bytes : null
    })
    const readback = JSON.parse(output.match(/codex-restored-context:([^\r\n]+)/u)?.[1] ?? 'null')
    assert.ok(readback); assert.equal(readback.nativeSessionId, original.nativeHandle.sessionId); assert.deepEqual(readback.bodies, originalBodies); assert.equal(readback.bodySha256, sha(JSON.stringify(originalBodies)))
    assert.equal(resumed.id, sid); assert.deepEqual(resumed.nativeHandle, original.nativeHandle)
    const continuity = resumed.continuityOperations[resumeId]
    assert.deepEqual(continuity.previousRun, recovered.current.control.run)
    assert.deepEqual(continuity.newRun, resumed.control.run)
    if (result.missingCondition.confirmed) assert.equal(continuity.evidence.kind, 'run-missing')
    const final = await saved(probe)
    assert.deepEqual(final.browserOpinionDrafts[bid], firstSaved.browserOpinionDrafts[bid])
    assert.equal(final.agentSteerQueues[sid].filter(entry => entry.operationId === queued.operationId).length, 1)
    const finalQueue = final.agentSteerQueues[sid].find(entry => entry.operationId === queued.operationId)
    for (const field of ['operationId', 'text', 'browserInput', 'browserRecipient', 'runId', 'promptCondition', 'inputReceipt']) assert.deepEqual(finalQueue[field], queued[field], 'Semantic recovery keeps original queued input ' + field)
    assert.ok(!output.includes(text) && !output.includes(image.sha256), 'Semantic recovery never reauthors or resends the original Browser opinion')
    assert.equal((await observer.listRuns()).filter(run => run.state === 'running' && run.agentSessionId === sid).length, 1)
    result.semanticRecovery = { recovery, resumed, continuity, nativeReadback: readback, originalTranscriptSha256: sha(nativeBefore), boundary: 'Only the original exited, unpinned private Run may be removed once through the official fenced Runtime SDK. A typed missing reply and original Core continuity evidence qualify missing; otherwise only actual ended-Run recovery is claimed. Same SID/native conversation, never opinion adoption, daemon crash or power loss.' }
    result.cases.push({ name: 'same-session-native-conversation-recovery-after-authoritative-run-end', passed: true })
    result.secondQuit = await ctx.normalQuit(probe)
    result.passed = true
  } finally {
    await observer?.dispose()
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}
