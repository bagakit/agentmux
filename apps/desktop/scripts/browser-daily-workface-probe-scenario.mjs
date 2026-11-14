import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { native } from './browser-demonstration-probe-scenario.mjs'
import { handleTaskDataRequest, prepareTaskDataOutcomes, recoverTaskDataOutcomes, presentRecoveredTaskDataOutcomes } from './browser-task-data-outcomes-probe-scenario.mjs'
import { frameFixture, frameDocuments, issuedFrameActionsCode, auditFrameObservation, auditScopedFrame } from './browser-frame-probe-scenario.mjs'
import { collectBrowserCapabilityMeasurements, assertSourceBrowserConsumers } from './lib/browser-capability-cost-collector.mjs'
import { restoreDailyPrivateWindowForInput } from './browser-daily-workface-support.mjs'

// The original recovery harness owns launch, quit, source identity and cleanup.
const q = JSON.stringify, sha = bytes => createHash('sha256').update(bytes).digest('hex')
const region = id => `[data-workbench-region-id="${id}"]`
export function dailyProbeExecutors({ coreRoot, codexHome, privateHome }) {
  return Object.fromEntries(['a', 'b'].map(id => ['daily-' + id, {
    label: 'Private daily Agent ' + id.toUpperCase(), providerId: 'codex', command: join(coreRoot, 'test/fixtures/fake-codex-cli.mjs'), args: [], injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_READY_MODE: 'working-until-resume', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(codexHome, 'sessions'),
      AGENTMUX_FAKE_NATIVE_PRESERVE: '1', AGENTMUX_FAKE_NATIVE_CONTEXT: 'Original private daily Browser conversation ' + id,
      AGENTMUX_FAKE_CAPABILITY_RECEIPT: join(privateHome, 'daily-' + id + '-credential.json') }
  }]))
}
export function handleDailyRequest(request, response, receipt) {
  const path = new URL(request.url, 'http://fixture.invalid').pathname
  if (path === '/daily-frames' || path.startsWith('/frame-')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>Daily independent frames</title>' + frameFixture(request.url, `http://${request.headers.host}/daily-frames`)); return true
  }
  if (path === '/daily-control' || path === '/daily-default-survey' || path === '/daily-extension-effect') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>Daily Browser</title><h1>Daily Browser</h1><input id="daily-draft" aria-label="Daily page draft"><script>globalThis.dailyActions=0;globalThis.demoTrusted={click:0,input:0};for(const type of ["click","input"])document.addEventListener(type,e=>{if(e.isTrusted){globalThis.demoTrusted[type]++;globalThis.demoTrusted.lastTarget=e.target.id}},true)</script>'); return true
  }
  return handleTaskDataRequest(request, response, receipt)
}
async function cli(ctx, actor, args, input = '', expectOkay = true, focusObservation = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|ELECTRON_)/.test(key)))
  Object.assign(env, { HOME: ctx.privateHome, CODEX_HOME: join(ctx.privateHome, 'codex'), AGENTMUX_RPC_ENDPOINT: 'unix:' + join(ctx.runtimeDirectory, 'control.sock'),
    AGENTMUX_RUNTIME_DIRECTORY: ctx.runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(ctx.runtimeDirectory, 'state') })
  if (actor) Object.assign(env, { AGENTMUX_AGENT_SESSION_ID: actor.sid, AGENTMUX_AGENT_CAPABILITY: actor.capability })
  assert.deepEqual(Object.keys(ctx.fixtureTlsEnvironment).sort(), ['NODE_EXTRA_CA_CERTS'])
  Object.assign(env, ctx.fixtureTlsEnvironment)
  const value = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ctx.coreRoot, 'dist/agentmux.js'), ...args], { cwd: ctx.workspacePath, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false, escalation
    const nativeReview = args.slice(0, 4).join(' ') === 'browser profile extension apply'
    const timer = nativeReview ? undefined : setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1000) }, 30_000)
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) }); child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation)
      try {
        assert.equal(expired, false, 'Private CLI deadline is not a business result'); assert.equal(signal, null)
        const row = JSON.parse(stdout.trim() ? stdout : stderr)
        const observedFocus = focusObservation && row.ok === true && row.operation === 'app.focus' && code === 1 && row.result.partial === true
        if (focusObservation || code !== (expectOkay ? 0 : 1)) ctx.receipt.daily.cli.push({ args, actor: actor?.sid ?? 'person', ok: row.ok, operation: row.operation, exitCode: code, error: row.error, ...(focusObservation ? { result: row.result } : {}) })
        if (!observedFocus) assert.equal(code, expectOkay ? 0 : 1, 'The original CLI must return its expected exit status: ' + q({ args, error: row.error, result: row.result }))
        if (focusObservation) {
          assert.ok(['applied', 'unchanged'].includes(row.result.navigation.state)); assert.equal(row.result.input.policy, 'preserve')
          assert.equal(row.result.navigation.selection.surface, args[args.indexOf('--surface') + 1]); assert.equal(row.result.save.clientStateWritten, true)
        }
        assert.equal(row.ok, expectOkay, stdout + stderr); resolve(row)
      } catch (error) { reject(error) }
    }); child.stdin.on('error', () => {}); child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
  ctx.receipt.daily.cli.push({ args, actor: actor?.sid ?? 'person', ok: value.ok, operation: value.operation }) // Never record the capability or environment.
  return value.ok ? value.result : value
}
const target = async (ctx, id) => (await ctx.rpc.call('browser.targets', {})).targets.find(row => row.id === id)
async function focus(ctx, reference) {
  const request = { operationId: randomUUID(), inputPolicy: 'preserve', target: { kind: 'space', regionId: reference.regionId } }
  const observed = { request, reference: structuredClone(reference), startedAt: Date.now() }
  ;(ctx.receipt.daily.focusOperations ??= []).push(observed)
  try {
    const receipt = await ctx.rpc.call('space.focus', request)
    observed.receipt = receipt; observed.finishedAt = Date.now()
    assert.ok(['applied', 'unchanged'].includes(receipt.navigation.state)); return receipt
  } catch (error) {
    observed.failedAt = Date.now(); observed.failure = { name: error.name, code: error.code ?? null, message: error.message }
    throw error
  }
}
// Read only the exact existing document. A hidden native owner is still readable;
// no Browser restore, input transfer or preview-health precondition is introduced.
async function documentReady(ctx, url) {
  await ctx.waitFor('the original daily document is loaded without transferring input', async () => {
    const owners = await ctx.probe.main.evaluate(`(()=>{const {webContents}=process.getBuiltinModule('module').createRequire(${q(join(ctx.desktopRoot, 'package.json'))})('electron');return webContents.getAllWebContents().filter(c=>!c.isDestroyed()&&c.getURL()===${q(url)}).length})()`)
    return owners === 1 && await ctx.nativePageScript(ctx.probe, 'document.readyState', url) === 'complete'
  })
}
async function take(ctx, browser) {
  await focus(ctx, browser)
  if ((await target(ctx, browser.browserId))?.control?.owner === 'agent') await ctx.click(ctx.probe.cdp, ctx.selectors(region(browser.regionId) + ' [aria-label="Take control of Browser"]'))
  await ctx.waitFor('the exact trusted human control receipt', async () => (await target(ctx, browser.browserId))?.control?.owner === 'human')
}
async function give(ctx, browser, actor, returning = false) {
  await focus(ctx, browser)
  const current = (await target(ctx, browser.browserId))?.control
  if (current?.owner === 'agent' && current.agent?.agentSessionId === actor.sid) return
  if (returning) {
    await ctx.click(ctx.probe.cdp, ctx.selectors(region(browser.regionId) + ' [aria-label^="Browser activity:"]'))
    await ctx.click(ctx.probe.cdp, `${ctx.selectors('[role="menuitem"]')}.filter(e=>e.checkVisibility()&&e.textContent.trim().startsWith('Return to '))`)
  } else await ctx.click(ctx.probe.cdp, ctx.selectors(region(browser.regionId) + ' [aria-label^="Give to "]'))
  await ctx.waitFor('the original Core Agent receives trusted Browser control', async () => {
    const control = (await target(ctx, browser.browserId))?.control
    return control?.owner === 'agent' && control.agent?.agentSessionId === actor.sid
  })
}
async function originalDraftPresentation(ctx, selector) {
  const renderer = await ctx.probe.cdp.evaluate(`(()=>{
    const region=document.querySelector(${q(selector.split(' [role=')[0])});
    const editor=region?.querySelector('.composer__editor');let structure=null;
    if(editor){const clone=editor.cloneNode(true);for(const node of clone.querySelectorAll('[contenteditable],.composer__editor-fallback'))node.textContent='';structure=clone.outerHTML;}
    return{visibilityState:document.visibilityState,hidden:document.hidden,hasFocus:document.hasFocus(),closed:window.closed,
      textboxCount:document.querySelectorAll(${q(selector)}).length,editorStructure:structure};
  })()`)
  const native = await ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${q(join(ctx.desktopRoot, 'package.json'))})('electron');return{pid:process.pid,windows:BrowserWindow.getAllWindows().map(w=>({windowId:w.id,visible:w.isVisible(),minimized:w.isMinimized(),focused:w.isFocused(),bounds:w.getBounds()}))}})()`)
  return { renderer, native, windows: await ctx.rpc.call('app.window.ls', {}) }
}
async function typeDraft(ctx, selector, value) {
  try { await ctx.click(ctx.probe.cdp, ctx.selectors(selector)) }
  catch (error) {
    try {
      ctx.receipt.daily.draftDiagnostic = await ctx.probe.cdp.evaluate(`(async()=>{
        const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
        const fact=e=>({tag:e.tagName,role:e.getAttribute('role'),label:e.getAttribute('aria-label'),connected:e.isConnected,
          visible:e.checkVisibility(),rect:rect(e),display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,
          overflow:getComputedStyle(e).overflow,regionId:e.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId??null});
        const nodes=Array.from(document.querySelectorAll(${q(selector)}));
        const spatial=await window.agentmux.spatial.read(),sessions=await window.agentmux.sessions.snapshot();
        return{selector:${q(selector)},viewport:{width:innerWidth,height:innerHeight},
          nodes:nodes.map(e=>({node:fact(e),ancestors:(()=>{const a=[];for(let p=e.parentElement;p&&a.length<10;p=p.parentElement)a.push(fact(p));return a})()})),
          regions:Array.from(document.querySelectorAll('[data-workbench-region-id]')).map(fact),
          activeElement:document.activeElement&&fact(document.activeElement),spatial,
          sessions:sessions.sessions.filter(s=>s.kind==='agent').map(s=>({id:s.id,agentSessionId:s.control.agentSessionId,run:s.control.run,processState:s.processState}))};
      })()`)
      const frame = await ctx.probe.cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
      const file = join(ctx.receipt.visual.captureDirectory, 'daily-failed-draft-renderer.png')
      await writeFile(file, Buffer.from(frame.data, 'base64'))
      ctx.receipt.visual.frames.push({ label: 'daily-failed-draft', file })
    } catch (diagnosticError) { ctx.receipt.daily.draftDiagnosticError = { code: diagnosticError.code ?? null, message: diagnosticError.message } }
    throw error
  }
  await ctx.probe.cdp.call('Input.insertText', { text: value })
  assert.equal(await ctx.probe.cdp.evaluate(`document.querySelector(${q(selector)}).textContent`), value)
}
async function createActor(ctx, id, zone, observer) {
  const opened = await ctx.rpc.call('agent.open', { content: { kind: 'new-agent', executorId: 'daily-' + id, executionWorkspaceId: ctx.workspaceId }, destination: { zoneId: zone.zoneId, newTab: true }, focus: true })
  assert.equal(opened.outcome, 'opened'); assert.ok(opened.agent)
  const sid = opened.agent.agentSessionId, credential = await ctx.waitFor('the original Core-injected private credential', async () => {
    try { return JSON.parse(await readFile(join(ctx.privateHome, 'daily-' + id + '-credential.json'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  })
  assert.equal(credential.agentSessionId, sid); assert.ok(typeof credential.capability === 'string' && credential.capability.length > 0, 'The original Core-injected credential is required')
  const session = await ctx.waitFor('the original private Session has a live Run', () => ctx.probe.cdp.evaluate(`window.agentmux.sessions.snapshot().then(s=>s.sessions.find(x=>x.kind==='agent'&&x.control.agentSessionId===${q(sid)}&&x.control.run?.runId))`))
  const run = (await observer.listRuns()).find(row => row.runId === session.control.run.runId); assert.equal(run?.state, 'running'); assert.ok(run.pid > 1)
  return { sid, capability: credential.capability, expectedRun: session.control.run, opened, originalRun: run }
}
async function exactRun(observer, actor) {
  const run = (await observer.listRuns()).find(row => row.runId === actor.originalRun.runId)
  assert.equal(run?.state, 'running'); assert.equal(run.pid, actor.originalRun.pid); return run
}
async function newAck(observer, actor, text) {
  const before = await exactRun(observer, actor), ack = await observer.writeAgent({ agentSessionId: actor.sid, expectedRun: actor.expectedRun, source: 'user', data: text + '\n' })
  assert.equal(ack.appliedByteRange?.startByte, before.acceptedInputBytes); assert.ok(ack.appliedByteRange.endByte > ack.appliedByteRange.startByte); return ack
}
async function runAs(ctx, actor, browser, operationId, code) {
  const result = await cli(ctx, actor, ['browser', 'run', '--browser', browser.browserId, '--operation-id', operationId], code)
  ;(ctx.receipt.daily.programs ??= []).push({ actor: actor.sid, browserId: browser.browserId, operationId, codeSha256: sha(code), reply: result })
  assert.equal(result.runOperation.id, operationId); assert.equal(result.runOperation.browserId, browser.browserId); assert.equal(result.runOperation.operator.id, actor.sid)
  assert.ok(['completed', 'stopped'].includes(result.runOperation.phase), 'Retain the original program outcome: ' + q(result))
  return result
}
async function cooperativeControl(ctx, a, b, pageA, pageB, observer) {
  await give(ctx, pageA, a); await give(ctx, pageB, b)
  const operationId = randomUUID(), originalCode = 'await waitForElement("Daily deliberately absent target",20000);'
  const pending = runAs(ctx, a, pageA, operationId, originalCode)
  let earlyFailure; void pending.catch(error => { earlyFailure = error })
  // Observe the actual owner; the operation title and visible label do not establish control.
  await ctx.waitFor('the exact credentialed first program is waiting', async () => { if (earlyFailure) throw earlyFailure; return (await cli(ctx, a, ['browser', 'inspect', '--operation-id', operationId])).runOperation?.phase === 'waiting' })
  const other = await runAs(ctx, b, pageB, randomUUID(), 'return await js("++globalThis.dailyActions");')
  assert.equal(other.result, 1); assert.equal((await target(ctx, pageA.browserId)).control.activeOperationId, operationId)
  const borrowed = await cli(ctx, b, ['browser', 'run', '--browser', pageA.browserId, '--operation-id', operationId], originalCode, false)
  assert.equal(borrowed.ok, false) // Existing shared history remains readable; this is no new per-Agent page ACL.
  assert.equal((await cli(ctx, b, ['browser', 'inspect', '--operation-id', operationId])).runOperation.operator.id, a.sid)
  const stopped = await cli(ctx, a, ['browser', 'stop', '--operation-id', operationId]); assert.equal(stopped.runOperation.phase, 'stopped'); assert.equal((await pending).runOperation.phase, 'stopped')
  assert.equal((await target(ctx, pageA.browserId)).control.owner, 'agent')
  await take(ctx, pageB)
  await ctx.nativeFrameReady(pageB.url, ctx.probe) // Actual native typing below needs its visible input owner.
  const human = await native({ ...ctx, browserId: pageB.browserId, pageUrl: pageB.url }, '#daily-draft', 'Retained human page input')
  assert.ok(human.after.input > human.before.input)
  const beforeReturn = await ctx.nativePageScript(ctx.probe, 'document.querySelector("#daily-draft").value', pageB.url)
  assert.equal(beforeReturn, 'Retained human page input')
  await ctx.capture(ctx.probe, 'daily-original-mixed-workface', 'page', pageB.url)
  await give(ctx, pageB, b, true)
  const returned = await runAs(ctx, b, pageB, randomUUID(), 'return await js(' + q('document.querySelector("#daily-draft").value') + ');'); assert.equal(returned.result, 'Retained human page input')
  await exactRun(observer, a); await exactRun(observer, b)
  ctx.receipt.daily.control = { operationId, firstActor: a.sid, secondActor: b.sid, secondOperationId: other.runOperation.id, stopped: stopped.runOperation.phase, originalHumanInput: returned.result }
}
async function frameFacts(ctx, url) {
  return ctx.probe.main.evaluate(`(async()=>{const {webContents}=process.getBuiltinModule('module').createRequire(${q(join(ctx.desktopRoot, 'package.json'))})('electron');const pages=webContents.getAllWebContents().filter(w=>!w.isDestroyed()&&w.getURL()===${q(url)});if(pages.length!==1)throw Error('Daily frame owner missing or ambiguous');return Promise.all(pages[0].mainFrame.framesInSubtree.map(async f=>({url:f.url,processId:f.processId,frameTreeNodeId:f.frameTreeNodeId,...await f.executeJavaScript('({document:globalThis.frameDocument,identity:globalThis.frameIdentity,actions:globalThis.frameActions})')})))})()`)
}
async function frames(ctx, actor, browser) {
  await give(ctx, browser, actor)
  await documentReady(ctx, browser.url)
  const before = await ctx.waitFor('five exact native frame documents', async () => { const facts = await frameFacts(ctx, browser.url); return facts.length === 5 && facts.every(f => f.identity) ? facts : null })
  assert.ok(before.every(f => f.actions === 0))
  const report = await runAs(ctx, actor, browser, randomUUID(), issuedFrameActionsCode()); assert.equal(report.outcome.kind, 'completed')
  const nativeDocuments = await frameFacts(ctx, browser.url), joined = auditFrameObservation({ ...report.result, nativeDocuments }, browser.url)
  auditScopedFrame(report.result.withinRef, joined, 'child', 'subtree')
  assert.deepEqual(Object.fromEntries(nativeDocuments.map(f => [f.document, f.actions])), { main: 1, child: 2, nested: 1, remote: 1, 'remote-child': 1 })
  assert.deepEqual([...nativeDocuments.map(f => f.document)].sort(), [...frameDocuments].sort())
  const clipped = await runAs(ctx, actor, browser, randomUUID(), 'return await snapshot({scope:"page",interactiveOnly:true,maxNodes:1});')
  assert.equal(clipped.result.nodes.length, 1); assert.equal(clipped.result.observation.work.axTrees, 5)
  ctx.receipt.daily.frames = { browserId: browser.browserId, operationId: report.runOperation.id, joined, work: report.result.snapshot.observation.work, clippedWork: clipped.result.observation.work, returnedNodes: clipped.result.nodes.length, nativeDocuments }
}
async function originalResultWithCost(ctx, actor, operationId) {
  const buffers = [], chunks = []; let offset = 0, artifact
  do {
    const result = await cli(ctx, actor, ['browser', 'inspect', '--operation-id', operationId, '--step', '1', '--offset', String(offset), '--max-bytes', '65536'])
    assert.equal(result.resultRead?.status, 'available'); const chunk = result.resultRead.chunk
    artifact ??= chunk.reference; assert.deepEqual(chunk.reference, artifact); assert.equal(chunk.offset, offset)
    buffers.push(Buffer.from(chunk.data, 'base64')); chunks.push({ offset, returnedBytes: chunk.returnedBytes, nextOffset: chunk.nextOffset, readCost: chunk.readCost }); offset = chunk.nextOffset
  } while (offset !== null)
  const bytes = Buffer.concat(buffers), document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  return { artifact, source: document.source, document, byteLength: bytes.length, sha256: sha(bytes), chunks }
}
export async function reviewDailyWorkface(ctx) {
  // Required unfinished T002/UI and exact Source-consumer inputs. Missing hooks fail;
  // they cannot be replaced with a passed boolean or skipped stage.
  assert.equal(typeof ctx.extensionHooks?.prepareAndUpdate, 'function', 'Wire the T002 public check/prepare/apply and real native dialog UI phase before activation')
  assert.equal(typeof ctx.extensionHooks?.recover, 'function', 'Wire the original v2 extension restart effect check')
  assert.equal(typeof ctx.sourceConsumerMeasurements, 'function', 'Wire exact current-source hidden/unselected consumers; native bytes are not UI cost')
  assert.equal(typeof ctx.contextFor, 'function', 'The recovery harness must rebuild its probe-bound capture/readiness closures after restart')
  const report = ctx.receipt.daily = { complete: false, cli: [], boundary: 'Actual ordinary App/Core/CLI/native Browser and two synthetic Provider Sessions with original Core-issued capabilities. No Store seed, fake approval handler, manual storage flush, LLM quality or physical input claim.' }
  report.engine = await ctx.probe.main.evaluate('({electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node})')
  assert.equal(report.engine.electron, JSON.parse(await readFile(join(ctx.desktopRoot, 'package.json'), 'utf8')).devDependencies.electron)
  report.privateTaskDataReference = ctx.privateTaskDataReference
  let observer
  try {
    // Explicit hosted RPC and per-CLI-child env preserve the parent/Orca tool environment.
    const sdk = await import(pathToFileURL(join(ctx.coreRoot, 'dist/index.js'))); observer = await sdk.connectHostedAgentMux({ rpc: await sdk.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(ctx.runtimeDirectory, 'control.sock') } }) })
    const spatial = await ctx.probe.cdp.evaluate('window.agentmux.spatial.read()'), zone = spatial.graph.zones.find(z => z.workspaceId === ctx.workspaceId); assert.ok(zone)
    const a = await createActor(ctx, 'a', zone, observer), b = await createActor(ctx, 'b', zone, observer)
    report.actors = [a, b].map(actor => ({ sid: actor.sid, regionId: actor.opened.to.regionId, run: actor.originalRun }))
    assert.ok(a.capability !== b.capability, 'Each original Core Session must receive its own credential')
    const creationId = randomUUID()
    const created = await cli(ctx, null, ['browser', 'profile', 'create', '--operation-id', creationId, '--label', 'Private daily work environment'])
    assert.equal(created.creation.operationId, creationId); assert.equal(created.creation.receipt.createdKind, 'profile')
    assert.equal(created.creation.current.state, 'present'); assert.equal(created.creation.current.createdId, created.creation.receipt.createdId)
    const profile = (await cli(ctx, null, ['browser', 'profile', 'inspect', '--profile', created.creation.receipt.createdId])).profile
    assert.equal(profile.id, created.creation.receipt.createdId)
    report.profileCreation = created.creation
    const open = async (url, actor, profileId, survey, after) => {
      const result = await ctx.rpc.call('browser.open', { url, ...(profileId ? { profileId } : {}), ...(survey ? { survey: true } : {}),
        destination: after ? { kind: 'new-tab', after: { kind: 'tab', tabId: after.tabId } } : { kind: 'split', direction: 'right', region: { kind: 'region', regionId: actor.opened.to.regionId } } })
      assert.equal(result.region.kind, 'browser'); assert.ok(result.region.browserId)
      if (profileId) assert.equal(result.region.profileId, profileId)
      assert.equal(result.survey.outcome, profileId || survey ? 'registered' : 'not-requested')
      return { ...result.region, url }
    }
    const pageA = await open(ctx.urls[0], a), pageB = await open(new URL('/daily-control', ctx.urls[0]).href, b, profile.id)
    await focus(ctx, pageA); await documentReady(ctx, pageA.url); await focus(ctx, pageB); await documentReady(ctx, pageB.url)
    await ctx.nativePageScript(ctx.probe, "document.cookie='daily-login=original-default; Max-Age=86400; SameSite=Lax';null", pageA.url)
    const defaultSurvey = await open(new URL('/daily-default-survey', ctx.urls[0]).href, a, undefined, true, pageA)
    const defaultSurveyUrl = new URL('/daily-default-survey', ctx.urls[0]).href
    await focus(ctx, defaultSurvey); await documentReady(ctx, defaultSurveyUrl)
    const surveyCookie = await ctx.nativePageScript(ctx.probe, 'document.cookie', defaultSurveyUrl)
    const namedCookie = await ctx.nativePageScript(ctx.probe, 'document.cookie', pageB.url)
    report.profileIsolation = { defaultSurvey, namedBrowser: pageB, surveyCookie, namedCookie }
    ctx.setPhase('daily-profile-cookie-isolation')
    assert.ok(surveyCookie.includes('daily-login=original-default'), 'Survey and the default task environment share their original login')
    assert.ok(!namedCookie.includes('daily-login='), 'A named Profile must not share the default environment Cookie')
    ctx.setPhase('daily-original-two-Agent-workface')
    for (const page of [defaultSurvey, pageB]) await cli(ctx, null, ['app', 'focus', '--surface', 'survey', '--browser', page.browserId, '--region', page.regionId], '', true, true)
    const survey = await cli(ctx, null, ['space', 'survey-list'])
    assert.ok(survey.pageReferences.some(r => r.browserId === defaultSurvey.browserId && r.regionId === defaultSurvey.regionId))
    assert.ok(survey.pageReferences.some(r => r.browserId === pageB.browserId && r.regionId === pageB.regionId))
    assert.ok(!survey.pageReferences.some(r => r.browserId === pageA.browserId))
    await cli(ctx, null, ['app', 'focus', '--surface', 'space'], '', true, true)
    await writeFile(join(ctx.workspacePath, 'daily-retained.txt'), 'Original daily File workface.\n')
    const file = await ctx.rpc.call('file.open', { path: 'daily-retained.txt', zoneId: zone.zoneId, focus: false })
    assert.equal(file.outcome, 'opened'); assert.equal(file.data.kind, 'text'); assert.equal(file.navigation, 'background')
    const draftSelector = region(a.opened.to.regionId) + ' [role="textbox"][aria-label="Message Agent"]', draft = 'Original unsent daily draft — keep these bytes.'
    report.draftNavigation = await focus(ctx, { regionId: a.opened.to.regionId })
    report.draftPresentationBefore = await originalDraftPresentation(ctx, draftSelector)
    report.draftWindowRestore = await restoreDailyPrivateWindowForInput(ctx, 'first-draft')
    await ctx.waitFor('the original private document is actually visible for UI input', () => ctx.probe.cdp.evaluate('!document.hidden && document.visibilityState === "visible"'))
    report.draftPresentationAfter = await originalDraftPresentation(ctx, draftSelector)
    await typeDraft(ctx, draftSelector, draft)
    await cooperativeControl(ctx, a, b, pageA, pageB, observer)
    report.extensions = await ctx.extensionHooks.prepareAndUpdate({ ...ctx, cli: (actor, args, input, okay) => cli(ctx, actor, args, input, okay), actors: { a, b }, profile, browser: pageB })
    assert.ok(report.extensions.extensionId); assert.equal(report.extensions.version, '2.0.0')
    const installedExtension = report.extensions
    assert.equal(installedExtension?.version, '2.0.0'); assert.ok(installedExtension.nativeId)
    const effectUrl = new URL('/daily-extension-effect', ctx.urls[0]).href, effectBrowser = await open(effectUrl, b, profile.id, undefined, pageB)
    report.effectBrowser = effectBrowser
    await focus(ctx, effectBrowser); await documentReady(ctx, effectUrl)
    const effectReady = () => ctx.waitFor('the original extension content and background callbacks report v2', async () => {
      const value = await ctx.nativePageScript(ctx.probe, '({...document.documentElement.dataset})', effectUrl)
      return value.extensionVersion === '2.0.0' && value.extensionBackground === '2.0.0' ? value : null
    })
    const firstEffect = await effectReady()
    assert.equal(firstEffect.extensionVersion, '2.0.0'); assert.equal(firstEffect.extensionBackground, '2.0.0')
    report.extensions.firstNativeEffect = { nativeId: installedExtension.nativeId, contentVersion: firstEffect.extensionVersion, backgroundVersion: firstEffect.extensionBackground }
    assert.equal(await ctx.nativePageScript(ctx.probe, 'document.querySelector("#daily-draft").value', pageB.url), 'Retained human page input', 'Extension management must not reload or replace the original input document')
    const frameUrl = new URL('/daily-frames', ctx.urls[0]).href
    // Keep the existing B Agent beside its Browser. A new Browser-only Tab has
    // no existing Agent recipient for the original trusted Give control action.
    const frameNavigation = await runAs(ctx, b, pageB, randomUUID(), 'await gotoUrl(' + q(frameUrl) + ');return await pageInfo();')
    assert.equal(frameNavigation.result.url, frameUrl)
    const frameBrowser = { ...pageB, url: frameUrl }
    await frames(ctx, b, frameBrowser)
    await take(ctx, pageA)
    const task = { ...ctx.contextFor(ctx.probe, pageA.browserId, ctx.urls[0]), privateHome: ctx.privateHome, runtimeDirectory: ctx.runtimeDirectory, zone, region: pageA }
    // T003's trusted demonstration click is the native-input consumer here.
    await task.nativeFrameReady(task.pageUrl, task.probe)
    await prepareTaskDataOutcomes(task) // Leaves this exact Browser at /b; demonstration+task POST count remains two.
    assert.equal(ctx.receipt.taskDataRequests.actions.length, 2)
    const recordedResult = await originalResultWithCost(ctx, a, ctx.receipt.taskData.producers[0])
    const costReceipt = { ...ctx.receipt, browserOutcome: { recordedResult } }
    try {
      report.cost = await collectBrowserCapabilityMeasurements({ ...ctx, receipt: costReceipt }, { relatedOperationId: recordedResult.artifact.operationId, siblingBrowserId: pageB.browserId })
    } finally {
      report.costObservation = costReceipt.capabilityMeasurementObservation
    }
    report.sourceConsumers = await ctx.sourceConsumerMeasurements(ctx); assertSourceBrowserConsumers(report.sourceConsumers)
    for (const sample of report.sourceConsumers.reports) {
      assert.equal(sample.candidateCommit, ctx.receipt.sourceCommit)
      for (const [file, expected] of Object.entries(sample.sourceIdentity)) {
        assert.equal(sha(await readFile(join(ctx.repositoryRoot, file))), expected, 'Source consumer report drift: ' + file)
        if (ctx.receipt.identityBefore[file]) assert.equal(expected, ctx.receipt.identityBefore[file], 'Source and Native must consume the same exact owner: ' + file)
      }
    }
    // Keep the task Browser cold at the one ordinary App restart. Reading its
    // original artifact below cannot instantiate or restore its native document.
    await focus(ctx, pageB)
    const graph = await ctx.probe.cdp.evaluate('window.agentmux.spatial.read()'), savedSurvey = await cli(ctx, null, ['space', 'survey-list'])
    const runBefore = await Promise.all([exactRun(observer, a), exactRun(observer, b)]), firstAcks = await Promise.all([newAck(observer, a, 'Daily first A'), newAck(observer, b, 'Daily first B')])
    const afterAcks = await Promise.all([exactRun(observer, a), exactRun(observer, b)])
    report.original = { actors: [a, b].map((actor, index) => ({ sid: actor.sid, expectedRun: actor.expectedRun, run: afterAcks[index] })), firstAcks, runBefore, pageA, pageB, effectBrowser, frameBrowser, defaultSurvey, profile, file, graph, survey: savedSurvey, draft }
    report.firstQuit = await ctx.normalQuit(ctx.probe)
    await exactRun(observer, a); await exactRun(observer, b)
    const second = await ctx.launch('second'); ctx.retainSecond(second)
    Object.assign(ctx, ctx.contextFor(second, pageA.browserId, ctx.urls[1]), { probe: second })
    await ctx.waitFor('both exact original Core Runs attach in the actual second App', () => ctx.probe.cdp.evaluate(`window.agentmux.sessions.snapshot().then(s=>${q([a, b].map(actor => ({ sid: actor.sid, runId: actor.originalRun.runId })))}.every(original=>s.sessions.some(x=>x.kind==='agent'&&x.control.agentSessionId===original.sid&&x.control.run?.runId===original.runId)))`))
    const after = await ctx.probe.cdp.evaluate('window.agentmux.spatial.read()')
    for (const key of ['tabs', 'regions', 'tabLayouts', 'layouts']) assert.deepEqual(after.graph[key], graph.graph[key])
    assert.deepEqual((await cli(ctx, null, ['space', 'survey-list'])).pageReferences, savedSurvey.pageReferences)
    assert.equal(await readFile(join(ctx.workspacePath, 'daily-retained.txt'), 'utf8'), 'Original daily File workface.\n')
    for (const [index, actor] of [a, b].entries()) assert.equal((await exactRun(observer, actor)).acceptedInputBytes, afterAcks[index].acceptedInputBytes, 'Ordinary App restore must not replay input')
    const secondAcks = await Promise.all([newAck(observer, a, 'Daily second A'), newAck(observer, b, 'Daily second B')])
    report.recovered = { secondAcks, graph: after }
    const owners = () => ctx.probe.main.evaluate(`(()=>{const {webContents}=process.getBuiltinModule('module').createRequire(${q(join(ctx.desktopRoot, 'package.json'))})('electron');return webContents.getAllWebContents().filter(c=>!c.isDestroyed()&&c.getURL()===${q(ctx.urls[1])}).map(c=>({id:c.id,url:c.getURL()}))})()`)
    assert.deepEqual(await owners(), [], 'The original background task Browser stays cold in the second App')
    const coldArtifact = await originalResultWithCost(ctx, a, ctx.receipt.taskData.producers[0])
    assert.equal(coldArtifact.sha256, recordedResult.sha256)
    assert.deepEqual(await owners(), [], 'Original result reads cannot create the task Browser native page')
    assert.equal(ctx.receipt.taskDataRequests.actions.length, 2)
    report.coldRead = { operationId: recordedResult.artifact.operationId, artifactSha256: coldArtifact.sha256, nativeBefore: [], nativeAfter: [], actionCount: 2 }
    report.recoveredWindowRestore = await restoreDailyPrivateWindowForInput(ctx, 'second-original-result')
    await focus(ctx, pageA)
    await documentReady(ctx, ctx.urls[1])
    await ctx.waitFor('the original retained draft editor is presented after explicit restore', () => ctx.probe.cdp.evaluate(`document.querySelector(${q(draftSelector)})?.checkVisibility()`))
    assert.equal(await ctx.probe.cdp.evaluate(`document.querySelector(${q(draftSelector)}).textContent`), draft)
    assert.ok((await ctx.nativePageScript(ctx.probe, 'document.cookie', ctx.urls[1])).includes('daily-login=original-default'))
    const recoveredTask = { ...task, ...ctx.contextFor(second, pageA.browserId, ctx.urls[1]), probe: second }
    const restored = await recoverTaskDataOutcomes(recoveredTask)
    report.recovered.task = restored
    await presentRecoveredTaskDataOutcomes(recoveredTask)
    const retainedExtension = await ctx.extensionHooks.recover({ ...ctx, cli: (actor, args, input, okay) => cli(ctx, actor, args, input, okay), actor: b, browser: effectBrowser, profile, original: report.extensions })
    assert.equal(retainedExtension?.nativeId, installedExtension.nativeId); assert.equal(retainedExtension.version, '2.0.0')
    await focus(ctx, effectBrowser); await documentReady(ctx, effectUrl)
    const effect = await effectReady()
    assert.equal(effect.extensionVersion, '2.0.0'); assert.equal(effect.extensionBackground, '2.0.0')
    const actualV2 = { extensionId: retainedExtension.extensionId, nativeId: retainedExtension.nativeId, version: retainedExtension.version, contentVersion: effect.extensionVersion, backgroundVersion: effect.extensionBackground }
    Object.assign(report.recovered, { runs: await Promise.all([exactRun(observer, a), exactRun(observer, b)]), extensions: actualV2 })
    await ctx.capture(ctx.probe, 'daily-restored-profile-environment', 'page', effectUrl)
    await focus(ctx, pageA)
    report.secondQuit = await ctx.normalQuit(ctx.probe); report.complete = true
  } finally {
    await observer?.dispose()
  }
}
