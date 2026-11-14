import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { native } from './browser-demonstration-probe-scenario.mjs'

// Scenario only. The original recovery harness owns App launch, socket, geometry,
// ordinary quit, exact private process cleanup and the original userData.
const q = JSON.stringify, sha = bytes => createHash('sha256').update(bytes).digest('hex')
const editor = '[aria-label="Editable Browser task asset"]'
const button = (ctx, name) => `${ctx.selectors(editor + ' button')}.filter(e=>e.textContent.trim()===${q(name)})`
const state = ctx => ctx.probe.cdp.evaluate(`window.agentmux.browser.getTaskAssets(${q(ctx.browserId)})`)
const longText = '任务数据🌿é'.repeat(600)

const expectedFirst = { number: 0, flag: false, empty: '', long: longText, ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['long' + (i + 2), longText])) }

// Native contents are observed from the exact private Main, never from a title or
// saved display row. This read does not attach CDP to or restore the website.
async function contentsFor(ctx, url) {
  return ctx.probe.main.evaluate(`(()=>{const{webContents}=process.getBuiltinModule('module').createRequire(${q(join(ctx.desktopRoot, 'package.json'))})('electron');return webContents.getAllWebContents().filter(c=>!c.isDestroyed()&&c.getURL()===${q(url)}).map(c=>c.id).sort((a,b)=>a-b)})()`)
}

export function handleTaskDataRequest(request, response, receipt) {
  const path = new URL(request.url, 'http://fixture.invalid').pathname
  const counts = receipt.taskDataRequests ??= { pages: [], actions: [], downloads: 0 }
  if (path === '/task-action') {
    counts.actions.push({ path, at: Date.now() }); response.writeHead(200); response.end('recorded'); return true
  }
  if (path === '/task-data.bin') {
    counts.downloads++; response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="task-data.bin"' }); response.end('original task data file'); return true
  }
  if (!['/a', '/b', '/private'].includes(path)) return false
  counts.pages.push(path)
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html><meta charset="utf-8"><title>Task data ${path}</title><h1>Recorded task data</h1><button id="produce">Produce once</button><label>Name<input id="private-input"></label><span id="number">${path === '/a' ? '0' : '7'}</span><input id="flag" type="checkbox"><span id="empty"></span><p id="long">${longText}</p><a id="download" download="task-data.bin" href="/task-data.bin">Get task file</a><script>globalThis.demoTrusted={click:0,input:0};globalThis.taskDataActions=0;for(const type of ['click','input'])document.addEventListener(type,e=>{if(e.isTrusted){globalThis.demoTrusted[type]++;globalThis.demoTrusted.lastTarget=e.target.id}},true);document.querySelector('#produce').onclick=()=>{globalThis.taskDataActions++;fetch('/task-action',{method:'POST'})};</script>`)
  return true
}

async function cli(ctx, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|ELECTRON_)/.test(key)))
  Object.assign(env, { HOME: ctx.privateHome, CODEX_HOME: join(ctx.privateHome, 'codex'), AGENTMUX_RPC_ENDPOINT: 'unix:' + join(ctx.runtimeDirectory, 'control.sock'), AGENTMUX_RUNTIME_DIRECTORY: ctx.runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(ctx.runtimeDirectory, 'state') })
  const value = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(ctx.coreRoot, 'dist/agentmux.js'), ...args], { cwd: ctx.workspacePath, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false, escalation
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1000) }, 25_000)
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation)
      try { assert.equal(expired, false); assert.equal(signal, null); assert.equal(code, 0, stderr || stdout); const row = JSON.parse(stdout); assert.equal(row.ok, true, stdout); done(row) } catch (error) { reject(error) }
    })
    child.stdin.end(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input))
  })
  ctx.receipt.taskData.cli.push({ args, operation: value.operation, result: value.result })
  return value.result
}
async function type(ctx, selector, value) {
  await ctx.click(ctx.probe.cdp, ctx.selectors(selector))
  await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] })
  await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
  await ctx.probe.cdp.call('Input.insertText', { text: value })
  assert.equal(await ctx.probe.cdp.evaluate(`(()=>{const e=document.querySelector(${q(selector)});return e.value??e.textContent})()`), value)
}
async function openEditor(ctx) {
  const surface = `[data-browser-surface=${q(ctx.browserId)}]`
  const visibleEditor = ctx.selectors(surface + ' ' + editor)
  if (await ctx.probe.cdp.evaluate(`(${visibleEditor}).length===1`)) return
  await ctx.click(ctx.probe.cdp, ctx.selectors(surface + ' [aria-label="More browser tools"]'))
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Open human demonstration draft"]'))
  // The initial demonstration has no asset yet; the reader can also live in the
  // original overlay portal rather than below its Browser surface in the DOM.
  await ctx.waitFor('the current Browser activity reader is visible', () => ctx.probe.cdp.evaluate(`(${ctx.selectors('[aria-label="Browser activity trace"]')}).length===1`))
}
async function waitAsset(ctx, id) { return ctx.waitFor('the exact original asset is projected', async () => (await state(ctx)).assets.find(a => a.id === id) ?? null) }
async function readFailureControlGeometry(ctx) {
  return ctx.probe.cdp.evaluate(`(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
    return Array.from(document.querySelectorAll(${q(editor + ' .browser-task-step-failure')})).filter(e=>e.checkVisibility()).map(group=>{
      const rail=group.closest('.browser-trace-rail'),bounds=rect(group),clip=rect(rail);
      return {stepId:group.closest('[data-task-step-id]')?.dataset.taskStepId,bounds,clip,display:getComputedStyle(group).display,
        inViewport:Math.max(0,clip.y,bounds.y)<Math.min(innerHeight,clip.bottom,bounds.bottom),
        fields:Array.from(group.children).map(label=>({columns:getComputedStyle(label).gridTemplateColumns,label:rect(label.querySelector('span')),select:rect(label.querySelector('select'))}))};
    });
  })()`)
}
function failureControlViolations(groups) {
  assert.ok(groups.length > 0 && groups.some(group => group.inViewport), 'The real editor must expose nonempty failure controls in its viewport')
  const failures = []
  for (const group of groups) {
    assert.equal(group.fields.length, 2)
    const boxes = group.fields.flatMap(field => [field.label, field.select])
    for (const box of boxes) {
      assert.ok(box.width > 0 && box.height > 0, 'Actual labels and selects need positive geometry')
      if (box.x < group.bounds.x - 1 || box.right > group.bounds.right + 1) failures.push({ stepId: group.stepId, kind: 'control-overflow' })
    }
    if (group.bounds.x < group.clip.x - 1 || group.bounds.right > group.clip.right + 1) failures.push({ stepId: group.stepId, kind: 'group-overflow' })
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      if (Math.min(boxes[i].right, boxes[j].right) - Math.max(boxes[i].x, boxes[j].x) > .5 &&
          Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].y, boxes[j].y) > .5) failures.push({ stepId: group.stepId, kind: 'overlap', pair: [i, j] })
    }
  }
  return failures
}
async function reviewFailureControlGeometry(ctx, label) {
  await ctx.probe.cdp.evaluate(`document.querySelector(${q(editor + ' .browser-task-step-failure')}).scrollIntoView({block:'nearest'});null`)
  const groups = await readFailureControlGeometry(ctx), observation = { label, groups }
  ;(ctx.receipt.taskData.currentFailureControlGeometry ??= []).push(observation)
  observation.violations = failureControlViolations(groups)
  assert.deepEqual(observation.violations, [])
  return groups
}
async function reviewFailureControlCssCounterexample(ctx, original) {
  original ??= await reviewFailureControlGeometry(ctx, 'css-counterexample-original')
  const id = 'task-data-original-failure-css-counterexample'
  // Restore only the previous failure grid and its original winning path rule.
  // !important lets those old declarations override the newly fixed specificity.
  const css = '.browser-task-step-failure{display:grid!important;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)!important}' +
    '.browser-task-step-failure>.browser-task-asset__field{grid-template-columns:auto minmax(0,1fr)!important}' +
    '.browser-task-asset li[data-task-has-path] .browser-task-step-failure>.browser-task-asset__field{grid-template-columns:32px minmax(0,1fr)!important}'
  let counterexample
  try {
    await ctx.probe.cdp.evaluate(`(()=>{if(document.getElementById(${q(id)}))throw new Error('CSS counterexample already exists');const s=document.createElement('style');s.id=${q(id)};s.textContent=${q(css)};document.head.append(s);})()`)
    counterexample = await readFailureControlGeometry(ctx)
    assert.ok(failureControlViolations(counterexample).length > 0, 'The original bad CSS must fail the actual label/select geometry oracle')
  } finally { await ctx.probe.cdp.evaluate(`document.getElementById(${q(id)})?.remove();null`) }
  const restored = await readFailureControlGeometry(ctx); assert.deepEqual(failureControlViolations(restored), [])
  ctx.receipt.taskData.failureControlGeometry = { original, cssCounterexample: { css, groups: counterexample, violations: failureControlViolations(counterexample) }, restored,
    scope: 'Same actual App CSS-only RED to restored GREEN; no task action, product source mutation or business replay.' }
}
async function recorded(ctx, runId) {
  const result = (await cli(ctx, ['browser', 'task', 'inspect', '--browser', ctx.browserId, '--run', runId])).inspection
  assert.ok(result, 'The exact original task inspection is retained')
  const completion = result.completions?.find(row => row.runId === runId)
  assert.ok(completion?.conditions.length > 0, 'Inspect must expose nonempty original recorded conditions')
  return { result, completion }
}
async function readArtifact(ctx, operationId, expected, privateValues = []) {
  const chunks = [], parts = []; let offset = 0, reference
  do {
    const result = await cli(ctx, ['browser', 'inspect', '--operation-id', operationId, '--step', '1', '--offset', String(offset), '--max-bytes', '65535'])
    const read = result.resultRead
    assert.equal(read?.status, 'available', JSON.stringify(read)); assert.equal(read.sequence, 1)
    const chunk = read.chunk; assert.ok(chunk)
    reference ??= chunk.reference; assert.deepEqual(chunk.reference, reference)
    assert.equal(chunk.offset, offset); const bytes = Buffer.from(chunk.data, 'base64')
    assert.equal(chunk.returnedBytes, bytes.length); assert.ok(bytes.length > 0 && bytes.length <= 65535)
    assert.equal(bytes.toString('base64'), chunk.data); parts.push(bytes)
    assert.ok(chunk.readCost?.metadataBytes > 0 && chunk.readCost.payloadBytes >= bytes.length, 'Read cost comes from the actual artifact owner, not the returned slice')
    chunks.push({ offset, returnedBytes: bytes.length, nextOffset: chunk.nextOffset, readCost: chunk.readCost })
    offset = chunk.nextOffset
  } while (offset !== null)
  const bytes = Buffer.concat(parts), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  for (const value of privateValues) assert.equal(text.includes(value), false, 'The original artifact cannot retain a known private invocation value')
  const document = JSON.parse(text)
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(document.fields.find(field => field.key === key)?.value, value, `Exact recorded ${key}`)
  assert.equal(reference.operationId, operationId)
  const files = ctx.receipt.taskData.artifactFiles ??= []
  if (!files.some(item => item.operationId === operationId)) {
    const file = join(ctx.receipt.visual.captureDirectory, `task-data-${operationId}.json`)
    await writeFile(file, bytes, { flag: 'wx' })
    files.push({ operationId, file, sha256: sha(bytes), byteLength: bytes.length })
  }
  return { reference, sha256: sha(bytes), bytes: bytes.length, chunks, fields: document.fields }
}
async function preserveDurable(ctx, label) {
  const files = ctx.receipt.taskData.durableFiles ??= []
  for (const name of ['browser-task-assets.json', 'browser-operation-journal.json']) {
    const bytes = await readFile(join(ctx.userData, name)), file = join(ctx.receipt.visual.captureDirectory, label + '-' + name)
    await writeFile(file, bytes, { flag: 'wx' })
    files.push({ label, owner: name, file, sha256: sha(bytes), byteLength: bytes.length })
  }
}
async function durablePrivacy(ctx, secret) {
  const files = ['browser-task-assets.json', 'browser-operation-journal.json']
  for (const name of files) {
    const text = await readFile(join(ctx.userData, name), 'utf8')
    assert.ok(text.length > 0)
    for (const spelling of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) assert.equal(text.includes(spelling), false, `${name}: private invocation escaped into durable metadata`)
  }
  return files
}

export async function prepareTaskDataPrivateCounterexamples(ctx, sdk, zone, mainAsset, mainRegion) {
  const url = new URL('/private', ctx.pageUrl).href
  const opened = await ctx.rpc.call('browser.open', { url, destination: { kind: 'new-tab', after: { kind: 'tab', tabId: mainRegion.tabId } } })
  const other = { ...ctx, browserId: opened.region.browserId, pageUrl: url }
  await ctx.rpc.call('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId: opened.region.regionId } })
  await ctx.nativeFrameReady(url)
  const bundle = (await cli(ctx, ['browser', 'task', 'export', '--browser', ctx.browserId, '--asset', mainAsset.id, '--expected-revision', String(mainAsset.revision), '--version', '1'])).bundle
  const intent = sdk.browserTaskImportInput(other.browserId, bundle)
  await cli(other, ['browser', 'task', 'import', '--browser', other.browserId, '--input', '-'], intent)
  let asset = await waitAsset(other, intent.assetId)
  const privateValue = 'private-invocation-' + randomUUID()
  const definition = { name: 'Reviewed private invocation data', url, parameters: [{ key: 'fresh', label: 'Private name', secret: true }], steps: [
    { id: 'fresh-input', kind: 'fill', url, target: { role: 'text input', name: 'Name', ordinal: 1, count: 1 }, parameterKey: 'fresh', reviewed: true },
    { id: 'safe-extract', kind: 'extract', url, reviewed: true, extraction: { fields: [{ key: 'number', type: 'number', source: { selector: '#number', read: 'text' } }] } }
  ], completion: { criteria: [{ kind: 'field-equals', stepId: 'safe-extract', key: 'number', expected: 7 }] } }
  const publish = async content => {
    await cli(other, ['browser', 'task', 'edit', '--browser', other.browserId, '--asset', asset.id, '--expected-revision', String(asset.revision), '--input', '-'], content)
    asset = await waitAsset(other, asset.id)
    await cli(other, ['browser', 'task', 'publish', '--browser', other.browserId, '--asset', asset.id, '--expected-revision', String(asset.revision)])
    asset = await waitAsset(other, asset.id)
    return asset.versions.at(-1).version
  }
  const invoke = async version => {
    const result = await cli(other, ['browser', 'task', 'run', '--browser', other.browserId, '--asset', asset.id, '--version', String(version), '--input', '-'], { parameters: { fresh: privateValue } })
    assert.ok(result.run?.id)
    return ctx.waitFor('the exact private invocation reaches a retained terminal result', async () => (await state(other)).runs.find(r => r.id === result.run.id && !['ready', 'running', 'waiting-human'].includes(r.status)) ?? null)
  }
  await publish(definition)
  await openEditor(other)
  await ctx.waitFor('the exact published private task asset is visible', () => ctx.probe.cdp.evaluate(`(${ctx.selectors('[data-task-asset-id=' + q(asset.id) + ']')}).length===1`))
  await type(other, editor + ' [aria-label="Task parameter Private name"]', privateValue)
  await ctx.click(ctx.probe.cdp, button(other, 'Run version'))
  const safe = await ctx.waitFor('the trusted first private task has a retained native result', async () => (await state(other)).runs.find(r => r.assetId === asset.id && !['ready', 'running', 'waiting-human'].includes(r.status)) ?? null)
  assert.equal(safe.status, 'completed')
  assert.equal(await ctx.nativePageScript(ctx.probe, 'document.querySelector("#private-input").value', url), privateValue, 'The real native task invocation applied the fresh private input')
  const safeFacts = await recorded(other, safe.id); assert.equal(safeFacts.completion.status, 'passed')
  const safeOperation = safe.stepExecutions.find(s => s.stepId === 'safe-extract').operationId
  const safeArtifact = await readArtifact(other, safeOperation, { number: 7 }, [privateValue])
  const fillOperation = safe.stepExecutions.find(s => s.stepId === 'fresh-input').operationId
  const fillEvidence = await other.probe.cdp.evaluate(`window.agentmux.browser.getStepEvidence(${q(fillOperation)},1)`)
  assert.equal(fillEvidence.items.filter(item => ['page', 'structured-output'].includes(item.content.kind)).length, 0, 'Private automatic page evidence remains suppressed')
  const echo = structuredClone(definition)
  echo.steps[1].extraction.fields = [{ key: 'number', type: 'string', source: { selector: '#private-input', read: 'value' } }]
  echo.completion.criteria[0].expected = 'A declared public result'
  const blocked = await invoke(await publish(echo)), blockedFacts = await recorded(other, blocked.id)
  assert.equal(blocked.status, 'interrupted', 'Known-secret suppression preserves the original indeterminate operation')
  assert.equal(blockedFacts.completion.status, 'unavailable')
  const missing = structuredClone(definition)
  missing.steps[1].extraction.fields[0].source.selector = '#absent'
  const partial = await invoke(await publish(missing)), partialFacts = await recorded(other, partial.id)
  assert.equal(partialFacts.completion.status, 'not-met')
  const protectedFiles = await durablePrivacy(ctx, privateValue)
  ctx.receipt.taskData.privateCounterexamples = { browser: opened.region, actualPrivateInputObserved: true, safe, safeFacts, safeArtifact, fillEvidence, blocked, blockedFacts, partial, partialFacts, protectedFiles }
  ctx.receipt.taskData.cases.push('private-reviewed-fields-only', 'known-secret-unknown-retained-no-replay', 'missing-field-not-met')
  const focus = await ctx.rpc.call('space.focus', { inputPolicy: 'preserve', target: { kind: 'space', regionId: mainRegion.regionId } })
  assert.ok(['applied', 'unchanged'].includes(focus.navigation.state))
  const originalSurface = `[data-workbench-region-id=${q(mainRegion.regionId)}] [data-browser-surface=${q(ctx.browserId)}]`
  const mainVisible = await ctx.waitFor('the original Region is visible before checking the background page', () => ctx.probe.cdp.evaluate(`(()=>{
    const surface=document.querySelector(${q(originalSurface)});
    if(!surface?.checkVisibility())return null;const r=surface.getBoundingClientRect();return r.width>0&&r.height>0?{x:r.x,y:r.y,width:r.width,height:r.height}:null;
  })()`))
  const targets = (await ctx.rpc.call('browser.targets', {})).targets
  const mainTarget = targets.find(item => item.id === ctx.browserId)
  assert.ok(mainTarget?.navigationId); assert.equal(mainTarget.url, ctx.pageUrl)
  ctx.receipt.taskData.privateCounterexamples.returnToOriginal = { focus, mainTarget, visibleBounds: mainVisible,
    scope: 'Original Region and page discovery only; no native-input ownership transfer or preview-health claim.' }
  const target = targets.find(item => item.id === other.browserId)
  assert.ok(target?.navigationId, 'The original private task page has a confirmed current navigation')
  const nativeBefore = await contentsFor(ctx, url)
  assert.equal(nativeBefore.length, 1)
  const release = await cli(other, ['browser', 'release', '--browser', other.browserId, '--navigation', target.navigationId, '--operation-id', randomUUID()])
  assert.equal(release.receipt.status, 'retained', 'A used task document must retain the original safe release policy')
  assert.ok(release.receipt.reasons.includes('document-used'))
  const originalRead = await readArtifact(other, safeOperation, { number: 7 }, [privateValue])
  assert.equal(originalRead.sha256, safeArtifact.sha256)
  assert.deepEqual(await contentsFor(ctx, url), nativeBefore, 'A retained-page read cannot replace its original native owner')
  ctx.receipt.taskData.privateCounterexamples.retention = { release: release.receipt, nativeContents: nativeBefore, artifactSha256: originalRead.sha256 }
  ctx.receipt.taskData.cases.push('used-document-retained-original-result-readable')
}

// Reusable stages: callers already own the exact Browser, workspace, geometry and
// one App lifecycle. Neither stage creates a Core/Runtime owner or restarts an App.
export async function prepareTaskDataOutcomes(ctx) {
  const report = ctx.receipt.taskData ??= { complete: false, cli: [], cases: [] }
  const sdk = await import(pathToFileURL(join(ctx.coreRoot, 'dist/index.js')))
  await openEditor(ctx)
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Start recording demonstration"]'))
  await ctx.waitFor('the actual original recording is ready', () => ctx.probe.cdp.evaluate(`window.agentmux.browser.getDemonstration(${q(ctx.browserId)}).then(s=>s.draft?.status==='recording')`))
  await native(ctx, '#produce')
  await ctx.waitFor('the original recording retained one native click', () => ctx.probe.cdp.evaluate(`window.agentmux.browser.getDemonstration(${q(ctx.browserId)}).then(s=>s.draft?.steps.length===1)`))
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Stop recording demonstration"]'))
  await ctx.waitFor('the original demonstration has durably stopped', () => ctx.probe.cdp.evaluate(`window.agentmux.browser.getDemonstration(${q(ctx.browserId)}).then(s=>s.draft?.status==='stopped')`))
  const source = (await cli(ctx, ['browser', 'task', 'source', '--browser', ctx.browserId])).source
  const intent = sdk.browserTaskCreateInput(source, 'Native recorded data outcomes')
  const created = await cli(ctx, ['browser', 'task', 'create', '--browser', ctx.browserId, '--input', '-'], intent)
  report.creation = { intent, result: created }
  let asset = await waitAsset(ctx, intent.assetId)
  // Exercise the real new editor before the full multi-producer definition goes
  // through the public edit/publish entry. No DOM value assignment or callbacks.
  await ctx.click(ctx.probe.cdp, button(ctx, 'Add extraction'))
  await type(ctx, editor + ' [aria-label="Extraction field 1 key"]', 'empty')
  await type(ctx, editor + ' [aria-label="Extraction field 1 selector"]', '#empty')
  await ctx.click(ctx.probe.cdp, ctx.selectors(editor + ' [aria-label="Require extraction field 1"]'))
  await ctx.click(ctx.probe.cdp, ctx.selectors(editor + ' [aria-label="Review task step 2"]'))
  await ctx.click(ctx.probe.cdp, button(ctx, 'Save draft'))
  asset = await ctx.waitFor('the GUI extraction definition is saved by the original asset owner', async () => { const value = await waitAsset(ctx, intent.assetId); return value.draft.steps.length === 2 ? value : null })
  assert.equal(asset.draft.steps[1].kind, 'extract')
  assert.deepEqual(asset.draft.completion.criteria, [{ kind: 'field-equals', stepId: asset.draft.steps[1].id, key: 'empty', expected: '' }])
  report.guiAuthored = asset.draft
  assert.equal(await ctx.probe.cdp.evaluate(`document.querySelector(${q(editor)})?.dataset.taskAssetId`), intent.assetId, 'The GUI edits the exact publicly created asset')
  const extract = (id, url, fields) => ({ id, kind: 'extract', url, label: id, reviewed: true, extraction: { fields } })
  const firstFields = [{ key: 'number', type: 'number', source: { selector: '#number', read: 'text' } }, { key: 'flag', type: 'boolean', source: { selector: '#flag', read: 'checked' } }, { key: 'empty', type: 'string', source: { selector: '#empty', read: 'text' } }, { key: 'long', type: 'string', source: { selector: '#long', read: 'text' } }]
  for (let index = 2; index <= 7; index++) firstFields.push({ key: 'long' + index, type: 'string', source: { selector: '#long', read: 'text' } })
  const definition = { name: 'Reviewed native data task', url: ctx.urls[0], parameters: [], steps: [
    { ...asset.draft.steps[0], reviewed: true }, extract('first-fields', ctx.urls[0], firstFields),
    { id: 'go-next', kind: 'navigate', url: ctx.urls[1], reviewed: true },
    extract('second-fields', ctx.urls[1], [firstFields[0]]),
    { id: 'human-confirm', kind: 'checkpoint', url: ctx.urls[1], label: 'Review recorded data', reviewed: true }
  ], completion: { criteria: [
    { kind: 'field-equals', stepId: 'first-fields', key: 'number', expected: 0 },
    { kind: 'field-equals', stepId: 'first-fields', key: 'flag', expected: false },
    { kind: 'field-equals', stepId: 'first-fields', key: 'empty', expected: '' },
    { kind: 'field-equals', stepId: 'second-fields', key: 'number', expected: 7 },
    { kind: 'human-checkpoint', checkpointId: 'human-confirm' }
  ] } }
  await cli(ctx, ['browser', 'task', 'edit', '--browser', ctx.browserId, '--asset', asset.id, '--expected-revision', String(asset.revision), '--input', '-'], definition)
  asset = await waitAsset(ctx, asset.id)
  await cli(ctx, ['browser', 'task', 'publish', '--browser', ctx.browserId, '--asset', asset.id, '--expected-revision', String(asset.revision)])
  asset = await ctx.waitFor('the immutable public version is visible in the original GUI', async () => { const value = await waitAsset(ctx, asset.id); return value.versions.length === 1 ? value : null })
  await ctx.click(ctx.probe.cdp, button(ctx, 'Run version'))
  let run = await ctx.waitFor('both native extractions finish before the real human checkpoint', async () => (await state(ctx)).runs.find(r => r.assetId === asset.id && r.status === 'waiting-human') ?? null)
  report.beforeContinue = await recorded(ctx, run.id)
  assert.equal(report.beforeContinue.completion.status, 'unavailable', 'An unfinished task cannot claim its declared outcome complete')
  assert.equal(report.beforeContinue.completion.conditions.length, 5)
  await ctx.click(ctx.probe.cdp, button(ctx, 'Return control and continue'))
  run = await ctx.waitFor('the exact task completes after trusted Continue', async () => (await state(ctx)).runs.find(r => r.id === run.id && r.status === 'completed') ?? null)
  const outcomes = await recorded(ctx, run.id)
  assert.equal(outcomes.completion.status, 'passed')
  const producers = ['first-fields', 'second-fields'].map(id => run.stepExecutions.find(s => s.stepId === id)?.operationId)
  assert.ok(producers.every(Boolean)); assert.notEqual(producers[0], producers[1])
  report.artifacts = [await readArtifact(ctx, producers[0], expectedFirst), await readArtifact(ctx, producers[1], { number: 7 })]
  assert.ok(report.artifacts[0].bytes > 65536 && report.artifacts[0].chunks.length > 1, 'Actual CLI paging must cross native Unicode bytes without exceeding any field budget')
  const unavailableRead = await cli(ctx, ['browser', 'inspect', '--operation-id', producers[0], '--step', '1', '--offset', String(report.artifacts[0].bytes + 1), '--max-bytes', '1021'])
  assert.equal(unavailableRead.resultRead?.status, 'unavailable')
  assert.equal(unavailableRead.runOperation?.id, producers[0], 'A failed byte read must retain the exact original operation')
  report.unavailableRead = unavailableRead
  report.asset = asset; report.run = run; report.outcomes = outcomes; report.producers = producers
  report.cases.push('native-multiple-producers-across-navigation', 'zero-false-empty-and-unicode-pages', 'trusted-checkpoint-and-recorded-outcomes', 'actual-gui-edit-and-public-publish')
  ctx.pageUrl = ctx.urls[1]
  await ctx.waitFor('the original task result projection is visible', () => ctx.probe.cdp.evaluate("document.querySelector('[data-task-recorded-outcome]')?.dataset.taskRecordedOutcome==='passed'"))
  for (const [label, width, height] of [['normal', 1440, 900], ['narrow', 1000, 720], ['short', 1000, 660]]) {
    await ctx.resize(ctx.probe, width, height)
    const groups = await reviewFailureControlGeometry(ctx, label)
    if (label === 'narrow' && ctx.receipt.case === 'daily-workface') await reviewFailureControlCssCounterexample(ctx, groups)
    await ctx.probe.cdp.evaluate(`document.querySelector(${q(editor + ' .browser-task-asset__progress')}).scrollIntoView({block:'start'});null`)
    const reader = await ctx.waitFor('the task activity reader fits its Browser and retains a visible Close action', () => ctx.probe.cdp.evaluate(`(()=>{
      const progress=document.querySelector(${q(editor + ' .browser-task-asset__progress')}),rail=progress?.closest('.browser-trace-rail');
      const pane=document.querySelector(${q(`[data-browser-surface=${q(ctx.browserId)}]`)}),close=rail?.querySelector('[aria-label="Close browser activity timeline"]');
      if(!pane||!close||!close.checkVisibility())return null;
      const p=pane.getBoundingClientRect(),r=rail.getBoundingClientRect(),c=close.getBoundingClientRect();
      if(r.left<p.left-1||r.right>p.right+1||r.top<p.top-1||r.bottom>p.bottom+1||!close.contains(document.elementFromPoint(c.x+c.width/2,c.y+c.height/2)))return null;
      return {pane:p.toJSON(),rail:r.toJSON(),close:c.toJSON()};
    })()`))
    ;(report.readerBoundaries ??= []).push({ label, ...reader })
    await ctx.capture(ctx.probe, label + '-task-data-outcomes', 'task-assets', ctx.pageUrl)
  }
  await ctx.resize(ctx.probe, 1440, 900)
  await ctx.click(ctx.probe.cdp, ctx.selectors(`[data-task-result-operation="${producers[0]}"]`))
  await ctx.waitFor('the original structured field reader is visible in its actual result viewport', () => ctx.probe.cdp.evaluate(`(()=>{
    const surface=document.querySelector('[aria-label="Recorded structured fields"]'),rail=surface?.closest('.browser-trace-rail');
    if(!surface||!rail||surface.closest('.browser-step-evidence')?.querySelector('header strong')?.textContent!=='Recorded fields')return false;const clip=rail.getBoundingClientRect();
    return [surface.querySelector('.browser-structured-fields__summary'),surface.querySelector('.browser-structured-fields__values dt')].every(element=>{
      if(!element||!element.checkVisibility())return false;const r=element.getBoundingClientRect();
      return Math.max(0,clip.top,r.top)<Math.min(innerHeight,clip.bottom,r.bottom)&&Math.max(0,clip.left,r.left)<Math.min(innerWidth,clip.right,r.right);
    });
  })()`))
  await ctx.click(ctx.probe.cdp, `${ctx.selectors('[aria-label="Recorded structured fields"] details > summary')}.filter(element=>element.textContent.trim()==='Recorded JSON')`)
  const guiRaw = await ctx.waitFor('the real GUI reads the original retained artifact chunk', () => ctx.probe.cdp.evaluate(`(()=>{
    const surface=document.querySelector('[aria-label="Recorded structured fields"]'),range=surface?.querySelector('.browser-structured-fields__range'),raw=surface?.querySelector('[aria-label="Recorded JSON chunk"]');
    return range&&raw?.textContent.length?{range:range.textContent,text:raw.textContent}:null;
  })()`))
  const originalFile = report.artifactFiles.find(item => item.operationId === producers[0])
  const originalText = await readFile(originalFile.file, 'utf8')
  assert.ok(originalText.startsWith(guiRaw.text), 'The GUI must read the exact original artifact, not today’s page or a replacement value')
  assert.equal(guiRaw.text.includes('\uFFFD'), false, 'The GUI must preserve native Unicode chunk decoding')
  assert.ok(guiRaw.text.includes('"value":0') && guiRaw.text.includes('"value":false') && guiRaw.text.includes('"value":""'))
  await ctx.probe.cdp.evaluate(`document.querySelector('[aria-label="Recorded JSON chunk"]').scrollIntoView({block:'nearest'});null`)
  const guiViewport = await ctx.waitFor('the original JSON chunk is visible for independent review', () => ctx.probe.cdp.evaluate(`(()=>{
    const raw=document.querySelector('[aria-label="Recorded JSON chunk"]'),rail=raw?.closest('.browser-trace-rail');
    if(!raw?.checkVisibility()||!rail)return null;const r=raw.getBoundingClientRect(),clip=rail.getBoundingClientRect();
    return Math.max(0,clip.top,r.top)<Math.min(innerHeight,clip.bottom,r.bottom)&&Math.max(0,clip.left,r.left)<Math.min(innerWidth,clip.right,r.right)?{raw:{x:r.x,y:r.y,width:r.width,height:r.height},reader:{x:clip.x,y:clip.y,width:clip.width,height:clip.height}}:null;
  })()`))
  report.guiResultRead = { range: guiRaw.range, utf8Bytes: Buffer.byteLength(guiRaw.text), originalArtifactSha256: report.artifacts[0].sha256, viewport: guiViewport }
  await ctx.capture(ctx.probe, 'normal-task-data-original-fields', 'structured-output', ctx.pageUrl)
  await ctx.waitFor('both deliberate producers reached the real HTTP fixture', () => ctx.receipt.taskDataRequests.actions.length === 2)
  report.actionCount = ctx.receipt.taskDataRequests.actions.length
  report.pageUrl = ctx.pageUrl
}

export async function recoverTaskDataOutcomes(ctx) {
  const report = ctx.receipt.taskData
  const { run, outcomes, producers } = report
  ctx.pageUrl = report.pageUrl
  assert.deepEqual(await recorded(ctx, run.id), outcomes, 'Historical inspection retains original judgments after navigation and restart')
  const restoredArtifacts = [await readArtifact(ctx, producers[0], expectedFirst), await readArtifact(ctx, producers[1], { number: 7 })]
  assert.deepEqual(restoredArtifacts, report.artifacts)
  assert.equal(ctx.receipt.taskDataRequests.actions.length, report.actionCount, 'Reading original outcomes cannot replay a producer')
  assert.equal(await ctx.nativePageScript(ctx.probe, 'globalThis.taskDataActions', ctx.pageUrl), 0)
  return { artifacts: restoredArtifacts, actionCount: ctx.receipt.taskDataRequests.actions.length }
}

export async function recoverTaskDataPrivateCounterexamples(ctx) {
  const report = ctx.receipt.taskData
  const originalPrivate = report.privateCounterexamples
  const privateUrl = new URL('/private', ctx.pageUrl).href
  const nativeBefore = await contentsFor(ctx, privateUrl)
  assert.deepEqual(nativeBefore, [], 'The background original task page must stay cold after ordinary App restart')
  const privateContext = { ...ctx, browserId: originalPrivate.browser.browserId, pageUrl: privateUrl }
  const coldArtifact = await readArtifact(privateContext, originalPrivate.safeArtifact.reference.operationId, { number: 7 })
  assert.equal(coldArtifact.sha256, originalPrivate.safeArtifact.sha256)
  assert.deepEqual(await contentsFor(ctx, privateUrl), [], 'Reading the original artifact cannot warm or recreate a native page')
  assert.equal(ctx.receipt.taskDataRequests.actions.length, report.actionCount)
  report.coldRead = { browserId: privateContext.browserId, operationId: coldArtifact.reference.operationId,
    artifactSha256: coldArtifact.sha256, nativeBefore, nativeAfter: [], actionCount: report.actionCount }
  report.cases.push('cold-original-artifact-read-without-native-page')
}

export async function presentRecoveredTaskDataOutcomes(ctx) {
  await openEditor(ctx)
  await ctx.waitFor('the original historical task completion projects after restart', () => ctx.probe.cdp.evaluate("document.querySelector('[data-task-recorded-outcome]')?.dataset.taskRecordedOutcome==='passed'"))
  await ctx.probe.cdp.evaluate(`document.querySelector(${q(editor + ' .browser-task-asset__progress')}).scrollIntoView({block:'start'});null`)
  await ctx.capture(ctx.probe, 'normal-task-data-restored', 'task-assets', ctx.pageUrl)
}

export async function reviewTaskDataOutcomes(ctx) {
  const report = ctx.receipt.taskData = { complete: false, cli: [], cases: [], boundary: 'Complete ordinary product Main/Renderer/native Browser; actual public CLI; private Core Agent and original Run across normal App quit; no Store seeding, bridge replacement or forced storage flush. CDP/native synthetic device input is not physical OS input.' }
  let observer
  try {
    ctx.setPhase('task-data-original-workface')
    report.engine = await ctx.probe.main.evaluate('({electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node})')
    const desktopPackage = JSON.parse(await readFile(join(ctx.desktopRoot, 'package.json'), 'utf8'))
    assert.equal(report.engine.electron, desktopPackage.devDependencies.electron, 'The actual private Main uses this candidate’s declared native engine')
    const spatial = await ctx.probe.cdp.evaluate('window.agentmux.spatial.read()')
    const zone = spatial.graph.zones.find(z => z.workspaceId === ctx.workspaceId); assert.ok(zone)
    const agent = await ctx.rpc.call('agent.open', { content: { kind: 'new-agent', executorId: 'collaboration', executionWorkspaceId: ctx.workspaceId }, destination: { zoneId: zone.zoneId, newTab: true }, focus: true })
    assert.equal(agent.outcome, 'opened'); assert.ok(agent.agent)
    const sid = agent.agent.agentSessionId
    const original = await ctx.waitFor('the original private Agent has an exact healthy Run', () => ctx.probe.cdp.evaluate(`window.agentmux.sessions.snapshot().then(s=>s.sessions.find(v=>v.kind==='agent'&&v.control.agentSessionId===${q(sid)}&&v.control.run?.runId))`))
    // The existing hosted client names this exact private endpoint. Its caller
    // needs no local Core or process-wide HOME change; Orca keeps its real owner.
    const sdk = await import(pathToFileURL(join(ctx.coreRoot, 'dist/index.js')))
    observer = await sdk.connectHostedAgentMux({ rpc: await sdk.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(ctx.runtimeDirectory, 'control.sock') } }) })
    const exact = async () => { const value = (await observer.listRuns()).find(r => r.runId === original.control.run.runId); assert.equal(value?.state, 'running'); return value }
    const firstRun = await exact()
    const firstAck = await observer.writeAgent({ agentSessionId: sid, expectedRun: original.control.run, source: 'user', data: 'private task data first input\n' })
    assert.ok(firstAck.appliedByteRange?.endByte > firstAck.appliedByteRange?.startByte)
    await writeFile(join(ctx.workspacePath, 'retained.txt'), 'Original file beside the task data workface.\n')
    const file = await ctx.rpc.call('file.open', { path: 'retained.txt', zoneId: zone.zoneId, focus: false })
    assert.equal(file.outcome, 'opened'); assert.equal(file.data.kind, 'text')
    assert.ok(file.placement.regionId); assert.equal(file.navigation, 'background')
    const opened = await ctx.rpc.call('browser.open', { url: ctx.urls[0], destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: agent.to.regionId } } })
    ctx.browserId = opened.region.browserId
    await ctx.nativeFrameReady(ctx.urls[0])
    const draftSelector = `[data-workbench-region-id="${agent.to.regionId}"] [role="textbox"][aria-label="Message Agent"]`
    await type(ctx, draftSelector, 'Unsent original task data draft — preserve these bytes.')
    await ctx.nativePageScript(ctx.probe, "document.cookie='task-data-login=original; Max-Age=86400; SameSite=Lax';null")
    ctx.zone = zone; ctx.region = opened.region
    await prepareTaskDataOutcomes(ctx)
    await reviewFailureControlCssCounterexample(ctx)
    await prepareTaskDataPrivateCounterexamples(ctx, sdk, ctx.zone, report.asset, ctx.region)
    const graph = await ctx.probe.cdp.evaluate('window.agentmux.spatial.read()')
    const draft = await ctx.probe.cdp.evaluate(`document.querySelector(${q(draftSelector)}).textContent`)
    const actionCount = ctx.receipt.taskDataRequests.actions.length
    assert.equal(actionCount, 2, 'The demonstration and the one saved-task action each reached the actual HTTP producer exactly once')
    const beforeQuit = await exact()
    await preserveDurable(ctx, 'first-process')
    report.original = { sid, runId: firstRun.runId, pid: firstRun.pid, firstAck, file, graph, draft, actionCount, browserId: ctx.browserId, acceptedInputBytes: beforeQuit.acceptedInputBytes }
    report.firstQuit = await ctx.normalQuit(ctx.probe)
    const retained = await exact(); assert.equal(retained.pid, firstRun.pid)
    ctx.probe = await ctx.launch('second'); ctx.retainSecond(ctx.probe)
    ctx.setPhase('task-data-second-process-read-original-results')
    await ctx.waitFor('the original Agent Run is reattached in the second App', () => ctx.probe.cdp.evaluate(`window.agentmux.sessions.snapshot().then(s=>s.sessions.some(v=>v.kind==='agent'&&v.control.agentSessionId===${q(sid)}&&v.control.run?.runId===${q(firstRun.runId)}))`))
    const after = await ctx.probe.cdp.evaluate('window.agentmux.spatial.read()')
    for (const key of ['tabs', 'regions', 'tabLayouts', 'layouts']) assert.deepEqual(after.graph[key], graph.graph[key])
    assert.equal(await readFile(join(ctx.workspacePath, 'retained.txt'), 'utf8'), 'Original file beside the task data workface.\n')
    assert.equal(await ctx.probe.cdp.evaluate(`document.querySelector(${q(draftSelector)}).textContent`), draft)
    assert.equal((await exact()).acceptedInputBytes, beforeQuit.acceptedInputBytes, 'App restoration must not replay original input')
    assert.equal((await exact()).pid, firstRun.pid)
    const secondAck = await observer.writeAgent({ agentSessionId: sid, expectedRun: original.control.run, source: 'user', data: 'private task data second input\n' })
    assert.equal(secondAck.appliedByteRange?.startByte, beforeQuit.acceptedInputBytes); assert.ok(secondAck.appliedByteRange.endByte > secondAck.appliedByteRange.startByte)
    await ctx.waitFor('the original main document is loaded without transferring native input', async () =>
      (await contentsFor(ctx, ctx.pageUrl)).length === 1 && await ctx.nativePageScript(ctx.probe, 'document.readyState', ctx.pageUrl) === 'complete')
    assert.equal(await ctx.nativePageScript(ctx.probe, 'document.cookie', ctx.pageUrl), 'task-data-login=original')
    const restored = await recoverTaskDataOutcomes(ctx)
    await recoverTaskDataPrivateCounterexamples(ctx)
    await presentRecoveredTaskDataOutcomes(ctx)
    report.recovered = { secondAck, run: await exact(), graph: after, ...restored }
    await preserveDurable(ctx, 'second-process')
    report.cases.push('ordinary-second-pid-original-run-new-input-ack', 'original-file-draft-cookie-and-layout', 'readonly-original-artifacts-no-replay')
    report.secondQuit = await ctx.normalQuit(ctx.probe)
    report.complete = true
  } finally {
    await observer?.dispose()
  }
}
