const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { schema: 'agentmux.mote-render-cost-native.v1', passed: false, versions: process.versions,
  userAppOrRunTouched: false, physicalInputOrOsImeTested: false, visualReview: 'pending independent Agent review',
  boundary: 'Production SpaceObjectIcon/MoteIdentityMotion/MoteFace/motion owner/styles plus real xterm; isolated typed Session facts and local xterm onData sink. No Core/ctxmux Run, attachment or OS IME claim.', cases: [], frames: [] }
let win
const read = expression => win.webContents.executeJavaScript(expression)
const facts = () => read('proof.facts()')
const send = (command, params = {}) => win.webContents.debugger.sendCommand(command, params)
async function until(expression) {
  for (let i = 0; i < 200; i++) { if (await read(expression)) return; await delay(20) }
  throw new Error('Native condition not reached: ' + expression)
}
async function capture(label) {
  const image = await win.webContents.capturePage(), bytes = image.toPNG()
  assert.ok(!image.isEmpty() && bytes.length > 0)
  const file = label + '.png'; fs.writeFileSync(path.join(evidence, file), bytes)
  result.frames.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), size: image.getSize() })
}
async function trace(label, work) {
  await send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReturnAsStream' })
  await work()
  const complete = new Promise(resolve => {
    const listener = (_event, method, params) => { if (method === 'Tracing.tracingComplete') { win.webContents.debugger.removeListener('message', listener); resolve(params) } }
    win.webContents.debugger.on('message', listener)
  })
  await send('Tracing.end')
  const { stream } = await complete
  let json = ''
  while (true) { const chunk = await send('IO.read', { handle: stream }); json += chunk.data; if (chunk.eof) break }
  await send('IO.close', { handle: stream })
  fs.writeFileSync(path.join(evidence, label + '.trace.json'), json)
  const events = JSON.parse(json).traceEvents.sort((a, b) => a.ts - b.ts), layouts = []
  let svgDirty = false
  const sources = new Map(), rootNames = new Set()
  for (const event of events) {
    const data = event.args?.data
    if (event.name.endsWith('InvalidationTracking') && data && (data.nodeName?.includes('mote-face') || data.reason === 'SVG changed')) {
      svgDirty = true
      const key = data.nodeName + ' / ' + data.reason; sources.set(key, (sources.get(key) ?? 0) + 1)
    }
    if (event.name === 'Layout' && event.ph === 'X') {
      const roots = event.args?.endData?.layoutRoots ?? []
      for (const root of roots) rootNames.add(root.nodeName)
      layouts.push({ ms: (event.dur ?? 0) / 1000, svgDirty, documentRoot: roots.some(root => root.nodeName === '#document'),
        svgRoot: roots.some(root => root.nodeName?.includes("svg class='mote-face'")), details: event.args })
      svgDirty = false
    }
  }
  const attributed = layouts.filter(row => row.svgDirty), local = attributed.filter(row => row.svgRoot && !row.documentRoot)
  const duration = name => events.filter(e => e.name === name).reduce((n, e) => n + (e.dur ?? 0), 0) / 1000
  const average = rows => rows.reduce((n, r) => n + r.ms, 0) / Math.max(1, rows.length)
  return { layoutMs: duration('Layout'), styleMs: duration('UpdateLayoutTree'), paintMs: duration('Paint'), layouts: layouts.length,
    svgLayouts: attributed.length, localSvgLayouts: local.length, documentSvgLayouts: attributed.filter(row => row.documentRoot).length,
    svgAverageMs: average(attributed), localSvgAverageMs: average(local), rootNames: [...rootNames],
    sourceCounts: Object.fromEntries(sources), layoutExamples: layouts.slice(0, 4),
    paintExamples: events.filter(e => e.name === 'Paint').slice(0, 4).map(e => e.args), trace: label + '.trace.json' }
}
async function setBoundary(mutate) {
  // Revert the actual localization mechanism, without replacing the animation,
  // SVG tree, terminal consumer, retained work or any source file.
  await read(`(() => { document.getElementById('boundary-mutation')?.remove(); ${mutate ? `const s=document.createElement('style');s.id='boundary-mutation';s.textContent='.mote-identity-motion:has(.mote-face){display:inline-flex!important}';document.head.append(s);` : ''} })()`)
}
async function interactions(kind, before) {
  await read('proof.focus();proof.scrollToLine(900)')
  const r = before.terminal.rect, start = performance.now()
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), deltaX: 0, deltaY: -180 })
  await delay(50)
  const scrolled = await facts()
  assert.ok(scrolled.terminal.viewportY < 900, 'Actual xterm normal-buffer wheel scrolls upward during live output')
  await send('Input.insertText', { text: 'input-proof-' })
  await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  await send('Input.insertText', { text: '中文' })
  if (kind === 'pointer-state') {
    const face = before.faces[6].rect
    for (let i = 0; i < 12; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(face.x + face.width / 2 + (i % 2 ? 35 : -35)), y: Math.round(face.y + face.height / 2 - 12) })
      await delay(35)
    }
  }
  await delay(50)
  const after = await facts(), elapsedMs = performance.now() - start
  assert.ok(after.terminal.inputs.join('').includes('input-proof-中文'), 'Committed keyboard and composition reach real xterm onData')
  assert.ok(after.terminal.compositions.some(row => row.name === 'compositionstart'))
  assert.ok(after.terminal.compositions.some(row => row.name === 'compositionend' && row.data === '中文'))
  assert.equal(after.terminal.focused, true)
  return { elapsedMs, scrolled: scrolled.terminal, terminal: after.terminal, gaze: after.faces.map(row => row.gaze) }
}
function geometry(state) { return { faces: state.faces.map(row => row.rect), buttons: state.buttons.map(row => row.rect), terminal: state.terminal.rect } }
function visibleOriginal(state) {
  assert.equal(state.faces.length, 8)
  assert.ok(state.faces.every(row => row.motion === 'on' && row.visible === 'on' && row.animations.length > 0 && row.overflow === 'visible'))
  assert.ok(state.buttons.every(row => row.hit && row.rect.width > 0 && row.rect.height > 0))
  assert.deepEqual(state.errors, [])
}
async function sample(boundary, kind, scale) {
  await setBoundary(boundary === 'mutation')
  await read(`proof.scale(${scale});proof.trigger(${JSON.stringify(kind)})`)
  await until(`proof.facts().faces.every(n=>n.motion==='on'&&n.expression===${JSON.stringify(kind === 'pointer-state' ? 'starting' : 'idle')})`)
  // Seek the original CSS animations to the same active phase, then let their
  // native timelines run; no alternate keyframes or accelerated duration.
  await read("for(const n of document.querySelectorAll('.mote-identity-motion'))for(const a of n.getAnimations({subtree:true}))a.currentTime=0")
  const before = await facts(); visibleOriginal(before)
  const label = `${boundary}-${kind}-${scale}`
  let interaction, dynamic
  const costs = await trace(label, async () => {
    interaction = await interactions(kind, before)
    await delay(120)
    dynamic = await facts()
    if (boundary === 'candidate' && scale === 16000) await capture(label + '-moving')
    await delay(kind === 'pointer-state' ? 500 : 950)
  })
  const after = await facts(); await read('proof.stop()')
  visibleOriginal(after)
  assert.deepEqual(geometry(after), geometry(before), 'Motion/input keeps the original slots, terminal geometry and hit rectangles')
  assert.deepEqual(after.faces.map(row => row.svg), before.faces.map(row => row.svg), 'The selected SVG parts/colors remain original')
  assert.ok(after.terminal.output - before.terminal.output >= 20, 'Nonempty live xterm output continues throughout observation')
  assert.ok(costs.svgLayouts > 0 && Object.keys(costs.sourceCounts).length > 0, 'Actual SVG animation invalidations and layout are nonempty')
  if (kind === 'pointer-state') assert.ok(interaction.gaze.some(value => value !== 'matrix(1, 0, 0, 1, 0, 0)' && value !== 'none'), 'Original pointer rig moves during actual state animation')
  else assert.notDeepEqual(dynamic.faces.map(row => [row.head, row.transform]), before.faces.map(row => [row.head, row.transform]), 'Original native part animations visibly progress')
  const row = { boundary, kind, scale, before, after, dynamic, interaction, costs }; result.cases.push(row)
  console.log(JSON.stringify({ boundary, kind, scale, layouts: costs.layouts, layoutMs: costs.layoutMs, localSvgLayouts: costs.localSvgLayouts, documentSvgLayouts: costs.documentSvgLayouts, svgAverageMs: costs.svgAverageMs }))
  return row
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1180, height: 820, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.proof?.ready'); await until("proof.facts().faces.length===8&&proof.facts().faces.every(n=>n.motion==='on')")
    await capture('original-visible-slots')
    for (const kind of ['ambient-gesture', 'pointer-state']) {
      const small = await sample('candidate', kind, 200), large = await sample('candidate', kind, 16000)
      const mutationSmall = await sample('mutation', kind, 200), mutationLarge = await sample('mutation', kind, 16000)
      assert.deepEqual(geometry(mutationLarge.before), geometry(large.before), 'Reverting boundary keeps identical slot/focus/hit/input geometry')
      const costBudget = small.costs.svgAverageMs * 1.8
      // A scope failure needs measured cost amplification in the same run. Root
      // names/totalObjects by themselves never stand for all-node reflow.
      const oracle = row => !(row.costs.documentSvgLayouts / row.costs.svgLayouts > .8 && row.costs.svgAverageMs > costBudget)
      assert.ok(large.costs.localSvgLayouts > 0, 'Candidate actually relayouts SVG locally')
      assert.ok(large.costs.localSvgAverageMs <= small.costs.localSvgAverageMs * 2.5, 'Local SVG work does not scale with 80x unrelated retained faces')
      assert.equal(oracle(large), true, 'Actual localized consumer passes the scope/cost oracle')
      assert.equal(oracle(mutationLarge), false, 'Reverting real boundary fails the same scope/cost oracle')
      result[kind] = { costBudget, candidatePassed: true, mutationKilled: true, mutationScaleRatio: mutationLarge.costs.svgAverageMs / mutationSmall.costs.svgAverageMs }
    }
    const restored = await sample('restored', 'ambient-gesture', 16000)
    assert.ok(restored.costs.localSvgLayouts > 0 && restored.costs.documentSvgLayouts / restored.costs.svgLayouts < .8, 'Restoring candidate restores actual localization')
    await capture('restored-visible-slots')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await until("proof.facts().faces.every(n=>n.motion==='off'&&n.animations.length===0)")
    const reduced = await facts(); await capture('reduced-motion')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await until("proof.facts().faces.every(n=>n.motion==='on')")
    await read('setFacesVisible(false)'); await until("proof.facts().faces.every(n=>n.visible==='off'&&n.animations.length===0)")
    const hidden = await facts(); assert.equal(hidden.faces.length, 8)
    await read('setFacesVisible(true)'); await until("proof.facts().faces.every(n=>n.motion==='on')")
    await read("document.getElementById('faces').style.transform='translateX(-3000px)'")
    await until("proof.facts().faces.every(n=>n.visible==='off'&&n.animations.length===0)")
    const offscreen = await facts()
    await read("document.getElementById('faces').style.transform=''"); await until("proof.facts().faces.every(n=>n.motion==='on')")
    result.stopping = { reduced, hidden, offscreen, restored: await facts(), scope: 'Actual reduced-motion media, visible prop and IntersectionObserver. A hidden native window remains focus-emulated; no Page Visibility or physical OS IME claim.' }
    assert.deepEqual(geometry(reduced), geometry(result.stopping.restored))
    assert.deepEqual(result.stopping.restored.errors, [])
    result.passed = true
  } catch (error) { result.error = { message: error.message, stack: error.stack }; try { result.failureFacts = await facts() } catch {} console.error(error) }
  finally {
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) { try { win.webContents.debugger.detach() } catch {}; win.destroy() }
    app.exit(result.passed ? 0 : 1)
  }
})
