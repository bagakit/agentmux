const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { gzipSync } = require('node:zlib')

function observe() {
  const visible = element => { const bounds = element.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 44 && bounds.left < innerWidth && bounds.top < innerHeight && !element.closest('[hidden],[inert]') }
  const animations = [...document.getAnimations()].filter(animation => animation.effect?.target?.closest?.('.collaboration-map')).map(animation => {
    const target = animation.effect.target, style = getComputedStyle(target), timing = animation.effect.getComputedTiming()
    return { target: target.getAttribute('class'), tag: target.tagName, state: animation.playState, currentTime: animation.currentTime, progress: timing.progress, duration: timing.duration, iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations, delay: timing.delay, opacity: style.opacity, dashoffset: style.strokeDashoffset, offsetDistance: style.offsetDistance, visible: visible(target) }
  })
  const edges = [...document.querySelectorAll('.collaboration-map .react-flow__edge')].map(element => {
    const [kind, source, target] = JSON.parse(element.dataset.id), route = element.querySelector('.react-flow__edge-path'), bounds = route.getBoundingClientRect()
    const subject = value => { try { return JSON.parse(JSON.parse(value)[1])[1] } catch { return null } }
    return { id: element.dataset.id, kind, source: subject(source), target: subject(target), path: route.getAttribute('d'), visible: bounds.right > 0 && bounds.bottom > 44 && bounds.left < innerWidth && bounds.top < innerHeight, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }
  })
  return { at: performance.now(), wall: Date.now(), width: innerWidth, height: innerHeight, hidden: document.hidden, visibility: document.visibilityState,
    motion: document.querySelector('.collaboration-canvas')?.dataset.motion, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    camera: document.querySelector('.collaboration-map .react-flow__viewport')?.getAttribute('style'), nodes: document.querySelectorAll('*').length,
    visibleAgents: [...document.querySelectorAll('.collaboration-map [data-collaboration-agent]')].filter(visible).map(element => element.dataset.collaborationAgent).sort(),
    animations, edges, activity: window.graphCapture.activity(), controls: window.graphCapture.facts().controls }
}

function unionMS(events, lower = -Infinity, upper = Infinity) {
  const intervals = events.map(event => [Math.max(lower, event.ts), Math.min(upper, event.ts + event.dur)]).filter(([start, end]) => end > start).sort((first, second) => first[0] - second[0])
  let total = 0, end = -Infinity
  for (const [start, finish] of intervals) { total += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish) }
  return total / 1000
}

function assertNativeTravel(stages) {
  const first = stages.find(stage => stage.label === 'dispatch-dark-normal-start')
  const middle = stages.find(stage => stage.label === 'dispatch-dark-normal-middle')
  assert.ok(first && middle, 'Native start and middle observations are required')
  const paths = first.before.animations.filter(animation => animation.tag === 'path' && animation.target?.split(' ').includes('collaboration-edge__packet'))
  if (!paths.length) {
    assert.ok(first.before.activity.packets.length > 0, 'The original baseline packet is actually present')
    return
  }
  const numeric = value => {
    const match = /^(?:calc\()?(-?(?:\d+\.?\d*|\.\d+))px\)?$/.exec(value)
    assert.ok(match, 'Native computed stroke offset must resolve to one numeric length; unknown: ' + value)
    return Number(match[1])
  }
  const later = middle.before.animations.filter(animation => animation.tag === 'path' && animation.target?.split(' ').includes('collaboration-edge__packet'))
  assert.equal(paths.length, 1); assert.equal(later.length, 1)
  assert.ok(numeric(later[0].dashoffset) < numeric(paths[0].dashoffset) - .08, 'Native path head must advance continuously before the midpoint; animation running or a discrete late jump is not movement')
}

function summarize(events, rendererPid, startMark, endMark) {
  const thread = events.find(event => event.pid === rendererPid && event.name === 'thread_name' && event.args?.name === 'CrRendererMain')
  assert.ok(thread, 'Native Renderer main thread metadata is required')
  const begin = events.find(event => event.pid === rendererPid && event.name === startMark)?.ts
  const end = events.find(event => event.pid === rendererPid && event.name === endMark)?.ts
  assert.ok(Number.isFinite(begin) && end > begin, 'Real UserTiming observation bounds must exist')
  const main = events.filter(event => event.pid === rendererPid && event.tid === thread.tid && event.ph === 'X' && Number.isFinite(event.dur))
  const tasks = main.filter(event => event.name === 'ThreadControllerImpl::RunTask')
  assert.ok(tasks.length, 'A nonempty native task sample is required')
  const pipeline = /^(?:UpdateLayoutTree|RecalculateStyles|Layout|PrePaint|Paint|Layerize|Commit|CompositeLayers|UpdateLayerTree|IntersectionObserverController::computeIntersections)$/
  const windows = [[0, 1200], [1200, 3200], [3200, (end - begin) / 1000]].map(([from, to]) => {
    const lower = begin + from * 1000, upper = Math.min(end, begin + to * 1000), statistics = {}
    for (const event of main.filter(event => pipeline.test(event.name) && event.ts < upper && event.ts + event.dur > lower)) {
      const entry = statistics[event.name] ??= { count: 0, unionMS: 0, inclusiveMS: 0, maxMS: 0 }
      entry.count++; entry.inclusiveMS += Math.max(0, Math.min(upper, event.ts + event.dur) - Math.max(lower, event.ts)) / 1000
      entry.maxMS = Math.max(entry.maxMS, event.dur / 1000)
    }
    for (const [name, entry] of Object.entries(statistics)) entry.unionMS = unionMS(main.filter(event => event.name === name), lower, upper)
    return { fromMS: from, toMS: (upper - begin) / 1000, taskUnionMS: unionMS(tasks, lower, upper), statistics }
  })
  const invalidations = events.filter(event => event.pid === rendererPid && /InvalidationTracking/.test(event.name) && event.ts >= begin && event.ts <= end)
  const pipelineEvents = main.filter(event => pipeline.test(event.name) && event.ts >= begin && event.ts <= end)
  const composition = {}
  for (const event of events.filter(event => event.ph === 'X' && event.ts >= begin && event.ts <= end && /(?:DrawFrame|DrawAndSwap|SubmitCompositorFrame|BeginMainFrame|CommitToActiveTree|RasterTask|Layerize|CompositeLayers)/.test(event.name))) {
    const key = event.pid + ':' + event.tid + ':' + event.name, entry = composition[key] ??= { pid: event.pid, tid: event.tid, name: event.name, count: 0, inclusiveMS: 0 }
    entry.count++; entry.inclusiveMS += (event.dur ?? 0) / 1000
  }
  return { rendererPid, mainTid: thread.tid, traceEvents: events.length, beginUS: begin, endUS: end, observedMS: (end - begin) / 1000, taskUnionMS: unionMS(tasks, begin, end), windows, composition: Object.values(composition),
    invalidations: { count: invalidations.length, names: [...new Set(invalidations.map(event => event.name))], examples: invalidations.slice(0, 24).map(event => ({ name: event.name, atMS: (event.ts - begin) / 1000, args: event.args })) },
    layoutExamples: pipelineEvents.filter(event => event.name === 'Layout').slice(0, 12).map(event => event.args),
    boundary: 'Same-process same-thread task interval union is occupied wall time, not CPU; pipeline categories can overlap and are not summed. Inclusive composition values are diagnostics, not total GPU cost. Root/document/partialLayout/totalObjects alone are not a pass or fail.' }
}

module.exports = async function dispatchMotion({ win, result, read, click, key, move, frame, check, facts, intact, mapReady, closeDetails, locate, pause, until, settle, waitCamera, rect, evidence }) {
  const refresh = process.env.COLLABORATION_CAPTURE_MOTION_REFRESH === '1'
  const data = result.dispatchMotion = { schema: 'agentmux.dispatch-motion-native.v1', refresh, stages: [], policies: [], costs: [], retention: [],
    captureOnly: true, aestheticReview: 'not-performed', boundary: 'Original App/Store/Focus/Worker/Graph/SVG/CSS, controlled typed private platform events. No actual Provider dispatch, user Run, Terminal output, process restart, installed binary, public CLI navigation or physical refresh qualification.' }
  const send = (method, params) => win.webContents.debugger.sendCommand(method, params)
  const sample = () => read(`(${observe.toString()})()`)
  const preference = async value => { await read(`window.graphCapture.dispatchPreference(${JSON.stringify(value)})`); await settle() }
  const emit = (count = 1, dispatch = false) => read(`(()=>{const pairs=[['fixture-ui','fixture-core'],['fixture-core','fixture-ui'],['fixture-core','fixture-review'],['fixture-ui','fixture-design']];return Array.from({length:${count}},(_,index)=>{const [source,target]=pairs[index%pairs.length];return window.graphCapture.live(true,source,target,${JSON.stringify(dispatch ? 'dispatch-open' : 'message')})})})()`)
  const depart = async () => { await move('[aria-label="Find Agent in map"]'); await closeDetails(); await pause(400) }
  const waitFrom = async (start, offset) => pause(Math.max(0, start + offset - await read('performance.now()')))
  const stages = async (label, count, dispatch = false) => {
    await pause(3300)
    const events = await emit(count, dispatch), start = events[0].at
    for (const [phase, offset] of (refresh ? [['start', 90], ['middle', 460], ['arrival', 1030]] : [['start', 90], ['middle', 460], ['arrival', 1030], ['recent', 1570], ['static', 3440]])) {
      await waitFrom(start, offset)
      const before = await sample(), name = label + '-' + phase
      await frame(name, { motion: true })
      const after = await read('performance.now()')
      data.stages.push({ label: name, events, requestedMS: offset, before, captureRangeMS: [before.at - start, after - start] })
      if (label === 'dispatch-dark-normal' && phase === 'middle') assertNativeTravel(data.stages)
    }
  }
  await check('dispatch-native-stages', async () => {
    await click('button.surface-navigation__focus'); await click('[aria-label="Map"]'); await mapReady(); await read('window.graphCapture.rememberMap()')
    for (const id of ['fixture-review', 'fixture-design', 'fixture-ui', 'fixture-core']) { await locate(id); await mapReady() }
    await depart(); await preference('on'); await intact()
    await stages('dispatch-dark-normal', 1)
    await stages('dispatch-dark-dense', 16)
    await read('window.graphCapture.appearance("light")'); await settle(); await stages('dispatch-light-normal', 1)
    win.setContentSize(620, 820)
    await settle(); await locate('fixture-core'); await depart(); await stages('dispatch-narrow-light', 1)
    await read('window.graphCapture.appearance("dark")'); await settle(); await stages('dispatch-narrow-dark', 4)
    win.setContentSize(1440, 900); await settle(); await locate('fixture-core'); await depart()
    if (refresh) {
      for (let index = 0; index < 4; index++) await click('[aria-label="Zoom out"]')
      await waitCamera('frame', 'dispatch-low-zoom-middle'); await depart(); await pause(3300)
      const events = await emit(), start = events[0].at
      await waitFrom(start, 460)
      const before = await sample(), zoom = await read(`new DOMMatrix(getComputedStyle(document.querySelector('.collaboration-map .react-flow__viewport')).transform).a`)
      assert.ok(zoom > 0 && zoom < .8, 'The additional native middle frame must actually use a lower camera scale')
      await frame('dispatch-low-zoom-middle', { motion: true })
      data.stages.push({ label: 'dispatch-low-zoom-middle', events, requestedMS: 460, zoom, before, captureRangeMS: [before.at - start, await read('performance.now()') - start] })
      await locate('fixture-core'); await depart()
    } else await stages('dispatch-update-undirected', 1, true)
    await intact()
  })
  if (result.failures.length) return
  if (!refresh) await check('dispatch-native-motion-policies', async () => {
    for (const [label, choice, reduce] of [['off', 'off', false], ['system-reduce', 'system', true], ['explicit-on-reduce', 'on', true], ['system-normal', 'system', false]]) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] })
      await preference(choice); const events = await emit(); await waitFrom(events[0].at, 220)
      const observed = await sample(); await frame('dispatch-policy-' + label, { motion: true }); data.policies.push({ label, choice, reduce, events, observed })
      assert.equal(observed.motion, choice === 'off' || choice === 'system' && reduce ? 'off' : 'on')
      if (observed.motion === 'off') { assert.equal(observed.activity.paths.length, 0); assert.equal(observed.activity.packets.length, 0); assert.ok(observed.activity.markers.length > 0, 'Motion policy retains original recent event evidence') }
      await pause(3300)
    }
    await preference('on'); await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    const event = (await emit())[0]; await waitFrom(event.at, 220); await click('[aria-label="List"]'); await emit(4); await pause(1450)
    const inactive = await sample(); await frame('dispatch-hidden-list', { motion: true }); await click('[aria-label="Map"]'); await mapReady(); await depart()
    const restored = await sample(); await frame('dispatch-hidden-restored', { motion: true }); data.retainedVisibility = { protocol: 'Original Focus List/Map navigation', inactive, restored }
    assert.equal(restored.activity.paths.length, 0, 'Retained Map does not replay departed or hidden traffic')
    win.showInactive(); win.webContents.setBackgroundThrottling(true); await pause(100); win.hide(); await pause(150)
    const nativeHidden = await sample()
    await emit(); await pause(1450); win.showInactive(); await pause(150); win.webContents.setBackgroundThrottling(false); await settle()
    const nativeRestored = await sample(); await frame('dispatch-native-visibility-restored', { motion: true })
    data.nativeVisibility = { status: nativeHidden.hidden ? 'observed' : 'unknown', hidden: nativeHidden, restored: nativeRestored, boundary: 'Actual source BrowserWindow showInactive/hide and native document visibility; no visibility getter or event replacement. Unknown means native hidden policy was not measured.' }
    await pause(3300); await intact()
  })
  async function trace(label, count, retention) {
    await depart(); await pause(3300)
    const search = await rect('[aria-label="Find Agent in map"]')
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: search.x, y: search.y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: search.x, y: search.y, button: 'left', clickCount: 1 })
    const before = await sample(), beginMark = label + '-begin', endMark = label + '-end'
    const complete = new Promise(resolve => { var listener = (_event, method, params) => { if (method === 'Tracing.tracingComplete') resolve(params) }; trace.listener = listener; win.webContents.debugger.on('message', listener) })
    let tracing = false, stream
    try {
      await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,toplevel,disabled-by-default-devtools.timeline.invalidationTracking,blink.user_timing,cc,gpu,viz,input,latencyInfo', transferMode: 'ReturnAsStream' }); tracing = true
      await read(`(()=>{performance.mark(${JSON.stringify(beginMark)});const start=performance.now(),frames=[],longTasks=[],state={start,frames,longTasks,observerMS:0,active:true};globalThis.__dispatchSample=state;let last=start;const tick=at=>{const began=performance.now();frames.push(at-last);last=at;state.observerMS+=performance.now()-began;if(state.active)requestAnimationFrame(tick)};requestAnimationFrame(tick);try{state.observer=new PerformanceObserver(list=>{const began=performance.now();for(const entry of list.getEntries())longTasks.push({start:entry.startTime,duration:entry.duration});state.observerMS+=performance.now()-began});state.observer.observe({type:'longtask',buffered:false})}catch{}return true})()`)
      const events = await emit(count), start = events[0].at
      await waitFrom(start, 300)
      const inputStart = Number(process.hrtime.bigint()) / 1e6
      await read('globalThis.__dispatchInputAt=performance.now()'); await send('Input.insertText', { text: 'fixture' })
      const input = await read(`new Promise(resolve=>requestAnimationFrame(()=>resolve({elapsedToFrameMS:performance.now()-globalThis.__dispatchInputAt,value:document.querySelector('[aria-label="Find Agent in map"]').value,focused:document.activeElement?.getAttribute('aria-label')})))`)
      input.nativeCommandToObservedFrameWallMS = Number(process.hrtime.bigint()) / 1e6 - inputStart
      assert.equal(input.value, 'fixture'); assert.equal(input.focused, 'Find Agent in map')
      await key('a', 4); await key('Backspace'); await key('Escape')
      await waitFrom(start, 1500)
      const recent = await sample()
      const pane = await rect('.collaboration-canvas'), wheelStart = Number(process.hrtime.bigint()) / 1e6
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pane.x, y: pane.y, deltaX: 0, deltaY: 30 })
      await settle(); const afterWheel = await sample()
      const wheel = { commandToObservedFrameWallMS: Number(process.hrtime.bigint()) / 1e6 - wheelStart, beforeCamera: recent.camera, afterCamera: afterWheel.camera, deltaY: 30 }
      await waitFrom(start, 3760)
      const after = await sample()
      const measured = await read(`(()=>{const state=globalThis.__dispatchSample;state.active=false;state.observer?.disconnect();performance.mark(${JSON.stringify(endMark)});return{start:state.start,end:performance.now(),frames:state.frames,longTasks:state.longTasks,observerMS:state.observerMS}})()`)
      await send('Tracing.end'); tracing = false
      const finished = await Promise.race([complete, pause(8000).then(() => { throw Error('Native trace completion unknown') })])
      assert.equal(finished.dataLossOccurred, false); assert.ok(finished.stream); stream = finished.stream
      const chunks = []
      for (;;) { const part = await send('IO.read', { handle: stream, size: 1024 * 1024 }); chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8')); if (part.eof) break }
      await send('IO.close', { handle: stream }); stream = undefined
      const bytes = Buffer.concat(chunks), eventsTrace = JSON.parse(bytes.toString()).traceEvents, file = label + '.trace.json.gz'
      await fs.writeFile(path.join(evidence, file), gzipSync(bytes))
      data.costs.push({ label, trace: file, relatedEvents: count, retention, events, before, recent, after, input, wheel, measured, native: summarize(eventsTrace, win.webContents.getOSProcessId(), beginMark, endMark),
        overhead: 'Same instrumented App compiler, real Worker observer, context counter, native categories, finite rAF/LongTask observers and explicit boundary DOM/animation census in both arms; observerMS measured, trace/protocol/census cost not calibrated or subtracted. No screenshots inside cost trace.' })
    } finally {
      win.webContents.debugger.off('message', trace.listener)
      if (tracing) await send('Tracing.end').catch(() => {})
      if (stream) await send('IO.close', { handle: stream }).catch(() => {})
      await read('if(globalThis.__dispatchSample){globalThis.__dispatchSample.active=false;globalThis.__dispatchSample.observer?.disconnect()}').catch(() => {})
    }
  }
  await check('dispatch-native-cost', async () => {
    await preference('on'); await locate('fixture-core'); await depart()
    for (const total of [8, 128, 384]) {
      if (total !== 8) {
        const retained = await read(`window.graphCapture.dispatchRetain(${total})`); data.retention.push(retained)
        assert.equal(retained.sessions, total); assert.equal(retained.originalTabsSame, true)
        await until('original catalog consumes retained membership', () => read(`window.graphCapture.facts().ids.length===${total}`)); await mapReady(); await locate('fixture-core'); await depart()
        await read('window.graphCapture.remember()'); result.before = await facts()
      }
      for (let repeat = 0; repeat < 2; repeat++) { await trace('dispatch-cost-n' + total + '-a1-r' + repeat, 1, total); await locate('fixture-core'); await depart() }
    }
    for (let repeat = 0; repeat < 2; repeat++) { await trace('dispatch-cost-n384-a4-r' + repeat, 4, 384); await locate('fixture-core'); await depart() }
    await intact(); data.afterControls = (await facts()).controls
    data.costJudgment = 'Raw repeated per-window Style/Layout/Paint/Layerize/Commit/Intersection and cross-thread composition evidence; baseline/candidate join and unrelated-vs-related increment judgment remain a separate reviewed artifact, not a CSS/GPU label pass.'
  })
}

module.exports.verify = function verify(data, frames) {
  assert.equal(data?.schema, 'agentmux.dispatch-motion-native.v1')
  assert.ok(data.stages.length >= (data.refresh ? 16 : 30)); assert.ok(data.costs.length >= 8)
  assertNativeTravel(data.stages)
  for (const stage of data.stages) { assert.ok(frames.some(frame => frame.label === stage.label)); assert.ok(stage.captureRangeMS[1] >= stage.captureRangeMS[0]); assert.deepEqual(stage.before.controls, []) }
  for (const label of ['dispatch-dark-normal-start', 'dispatch-dark-normal-middle', 'dispatch-dark-normal-arrival', 'dispatch-dark-dense-middle', 'dispatch-narrow-dark-middle', 'dispatch-light-normal-middle', ...(data.refresh ? ['dispatch-narrow-light-arrival', 'dispatch-low-zoom-middle'] : ['dispatch-dark-normal-recent', 'dispatch-dark-normal-static', 'dispatch-narrow-light-static', 'dispatch-update-undirected-middle'])]) assert.ok(data.stages.some(stage => stage.label === label))
  for (const stage of data.stages.filter(stage => stage.label.endsWith('-static'))) { assert.equal(stage.before.activity.paths.length, 0); assert.equal(stage.before.activity.packets.length, 0); assert.equal(stage.before.activity.markers.length, 0) }
  for (const cost of data.costs) { assert.ok(cost.native.observedMS >= 3700); assert.ok(cost.native.traceEvents > 0); assert.ok(cost.measured.frames.length > 8); assert.equal(cost.input.value, 'fixture'); assert.equal(cost.after.activity.paths.length, 0); assert.deepEqual(cost.after.controls, []) }
  assert.deepEqual(data.afterControls, [])
}
