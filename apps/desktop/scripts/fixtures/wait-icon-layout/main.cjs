const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto'), { gzipSync } = require('node:zlib')
const [html, privateRoot, evidence, mode, referenceFile] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
// Match a continuously presented foreground workload without stealing the user's focus.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { schema: 'agentmux.wait-icon-layout-native.v1', passed: false, mode, versions: process.versions,
  userAppOrRunTouched: false, visualReview: 'pending independent Agent review', cases: [], frames: [] }
let win, attached = false, tracing = false, stream
const read = expression => win.webContents.executeJavaScript(expression), send = (method, params = {}) => win.webContents.debugger.sendCommand(method, params)
async function until(expression) { const end = Date.now() + 6000
  while (Date.now() < end) { if (await read(expression)) return; await delay(20) }
  throw Error('Native condition not reached: ' + expression) }
const facts = () => read('proof.facts()')
function unionMs(events) { let value = 0, end = -Infinity
  for (const e of events.sort((a, b) => a.ts - b.ts)) { value += Math.max(0, e.ts + e.dur - Math.max(e.ts, end)); end = Math.max(end, e.ts + e.dur) }
  return value / 1000 }
async function trace(label, work) {
  let done; const complete = new Promise(resolve => done = resolve)
  const listener = (_event, method, params) => { if (method === 'Tracing.tracingComplete') done(params) }
  win.webContents.debugger.on('message', listener)
  try {
    await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,toplevel,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReturnAsStream' }); tracing = true
    await work(); await send('Tracing.end'); tracing = false
    const finished = await Promise.race([complete, delay(5000).then(() => { throw Error('Native trace did not finish') })])
    assert.equal(finished.dataLossOccurred, false); assert.ok(finished.stream); stream = finished.stream
    const chunks = []
    for (;;) { const c = await send('IO.read', { handle: stream, size: 1024 * 1024 }); chunks.push(Buffer.from(c.data, c.base64Encoded ? 'base64' : 'utf8')); if (c.eof) break }
    await send('IO.close', { handle: stream }); stream = undefined
    const bytes = Buffer.concat(chunks), events = JSON.parse(bytes.toString('utf8')).traceEvents
    fs.writeFileSync(path.join(evidence, label + '.trace.json.gz'), gzipSync(bytes))
    const pid = win.webContents.getOSProcessId(), tid = events.find(e => e.pid === pid && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')?.tid
    assert.ok(tid, 'Actual renderer main thread is present')
    const main = events.filter(e => e.pid === pid && e.tid === tid && e.ph === 'X'), statistics = {}
    for (const e of main) { const s = statistics[e.name] ??= { count: 0, totalMs: 0, maxMs: 0 }; s.count++; s.totalMs += e.dur / 1000; s.maxMs = Math.max(s.maxMs, e.dur / 1000) }
    const tasks = main.filter(e => e.name === 'ThreadControllerImpl::RunTask'), layouts = main.filter(e => e.name === 'Layout')
    assert.ok(tasks.length > 0 && layouts.length > 0, 'Nonempty native pipeline observation')
    const local = layouts.filter(e => e.args?.beginData?.partialLayout && e.args?.endData?.layoutRoots?.length > 0 && e.args.endData.layoutRoots.every(r => r.nodeName?.startsWith('svg ')))
    const global = layouts.filter(e => e.args?.endData?.layoutRoots?.some(r => r.nodeName === '#document'))
    const invalidations = events.filter(e => e.pid === pid && e.name === 'LayoutInvalidationTracking')
    return { rendererPid: pid, mainTid: tid, events: events.length, trace: label + '.trace.json.gz', taskUnionMs: unionMs(tasks), statistics,
      localLayouts: local.length, documentLayouts: global.length,
      localLayoutMs: local.reduce((sum, e) => sum + e.dur / 1000, 0),
      layoutObjects: [...new Set(layouts.map(e => e.args?.beginData?.totalObjects))],
      rootExamples: layouts.slice(0, 4).map(e => e.args),
      invalidationExamples: invalidations.slice(0, 12).map(e => e.args) }
  } finally { win.webContents.debugger.off('message', listener) }
}
async function partNodes() {
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }), parts = []
  function walk(node, waitingShadow = false) {
    const attributes = Object.fromEntries(Array.from({ length: (node.attributes?.length ?? 0) / 2 }, (_, i) => [node.attributes[i * 2], node.attributes[i * 2 + 1]]))
    if (waitingShadow && attributes['data-semantic-icon-part']?.startsWith('hourglass-')) parts.push({ nodeId: node.nodeId, name: attributes['data-semantic-icon-part'] })
    for (const child of node.children ?? []) walk(child, waitingShadow)
    for (const shadow of node.shadowRoots ?? []) walk(shadow, node.nodeName === 'use' && attributes.href === '#agentmux-icon-status.waiting')
  }
  walk(root)
  assert.ok(parts.length > 0, 'Actual native SVG use shadow-tree parts are inspectable')
  return parts
}
async function partStyles(nodes) {
  const parts = []
  for (const node of nodes) { const { computedStyle } = await send('CSS.getComputedStyleForNode', { nodeId: node.nodeId })
    const style = Object.fromEntries(computedStyle.filter(s => ['transform', 'opacity', 'animation-name', 'animation-play-state'].includes(s.name)).map(s => [s.name, s.value]))
    parts.push({ ...node, style })
  }
  return parts
}
async function samplePixels(state) {
  const image = await win.webContents.capturePage(), size = image.getSize()
  const scale = { x: size.width / state.viewport.width, y: size.height / state.viewport.height }
  return { at: Date.now(), scale, size, icons: state.icons.map(({ rect: r }) => {
    const region = { x: Math.floor(r.x * scale.x), y: Math.floor(r.y * scale.y), width: Math.ceil(r.width * scale.x), height: Math.ceil(r.height * scale.y) }
    assert.ok(region.width > 0 && region.height > 0)
    return { region, hash: hash(image.crop(region).toBitmap()) }
  }) }
}
async function capture(label) { const bytes = (await win.webContents.capturePage()).toPNG(); fs.writeFileSync(path.join(evidence, label + '.png'), bytes); result.frames.push({ file: label + '.png', sha256: hash(bytes) }) }
async function observe(scale, count, live = false) {
  await read(`proof.scale(${scale});proof.count(${count});proof.output(${live})`)
  await until('document.querySelectorAll(".additional-slot").length===' + (count - 1)); await read('proof.adapt()')
  await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(160)
  const before = await facts(); assert.equal(before.icons.length, count + 1); assert.equal(before.retained, scale); assert.equal(before.visibility, 'visible'); assert.deepEqual(before.errors, [])
  const nodes = await partNodes(); assert.equal(nodes.length, before.icons.length * 4)
  const pixels = [], start = Date.now(), label = `${mode}-${scale}-${count}-${live ? 'live' : 'idle'}`
  const costs = await trace(label, async () => {
    for (const offset of [0, 400, 1200, 2400, 3600, 4000, 4400, 5000]) { await delay(Math.max(0, start + offset - Date.now())); pixels.push({ ...await samplePixels(before), parts: await partStyles(nodes) }) }
  })
  const after = await facts()
  assert.ok(pixels.at(-1).at - pixels[0].at >= 4800, 'Complete 4.8 s natural hourglass cycle observed')
  assert.ok(before.icons.length > 0)
  for (let i = 0; i < before.icons.length; i++) assert.ok(new Set(pixels.map(p => p.icons[i].hash)).size >= 3, 'Every actual waiter visibly drains/fills/turns throughout its natural cycle')
  for (const node of nodes) assert.ok(new Set(pixels.map(p => JSON.stringify(p.parts.find(part => part.nodeId === node.nodeId).style))).size >= 2, 'Actual native part matrices/opacity continue changing: ' + node.name)
  assert.deepEqual(after.icons.map(i => i.rect), before.icons.map(i => i.rect), 'Continuous motion preserves original external geometry')
  if (live) assert.ok(after.terminal.completedOutput > before.terminal.completedOutput + 50, 'Real xterm consumes sustained output')
  const row = { scale, count, live, before, after, pixels, costs }; result.cases.push(row)
  return row
}
async function inputProof() {
  await read('proof.output(true);proof.focus();proof.scrollToLine(900)'); const before = await facts(), r = before.terminal.rect
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), deltaX: 0, deltaY: -180 }); await delay(80)
  const up = await facts(); assert.ok(up.terminal.viewportY < 900, 'Real xterm continuously reads upward')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), deltaX: 0, deltaY: 180 }); await delay(80)
  const down = await facts(); assert.ok(down.terminal.viewportY > up.terminal.viewportY)
  await send('Input.insertText', { text: 'wait-input-' }); await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await send('Input.insertText', { text: '中文' }); await delay(80)
  const after = await facts(); assert.ok(after.terminal.inputs.join('').includes('wait-input-中文')); assert.ok(after.terminal.compositions.some(e => e.name === 'compositionend' && e.data === '中文')); assert.equal(after.terminal.focused, true)
  await read('document.querySelector(".small-button").click()'); assert.equal((await facts()).action, 1)
  return { before, up, down, after, boundary: 'Real native Chromium input/xterm; no physical keyboard, OS IME, Provider or Core Run claim' }
}
async function behaviorProof() {
  await read('proof.count(1);proof.output(false)'); await until('document.querySelectorAll(".additional-slot").length===0')
  const themes = []
  for (const index of [0, 1, 2]) for (const light of [false, true]) {
    assert.equal((await read(`proof.theme(${index},${light})`)).applied, true); await delay(100)
    const before = await facts(), first = await samplePixels(before); await delay(900); const second = await samplePixels(before)
    assert.match(before.symbol, /hourglass-upper/); assert.notEqual(first.icons[0].hash, second.icons[0].hash, 'All built-in themes preserve actual flowing sand')
    await capture('theme-' + index + (light ? '-light' : '-dark')); themes.push({ index, light, before, first, second })
  }
  const hrefs = (await facts()).icons.map(i => i.href)
  assert.equal((await read('proof.custom()')).applied, true); await delay(100)
  const custom = await facts(); assert.ok(custom.symbol.includes('M4 12h16')); assert.ok(!custom.symbol.includes('hourglass-')); assert.deepEqual(custom.icons.map(i => i.href), hrefs)
  const customA = await samplePixels(custom); await delay(550); const customB = await samplePixels(custom)
  assert.deepEqual(customA.icons.map(i => i.hash), customB.icons.map(i => i.hash), 'Custom artwork stays whole, without invented parts')
  await capture('custom-path'); await read('proof.restoreTheme()'); await delay(100)
  await read('proof.pause(true)'); await delay(100); const paused = await facts(), pauseA = await samplePixels(paused); await delay(550); const pauseB = await samplePixels(paused)
  assert.deepEqual(pauseA.icons.map(i => i.hash), pauseB.icons.map(i => i.hash), 'Original inherited motion policy pauses shadow-tree sand')
  await read('proof.pause(false)')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await delay(100)
  const reduced = await facts(), reduceA = await samplePixels(reduced); await delay(550); const reduceB = await samplePixels(reduced)
  assert.deepEqual(reduceA.icons.map(i => i.hash), reduceB.icons.map(i => i.hash)); await capture('reduced-motion')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await read('proof.visible(false)'); await until('proof.facts().waiting==="false"'); const hidden = await facts(); assert.equal(hidden.icons.length, 1)
  await read('proof.visible(true)'); await until('proof.facts().waiting==="true"'); await read('proof.parked(true)'); await until('proof.facts().waiting==="false"')
  const parked = await facts(); await delay(1100); assert.equal((await facts()).elapsed, parked.elapsed, 'Parked original waiting consumer schedules no elapsed tick')
  await read('proof.parked(false)'); await until('proof.facts().waiting==="true"')
  await read('document.getElementById("waiting-surface").style.transform="translateX(-3000px)"'); await until('proof.facts().waiting==="false"')
  await read('document.getElementById("waiting-surface").style.transform=""'); await until('proof.facts().waiting==="true"')
  await read('proof.scope("app")'); await delay(300); await capture('app-startup'); await read('proof.scope("region")'); await delay(300)
  win.setSize(680, 780); await delay(120); await capture('narrow-region'); win.setSize(1180, 820); await delay(120)
  const restored = await facts(); assert.deepEqual(restored.errors, []); await capture('restored-region')
  return { themes, custom, paused, reduced, hidden, parked, restored }
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1180, height: 820, show: false, focusable: false, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); win.showInactive(); await win.loadFile(html)
    win.webContents.debugger.attach('1.3'); attached = true; await send('Emulation.setFocusEmulationEnabled', { enabled: true }); await send('DOM.enable'); await send('CSS.enable'); await until('window.proof?.ready && proof.facts().waiting==="true"')
    result.native = { pid: process.pid, rendererPid: win.webContents.getOSProcessId(), visible: win.isVisible(), offscreen: win.webContents.isOffscreen(), gpu: app.getGPUFeatureStatus(), backgroundThrottling: win.webContents.getBackgroundThrottling() }
    assert.equal(result.native.visible, true); assert.equal(result.native.offscreen, false)
    await capture('original-region')
    const small = await observe(200, 1), large = await observe(16000, 1)
    const reference = referenceFile ? JSON.parse(fs.readFileSync(referenceFile, 'utf8')) : null
    const budget = reference?.budget ?? { taskUnionMs: small.costs.taskUnionMs * 2 + 100,
      layoutMs: small.costs.statistics.Layout.totalMs * 2 + 25 }
    result.budget = budget
    // Local SVG animation can legitimately update geometry each refresh. Its work may not escape
    // into the retained document; the 1 Hz product elapsed label remains a normal document consumer.
    const local = [small, large].every(row => row.costs.localLayouts > row.costs.documentLayouts && row.costs.documentLayouts <= Number.parseInt(row.after.elapsed) - Number.parseInt(row.before.elapsed) + 2)
    const independent = large.costs.taskUnionMs <= budget.taskUnionMs && large.costs.statistics.Layout.totalMs <= budget.layoutMs
    result.costOracle = { local, independent, taskMs: large.costs.taskUnionMs, layoutMs: large.costs.statistics.Layout.totalMs }
    assert.ok(local && independent, 'Waiting animation must stay local and independent of unrelated retained workfaces')
    if (mode === 'candidate') { await observe(16000, 7); const live = await observe(16000, 1, true); result.input = await inputProof(); result.behavior = await behaviorProof() }
    result.passed = true
  } catch (error) { result.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }; console.error(error)
    try { result.failureFacts = await facts() } catch {} }
  finally {
    try { await read('proof?.stop()') } catch {}
    if (stream) try { await send('IO.close', { handle: stream }) } catch {}
    if (tracing) try { await send('Tracing.end') } catch {}
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
    if (attached) try { win.webContents.debugger.detach() } catch {}
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
