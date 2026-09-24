import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

// Thin scenario hooks. The canonical harness owns all processes, userData,
// workbench setup, ordinary restart, captures, build identity and cleanup.
export const frameDocuments = ['main', 'child', 'nested', 'remote', 'remote-child']
const actionName = 'Shared frame action'
const quoted = JSON.stringify
const digest = value => createHash('sha256').update(value).digest('hex')

export function frameFixture(path, pageUrl) {
  const url = new URL(path, pageUrl), remote = new URL(pageUrl); remote.hostname = 'localhost'
  const routes = { '/frame-child': 'child', '/frame-nested': 'nested', '/frame-remote': 'remote', '/frame-remote-child': 'remote-child' }
  const name = routes[url.pathname] ?? (url.pathname === '/frame-budget' ? `budget-${url.searchParams.get('id')}` : 'main')
  const child = name === 'main' ? '<iframe title="Same-process document" src="/frame-child"></iframe>' +
    `<iframe title="Remote-process document" src="${remote.origin}/frame-remote"></iframe>`
    : name === 'child' ? '<iframe title="Nested document" src="/frame-nested"></iframe>'
      : name === 'remote' ? '<iframe title="Remote nested document" src="/frame-remote-child"></iframe>' : ''
  return `<style>body{font:14px system-ui;margin:12px}iframe{display:block;width:95%;height:180px;margin:8px 0}button{padding:8px}</style>` +
    `<section id="frame-main-zone"><button id="frame-action-${name}">${actionName}</button></section>${child}` +
    `<script>globalThis.frameDocument=${quoted(name)};globalThis.frameIdentity=crypto.randomUUID();globalThis.frameActions=0;` +
    `document.querySelector('button').addEventListener('click',()=>globalThis.frameActions++);</script>`
}

function nativeFrames(tree) {
  assert.ok(tree?.frameTree?.frame?.id, 'The native frame tree must identify its root')
  const frames = [], visit = node => { frames.push(node.frame); for (const child of node.childFrames ?? []) visit(child) }
  visit(tree.frameTree)
  return frames
}
function fixtureName(url) {
  const path = new URL(url).pathname
  return ({ '/frame-child': 'child', '/frame-nested': 'nested', '/frame-remote': 'remote', '/frame-remote-child': 'remote-child' })[path] ?? 'main'
}

/** Native result oracle; contract tests exercise this, never claim a native run. */
export function auditFrameObservation(value, pageUrl) {
  const { tree, snapshot, contexts, nativeDocuments } = value
  const frames = nativeFrames(tree), names = frames.map(frame => fixtureName(frame.url))
  for (const name of ['main', 'child', 'nested']) assert.equal(names.filter(item => item === name).length, 1)
  assert.ok(names.length >= 3 && names.length <= 5)
  assert.deepEqual(nativeDocuments.map(document => document.document).sort(), [...frameDocuments].sort())
  const root = tree.frameTree.frame, targets = snapshot.nodes.filter(node => node.role === 'button' && node.name === actionName)
  assert.equal(snapshot.url, pageUrl); assert.ok(snapshot.navigationId)
  assert.equal(targets.length, 5, 'All five actual documents need a nonempty same-named target')
  assert.equal(new Set(targets.map(node => node.ref)).size, 5)
  assert.equal(new Set(targets.map(node => node.frameId)).size, 5, 'Documents cannot collapse into their shared CDP sender')
  assert.deepEqual(snapshot.missingFrames, [])
  assert.deepEqual(snapshot.observation.omittedFrames, [])
  assert.equal(snapshot.observation.truncated, false)
  assert.equal(snapshot.observation.returned, snapshot.nodes.length)
  assert.equal(snapshot.observation.work.axTrees, 5)
  assert.ok(snapshot.observation.work.axNodes >= targets.length && snapshot.observation.work.cdpCommands > 0)
  assert.equal(contexts.length, 5)
  const joined = contexts.map(context => {
    const node = targets.find(target => target.ref === context.ref), frame = frames.find(frame => frame.id === node?.frameId)
    const document = context.selection.attributes.id?.replace(/^frame-action-/, ''), native = nativeDocuments.find(item => item.document === document)
    assert.ok(node && native, 'The issued ref must reach an independently observed Native document')
    const nativeUrl = new URL(native.url)
    nativeUrl.username = ''; nativeUrl.password = ''; nativeUrl.search = ''; nativeUrl.hash = ''
    assert.equal(new URL(context.selection.pageUrl).href, nativeUrl.href)
    assert.equal(fixtureName(context.selection.pageUrl), document)
    if (frame) assert.equal(fixtureName(frame.url), document)
    assert.equal(context.selection.tagName.toLowerCase(), 'button')
    assert.equal(context.selection.accessibleName, actionName)
    if (['main', 'child', 'nested'].includes(document)) {
      assert.ok(frame, 'Same-process refs must join the actual main CDP frame tree')
      assert.equal(node.sessionId, undefined)
      assert.equal(native.processId, nativeDocuments.find(item => item.document === 'main').processId)
      if (document === 'main') assert.equal(frame.id, root.id)
    } else {
      assert.ok(typeof node.sessionId === 'string' && node.sessionId.length > 0, 'Cross-site documents need their actual OOPIF sender')
      assert.notEqual(native.processId, nativeDocuments.find(item => item.document === 'main').processId)
    }
    return { document, frameId: node.frameId, ref: node.ref, backendNodeId: node.backendNodeId, sessionId: node.sessionId,
      nativeFrameTreeNodeId: native.frameTreeNodeId, independentlyJoinedMainCdpTree: Boolean(frame) }
  })
  assert.deepEqual(joined.map(item => item.document).sort(), [...frameDocuments].sort())
  assert.equal(joined.find(item => item.document === 'remote').sessionId, joined.find(item => item.document === 'remote-child').sessionId)
  return joined
}

export function auditScopedFrame(snapshot, joined, document, kind, returned = 1) {
  const target = joined.find(item => item.document === document); assert.ok(target)
  assert.ok(snapshot.nodes.length > 0)
  assert.equal(snapshot.nodes.filter(node => node.role === 'button' && node.name === actionName).length, returned)
  assert.deepEqual([...new Set(snapshot.nodes.map(node => node.frameId))], [target.frameId])
  assert.equal(snapshot.observation.scope.document, target.frameId)
  assert.equal(snapshot.observation.scope.kind, kind)
  assert.deepEqual([...snapshot.observation.omittedFrames].sort(), joined.filter(item => item.document !== document).map(item => item.frameId).sort())
  assert.deepEqual(snapshot.missingFrames, [])
  assert.equal(snapshot.observation.returned, snapshot.nodes.length)
  assert.equal(snapshot.observation.work.axTrees, 5, 'Output scope does not claim less underlying document work')
}

export function auditRejectedFrameAction(report) {
  assert.equal(report.outcome.kind, 'script-failed', 'An old ref cannot be turned into a fresh successful action')
  assert.equal(report.runOperation.steps.filter(step => step.method === 'click' && step.status === 'failed').length, 1)
}

export function auditCaughtFrameAction(report) {
  assert.equal(report.outcome.kind, 'completed')
  assert.match(report.result.supersededError, /superseded by a later snapshot in this run/)
  assert.equal(report.runOperation.steps.filter(step => step.method === 'click' && step.status === 'failed').length, 1)
  assert.equal(report.runOperation.steps.filter(step => step.method === 'click' && step.status === 'completed').length, 6)
}

export function auditRestoredFrameRead(report, pageUrl) {
  assert.equal(report.outcome.kind, 'indeterminate', 'Appearance recovery must retain its existing lossy notice')
  assert.match(report.runOperation.warning, /by appearance, not identity/)
  assert.equal(report.result.attributes.id, 'frame-action-main')
  assert.equal(report.result.pageUrl, pageUrl)
  assert.deepEqual(report.runOperation.steps.map(step => [step.method, step.status]), [['elementContext', 'completed']])
}

export async function run(ctx, code, completed = true) {
  const operationId = randomUUID()
  const receipt = await ctx.requestControl({ operation: 'browser.run', browserId: ctx.browserId, operationId, code })
  assert.equal(receipt.ok, true); assert.equal(receipt.operation, 'browser.run')
  const report = receipt.result
  assert.equal(report.runOperation.id, operationId); assert.equal(report.runOperation.browserId, ctx.browserId)
  assert.ok(report.runOperation.steps.length > 0)
  if (completed) assert.equal(report.outcome.kind, 'completed', JSON.stringify(report.outcome))
  ;(ctx.receipt.frames.operations ??= []).push(report.runOperation)
  return report
}
const observeCode = click => `const tree=await cdp('Page.getFrameTree');const page=await snapshot({scope:'page',maxNodes:120});const targets=page.nodes.filter(node=>node.role==='button'&&node.name===${quoted(actionName)});if(targets.length!==5)throw new Error('Expected five actual frame targets');const contexts=[];for(const target of targets){contexts.push({ref:target.ref,selection:await elementContext(target.ref)});${click ? 'await click(target.ref);' : ''}}return {tree,snapshot:page,contexts};`

// Keep issued-ref scope and supersession inside the dispatch closure that issued
// them. A later run legitimately uses the existing appearance ledger instead.
export function issuedFrameActionsCode() {
  return observeCode(true).replace('return {tree,snapshot:page,contexts};',
    `const child=contexts.find(item=>item.selection.attributes.id==='frame-action-child');if(!child)throw new Error('Missing actual child target');const withinRef=await snapshot({withinRef:child.ref,interactiveOnly:true,maxNodes:120});const scopedTarget=withinRef.nodes.find(node=>node.role==='button'&&node.name===${quoted(actionName)});if(!scopedTarget)throw new Error('Missing scoped issued ref');await click(scopedTarget.ref);let supersededError='';try{await click(child.ref)}catch(error){supersededError=error.message}if(!supersededError)throw new Error('Superseded ref was accepted');return {tree,snapshot:page,contexts,withinRef,supersededError};`)
}

export function navigatedFrameActionCode() {
  const navigate = `new Promise((resolve,reject)=>{const frame=document.querySelector('iframe[title="Same-process document"]');if(!frame)return reject(new Error('Missing actual child document'));frame.addEventListener('load',()=>resolve({identity:frame.contentWindow.frameIdentity}),{once:true});frame.contentWindow.location.replace('/frame-child?generation=2')})`
  return `const page=await snapshot({scope:'page',maxNodes:120});let child;for(const target of page.nodes.filter(node=>node.role==='button'&&node.name===${quoted(actionName)})){const selection=await elementContext(target.ref);if(selection.attributes.id==='frame-action-child')child=target}if(!child)throw new Error('Missing actual child ref');await js(${quoted(navigate)});await click(child.ref);`
}

async function frameFacts(ctx) {
  return await ctx.probe.main.evaluate(`(async()=>{const {webContents}=process.getBuiltinModule('module').createRequire(${quoted(ctx.desktopRoot + '/package.json')})('electron');const pages=webContents.getAllWebContents().filter(page=>!page.isDestroyed()&&page.getURL()===${quoted(ctx.pageUrl)});if(pages.length!==1)throw new Error('The original native Browser is missing or ambiguous');return await Promise.all(pages[0].mainFrame.framesInSubtree.map(async frame=>({url:frame.url,processId:frame.processId,frameTreeNodeId:frame.frameTreeNodeId,...await frame.executeJavaScript('({document:globalThis.frameDocument,identity:globalThis.frameIdentity,actions:globalThis.frameActions})')})));})()`)
}
async function ready(ctx, count = 5) {
  return await ctx.waitFor('all real fixture documents loaded', async () => {
    const facts = await frameFacts(ctx)
    return facts.length === count && facts.filter(fact => typeof fact.identity === 'string' && typeof fact.actions === 'number').length === count ? facts : null
  })
}
function counters(facts) {
  assert.ok(facts.length >= 5)
  const relevant = facts.filter(fact => frameDocuments.includes(fact.document))
  assert.deepEqual(relevant.map(fact => fact.document).sort(), [...frameDocuments].sort())
  return Object.fromEntries(relevant.map(fact => [fact.document, fact.actions]))
}
const history = async ctx => {
  const reply = await ctx.requestControl({ operation: 'browser.history', browserId: ctx.browserId })
  assert.equal(reply.ok, true); assert.equal(reply.operation, 'browser.history')
  assert.ok(reply.result.operations.length > 0)
  return reply.result.operations
}
async function readSnapshotEvidence(ctx, operation) {
  const before = (await history(ctx)).map(item => item.id).sort(), step = operation.steps.find(item => item.method === 'snapshot')
  assert.ok(step && step.evidence?.length > 0)
  const read = await ctx.probe.cdp.evaluate(`window.agentmux.browser.getStepEvidence(${quoted(operation.id)},${step.sequence})`)
  assert.equal(read.status, 'available'); assert.equal(read.sequence, step.sequence); assert.equal(read.operationId, operation.id)
  const pages = read.items.filter(item => item.content.kind === 'page'); assert.equal(pages.length, 1)
  const item = pages[0]
  assert.deepEqual(item.reference, step.evidence.find(reference => reference.id === item.reference.id))
  assert.equal(item.reference.browserId, ctx.browserId); assert.equal(item.reference.operationId, operation.id)
  assert.equal(item.reference.sequence, step.sequence); assert.ok(item.reference.navigationId)
  assert.ok(item.content.text.includes(actionName))
  assert.deepEqual((await history(ctx)).map(item => item.id).sort(), before, 'Retained evidence reads cannot start another producer')
  return { sequence: step.sequence, reference: item.reference, sha256: digest(item.content.text) }
}
function owned(ctx, selector) {
  return `${ctx.selectors(selector)}.filter(element=>element.closest('.browser-surface')?.querySelector('[aria-label="Browser address"]')?.value.split('#')[0]===${quoted(ctx.pageUrl)})`
}
async function selectEvidence(ctx, operation, sequence) {
  if (!await ctx.probe.cdp.evaluate(`Boolean(document.querySelector('.browser-rsi-timeline'))`)) {
    await ctx.click(ctx.probe.cdp, owned(ctx, '.browser-operation-status__trigger'))
    await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Open browser activity timeline"]'))
  }
  const timestamp = new Date(operation.startedAt).toISOString()
  await ctx.click(ctx.probe.cdp, `${owned(ctx, '.browser-rsi-history__item')}.filter(element=>element.querySelector('time')?.dateTime===${quoted(timestamp)})`)
  await ctx.waitFor('the original frame observation selected in the real timeline', () => ctx.probe.cdp.evaluate(`Boolean(document.querySelector('.browser-rsi-timeline[data-operation-id="${operation.id}"]'))`))
  await ctx.click(ctx.probe.cdp, owned(ctx, `.browser-rsi-timeline__step[data-sequence="${sequence}"] button`))
  await ctx.waitFor('nonempty recorded frame evidence in the original Renderer', () => ctx.probe.cdp.evaluate(`document.querySelector('.browser-step-evidence pre')?.textContent.includes(${quoted(actionName)})`))
}
async function captureEvidence(ctx, operation, sequence, suffix) {
  await selectEvidence(ctx, operation, sequence)
  for (const [size, width, height] of [['normal', 1440, 900], ['narrow', 980, 700], ['short', 1440, 560]]) {
    await ctx.resize(ctx.probe, width, height); await ctx.capture(ctx.probe, `${size}-frames-recorded-${suffix}`, 'operations', ctx.pageUrl)
  }
  await ctx.resize(ctx.probe, 1440, 900)
  await ctx.click(ctx.probe.cdp, owned(ctx, '[aria-label="Close browser activity timeline"]'))
}

export async function reviewFrameObservation(ctx) {
  ctx.setPhase('frames-public-native-document-provenance')
  const facts = ctx.receipt.frames = { complete: false, operations: [], physicalDeviceTested: false,
    scope: 'Public SuccessReceipt → actual snapshot/ref/elementContext/action owner; original native frames and ordinary canonical restart' }
  const initial = await ready(ctx); assert.deepEqual(counters(initial), { main: 0, child: 0, nested: 0, remote: 0, 'remote-child': 0 })
  const first = await run(ctx, issuedFrameActionsCode()), joined = auditFrameObservation({ ...first.result, nativeDocuments: await frameFacts(ctx) }, ctx.pageUrl)
  facts.first = first; facts.joined = joined; facts.initial = initial
  facts.afterActions = await frameFacts(ctx); assert.deepEqual(counters(facts.afterActions), { main: 1, child: 2, nested: 1, remote: 1, 'remote-child': 1 })
  auditScopedFrame(first.result.withinRef, joined, 'child', 'subtree'); auditCaughtFrameAction(first)
  facts.withinRef = first.result.withinRef; facts.superseded = first.result.supersededError
  const css = await run(ctx, `const page=await snapshot({within:'#frame-main-zone',interactiveOnly:true,maxNodes:120});await click(page.nodes[0].ref);return page;`)
  auditScopedFrame(css.result, joined, 'main', 'subtree'); assert.equal(css.result.observation.scope.within, '#frame-main-zone'); facts.css = css
  const viewport = await run(ctx, `return await snapshot({scope:'viewport',interactiveOnly:true,maxNodes:120});`)
  auditScopedFrame(viewport.result, joined, 'main', 'viewport'); facts.viewport = viewport
  const clipped = await run(ctx, `return await snapshot({scope:'page',interactiveOnly:true,maxNodes:1});`)
  assert.equal(clipped.result.nodes.length, 1); assert.equal(clipped.result.observation.truncated, true)
  assert.ok(clipped.result.observation.matched >= 5); assert.deepEqual(clipped.result.missingFrames, [])
  assert.deepEqual(clipped.result.observation.omittedFrames, []); assert.equal(clipped.result.observation.work.axTrees, 5); facts.clipped = clipped
  // Issue and reject the old child ref inside one live dispatch closure. The
  // real load event is awaited before resolution; no cross-run ledger healing.
  const oldDocuments = await frameFacts(ctx), navigated = await run(ctx, navigatedFrameActionCode(), false)
  auditRejectedFrameAction(navigated)
  const newDocuments = await ready(ctx)
  assert.notEqual(newDocuments.find(item => item.document === 'child').identity, oldDocuments.find(item => item.document === 'child').identity)
  assert.deepEqual(counters(newDocuments), { main: 2, child: 0, nested: 0, remote: 1, 'remote-child': 1 })
  facts.navigationRejected = navigated
  // A bounded real page with more than the production document budget proves a
  // missing read differs from scope exclusion and output truncation. No CDP fake.
  await ctx.nativePageScript(ctx.probe, `(()=>{for(let index=0;index<128;index++){const frame=document.createElement('iframe');frame.dataset.budget='true';frame.src='/frame-budget?id='+index;document.body.append(frame)}return null})()`, ctx.pageUrl)
  const many = await ready(ctx, 133)
  const partial = await run(ctx, `return await snapshot({scope:'page',interactiveOnly:true,maxNodes:1000});`)
  assert.ok(partial.result.nodes.length > 0); assert.ok(partial.result.missingFrames.length > 0)
  assert.ok(partial.result.missingFrames.some(item => /budget|not observed/i.test(item.reason)))
  assert.deepEqual(partial.result.observation.omittedFrames, []); assert.equal(partial.result.observation.truncated, false)
  assert.ok(partial.result.observation.work.axTrees > 0 && partial.result.observation.work.axTrees < many.length)
  facts.partial = { report: partial, actualDocuments: many.length }
  await ctx.nativePageScript(ctx.probe, `document.querySelectorAll('iframe[data-budget]').forEach(frame=>frame.remove());null`, ctx.pageUrl)
  await ready(ctx)
  facts.healthyAfterPartial = await run(ctx, 'return await pageInfo();')
  const current = await run(ctx, observeCode(false)), currentJoined = auditFrameObservation({ ...current.result, nativeDocuments: await frameFacts(ctx) }, ctx.pageUrl)
  facts.restartOldRef = currentJoined.find(item => item.document === 'main').ref
  facts.liveRefBeforeRestart = await run(ctx, `return await elementContext(${quoted(facts.restartOldRef)});`, false)
  auditRestoredFrameRead(facts.liveRefBeforeRestart, ctx.pageUrl)
  facts.evidence = await readSnapshotEvidence(ctx, first.runOperation)
  await captureEvidence(ctx, first.runOperation, facts.evidence.sequence, 'first')
  facts.beforeRestart = await frameFacts(ctx)
}

export async function recoverFrameObservation(ctx) {
  ctx.setPhase('frames-ordinary-second-process-no-action-replay')
  const facts = ctx.receipt.frames, restored = await ready(ctx)
  assert.deepEqual(counters(restored), { main: 0, child: 0, nested: 0, remote: 0, 'remote-child': 0 })
  for (const previous of facts.beforeRestart) assert.notEqual(restored.find(item => item.document === previous.document).identity, previous.identity)
  const retained = await history(ctx)
  for (const operation of facts.operations) assert.ok(retained.some(item => item.id === operation.id && item.browserId === ctx.browserId))
  const evidence = await readSnapshotEvidence(ctx, facts.first.runOperation); assert.deepEqual(evidence, facts.evidence)
  const restoredRead = await run(ctx, `return await elementContext(${quoted(facts.restartOldRef)});`, false)
  auditRestoredFrameRead(restoredRead, ctx.pageUrl); assert.deepEqual(counters(await frameFacts(ctx)), counters(restored))
  const fresh = await run(ctx, observeCode(false)); facts.restoredJoined = auditFrameObservation({ ...fresh.result, nativeDocuments: await frameFacts(ctx) }, ctx.pageUrl)
  assert.deepEqual(counters(await frameFacts(ctx)), counters(restored), 'Fresh observations cannot replay original actions')
  await captureEvidence(ctx, facts.first.runOperation, evidence.sequence, 'restored')
  facts.restored = restored; facts.oldRefAfterRestart = restoredRead; facts.freshAfterRestart = fresh
  facts.sameEvidenceAfterRestart = true; facts.noActionReplay = true; facts.complete = true
}
