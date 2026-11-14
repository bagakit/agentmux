const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { gzipSync } = require('node:zlib')
const { summarize, unionMS } = require('./dispatch-motion.cjs')
const scene = require('./list-feedback.cjs')
const visualLabels = ['list-feedback-pending-wide-dark', 'list-feedback-pending-narrow-light', 'list-feedback-pending-narrow-light-reduce']

function pendingVisualObservation(probe, detailProbe, subjects, operationId) {
  const subject = subjects.sender, snapshot = probe(subjects)
  const card = document.querySelector(`.focus-context-card[data-focus-agent-host=${JSON.stringify(subject.hostId)}][data-focus-agent-session=${JSON.stringify(subject.agentSessionId)}]`)
  const item = [...card?.querySelectorAll('.agent-operation-feedback__item') ?? []].find(value => value.querySelector('code')?.textContent === operationId)
  const animation = item?.getAnimations({ subtree: true }).find(value => value.animationName === 'agent-operation-shine')
  const timing = animation?.effect.getComputedTiming()
  const status = item?.querySelector('[role="status"]')
  return { snapshot, detail: detailProbe(subject, operationId), status: status ? { text: status.textContent, dataText: status.dataset.text } : null,
    clock: animation ? { pending: animation.pending, state: animation.playState, currentTime: animation.currentTime, startTime: animation.startTime,
      duration: timing.duration, progress: timing.progress, iteration: timing.currentIteration, iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations } : null }
}

function movingPending(before, after) {
  const first = before?.clock, second = after?.clock
  return first?.pending === false && second?.pending === false && first.state === 'running' && second.state === 'running' &&
    Number.isFinite(first.startTime) && first.startTime === second.startTime && Number.isFinite(first.currentTime) && second.currentTime > first.currentTime &&
    Number.isFinite(first.duration) && first.duration > 0 && first.duration === second.duration && first.iterations === 'infinite' && second.iterations === 'infinite' &&
    Number.isInteger(first.iteration) && first.iteration >= 0 && first.iteration === second.iteration &&
    second.progress > .35 && second.progress < .65 && after.snapshot.at > before.snapshot.at && after.snapshot.timeline > before.snapshot.timeline
}

function verifyPendingSnapshot(value, data, narrow, reduced) {
  assert.equal(value.snapshot.hidden, false); assert.equal(value.snapshot.reduced, reduced)
  assert.equal(value.snapshot.theme, narrow ? 'light' : 'dark'); assert.deepEqual(value.snapshot.viewport, narrow ? [620, 820] : [1440, 900])
  const detail = value.detail
  assert.equal(detail?.operationId, data.pending.operationId); assert.equal(detail.phase, 'pending')
  assert.equal(detail.hostId, data.pending.control.hostId); assert.equal(detail.agentSessionId, data.pending.control.agentSessionId)
  assert.equal(detail.open, false); assert.equal(detail.readerPresent, false)
  assert.ok(detail.summary?.visible && detail.summary.insideClip && Number(detail.summary.opacity) > 0 && detail.summary.hits.length === 9 && detail.summary.hits.every(point => point.hit))
  assert.ok(value.status?.text.trim()); assert.equal(value.status.dataText, value.status.text)
  if (reduced) {
    assert.equal(value.clock, null)
    const operation = value.snapshot.cards.sender?.operations.find(item => item.operationId === data.pending.operationId)
    assert.ok(operation && operation.animations.every(animation => animation.state !== 'running'))
  }
  else assert.ok(value.clock?.pending === false && value.clock.state === 'running' && value.clock.progress > 0 && value.clock.progress < 1)
}

function observe(subjects) {
  const snapshot = scene.observe(subjects)
  const body = document.querySelector('[data-desktop-focus-view="list"]')
  const visible = element => {
    const box = element.getBoundingClientRect()
    const rows = element.closest('.focus-project-lanes__rows')?.getBoundingClientRect()
    return !element.closest('[hidden],[inert]') && box.width > 0 && box.height > 0 && box.top < (rows?.bottom ?? innerHeight) && box.bottom > (rows?.top ?? 0)
  }
  return { ...snapshot, cardsVisible: [...body.querySelectorAll('.focus-context-card[data-focus-card-key]')].filter(visible).map(card => ({
    key: card.dataset.focusCardKey, hostId: card.dataset.focusAgentHost, agentSessionId: card.dataset.focusAgentSession,
    mounted: card.dataset.focusCardBody, output: card.querySelector('button.focus-context')?.textContent,
    operations: [...card.querySelectorAll('.agent-operation-feedback__item')].map(item => ({ phase: item.dataset.phase, kind: item.dataset.kind, operationId: item.querySelector('code')?.textContent })) })).sort((first, second) => first.key.localeCompare(second.key)),
    feedbackVisible: [...body.querySelectorAll('.focus-communication-feedback')].filter(visible).length,
    feedbackRunning: [...body.querySelectorAll('.focus-communication-feedback__mark')].flatMap(mark => mark.getAnimations().filter(animation => animation.playState === 'running')).length,
    operationReading: [...body.querySelectorAll('.agent-operation-feedback__label')].map(label => {
      const bounds = label.getBoundingClientRect(), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      return { text: label.textContent, bounds: bounds.toJSON(), nativeCheckVisibility: label.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
        centerHit: label.contains(hit), hitTag: hit?.tagName, hitClass: hit?.getAttribute('class'),
        phase: label.closest('[data-phase]')?.getAttribute('data-phase'), hostId: label.closest('[data-focus-agent-host]')?.getAttribute('data-focus-agent-host'), agentSessionId: label.closest('[data-focus-agent-session]')?.getAttribute('data-focus-agent-session') }
    }),
    search: body.querySelector('[aria-label="Search contexts"]')?.value,
    scroll: [...body.querySelectorAll('.focus-project-lanes__rows')].map(rows => ({ top: rows.scrollTop, height: rows.scrollHeight, viewport: rows.clientHeight })) }
}

function traceWindows(events, native) {
  return native.windows.map(window => {
    const lower = native.beginUS + window.fromMS * 1000, upper = native.beginUS + window.toMS * 1000, groups = {}
    const selected = events.filter(event => event.ph === 'X' && Number.isFinite(event.dur) && event.ts < upper && event.ts + event.dur > lower && /(?:Display::DrawAndSwap|DrawFrame|DrawAndSwap|SubmitCompositorFrame|BeginMainFrame|CommitToActiveTree|RasterTask|Layerize|CompositeLayers|InputLatency|EventDispatch)/.test(event.name))
    for (const event of selected) {
      const key = JSON.stringify([event.pid, event.tid, event.name]), group = groups[key] ??= { pid: event.pid, tid: event.tid, name: event.name, count: 0, inclusiveMS: 0 }
      group.count++; group.inclusiveMS += Math.max(0, Math.min(upper, event.ts + event.dur) - Math.max(lower, event.ts)) / 1000
    }
    for (const group of Object.values(groups)) group.unionMS = unionMS(selected.filter(event => event.pid === group.pid && event.tid === group.tid && event.name === group.name), lower, upper)
    return { fromMS: window.fromMS, toMS: window.toMS, compositionAndInput: Object.values(groups) }
  })
}

function verifyCosts(data) {
  assert.equal(data?.schema, 'agentmux.focus-list-feedback-cost.v1')
  assert.equal(data.costs.length, 8)
  assert.deepEqual(data.retention.map(item => item.sessions), [8, 128, 384])
  assert.ok(data.retention.every(item => item.originalTabObjects && item.originalTabBytes && item.originalLayouts))
  assert.ok(data.retention.every(item => item.originalRetainedWorkfaces === 0))
  assert.equal(data.pending.control.agentSessionId, data.subjects.sender.agentSessionId)
  assert.equal(data.pending.control.hostId, data.subjects.sender.hostId)
  assert.deepEqual(data.pending.control, data.initialStopStatus.originalRuns.find(control => control.hostId === data.pending.control.hostId && control.agentSessionId === data.pending.control.agentSessionId))
  for (const [index, cost] of data.costs.entries()) {
    assert.equal(cost.total, [8, 8, 128, 128, 384, 384, 384, 384][index])
    assert.equal(cost.relatedFeedback, index < 6 ? 2 : 4)
    assert.equal(cost.native.windows.length, 3); assert.ok(cost.native.observedMS >= 3900)
    assert.deepEqual(cost.native.windows.map(window => window.fromMS), [0, 1200, 3200])
    assert.equal(cost.listPhase.initialWindowMS, 120); assert.deepEqual(cost.listPhase.windows.map(window => window.fromMS), [0, 120, 3200]); assert.equal(cost.listPhase.windows[0].toMS, 120)
    assert.ok(cost.native.traceEvents > 0 && cost.measured.frames.length > 8 && cost.traceSHA256)
    assert.equal(cost.input.value, 'fixture-ui'); assert.equal(cost.input.focused, 'Search contexts')
    assert.ok(cost.input.elapsedToFrameMS >= 0 && cost.input.commandToObservedFrameWallMS >= 0)
    assert.ok(cost.wheel.commandToObservedFrameWallMS >= 0 && cost.wheel.events.length > 0)
    assert.ok(cost.wheel.events.every(event => event.trusted && event.deltaY === 35))
    if (cost.total > 8) assert.ok(cost.wheel.after.some(port => port.top !== cost.wheel.beforeTop), 'The original retained catalog must actually scroll in its real scrollport')
    assert.deepEqual(cost.before.cardsVisible, data.fixedCards)
    assert.deepEqual(cost.recent.cardsVisible, data.fixedCards)
    for (const sample of [cost.before, cost.recent]) for (const name of Object.keys(data.subjects)) assert.equal(sample.cards[name]?.visible, true, 'Each exact relevant subject stays in the original two-dimensional visible viewport')
    assert.equal(cost.recent.feedbackVisible, data.baseline ? 0 : cost.relatedFeedback)
    if (!data.baseline) for (const name of cost.relatedFeedback === 2 ? ['sender', 'recipient'] : Object.keys(data.subjects)) {
      const feedback = cost.recent.cards[name].feedback
      assert.ok(feedback?.visible && feedback.paint?.nativeCheckVisibility && feedback.paint.hit && feedback.paint.bounds.height > 0, 'Each related candidate feedback must actually occupy its readable original text point')
      for (const owner of feedback.paint.ancestors.filter(owner => owner.contentVisibility === 'auto')) assert.ok(feedback.paint.bounds.top >= owner.bounds.top - .5 && feedback.paint.bounds.bottom <= owner.bounds.bottom + .5 && feedback.paint.bounds.left >= owner.bounds.left - .5 && feedback.paint.bounds.right <= owner.bounds.right + .5, 'The original card paint containment encloses the related feedback')
    }
    assert.equal(cost.recent.feedbackRunning, 0)
    assert.equal(cost.after.feedbackVisible, 0); assert.equal(cost.after.feedbackRunning, 0)
    assert.equal(cost.stop.calls.length, 1); assert.equal(cost.stop.calls[0].operationId, data.pending.operationId); assert.equal(cost.stop.calls[0].settled, false)
    assert.equal(Object.values(cost.stop.operations).find(operation => operation.operationId === data.pending.operationId)?.phase, 'pending')
    for (const field of ['sameDraft', 'sameDrafts', 'draftMounted']) assert.equal(cost.facts[field], true)
    assert.deepEqual(cost.facts.originalRun, data.original.originalRun); assert.deepEqual(cost.facts.controls, [...data.original.controls, 'stop'])
    assert.equal(cost.facts.draft, data.original.draft); assert.equal(cost.facts.storedDraft, data.original.storedDraft); assert.deepEqual(cost.facts.range, data.original.range)
  }
}

function verify(data, captured) {
  verifyCosts(data)
  assert.deepEqual(captured.map(frame => frame.label), data.baseline ? [] : visualLabels)
  if (data.baseline) return
  for (const cost of data.costs) {
    let previous
    for (const sample of [cost.before, cost.recent, cost.after]) {
      assert.equal(sample.hidden, false); assert.equal(sample.reduced, false)
      const operation = sample.cards.sender?.operations.find(item => item.operationId === data.pending.operationId)
      const clock = operation?.animations.find(animation => animation.name === 'agent-operation-shine')
      assert.ok(operation?.phase === 'pending' && clock?.state === 'running' && clock.iterations === 'infinite' && Number.isFinite(clock.startTime) && Number.isFinite(clock.currentTime))
      assert.ok(sample.operationReading.some(label => label.phase === 'pending' && label.hostId === data.pending.control.hostId && label.agentSessionId === data.pending.control.agentSessionId && label.nativeCheckVisibility && label.centerHit))
      if (previous) { assert.equal(clock.startTime, previous.startTime); assert.ok(clock.currentTime > previous.currentTime) }
      previous = clock
    }
  }
  assert.equal(data.pendingVisuals?.length, visualLabels.length)
  for (const [index, visual] of data.pendingVisuals.entries()) {
    assert.equal(visual.label, visualLabels[index]); assert.equal(captured[index].file, visual.label + '.png')
    const narrow = index > 0, reduced = index === 2
    assert.deepEqual(captured[index].viewport, narrow ? [620, 820] : [1440, 900])
    verifyPendingSnapshot(visual.after, data, narrow, reduced); verifyPendingSnapshot(visual.captured, data, narrow, reduced)
    if (!reduced) {
      assert.ok(movingPending(visual.before, visual.after), 'The original visible pending light must advance into its native middle before capture')
      assert.equal(visual.captured.clock.startTime, visual.after.clock.startTime)
      assert.equal(visual.captured.clock.iteration, visual.after.clock.iteration)
      assert.ok(visual.captured.clock.progress > .35 && visual.captured.clock.progress < .65)
      assert.ok(visual.captured.clock.currentTime >= visual.after.clock.currentTime)
    }
  }
  assert.equal(data.visualStop.calls.length, 1); assert.equal(data.visualStop.calls[0].operationId, data.pending.operationId)
  assert.deepEqual(data.visualStop.calls[0].control, data.pending.control)
  assert.equal(data.visualStop.calls[0].settled, false)
  const operation = Object.values(data.visualStop.operations).find(item => item.operationId === data.pending.operationId)
  assert.equal(operation?.phase, 'pending'); assert.deepEqual(operation.control, data.pending.control)
  for (const field of ['sameTabObjects', 'sameDrafts', 'draftMounted', 'sameDraft']) assert.equal(data.visualFacts[field], true)
  assert.ok(data.beforeVisualFacts.tabDifference?.after && data.beforeVisualFacts.layoutDifference?.after)
  for (const field of ['tabDifference', 'layoutDifference']) assert.deepEqual(data.visualFacts[field], data.beforeVisualFacts[field])
  for (const field of ['originalRun', 'draft', 'storedDraft', 'range']) assert.deepEqual(data.visualFacts[field], data.original[field])
  assert.deepEqual(data.visualFacts.controls, [...data.original.controls, 'stop'])
}

module.exports = async function listFeedbackCost(ctx) {
  const { win, result, read, click, key, check, facts, until, pause, settle, frame, rect, evidence } = ctx
  const data = result.listFeedbackCost = { schema: 'agentmux.focus-list-feedback-cost.v1', baseline: process.env.COLLABORATION_CAPTURE_LIST_BASELINE === '1', costs: [], retention: [],
    boundary: 'Eight repeated Native traces, with three candidate pending visual frames only after all traces; no PNGs during trace. Original App List and one original confirmed pending Stop promise/control/Run remain. Old source has no List A2A feedback and may clip its Stop summary; candidate adds visible finite feedback and fixes sibling layout. Membership, output and pending intent are comparable, not pixel/geometry-equivalent UI. Differences are whole declared presentation-slice costs, never pure animation improvement, live PTY/Provider execution, aesthetic or CPU/GPU time. Document visibility is not qualified by the post-trace frames.' }
  data.subjects = await read('window.graphCapture.listCostSubjects()'); data.original = await facts(); data.initialStopStatus = await read('window.graphCapture.listStopStatus()')
  assert.equal(data.initialStopStatus.calls.length, 0)
  const probe = `(${scene.observe.toString()})`
  const sample = () => read(`(()=>{const started=performance.now(),scene={observe:${probe}},snapshot=(${observe.toString()})(${JSON.stringify(data.subjects)});return{...snapshot,boundaryObserverMS:performance.now()-started}})()`)
  const send = (method, params) => win.webContents.debugger.sendCommand(method, params)
  const waitFrom = async (start, offset) => pause(Math.max(0, start + offset - await read('performance.now()')))
  win.showInactive(); result.conditions.privateWindowShown = true
  data.nativeWindow = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds(), boundary: 'The private BrowserWindow is shown without activation and its actual bounds are recorded; no offscreen placement, human input-owner or physical-display claim.' }
  assert.equal(data.nativeWindow.visible, true)
  await click('button.surface-navigation__focus'); await click('[aria-label="List"]')
  await until('original List mounted for bounded cost', async () => (await sample()).listVisible)
  data.retention.push(await read('window.graphCapture.listRetain(8)'))
  data.scope = await selectProject()
  await until('exact four original project cards visible', async () => (await sample()).cardsVisible.length === 4)
  data.pending = await scene.requestOriginalStop(ctx, data.subjects, 'sender')
  await pause(200); await settle(); data.fixedCards = (await sample()).cardsVisible
  assert.equal(data.fixedCards.length, 4); assert.ok(data.fixedCards.every(card => card.mounted === 'mounted'))
  assert.deepEqual(data.fixedCards.map(card => [card.hostId, card.agentSessionId]).sort(), Object.values(data.subjects).map(subject => [subject.hostId, subject.agentSessionId]).sort())
  await check('list-native-bounded-cost', async () => {
    for (const total of [8, 128, 384]) {
      if (total !== 8) data.retention.push(await read(`window.graphCapture.listRetain(${total})`))
      await until('original Store consumes exact retained catalog', async () => (await facts()).ids.length === total)
      for (let repeat = 0; repeat < 2; repeat++) await trace(total, 2, repeat)
    }
    for (let repeat = 0; repeat < 2; repeat++) await trace(384, 4, repeat)
    verifyCosts(data)
  })
  if (result.failures.length) throw Error('List Native cost failed; do not append another arm')
  if (!data.baseline) await check('list-native-pending-visuals', async () => {
    data.beforeVisualFacts = await facts(); data.pendingVisuals = []
    const visualCode = `(${pendingVisualObservation.toString()})(${probe},${scene.detailObservation.toString()},${JSON.stringify(data.subjects)},${JSON.stringify(data.pending.operationId)})`
    for (const [index, label] of visualLabels.entries()) {
      const narrow = index > 0, reduced = index === 2
      await read(`window.graphCapture.appearance(${JSON.stringify(narrow ? 'light' : 'dark')})`)
      win.setContentSize(...(narrow ? [620, 820] : [1440, 900]))
      await click('[aria-label="Search contexts"]')
      await read(`(()=>{const subject=${JSON.stringify(data.subjects.sender)},card=document.querySelector('.focus-context-card[data-focus-agent-host='+JSON.stringify(subject.hostId)+'][data-focus-agent-session='+JSON.stringify(subject.agentSessionId)+']');const item=[...card.querySelectorAll('.agent-operation-feedback__item')].find(value=>value.querySelector('code')?.textContent===${JSON.stringify(data.pending.operationId)});item.querySelector('summary').scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})})()`)
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
      try {
        await pause(180); await settle()
        const visual = { label }
        if (reduced) visual.after = await read(visualCode)
        else await until('same original pending light advances into its visible middle', async () => {
          visual.before = await read(visualCode); await settle(); visual.after = await read(visualCode)
          return movingPending(visual.before, visual.after) && visual.after.clock.progress > .4 && visual.after.clock.progress < .6
        })
        verifyPendingSnapshot(visual.after, data, narrow, reduced)
        visual.captured = await frame(label, { motion: true, immediateObservation: visualCode })
        data.pendingVisuals.push(visual)
      } finally {
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
      }
    }
    data.visualStop = await read('window.graphCapture.listStopStatus()'); data.visualFacts = await facts()
    verify(data, result.frames)
  })
  if (result.failures.length) throw Error('List pending visual refresh failed; preserve its original evidence')

  async function selectProject() {
    const label = await read(`(()=>{const frame=[...document.querySelectorAll('[data-project-group-key]')].find(element=>element.querySelector('[data-project-id="fixture-protocol"]'));const button=frame?.querySelector('[data-focus-project-scope-control]')??document.querySelector('[data-project-id="fixture-protocol"] [data-focus-project-scope-control]');if(!button)throw Error('Original Project scope button is absent');button.setAttribute('data-list-cost-scope','');button.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return button.textContent})()`)
    await settle(); await click('[data-list-cost-scope]'); return label
  }

  async function trace(total, relatedFeedback, repeat) {
    await pause(3250)
    if (!await read(`Boolean(document.querySelector('[data-focus-project-scope-control][aria-pressed="true"]'))`)) {
      await selectProject(); await settle()
    }
    await click('[aria-label="Search contexts"]')
    await until('original hover Reader departs before fixed-workload cost', () => read("!document.querySelector('.agent-information-reader')"))
    assert.equal((await sample()).search, '')
    const label = `list-cost-n${total}-a${relatedFeedback}-r${repeat}`, beginMark = label + '-begin', endMark = label + '-end'
    const before = await sample(), wheelEvents = []
    const complete = new Promise(resolve => {
      trace.listener = (_event, method, params) => { if (method === 'Tracing.tracingComplete') resolve(params) }
      win.webContents.debugger.on('message', trace.listener)
    })
    let tracing = false, stream
    try {
      await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,toplevel,disabled-by-default-devtools.timeline.invalidationTracking,blink.user_timing,cc,gpu,viz,input,latencyInfo', transferMode: 'ReturnAsStream' }); tracing = true
      const events = await read(`(()=>{const state={frames:[],longTasks:[],active:true,observerMS:0};globalThis.__listCostSample=state;let previous=performance.now();const tick=at=>{const start=performance.now();state.frames.push(at-previous);previous=at;state.observerMS+=performance.now()-start;if(state.active)requestAnimationFrame(tick)};requestAnimationFrame(tick);if(PerformanceObserver.supportedEntryTypes.includes('longtask')){state.observer=new PerformanceObserver(list=>{const start=performance.now();state.longTasks.push(...list.getEntries().map(entry=>({start:entry.startTime,duration:entry.duration})));state.observerMS+=performance.now()-start});state.observer.observe({type:'longtask',buffered:false})}performance.mark(${JSON.stringify(beginMark)});const subjects=${JSON.stringify(data.subjects)},events=[window.graphCapture.live(true,subjects.sender.agentSessionId,subjects.recipient.agentSessionId,'message',subjects.sender.hostId)];${relatedFeedback === 4 ? "events.push(window.graphCapture.live(true,subjects.peerSender.agentSessionId,subjects.peerRecipient.agentSessionId,'message',subjects.peerSender.hostId));" : ''}return events})()`)
      const start = events[0].at
      await waitFrom(start, 1500); const recent = await sample()
      await waitFrom(start, 3250); const after = await sample()
      await read('globalThis.__listInputStart=performance.now()')
      const commandAt = Number(process.hrtime.bigint()) / 1e6
      await send('Input.insertText', { text: 'fixture-ui' })
      const input = await read(`new Promise(done=>requestAnimationFrame(()=>done({at:performance.now(),elapsedToFrameMS:performance.now()-globalThis.__listInputStart,value:document.querySelector('[aria-label="Search contexts"]').value,focused:document.activeElement?.getAttribute('aria-label')})))`)
      input.commandToObservedFrameWallMS = Number(process.hrtime.bigint()) / 1e6 - commandAt; input.afterEventMS = input.at - start
      await key('a', 4); await key('Backspace'); await settle()
      await click('[aria-label="Focus filters"]')
      await until('original project filter option', () => read(`Boolean(document.querySelector('.focus-filter-menu [data-focus-project="all"]'))`))
      await click('.focus-filter-menu [data-focus-project="all"]')
      await until('original all-projects control is checked', () => read(`document.querySelector('.focus-filter-menu [data-focus-project="all"]')?.getAttribute('aria-checked')==='true'`))
      await key('Escape'); await until('original Focus filter menu exits', () => read(`!document.querySelector('.focus-filter-menu')`)); await settle()
      const rows = await read(`(()=>{const element=document.querySelector('[data-desktop-focus-view="list"] .focus-project-lanes__rows'),box=element.getBoundingClientRect();globalThis.__listWheelEvents=[];element.addEventListener('wheel',event=>globalThis.__listWheelEvents.push({at:performance.now(),trusted:event.isTrusted,deltaY:event.deltaY}),{once:true,passive:true});return{x:box.x+box.width/2,y:box.y+box.height/2,top:element.scrollTop}})()`)
      const wheelAt = Number(process.hrtime.bigint()) / 1e6
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rows.x, y: rows.y, deltaX: 0, deltaY: 35 })
      await settle(); wheelEvents.push(...await read('globalThis.__listWheelEvents'))
      const wheel = { commandToObservedFrameWallMS: Number(process.hrtime.bigint()) / 1e6 - wheelAt, beforeTop: rows.top, after: (await sample()).scroll, events: wheelEvents, boundary: 'After 3200ms only: original Focus filters menu selects All projects and exits through native Escape before trusted wheel on the full retained catalog. N8 may clamp; larger catalogs require actual displacement. Late window includes real menu/filter/input/scroll costs, not A2A-only cost.' }
      await waitFrom(start, 4000)
      const measured = await read(`(()=>{const state=globalThis.__listCostSample;state.active=false;state.observer?.disconnect();performance.mark(${JSON.stringify(endMark)});return{end:performance.now(),frames:state.frames,longTasks:state.longTasks,observerMS:state.observerMS}})()`)
      await send('Tracing.end'); tracing = false
      const finished = await Promise.race([complete, pause(8000).then(() => { throw Error('Native List trace completion unknown') })])
      assert.equal(finished.dataLossOccurred, false); assert.ok(finished.stream); stream = finished.stream
      const chunks = []
      for (;;) { const part = await send('IO.read', { handle: stream, size: 1024 * 1024 }); chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8')); if (part.eof) break }
      await send('IO.close', { handle: stream }); stream = undefined
      const bytes = Buffer.concat(chunks), eventsTrace = JSON.parse(bytes).traceEvents, native = summarize(eventsTrace, win.webContents.getOSProcessId(), beginMark, endMark), compressed = gzipSync(bytes), file = label + '.trace.json.gz'
      await fs.writeFile(path.join(evidence, file), compressed)
      const listPhase = summarize(eventsTrace, win.webContents.getOSProcessId(), beginMark, endMark, 120)
      data.costs.push({ label, total, repeat, relatedFeedback, trace: file, traceSHA256: createHash('sha256').update(compressed).digest('hex'), before, recent, after, events, input, wheel, measured, native, windows: traceWindows(eventsTrace, native),
        listPhase: { initialWindowMS: 120, windows: listPhase.windows, compositionWindows: traceWindows(eventsTrace, listPhase), boundary: 'Offline re-bucketing of the same original trace at the List 120ms token. No second sampling or motion/GPU causality attribution; the original 1200ms first window remains a whole-slice mixed window.' },
        stop: await read('window.graphCapture.listStopStatus()'), facts: await facts(), overhead: 'Same original App instrumentation and native categories. Finite rAF/LongTask observers and explicit boundary DOM/animation/paint clocks are included; boundaryObserverMS is measured per snapshot, not subtracted. Candidate has additional feedback to observe; this tooling difference is declared, not assigned to product animation. Inclusive pipeline durations overlap; per-thread union is occupied wall, not CPU. No screenshots or Provider output inside traces.' })
    } finally {
      win.webContents.debugger.off('message', trace.listener)
      if (tracing) await send('Tracing.end').catch(() => {})
      if (stream) await send('IO.close', { handle: stream }).catch(() => {})
      await read('if(globalThis.__listCostSample){globalThis.__listCostSample.active=false;globalThis.__listCostSample.observer?.disconnect()}').catch(() => {})
    }
  }
}
module.exports.verify = verify
module.exports.visualLabels = visualLabels
