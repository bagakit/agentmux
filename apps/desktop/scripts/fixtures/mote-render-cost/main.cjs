const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
const { createHash } = require('node:crypto'),
  { gzipSync } = require('node:zlib')
const [html, privateRoot, evidence, mode, referenceFile] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hash = (b) => createHash('sha256').update(b).digest('hex')
const result = {
  schema: 'agentmux.mote-render-cost-native.v2',
  passed: false,
  mode,
  versions: process.versions,
  userAppOrRunTouched: false,
  physicalInputOrOsImeTested: false,
  visualReview: 'pending independent Agent review',
  boundary:
    'Production SpaceObjectIcon/MoteIdentityMotion/shared Face/motion/styles and real xterm. Isolated typed Session facts/local input sink; no Core/ctxmux Run or original freeze proof.',
  cases: [],
  frames: []
}
let win,
  attached = false,
  tracing = false,
  stream
const read = (expression) => win.webContents.executeJavaScript(expression),
  facts = () => read('proof.facts()')
const send = (method, params = {}) => win.webContents.debugger.sendCommand(method, params)
async function until(expression) {
  for (let i = 0; i < 250; i++) {
    if (await read(expression)) return
    await delay(20)
  }
  throw Error('Native condition not reached: ' + expression)
}
async function capture(label) {
  await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await delay(50)
  const target = await facts()
  const image = await win.webContents.capturePage(),
    bytes = image.toPNG()
  assert.ok(!image.isEmpty())
  fs.writeFileSync(path.join(evidence, label + '.png'), bytes)
  result.frames.push({
    file: label + '.png',
    sha256: hash(bytes),
    size: image.getSize(),
    capturedAt: Date.now(),
    target: target.faces.map((face) => ({
      expression: face.expression,
      parts: face.selectedParts,
      bones: face.bones
    }))
  })
  return image
}
function geometry(state) {
  return {
    faces: state.faces.map((f) => f.rect),
    buttons: state.buttons.map((b) => b.rect),
    terminal: state.terminal.rect
  }
}
function visibleOriginal(state) {
  assert.equal(state.faces.length, 8)
  assert.equal(state.visibility, 'visible')
  assert.deepEqual(state.errors, [])
  assert.ok(
    state.faces.every(
      (f) =>
        f.motion === 'on' &&
        f.visible === 'on' &&
        f.animations.some((a) => a.state === 'running') &&
        f.overflow === 'visible' &&
        f.viewBox === '0 0 64 64'
    )
  )
  if (mode === 'candidate')
    assert.ok(
      state.faces.every(
        (f) =>
          f.drawingModels.length > 0 &&
          f.drawingModels.every((d) => d.width === '64px' && d.height === '64px' && d.overflow === 'visible')
      ),
      'Static drawing leaves keep 64-unit model dimensions under all actual host size selectors'
    )
  assert.ok(state.buttons.every((b) => b.hit && b.rect.width > 0 && b.rect.height > 0))
  assert.ok(
    state.faces.every((f) => f.drawingAnimations.length === 0),
    'Static drawings never join generic presence/gesture animation'
  )
}
async function pixelSample(state) {
  const image = await win.webContents.capturePage(),
    size = image.getSize(),
    scale = { x: size.width / state.viewport.width, y: size.height / state.viewport.height }
  const pixels = state.faces.map((f) => {
    const r = f.rect,
      region = {
        x: Math.max(0, Math.floor((r.x - 5) * scale.x)),
        y: Math.max(0, Math.floor((r.y - 5) * scale.y)),
        width: Math.ceil((r.width + 10) * scale.x),
        height: Math.ceil((r.height + 10) * scale.y)
      }
    region.width = Math.min(region.width, size.width - region.x)
    region.height = Math.min(region.height, size.height - region.y)
    const crop = image.crop(region)
    return { region, sha256: hash(crop.toBitmap()) }
  })
  return {
    at: Date.now(),
    scale,
    imageSize: size,
    faces: state.faces.map((f) => ({
      expression: f.expression,
      bones: f.bones.map((b) => ({ name: b.name, transform: b.transform }))
    })),
    pixels
  }
}
async function trace(label, work) {
  let resolveComplete
  const complete = new Promise((resolve) => {
    resolveComplete = resolve
  })
  const listener = (_e, method, p) => {
    if (method === 'Tracing.tracingComplete') resolveComplete(p)
  }
  win.webContents.debugger.on('message', listener)
  try {
    await send('Tracing.start', {
      categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,toplevel,v8.execute',
      options: 'record-until-full',
      transferMode: 'ReturnAsStream'
    })
    tracing = true
    await work()
    await send('Tracing.end')
    tracing = false
    const done = await Promise.race([
      complete,
      delay(5000).then(() => {
        throw Error('Trace did not complete')
      })
    ])
    assert.equal(done.dataLossOccurred, false, 'Full non-loss trace required')
    assert.ok(done.stream)
    stream = done.stream
    const chunks = []
    for (;;) {
      const c = await send('IO.read', { handle: stream, size: 1024 * 1024 })
      chunks.push(Buffer.from(c.data, c.base64Encoded ? 'base64' : 'utf8'))
      if (c.eof) break
    }
    await send('IO.close', { handle: stream })
    stream = undefined
    const bytes = Buffer.concat(chunks),
      events = JSON.parse(bytes.toString('utf8')).traceEvents,
      pid = win.webContents.getOSProcessId(),
      tid = events.find(
        (e) => e.pid === pid && e.name === 'thread_name' && e.args?.name === 'CrRendererMain'
      )?.tid
    assert.ok(tid, 'Actual Renderer main thread present')
    const main = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X'),
      statistics = {}
    for (const e of main) {
      const s = (statistics[e.name] ??= { count: 0, totalMs: 0, maxMs: 0 })
      s.count++
      s.totalMs += e.dur / 1000
      s.maxMs = Math.max(s.maxMs, e.dur / 1000)
    }
    const tasks = main.filter((e) => e.name === 'ThreadControllerImpl::RunTask')
    assert.ok(
      tasks.length > 0 && tasks.every((e) => Number.isFinite(e.dur) && e.dur > 0),
      'Main task timing is nonempty and finite'
    )
    assert.ok(
      statistics.Layerize?.count > 0 && statistics.Layerize.totalMs > 0,
      'Native pipeline timing is observed'
    )
    let union = 0,
      last = -Infinity
    for (const e of tasks.sort((a, b) => a.ts - b.ts)) {
      union += Math.max(0, e.ts + e.dur - Math.max(e.ts, last))
      last = Math.max(last, e.ts + e.dur)
    }
    fs.writeFileSync(path.join(evidence, label + '.trace.json.gz.tmp'), gzipSync(bytes))
    fs.renameSync(
      path.join(evidence, label + '.trace.json.gz.tmp'),
      path.join(evidence, label + '.trace.json.gz')
    )
    return {
      rendererPid: pid,
      mainTid: tid,
      events: events.length,
      dataLoss: false,
      taskUnionMs: union / 1000,
      statistics,
      trace: label + '.trace.json.gz'
    }
  } finally {
    win.webContents.debugger.off('message', listener)
  }
}
async function interactions(before) {
  await read('proof.focus();proof.scrollToLine(900)')
  const r = before.terminal.rect,
    x = Math.round(r.x + r.width / 2),
    y = Math.round(r.y + r.height / 2)
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -180 })
  await delay(60)
  const up = await facts()
  assert.ok(up.terminal.viewportY < 900, 'Real xterm reads upward during live output')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 180 })
  await delay(60)
  const down = await facts()
  assert.ok(down.terminal.viewportY > up.terminal.viewportY, 'Real xterm reads downward during live output')
  await send('Input.insertText', { text: 'input-proof-' })
  await send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  await send('Input.insertText', { text: '中文' })
  await delay(60)
  const after = await facts()
  assert.ok(after.terminal.inputs.join('').includes('input-proof-中文'))
  assert.ok(after.terminal.compositions.some((e) => e.name === 'compositionend' && e.data === '中文'))
  assert.equal(after.terminal.focused, true)
  return { up: up.terminal, down: down.terminal, after: after.terminal }
}
async function sample(scale) {
  await read(`proof.scale(${scale});proof.trigger('ambient')`)
  await until("proof.facts().faces.every(f=>f.motion==='on'&&f.expression==='idle')")
  const before = await facts()
  visibleOriginal(before)
  const start = Date.now(),
    samples = [],
    label = mode + '-ambient-' + scale
  const costs = await trace(label, async () => {
    for (let i = 0; i < 7; i++) {
      await delay(2000)
      const state = await facts()
      visibleOriginal(state)
      samples.push(await pixelSample(state))
    }
  })
  const after = await facts()
  visibleOriginal(after)
  assert.deepEqual(geometry(after), geometry(before))
  assert.ok(
    after.terminal.completedOutput - before.terminal.completedOutput > 250,
    'Sustained real output present for the complete cycle'
  )
  const pixelChanges = before.faces.map((_, i) => new Set(samples.map((s) => s.pixels[i].sha256)).size),
    matrixChanges = before.faces.map(
      (_, i) => new Set(samples.map((s) => JSON.stringify(s.faces[i].bones))).size
    )
  assert.ok(
    pixelChanges.every((n) => n > 1),
    'Each avatar has progressing actual bitmap pixels in a full natural cycle'
  )
  assert.ok(
    matrixChanges.every((n) => n > 1),
    'Each avatar has progressing native part transforms'
  )
  assert.equal(win.isVisible(), true, 'Ordinary native presentation remains visible throughout the cycle')
  const row = {
    scale,
    label,
    before,
    after,
    costs,
    natural: { spanMs: Date.now() - start, pixelChanges, matrixChanges, samples },
    interaction: await interactions(after)
  }
  result.cases.push(row)
  await capture(label + '-full')
  await read('proof.stop()')
  return row
}
function withinBudget(row, budget) {
  return (
    row.costs.taskUnionMs <= budget.taskUnionMs && row.costs.statistics.Layerize.totalMs <= budget.layerizeMs
  )
}
async function neutralProof() {
  const parts = await read('proof.parts'),
    base = await read('proof.defaultFace'),
    choices = []
  for (const [part, values] of Object.entries(parts))
    for (const value of values)
      choices.push({ label: part + ':' + value, choice: { ...base, [part]: value } })
  for (const shape of parts.shape)
    for (const accessory of parts.accessory)
      choices.push({
        label: 'head:' + shape + ':' + accessory,
        choice: { ...base, shape, accessory, marking: 'blush' }
      })
  const rows = []
  await read(
    "(()=>{const s=document.createElement('style');s.id='neutral-only';s.textContent='.mote-identity-motion *{animation:none!important;transition:none!important;transform:none!important}';document.head.append(s)})()"
  )
  try {
    for (const { label, choice } of choices) {
      await read(`proof.choose(${JSON.stringify(choice)})`)
      await delay(20)
      const state = await read('proof.facts(true)')
      rows.push({
        label,
        parts: state.faces[0].selectedParts,
        bones: state.faces[0].bones.filter((b) =>
          ['head', 'brows', 'eyes', 'gaze', 'mouth', 'neck'].includes(b.name)
        )
      })
    }
    await read(`proof.choose(${JSON.stringify(base)});setFacesSleeping(true)`)
    await until("proof.facts().faces.every(f=>f.expression==='sleep')")
    rows.push({
      label: 'sleep',
      bones: (await read('proof.facts(true)')).faces[0].bones.filter((b) =>
        ['head', 'brows', 'eyes', 'gaze', 'mouth', 'neck'].includes(b.name)
      )
    })
    await capture('sleep-neutral')
    await read('setFacesSleeping(false)')
    await until("proof.facts().faces.every(f=>f.expression==='idle')")
    await capture('awake-neutral')
    return rows
  } finally {
    await read("document.getElementById('neutral-only')?.remove()")
    await until("proof.facts().faces.every(f=>f.motion==='on'&&f.animations.some(a=>a.state==='running'))")
  }
}
async function behaviorProof() {
  await read("proof.trigger('pointer-state')")
  await until("proof.facts().faces.every(f=>f.expression==='starting')")
  const before = await facts(),
    target = before.faces[6].rect,
    poses = []
  await capture('pointer-gesture-before')
  for (const offset of [29.25, 30.5, 31.75, 33.125]) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: target.x + target.width / 2 + offset,
      y: target.y + target.height / 2 - 12.375
    })
    await delay(160)
    poses.push(await facts())
  }
  assert.ok(
    new Set(poses.map((s) => s.faces[6].gaze)).size > 1,
    'Real original pointer owner carries fractional continuous motion with state animation'
  )
  await read("document.querySelectorAll('.mote-identity-motion').forEach(n=>n.dataset.moteGesture='smile')")
  await delay(350)
  const combined = await facts()
  assert.ok(
    combined.faces.some((f) => f.animations.some((a) => a.name === 'mote-gesture-smile')),
    'Native gesture composes with existing state and pointer'
  )
  await capture('combined-pointer-state-gesture')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: before.viewport.height - 1 })
  await delay(1600)
  await capture('pointer-gesture-settled')
  await read('proof.stop()')
  // Actual React updates, preserving every selected authored part. This is not an all-Cartesian drawing test.
  const choices = await read('proof.parts'),
    base = await read('proof.defaultFace'),
    updates = []
  for (const [part, values] of Object.entries(choices))
    for (const value of values) {
      await read(`proof.choose(${JSON.stringify({ ...base, [part]: value })})`)
      await delay(20)
      const state = await facts()
      assert.equal(state.faces[0].selectedParts['data-mote-face-' + part], value)
      assert.deepEqual(state.errors, [])
      updates.push({ part, value })
    }
  for (const [name, choice] of Object.entries({
    beard: {
      ...base,
      shape: 'diamond',
      accessory: 'beard',
      palette: 'cocoa',
      mouth: 'smirk',
      marking: 'freckles'
    },
    horns: {
      ...base,
      shape: 'slim',
      accessory: 'horns',
      eyes: 'lashes',
      brows: 'bold',
      nose: 'bridge',
      marking: 'blush'
    },
    glasses: { ...base, shape: 'slim', accessory: 'glasses', eyes: 'wink', mouth: 'cat', nose: 'round' }
  })) {
    await read(`proof.choose(${JSON.stringify(choice)})`)
    await delay(160)
    await capture('parts-' + name)
  }
  await read(`proof.choose(${JSON.stringify(base)});proof.trigger('ambient')`)
  await until("proof.facts().faces.every(f=>f.motion==='on')")
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await until("proof.facts().faces.every(f=>f.motion==='off'&&f.animations.length===0)")
  const reduced = await facts()
  await capture('reduced-motion')
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
  })
  await until("proof.facts().faces.every(f=>f.motion==='on')")
  await read('setFacesVisible(false)')
  await until("proof.facts().faces.every(f=>f.visible==='off'&&f.animations.length===0)")
  const hidden = await facts()
  await read('setFacesVisible(true)')
  await until("proof.facts().faces.every(f=>f.motion==='on')")
  await read("document.getElementById('faces').style.transform='translateX(-3000px)'")
  await until("proof.facts().faces.every(f=>f.visible==='off'&&f.animations.length===0)")
  const offscreen = await facts()
  await read("document.getElementById('faces').style.transform=''")
  await until("proof.facts().faces.every(f=>f.motion==='on')")
  const restored = await facts()
  assert.deepEqual(geometry(restored), geometry(reduced))
  assert.deepEqual(restored.errors, [])
  await capture('restored-slots')
  return {
    poses,
    combined,
    updates,
    reduced,
    hidden,
    offscreen,
    restored,
    scope:
      'Real original motion owner/IntersectionObserver/media/React choices and CDP trusted native input. Composition is Chromium input, not OS IME. No user Core Run.'
  }
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      width: 1180,
      height: 820,
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    })
    win.showInactive()
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    attached = true
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('window.proof?.ready')
    await until("proof.facts().faces.length===8&&proof.facts().faces.every(f=>f.motion==='on')")
    result.native = {
      pid: process.pid,
      rendererPid: win.webContents.getOSProcessId(),
      offscreen: win.webContents.isOffscreen(),
      windowVisible: win.isVisible(),
      backgroundThrottling: win.webContents.getBackgroundThrottling(),
      gpu: app.getGPUFeatureStatus(),
      presentation:
        'ordinary native window shown without focus; CDP focus emulation and scale-qualified bitmap captures',
      initial: await facts()
    }
    assert.equal(result.native.offscreen, false)
    assert.equal(result.native.windowVisible, true)
    result.neutral = await neutralProof()
    await capture('original-slots')
    const small = await sample(200),
      large = await sample(16000)
    const reference = referenceFile ? JSON.parse(fs.readFileSync(referenceFile, 'utf8')) : null
    const budget = reference?.budget ?? {
      taskUnionMs: small.costs.taskUnionMs * 1.8 + 100,
      layerizeMs: small.costs.statistics.Layerize.totalMs * 1.8 + 25
    }
    result.budget = budget
    result.costOracle = {
      task: large.costs.taskUnionMs,
      layerize: large.costs.statistics.Layerize.totalMs,
      withinBudget: withinBudget(large, budget)
    }
    assert.ok(
      result.costOracle.withinBudget,
      'Direct natural render cost exceeds same fixed-relevant-consumer budget'
    )
    if (mode === 'candidate') result.behavior = await behaviorProof()
    result.passed = true
  } catch (error) {
    result.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }
    try {
      result.failureFacts = await facts()
    } catch {}
    console.error(error)
  } finally {
    try {
      await read('proof?.stop()')
    } catch {}
    if (stream)
      try {
        await send('IO.close', { handle: stream })
      } catch {}
    if (tracing)
      try {
        await send('Tracing.end')
      } catch {}
    fs.writeFileSync(path.join(evidence, 'receipt.json.tmp'), JSON.stringify(result, null, 2))
    fs.renameSync(path.join(evidence, 'receipt.json.tmp'), path.join(evidence, 'receipt.json'))
    if (win && !win.isDestroyed()) {
      if (attached)
        try {
          win.webContents.debugger.detach()
        } catch {}
      win.destroy()
    }
    app.exit(result.passed ? 0 : 1)
  }
})
