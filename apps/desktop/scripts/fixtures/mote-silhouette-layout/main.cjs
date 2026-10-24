const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto'), { gzipSync } = require('node:zlib')
const [html, privateRoot, evidence, mode, referenceFile] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
// Match a continuously presented foreground workload without stealing the user's focus.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { schema: 'agentmux.mote-silhouette-layout-native.v1', passed: false, mode, versions: process.versions,
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
    const isLocalRoot = root => root.nodeName?.startsWith('svg ') || root.nodeName === "DIV class='mote-avatar-crop__stage'"
    const bounded = layouts.filter(e => e.args?.beginData?.partialLayout && e.args?.endData?.layoutRoots?.length > 0 && e.args.endData.layoutRoots.every(isLocalRoot))
    const local = layouts.filter(e => e.args?.beginData?.partialLayout && e.args?.endData?.layoutRoots?.length > 0 && e.args.endData.layoutRoots.every(r => r.nodeName?.startsWith('svg ')))
    const global = layouts.filter(e => e.args?.endData?.layoutRoots?.some(r => r.nodeName === '#document'))
    const invalidations = events.filter(e => e.pid === pid && e.name === 'LayoutInvalidationTracking')
    return { rendererPid: pid, mainTid: tid, events: events.length, trace: label + '.trace.json.gz', taskUnionMs: unionMs(tasks), statistics,
      localLayouts: local.length, boundedLayouts: bounded.length, escapedLayouts: layouts.length - bounded.length, documentLayouts: global.length,
      localLayoutMs: local.reduce((sum, e) => sum + e.dur / 1000, 0),
      layoutObjects: [...new Set(layouts.map(e => e.args?.beginData?.totalObjects))],
      rootExamples: layouts.slice(0, 4).map(e => e.args),
      invalidationExamples: invalidations.slice(0, 12).map(e => e.args) }
  } finally { win.webContents.debugger.off('message', listener) }
}
function visible(state) {
  assert.deepEqual(state.errors, []); assert.equal(state.slots.length, 7)
  for (const slot of state.slots) { assert.equal(slot.motion, 'on', slot.slot + ' original motion enabled'); assert.equal(slot.visible, 'on'); assert.ok(slot.svgRect.width > 0 && slot.svgRect.height > 0); assert.ok(slot.animations.length > 0) }
  assert.equal(state.slots.find(s => s.slot === 'preview').rect.width, 104, 'Original avatar preview consumes its direct-child slot rule')
  assert.equal(state.buttons.length, 5); for (const button of state.buttons) assert.equal(button.hit, true, button.slot + ' original hit target')
}
async function pixels(state, frame) {
  const image = await win.webContents.capturePage(), size = image.getSize(), scale = { x: size.width / state.viewport.width, y: size.height / state.viewport.height }
  if (frame) { const bytes = image.toPNG(); fs.writeFileSync(path.join(evidence, frame), bytes); result.frames.push({ file: frame, sha256: hash(bytes) }) }
  return { at: Date.now(), scale, slots: state.slots.map(slot => { const r = slot.svgRect, region = { x: Math.max(0, Math.floor(r.x * scale.x)), y: Math.max(0, Math.floor(r.y * scale.y)), width: Math.ceil(r.width * scale.x), height: Math.ceil(r.height * scale.y) }; assert.ok(region.width > 0 && region.height > 0); return { slot: slot.slot, region, hash: hash(image.crop(region).toBitmap()), bones: slot.bones } }) }
}
async function capture(label) { const bytes = (await win.webContents.capturePage()).toPNG(); fs.writeFileSync(path.join(evidence, label + '.png'), bytes); result.frames.push({ file: label + '.png', sha256: hash(bytes) }) }
const geometry = state => state.slots.map(slot => ({ slot: slot.slot, rect: slot.rect, svgRect: slot.svgRect }))
async function observe(scale, additional = false, live = false) {
  await read(`proof.scale(${scale});proof.extra(${additional});proof.output(${live});proof.neighbours(${live})`); await delay(200)
  await read('proof.reset()')
  if (mode === 'smoke') await read('document.querySelectorAll(".mote-identity-motion").forEach(n=>n.getAnimations({subtree:true}).forEach(a=>a.currentTime=11000))')
  const before = await facts(); visible(before); const samples = [], label = `${mode}-${scale}-${additional ? 'more' : 'fixed'}-${live ? 'live' : 'idle'}`
  const costs = await trace(label, async () => { let start = Date.now(); for (const offset of mode === 'smoke' ? [0, 1200, 2400, 3200] : [0, 2800, 5600, 8400, 11000, 11600, 12400, 13200, 14100]) { await delay(Math.max(0, start + offset - Date.now())); const state = await facts(); const sample = await pixels(state, mode === 'candidate' && scale === 200 ? `cycle-${offset}.png` : undefined); samples.push(sample); if (offset === 0) start = sample.at } })
  const after = await facts(); visible(after); assert.deepEqual(geometry(after), geometry(before), 'Natural motion preserves all original external slots')
  for (const slot of before.slots) { assert.ok(new Set(samples.map(sample => sample.slots.find(s => s.slot === slot.slot).hash)).size > 1, slot.slot + ' visibly moves'); assert.ok(new Set(samples.map(sample => JSON.stringify(sample.slots.find(s => s.slot === slot.slot).bones))).size > 1, slot.slot + ' native part matrices move') }
  if (mode !== 'smoke') assert.ok(samples.at(-1).at - samples[0].at >= 14000)
  if (live) assert.ok(after.terminal.completed - before.terminal.completed > 200)
  const row = { scale, additional, live, before, after, samples, costs }; result.cases.push(row); await capture(label); return row
}
async function inputProof() {
  await read('proof.output(true);proof.focus();proof.scroll(900)'); const before = await facts(), r = before.terminal.rect
  const wheel = deltaY => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), deltaX: 0, deltaY })
  await wheel(-180); await delay(80); const up = await facts(); assert.ok(up.terminal.viewportY < 900)
  await wheel(180); await delay(80); const down = await facts(); assert.ok(down.terminal.viewportY > up.terminal.viewportY)
  await send('Input.insertText', { text: 'silhouette-' }); await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await send('Input.insertText', { text: '中文' }); await delay(80)
  const after = await facts(); assert.ok(after.terminal.inputs.join('').includes('silhouette-中文')); assert.ok(after.terminal.compositions.some(e => e.name === 'compositionend' && e.data === '中文')); assert.equal(after.terminal.focused, true)
  await read('document.querySelector("[data-slot-button=footer]").click()'); assert.equal((await facts()).clicks, 1); return { before, up, down, after }
}
async function focusSlotProof() {
  // Reuse the rendered original icon and the exact FocusToolbar host/container CSS.
  // This exercises presentation, not the Dropdown's navigation or business action.
  await read(`(() => { const button=document.querySelector('[data-slot-button=rail]'), host=document.createElement('div'); window.focusSlot={button,originalClass:button.className,host}; host.className='focus-toolbar__context'; host.style.width='420px'; button.replaceWith(host); host.append(button); button.removeAttribute('data-slot-button'); button.className='focus-toolbar__mote-choice'; })()`)
  const values = []
  try {
    for (const [label, width, edge] of [['focus-toolbar-14', 420, 14], ['focus-toolbar-narrow-12', 300, 12]]) {
      await read(`focusSlot.host.style.width='${width}px';focusSlot.button.focus()`); await delay(120)
      const state = await facts(), slot = state.slots.find(s => s.slot === 'rail'); assert.equal(slot.svgRect.width, edge); assert.equal(slot.svgRect.height, edge)
      assert.equal(await read('document.activeElement===focusSlot.button'), true)
      assert.equal(await read('(() => { const r=focusSlot.button.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest("button")===focusSlot.button })()'), true)
      values.push({ label, slot }); await capture(label)
    }
    await read(`(() => { const f=focusSlot; f.host.style.width='420px'; f.item=document.createElement('div'); f.item.className='tab-context-menu__item focus-chat-mote-menu__item'; f.item.setAttribute('role','menuitemradio'); f.item.tabIndex=0; const icon=document.createElement('span'); icon.className='focus-chat-mote-menu__icon'; icon.append(...f.button.childNodes); f.item.append(icon); f.button.replaceWith(f.item); f.item.focus(); })()`); await delay(120)
    const state = await facts(), slot = state.slots.find(s => s.slot === 'rail'); assert.equal(slot.svgRect.width, 20); assert.equal(slot.svgRect.height, 20); assert.equal(await read('document.activeElement===focusSlot.item'), true)
    values.push({ label: 'focus-menu-20', slot }); await capture('focus-menu-20')
  } finally {
    await read(`(() => { const f=focusSlot; if(f.item)f.button.append(...f.item.querySelector('.focus-chat-mote-menu__icon').childNodes); f.host.replaceWith(f.button); f.button.className=f.originalClass; f.button.dataset.slotButton='rail'; delete window.focusSlot; proof.focus(); })()`)
  }
  return values
}
async function behaviorProof() {
  await read('proof.output(false);proof.extra(false);proof.neighbours(true)'); await delay(100)
  const appearances = []
  for (const id of await read('proof.ids')) { await read(`proof.choose(${JSON.stringify(id)})`); await delay(80); const state = await facts(); visible(state); appearances.push({ id, slots: geometry(state) }); await capture('appearance-' + id) }
  const states = []
  for (const value of ['thinking', 'tool', 'starting', 'waiting', 'identity']) { await read(`proof.state(${JSON.stringify(value)})`); await until(`proof.facts().slots.filter(s=>s.slot!=="crop").every(s=>s.expression===${JSON.stringify(value)})`); await delay(160); states.push({ value, slots: (await facts()).slots }); await capture('state-' + value) }
  await read('proof.choose("retro-future");proof.size(64)'); await delay(100); await capture('directory-64'); await read('proof.size(45)')
  const focusSlots = await focusSlotProof()
  await read('proof.theme(true)'); await delay(120); await capture('light-slots'); await read('proof.theme(false)')
  const chipFacts = await read('[...document.querySelectorAll("[data-static-chip]")].map(n=>({size:Number(n.dataset.staticChip),width:n.querySelector("svg").getBoundingClientRect().width,animated:!!n.querySelector(".mote-identity-motion")}))'); assert.equal(chipFacts.length,2); for(const chip of chipFacts){assert.equal(chip.width,chip.size);assert.equal(chip.animated,false)}
  const cropBefore = await read('({width:document.querySelector("canvas").width,height:document.querySelector("canvas").height})')
  await read(`(() => { const n=document.querySelector('input[type=range]'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(n,'1.8'); n.dispatchEvent(new Event('input',{bubbles:true})); n.dispatchEvent(new Event('change',{bubbles:true})); })()`); await delay(120); await capture('crop-zoom')
  assert.deepEqual(await read('({width:document.querySelector("canvas").width,height:document.querySelector("canvas").height})'), cropBefore)
  const crop = await read('(() => { const r=document.querySelector(".mote-avatar-crop__preview").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: crop.x, y: crop.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: crop.x + 14, y: crop.y + 10, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: crop.x + 14, y: crop.y + 10, button: 'left', buttons: 0, clickCount: 1 })
  await until('proof.facts().cropFrame.offsetX>0&&proof.facts().cropFrame.offsetY>0'); const cropPanned = (await facts()).cropFrame; await capture('crop-pan')
  await read('document.querySelector(".mote-avatar-crop__reset").click()'); await until('proof.facts().cropFrame.zoom===1&&proof.facts().cropFrame.offsetX===0&&proof.facts().cropFrame.offsetY===0')
  const original = await facts()
  await read('proof.visible(false)'); await until('proof.facts().slots.every(s=>s.motion!=="on")'); const hidden = await facts()
  await read('proof.visible(true)'); await until('proof.facts().slots.every(s=>s.motion==="on")')
  await read('proof.parked(true)'); await delay(150); const parked = await facts(); assert.ok(parked.slots.length > 0); assert.ok(parked.slots.every(slot => slot.animations.length === 0 || slot.animations.every(a => a.state === 'paused')))
  await read('proof.parked(false)'); await until('proof.facts().slots.every(s=>s.visible==="on")')
  await read('document.getElementById("original-slots").style.transform="translateX(-3000px)"'); await until('proof.facts().slots.every(s=>s.visible==="off")')
  await read('document.getElementById("original-slots").style.transform=""'); await until('proof.facts().slots.every(s=>s.visible==="on")')
  await send('Emulation.setFocusEmulationEnabled', { enabled: false }); win.webContents.setBackgroundThrottling(true); win.hide(); await until('proof.facts().visibility==="hidden"'); const background = await facts(); assert.ok(background.slots.length > 0); assert.ok(background.slots.every(slot => slot.motion === 'off')); win.showInactive(); win.webContents.setBackgroundThrottling(false); await send('Emulation.setFocusEmulationEnabled', { enabled: true }); await until('proof.facts().visibility==="visible"&&proof.facts().slots.every(s=>s.motion==="on")')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await until('proof.facts().slots.every(s=>s.motion==="off")'); const reduced = await facts(); await capture('reduced-motion')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); await until('proof.facts().slots.every(s=>s.motion==="on")')
  const first = original.slots[0].svgRect; await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x + first.width / 2 + 28, y: first.y + first.height / 2 }); await delay(150); const pointed = await facts(); await capture('pointer-near')
  await read('proof.gesture("curious")'); await delay(180); await capture('gesture-composition')
  win.setSize(740, 840); await delay(150); await capture('narrow-slots'); win.setSize(1280, 840); await delay(150)
  const restored = await facts(); visible(restored); return { appearances, states, focusSlots, cropPanned, original, hidden, parked, background, reduced, pointed, restored }
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1280, height: 840, show: false, focusable: false, skipTaskbar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); win.showInactive(); await win.loadFile(html); win.webContents.debugger.attach('1.3'); attached = true
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }); await until('window.proof?.ready&&proof.facts().cropReady&&proof.facts().slots.every(s=>s.motion==="on")')
    result.native = { rendererPid: win.webContents.getOSProcessId(), mainPid: process.pid, visible: win.isVisible(), offscreen: win.webContents.isOffscreen(), gpu: app.getGPUFeatureStatus() }; await capture('original-slots')
    if (mode === 'behavior') { result.input = await inputProof(); result.behavior = await behaviorProof() } else {
    const small = await observe(200), large = mode === 'smoke' ? small : await observe(16000)
    const reference = referenceFile ? JSON.parse(fs.readFileSync(referenceFile, 'utf8')) : null
    result.budget = reference?.budget ?? { taskUnionMs: small.costs.taskUnionMs * 2 + 100, layoutMs: small.costs.statistics.Layout.totalMs * 2 + 25 }
    result.costOracle = { local: [small, large].every(row => row.costs.localLayouts > 0 && row.costs.escapedLayouts === 0 && row.costs.documentLayouts === 0), independent: large.costs.taskUnionMs <= result.budget.taskUnionMs && large.costs.statistics.Layout.totalMs <= result.budget.layoutMs }
    assert.ok(result.costOracle.local && result.costOracle.independent, 'Original Mote silhouette consumers must keep part layout local and independent of unrelated workfaces')
    if (mode === 'candidate') { const related = await observe(16000, true); assert.equal(related.before.visibleMotionCount, large.before.visibleMotionCount + 6); assert.equal(related.costs.escapedLayouts, 0, 'Additional related consumers keep layout bounded'); await observe(16000, false, true); await read('proof.output(true)'); result.input = await inputProof(); result.behavior = await behaviorProof() }
    }
    result.passed = true
  } catch (error) { result.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }; console.error(error); try { result.failureFacts = await facts() } catch {} }
  finally { try { await read('proof?.stop()') } catch {}; if (stream) try { await send('IO.close', { handle: stream }) } catch {}; if (tracing) try { await send('Tracing.end') } catch {}
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(result, null, 2)); if (attached) try { win.webContents.debugger.detach() } catch {}; win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
