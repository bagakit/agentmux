import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { native } from './browser-demonstration-probe-scenario.mjs'

// Scenario hooks only. The canonical private harness owns launch, workbench,
// ordinary quit/restart, captures, source identity and cleanup.
const quoted = JSON.stringify
const surface = '.browser-outcome-criteria'
const field = { key: 'result', type: 'number', source: { selector: '#verified-number', read: 'text' } }
const criterion = { kind: 'field-equals', key: 'result', expected: 0 }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function outcomeFixture(_path) {
  return '<section aria-label="Verification fields"><p>Number <span id="verified-number">0</span></p>' +
    '<label>Unchecked flag<input id="verified-boolean" type="checkbox"></label><p>Empty text <span id="verified-text"></span></p></section>' +
    '<button id="verified-action">Count page action</button><script>globalThis.outcomePageActions=0;globalThis.outcomeDocumentIdentity=crypto.randomUUID();globalThis.demoTrusted={click:0,input:0};' +
    'for(const type of ["click","input"])document.addEventListener(type,event=>{if(event.isTrusted){globalThis.demoTrusted[type]++;globalThis.demoTrusted.lastTarget=event.target.id}},true);' +
    'document.querySelector("#verified-action").addEventListener("click",()=>globalThis.outcomePageActions++);</script>'
}

const history = ctx => ctx.probe.cdp.evaluate('window.agentmux.browser.listOperationHistory()')
const operation = (ctx, id) => ctx.probe.cdp.evaluate(`window.agentmux.browser.getOperation(${quoted(id)})`)
async function ids(ctx) { return (await history(ctx)).filter(item => item.browserId === ctx.browserId).map(item => item.id).sort() }
function owned(ctx, selector) {
  return `${ctx.selectors(selector)}.filter(element=>element.closest('.browser-surface')?.querySelector('[aria-label="Browser address"]')?.value.split('#')[0]===${quoted(ctx.pageUrl)})`
}
const within = (ctx, selector) => `(${owned(ctx, surface)}).flatMap(root=>Array.from(root.querySelectorAll(${quoted(selector)})))`
const button = (ctx, label) => `${within(ctx, 'button')}.filter(element=>element.textContent.trim()===${quoted(label)})`
const labelControl = (ctx, label) => `${within(ctx, 'label')}.filter(element=>element.firstChild?.textContent.trim()===${quoted(label)}).map(element=>element.querySelector('input,select'))`
const key = async (ctx, key, code, windowsVirtualKeyCode) => {
  for (const type of ['keyDown', 'keyUp']) await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
}

async function open(ctx) {
  if (!await ctx.probe.cdp.evaluate(`(${owned(ctx, surface)}).length===1`)) {
    await ctx.click(ctx.probe.cdp, owned(ctx, '[aria-label="More browser tools"]'))
    await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Open human demonstration draft"]'))
  }
  await ctx.waitFor('the actual Browser completion condition in its existing activity rail', () => ctx.probe.cdp.evaluate(`(${owned(ctx, surface)}).length===1`))
  if (!await ctx.probe.cdp.evaluate(`(${owned(ctx, surface)})[0].open`)) await ctx.click(ctx.probe.cdp, within(ctx, ':scope > summary'))
}

async function type(ctx, label, value) {
  const expression = labelControl(ctx, label)
  await ctx.click(ctx.probe.cdp, expression)
  await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] })
  await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
  if (value) await ctx.probe.cdp.call('Input.insertText', { text: value })
  else await key(ctx, 'Backspace', 'Backspace', 8)
  assert.equal(await ctx.probe.cdp.evaluate(`(${expression})[0].value`), value)
}

export async function numberCondition(ctx) {
  await type(ctx, 'CSS selector', '#verified-number')
  // Native menus may keep the highlighted choice pending until Enter. Use one
  // arrow and one explicit commit; never assign its value/focus or retry senders.
  await key(ctx, 'Tab', 'Tab', 9)
  const expression = labelControl(ctx, 'Value type')
  const read = () => ctx.probe.cdp.evaluate(`(()=>{const controls=${expression};if(controls.length!==1)throw new Error('The actual type selector is missing');const target=controls[0];return {value:target.value,focused:document.activeElement===target,optionCount:target.options.length,selected:Array.from(target.selectedOptions).map(option=>option.value)}})()`)
  const observed = { before: await read() }
  ;(ctx.receipt.browserOutcome.numberSelections ??= []).push(observed)
  assert.equal(observed.before.focused, true)
  assert.equal(observed.before.optionCount, 3)
  const before = observed.before.value
  if (before === 'boolean') await key(ctx, 'ArrowUp', 'ArrowUp', 38)
  else if (before === 'string') await key(ctx, 'ArrowDown', 'ArrowDown', 40)
  else assert.equal(before, 'number')
  observed.afterArrow = await read()
  if (before !== 'number') await key(ctx, 'Enter', 'Enter', 13)
  observed.afterCommit = await read()
  assert.equal(observed.afterCommit.value, 'number', 'Actual keyboard input commits the numeric type')
  await type(ctx, 'Equals', '0')
}

async function syntheticClick(ctx, label) {
  const observation = await ctx.probe.cdp.evaluate(`(async()=>{const matches=${button(ctx, label)};if(matches.length!==1)throw new Error('The actual verification action is missing');const target=matches[0];if(target.disabled)throw new Error('A disabled action cannot prove its trust guard');let trusted=null;const listener=event=>{trusted=event.isTrusted};target.addEventListener('click',listener,{once:true});try{target.click();await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));return {label:${quoted(label)},trusted,disabled:target.disabled}}finally{target.removeEventListener('click',listener)}})()`)
  assert.equal(observation.trusted, false, 'The counterexample must really be an untrusted DOM click')
  await ctx.waitFor('the synthetic action has settled in the original UI', () => ctx.probe.cdp.evaluate(`(${button(ctx, label)}).length===1&&(${button(ctx, label)})[0].disabled===false`))
  return observation
}

/** Audits the Main DTO; public completion does not contain producer declarations. */
export function auditFieldOperation(value, browserId, expectedStatus) {
  assert.ok(value && value.id, 'The actual operation must be nonempty')
  assert.equal(value.browserId, browserId)
  assert.equal(value.phase, 'completed', 'Script termination is distinct from the completion condition')
  assert.deepEqual(value.steps.map(step => [step.sequence, step.method, step.status]), [[1, 'extractStructured', 'completed']])
  const registered = value.outcome?.registration, evaluation = value.outcome?.evaluation
  assert.ok(registered && evaluation, 'Main retains both the prior declaration and its actual result')
  assert.equal(registered.context.browserId, browserId); assert.equal(registered.context.operationId, value.id)
  assert.ok(registered.context.workspaceId && registered.context.navigationId)
  assert.deepEqual(registered.criteria, [{ ...criterion, producer: { operationId: value.id,
    navigationId: registered.context.navigationId, sequence: 1, request: { fields: [field] } } }])
  assert.deepEqual(evaluation.context, registered.context)
  assert.equal(evaluation.status, expectedStatus)
  assert.equal(evaluation.conditions.length, 1)
  assert.deepEqual(evaluation.conditions[0].criterion, criterion)
  assert.equal(evaluation.conditions[0].status, expectedStatus)
  assert.ok(evaluation.conditions[0].reason.length > 0)
  return evaluation
}

/** Both public reads must expose the same facts, without raw Main provenance. */
export function auditPublicCompletion(value, actual) {
  assert.ok(value, 'The public operation cannot disappear at the projection boundary')
  assert.equal(value.id, actual.id); assert.equal(value.browserId, actual.browserId)
  assert.deepEqual(value.completion, actual.outcome.evaluation, 'Core public completion must match the actual Main result')
  assert.equal(Object.hasOwn(value, 'outcome'), false, 'Producer declarations stay in the Main DTO')
}
export async function publicFacts(ctx, actual) {
  assert.equal(typeof ctx.requestControl, 'function', 'The canonical context must expose its existing public control socket')
  const listed = await ctx.requestControl({ operation: 'browser.history', browserId: ctx.browserId })
  assert.equal(listed.operation, 'browser.history'); assert.equal(listed.ok, true)
  const operations = listed.result.operations
  assert.ok(Array.isArray(operations) && operations.length > 0, 'Public history must retain operations in the SuccessReceipt result')
  auditPublicCompletion(operations.find(item => item.id === actual.id), actual)
  const read = await ctx.requestControl({ operation: 'browser.operation', operationId: actual.id })
  assert.equal(read.operation, 'browser.operation'); assert.equal(read.ok, true)
  auditPublicCompletion(read.result.runOperation, actual)
  return { history: operations.find(item => item.id === actual.id), operation: read.result.runOperation }
}

/** Consume the original T003 bytes. This path never executes browser.run. */
export async function readRecordedOutcome(ctx, actual) {
  const before = await ids(ctx)
  const evidence = await ctx.probe.cdp.evaluate(`window.agentmux.browser.getStepEvidence(${quoted(actual.id)},1)`)
  assert.equal(evidence.status, 'available'); assert.equal(evidence.operationId, actual.id); assert.equal(evidence.sequence, 1)
  const entries = evidence.items.filter(item => item.content.kind === 'structured-output')
  assert.equal(entries.length, 1, 'The completed producer must retain exactly one real extraction')
  const item = entries[0], receipt = item.content.receipt, artifact = receipt.artifact
  assert.deepEqual(actual.steps[0].evidence.find(reference => reference.id === item.reference.id), item.reference)
  assert.equal(receipt.kind, 'browser-structured-output'); assert.equal(receipt.status, 'complete')
  assert.equal(receipt.artifactStatus, 'available'); assert.ok(artifact && artifact.byteLength > 0)
  assert.equal(artifact.operationId, actual.id); assert.equal(artifact.browserId, ctx.browserId)
  assert.equal(artifact.navigationId, actual.outcome.registration.context.navigationId)
  assert.equal(receipt.source.operationId, actual.id); assert.equal(receipt.source.browserId, ctx.browserId)
  assert.equal(receipt.source.navigationId, artifact.navigationId); assert.ok(receipt.source.document)
  assert.equal(receipt.source.url, ctx.pageUrl); assert.equal(receipt.source.documentUrl, ctx.pageUrl)
  assert.deepEqual(receipt.fields.map(value => [value.key, value.status, value.inline, value.value]), [['result', 'observed', true, 0]])
  assert.ok(receipt.work.reads > 0 && receipt.work.visitedElements > 0)
  const parts = [], chunks = []
  let offset = 0
  while (offset < artifact.byteLength) {
    const chunk = await ctx.probe.cdp.evaluate(`window.agentmux.browser.readStepResult(${quoted(actual.id)},1,${quoted({ offset, maxBytes: 65_536 })})`)
    const bytes = Buffer.from(chunk.data, 'base64'), end = offset + bytes.length
    assert.deepEqual(chunk.reference, artifact); assert.equal(chunk.encoding, 'base64')
    assert.equal(chunk.offset, offset); assert.equal(chunk.totalBytes, artifact.byteLength)
    assert.equal(chunk.returnedBytes, bytes.length); assert.ok(bytes.length > 0 && bytes.length <= 65_536)
    assert.equal(bytes.toString('base64'), chunk.data); assert.ok(end <= artifact.byteLength)
    assert.equal(chunk.nextOffset, end === artifact.byteLength ? null : end)
    parts.push(bytes); chunks.push({ offset, returnedBytes: bytes.length, nextOffset: chunk.nextOffset }); offset = end
  }
  assert.ok(parts.length > 0)
  const bytes = Buffer.concat(parts), document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  assert.equal(bytes.length, artifact.byteLength)
  assert.equal(document.schema, 'browser-structured-output.v1')
  assert.deepEqual(document.source, receipt.source); assert.deepEqual(document.request, { fields: [field] })
  assert.deepEqual(document.fields.map(value => [value.key, value.status, value.value]), [['result', 'observed', 0]])
  assert.deepEqual(await ids(ctx), before, 'Reading the saved bytes cannot start another producer')
  return { artifact, source: receipt.source, byteLength: bytes.length, sha256: digest(bytes), chunks, document }
}

async function selectRecorded(ctx, actual) {
  await open(ctx)
  const timestamp = new Date(actual.startedAt).toISOString()
  await ctx.click(ctx.probe.cdp, `${owned(ctx, '.browser-rsi-history__item')}.filter(element=>element.querySelector('time')?.dateTime===${quoted(timestamp)})`)
  await ctx.waitFor('the retained operation selected through actual history', () => ctx.probe.cdp.evaluate(`Boolean(document.querySelector('.browser-rsi-timeline[data-operation-id="${actual.id}"]'))`))
}
async function projection(ctx, status, historical) {
  const label = status === 'passed' ? 'Satisfied' : 'Verification unavailable'
  const facts = await ctx.waitFor('the original completion result visible in the actual condition', () => ctx.probe.cdp.evaluate(`(()=>{const roots=${owned(ctx, surface)};if(roots.length!==1)return null;const root=roots[0],summary=root.querySelector(':scope > summary'),text=summary.textContent;return text===${quoted((historical ? 'Recorded check' : 'Completion condition') + ' · ' + label)}?{summary:text,open:root.open,text:root.innerText,verify:Array.from(root.querySelectorAll('button')).some(element=>element.textContent==='Verify recorded evidence'&&!element.disabled)}:null})()`))
  assert.equal(facts.open, true); assert.equal(facts.verify, true)
  assert.ok(facts.text.includes(label))
  if (historical) assert.match(facts.text, /earlier operation or document/)
  return facts
}
async function verify(ctx, actual, status) {
  const before = await ids(ctx), steps = actual.steps, registration = actual.outcome.registration
  await ctx.click(ctx.probe.cdp, button(ctx, 'Verify recorded evidence'))
  await ctx.waitFor('the trusted readonly action settled in its original control', () => ctx.probe.cdp.evaluate(`(async()=>{await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));const targets=${button(ctx, 'Verify recorded evidence')};return targets.length===1&&targets[0].disabled===false})()`))
  const checked = await ctx.waitFor('the actual Main readonly result', async () => {
    const value = await operation(ctx, actual.id)
    return value?.outcome?.evaluation?.status === status ? value : null
  })
  auditFieldOperation(checked, ctx.browserId, status)
  assert.deepEqual(checked.steps, steps); assert.deepEqual(checked.outcome.registration, registration)
  assert.deepEqual(await ids(ctx), before, 'Readonly verification cannot rerun the extraction producer')
  return checked
}

export async function reviewBrowserOutcome(ctx) {
  ctx.setPhase('outcome-trusted-field-first-ui')
  const observed = ctx.receipt.browserOutcome = { complete: false, physicalDeviceTested: false,
    scope: 'Trusted Renderer UI → original Main declaration/extraction/Journal/T003 bytes → public Core completion; no Store seed or API replacement' }
  await open(ctx)
  assert.equal(await ctx.probe.cdp.evaluate(`(${owned(ctx, surface)})[0].querySelector(':scope > summary').textContent`), 'Completion condition')
  const fixture = await ctx.nativePageScript(ctx.probe, '({url:location.href,identity:globalThis.outcomeDocumentIdentity,number:document.querySelector("#verified-number").textContent,flag:document.querySelector("#verified-boolean").checked,text:document.querySelector("#verified-text").textContent,actions:globalThis.outcomePageActions})')
  assert.ok(typeof fixture.identity === 'string' && fixture.identity.length > 0)
  const { identity, ...values } = fixture
  assert.deepEqual(values, { url: ctx.pageUrl, number: '0', flag: false, text: '', actions: 0 })
  observed.initialDocument = fixture
  await numberCondition(ctx)
  const before = await ids(ctx)
  observed.syntheticCheck = await syntheticClick(ctx, 'Check current field')
  assert.deepEqual(await ids(ctx), before, 'Untrusted Check cannot trigger the extraction producer')
  await ctx.click(ctx.probe.cdp, button(ctx, 'Check current field'))
  const saved = await ctx.waitFor('Main registered the actual UI field condition before its one producer', async () => {
    const candidates = (await history(ctx)).filter(item => item.browserId === ctx.browserId && !before.includes(item.id))
    assert.ok(candidates.length <= 1, 'One Check action must have one original producer')
    return candidates[0]?.outcome?.evaluation ? candidates[0] : null
  })
  auditFieldOperation(saved, ctx.browserId, 'passed')
  assert.deepEqual(await ids(ctx), [...before, saved.id].sort())
  observed.initial = saved; observed.publicInitial = await publicFacts(ctx, saved)
  observed.recordedResult = await readRecordedOutcome(ctx, saved)
  observed.projection = await projection(ctx, 'passed', false)
  for (const [size, width, height] of [['normal', 1440, 900], ['narrow', 1000, 720], ['short', 1000, 660]]) {
    await ctx.resize(ctx.probe, width, height)
    await ctx.probe.cdp.evaluate(`(${owned(ctx, surface)})[0].querySelector(':scope > summary').scrollIntoView({block:'start'});null`)
    await ctx.capture(ctx.probe, `${size}-browser-completion-condition`, 'operations')
  }
  await ctx.resize(ctx.probe, 1440, 900)
  observed.syntheticVerify = await syntheticClick(ctx, 'Verify recorded evidence')
  assert.deepEqual(await operation(ctx, saved.id), saved)
  assert.deepEqual(await ids(ctx), [...before, saved.id].sort())
  observed.sameDocument = await verify(ctx, saved, 'passed')
  // A real reload creates a different document with the same URL AND the same
  // satisfying value. A document.write rewrite is still the same Document.
  ctx.setPhase('outcome-same-url-new-document-readonly-check')
  if (await ctx.probe.cdp.evaluate(`(${owned(ctx, '[aria-label="Reload"]')}).length===1`)) {
    await ctx.click(ctx.probe.cdp, owned(ctx, '[aria-label="Reload"]'))
  } else {
    await ctx.click(ctx.probe.cdp, owned(ctx, '[aria-label="More browser tools"]'))
    await ctx.click(ctx.probe.cdp, `${ctx.selectors('[role="menuitem"]')}.filter(element=>element.textContent.trim()==='Reload page')`)
  }
  observed.reloadedDocument = await ctx.waitFor('the real same-URL replacement document loaded', () => ctx.nativePageScript(ctx.probe, `document.readyState==='complete'&&location.href===${quoted(ctx.pageUrl)}&&document.querySelector('#verified-number')?.textContent==='0'&&globalThis.outcomeDocumentIdentity!==${quoted(identity)}?{url:location.href,identity:globalThis.outcomeDocumentIdentity,value:document.querySelector('#verified-number').textContent}:null`).catch(error => {
    observed.reloadObservationErrors ??= []
    if (observed.reloadObservationErrors.length < 32) observed.reloadObservationErrors.push(String(error))
    return null
  }))
  assert.equal(observed.reloadedDocument.url, ctx.pageUrl); assert.equal(observed.reloadedDocument.value, '0')
  assert.notEqual(observed.reloadedDocument.identity, identity)
  await selectRecorded(ctx, saved)
  observed.changedDocument = await verify(ctx, saved, 'unavailable')
  observed.publicChangedDocument = await publicFacts(ctx, observed.changedDocument)
  const retained = await readRecordedOutcome(ctx, observed.changedDocument)
  assert.deepEqual(retained, observed.recordedResult, 'Unavailable live identity cannot rewrite the original saved bytes')
  observed.pageInput = await native(ctx, '#verified-action')
  assert.equal(await ctx.nativePageScript(ctx.probe, 'globalThis.outcomePageActions'), 1)
  observed.beforeRestart = await operation(ctx, saved.id); observed.operationsBeforeRestart = await ids(ctx)
}

export async function recoverBrowserOutcome(ctx) {
  ctx.setPhase('outcome-recorded-condition-after-ordinary-restart')
  const observed = ctx.receipt.browserOutcome, saved = observed.beforeRestart
  assert.deepEqual(await ids(ctx), observed.operationsBeforeRestart)
  const restored = await operation(ctx, saved.id)
  assert.deepEqual(restored, saved, 'Ordinary restart retains the exact declaration and recorded result')
  auditFieldOperation(restored, ctx.browserId, 'unavailable')
  await selectRecorded(ctx, restored)
  observed.restoredProjection = await projection(ctx, 'unavailable', true)
  observed.publicRestored = await publicFacts(ctx, restored)
  const bytes = await readRecordedOutcome(ctx, restored)
  assert.deepEqual(bytes, observed.recordedResult, 'The original artifact survives restart without another observation')
  observed.restoredVerified = await verify(ctx, restored, 'unavailable')
  await numberCondition(ctx)
  observed.syntheticCheckAfterRestart = await syntheticClick(ctx, 'Check current field')
  observed.syntheticVerifyAfterRestart = await syntheticClick(ctx, 'Verify recorded evidence')
  assert.deepEqual(await ids(ctx), observed.operationsBeforeRestart)
  assert.deepEqual((await operation(ctx, restored.id)).outcome.registration, restored.outcome.registration)
  observed.restoredPageInput = await native(ctx, '#verified-action')
  assert.equal(await ctx.nativePageScript(ctx.probe, 'globalThis.outcomePageActions'), 1)
  observed.restoredProjection = await projection(ctx, 'unavailable', true)
  await ctx.nativeFrameReady(ctx.pageUrl)
  await ctx.capture(ctx.probe, 'normal-browser-recorded-condition-after-ordinary-restart', 'operations')
  observed.publicFinal = await publicFacts(ctx, await operation(ctx, restored.id))
  observed.complete = true
}
