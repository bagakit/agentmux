const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const stopForkScenarios = Object.freeze([
  'production-card-source-identities', 'independent-confirmed-stops',
  'actual-cycle-ordered-output', 'reduced-hidden-offscreen-pause',
  'native-browser-related-consumer-scale', 'stop-unknown-read-only-inspection',
  'fork-real-original-controller', 'partial-result-inspection-without-create',
  'persistent-original-operation-references'
])
const stopForkRestartScenarios = Object.freeze([
  'second-real-process-no-reseed', 'restored-unknown-checks-without-replay'
])
exports.assertStopForkScenarios = function (scenarios, mode) {
  assert.ok(mode === 'first' || mode === 'second', 'The Stop/Fork scenario collection belongs to an exact process mode')
  assert.deepEqual([...scenarios].sort(), [...(mode === 'first' ? stopForkScenarios : stopForkRestartScenarios)].sort(),
    'The complete actual Stop/Fork scenario set must execute exactly once')
}

/** Native driver for mounted production consumers. It never calls a business controller itself. */
exports.runAgentOperations = async function ({ win, result, evaluate, wait, click, key, size, frame, painted, originalTerminalReady, spatial, evidence, mode, nativeMutant }) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const facts = () => evaluate('takeoverProbe.facts()')
  const operationFacts = () => evaluate('takeoverProbe.operations.facts()')
  const cards = 'document.querySelector("#agent-operation-cards")'
  const sourceCard = index => `${cards}.querySelector('button[data-session-id="'+takeoverProbe.operations.facts().originals[${index}]+'"]')`
  const menuItem = text => `([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(node=>node.textContent.trim()===${JSON.stringify(text)}))`
  const feedback = kind => `${cards}.querySelector('.agent-operation-feedback[data-kind="${kind}"]')`
  const reference = (values, kind) => Object.values(values.operations).find(item => item.kind === kind)
  const own = result.agentOperations = { qualification: 'stop-fork-feedback-v1', scenarios: [], costSamples: [], motion: [],
    nativeBoundary: 'Controlled exact Native launch/stop/ordered-byte/input facts; production card/controller/spatial/persistence consumers. No vendor CLI or real user Session is operated.' }

  async function openCard(index, action) {
    const point = await evaluate(`(()=>{const node=${sourceCard(index)};if(!node)throw Error('Exact original production card is missing');node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'right', clickCount: 1 })
    await wait(`Boolean(${menuItem(action)})`, `Actual original card menu offers ${action}`)
    await click(menuItem(action))
  }
  async function beginStop(index) {
    if (index === 1) {
      const location = await evaluate(`takeoverProbe.focus(${index})`)
      const button = `document.querySelector('.pane-group[data-pane-group-id=\"${location.groupId}\"] button[title=\"Stop Run\"]')`
      await wait(`(()=>{const node=${button};return Boolean(node&&node.getBoundingClientRect().width>0)})()`, 'Exact original PaneGroup exposes its real Stop Run button')
      await click(button)
    } else await openCard(index, 'Stop Agent')
    const confirm = `document.querySelector('[role="dialog"] [data-confirm-label="Stop Agent"]')`
    await wait(`Boolean(${confirm})`); await click(confirm)
    await wait('!document.querySelector("[role=dialog]")', 'Confirmed Stop immediately releases its modal')
    const state = await operationFacts(), sourceId = state.originals[index]
    const operation = Object.values(state.operations).find(item => item.kind === 'stop' && item.subject.agentSessionId === sourceId)
    assert.ok(operation, 'Actual Stop controller retained its exact original operation')
    await wait(`takeoverProbe.operations.facts().pending.some(item=>item.operationId===${JSON.stringify(operation.operationId)})`)
    await evaluate('takeoverProbe.focus(0)')
    return operation
  }
  async function beginFork() {
    await evaluate('takeoverProbe.focus(0);takeoverProbe.operations.creation("hold")')
    result.stage = 'agent-operation-fork-pointer'
    await openCard(0, 'Fork current conversation…')
    const destination = 'document.querySelector("[data-current-fork-review] [data-destination=right]")'
    await wait(`Boolean(${destination})`)
    // Expanding the real review resizes and collision-shifts its Radix menu.
    // Let its positioning paint before dispatching coordinates to the button.
    await painted()
    own.forkNativePointer = await evaluate(`(()=>{
      const button=${destination}, rect=button.getBoundingClientRect(), host=button.closest('[popover]');
      const events=[], controller=new AbortController();
      const describe=node=>node?.nodeType===1?{tag:node.tagName,role:node.getAttribute('role'),destination:node.closest('[data-destination]')?.getAttribute('data-destination'),className:typeof node.className==='string'?node.className:null}:null;
      for(const type of ['pointerdown','pointerup','click','focusin','focusout','beforetoggle','toggle'])document.addEventListener(type,event=>events.push({type,at:performance.now(),target:describe(event.target),trusted:event.isTrusted,oldState:event.oldState,newState:event.newState,hostShown:host?.matches(':popover-open'),active:describe(document.activeElement)}),{capture:true,signal:controller.signal});
      window.__forkPointerObservation={events,controller};
      return {rect:rect.toJSON(),hit:describe(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)),hostShown:host?.matches(':popover-open')};
    })()`)
    await click(destination)
    await painted()
    own.forkNativePointer.after = await evaluate(`(()=>{const probe=window.__forkPointerObservation;probe.controller.abort();return {events:probe.events,submitted:Object.values(takeoverProbe.operations.facts().operations).some(item=>item.kind==='fork')}})()`)
    assert.equal(own.forkNativePointer.after.submitted, true, 'Trusted native Fork activation reaches its original operation controller')
    const pointerEvents = own.forkNativePointer.after.events
    const down = pointerEvents.findIndex(event => event.type === 'pointerdown' && event.trusted && event.target?.destination === 'right')
    const activation = pointerEvents.findIndex(event => event.type === 'click' && event.trusted && event.target?.destination === 'right')
    assert.ok(down >= 0 && activation > down, 'Original Fork destination receives the real trusted pointer activation')
    assert.ok(!pointerEvents.slice(down, activation).some(event => event.type === 'beforetoggle' && event.newState === 'closed'), 'Opening its tooltip preserves the shown host through the native pointer sequence')
    await wait('!document.querySelector("[data-current-fork-review]") && !document.querySelector(".focus-context-menu[role=menu]")', 'Submitted fork releases the original menu')
    await wait(`takeoverProbe.operations.facts().pending.some(item=>item.kind==='creation')`)
    const state = await operationFacts(), operation = reference(state, 'fork')
    assert.ok(operation && operation.phase === 'pending', 'Real Fork controller retained its original request')
    assert.equal(operation.subject.agentSessionId, state.originals[0])
    return operation
  }
  async function motionSample(label) {
    const sample = await evaluate(`(()=>{const cards=${cards};return {sampledAt:performance.now(),
      rows:[...cards.querySelectorAll('.agent-operation-feedback')].map(node=>({kind:node.dataset.kind,phase:node.dataset.phase,active:node.dataset.motionActive,
        label:node.querySelector('summary')?.textContent,rect:node.getBoundingClientRect().toJSON(),
        animations:node.getAnimations({subtree:true}).map(animation=>({name:animation.animationName,currentTime:animation.currentTime,playState:animation.playState,duration:animation.effect.getTiming().duration,
          timing:animation.effect.getComputedTiming().progress,target:animation.effect.target?.className})),
        trail:(()=>{const target=node.querySelector('.agent-operation-feedback__trail');if(!target)return null;const style=getComputedStyle(target,'::after');return {distance:style.offsetDistance,path:style.offsetPath,display:style.display,playState:style.animationPlayState}})()}))}})()`)
    own.motion.push({ label, ...sample }); return sample
  }
  async function pausedWork(label) {
    const before = await motionSample(label + '-before')
    await delay(120)
    const after = await motionSample(label + '-after')
    const running = sample => sample.rows.flatMap(row => row.animations).filter(animation => animation.name === 'agent-operation-orbit' && animation.playState === 'running')
    const moving = before.rows.some((row, index) => row.trail && after.rows[index]?.trail && row.trail.distance !== after.rows[index].trail.distance)
    const observation = { label, beforeRunning: running(before).length, afterRunning: running(after).length, moving, before, after }
    own.isolationObservations ??= []; own.isolationObservations.push(observation)
    result.stage = 'agent-operation-visibility-work'
    assert.equal(observation.beforeRunning + observation.afterRunning, 0, 'Actual ' + label + ' operation edges do zero running animation work')
    assert.equal(moving, false, 'Actual ' + label + ' operation edge positions stay fixed')
    return observation
  }
  async function inputAndScroll(label) {
    const before = await operationFacts()
    const start = await evaluate('performance.now()')
    const textarea = 'document.querySelector(".workbench-region:not([hidden]) .xterm-helper-textarea") || document.querySelector(".xterm-helper-textarea")'
    await evaluate(`(${textarea})?.focus()`)
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'p', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 })
    await wait(`takeoverProbe.operations.facts().inputs.length>${before.inputs.length}`, 'Actual xterm keyboard reaches the controlled original Native input port')
    const after = await operationFacts(), inputMs = await evaluate(`performance.now()-${start}`)
    assert.deepEqual(after.inputs.at(-1).control, before.sourceControls[0], 'Input kept the original exact healthy source control')
    const termBefore = await evaluate('takeoverProbe.terminalFacts().terminals.find(term=>term.viewObservation?.liveReady)')
    assert.ok(termBefore, 'Actual live xterm is present during operation feedback')
    const rect = termBefore.element
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x + Math.min(rect.width / 2, 100), y: rect.y + Math.min(rect.height / 2, 100), deltaY: -240, deltaX: 0 })
    await delay(80)
    const termAfter = await evaluate('takeoverProbe.terminalFacts().terminals.find(term=>term.regionId===' + JSON.stringify(termBefore.regionId) + ')')
    assert.ok(termAfter.buffer.viewportY < termBefore.buffer.viewportY, 'Native mouse wheel scrolls the original live xterm history while cards animate')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x + Math.min(rect.width / 2, 100), y: rect.y + Math.min(rect.height / 2, 100), deltaY: 10000, deltaX: 0 })
    return { label, inputMs, before: before.inputs.length, after: after.inputs.length,
      viewportBefore: termBefore.buffer.viewportY, viewportAfter: termAfter.buffer.viewportY }
  }
  async function browserCost(unrelated, sample) {
    await evaluate(`takeoverProbe.operations.unrelated(${unrelated})`); await painted()
    const before = await operationFacts(), events = []
    let completed
    const end = new Promise(resolve => { completed = resolve })
    const listener = (_event, method, params) => {
      if (method === 'Tracing.dataCollected') events.push(...params.value)
      if (method === 'Tracing.tracingComplete') completed()
    }
    win.webContents.debugger.on('message', listener)
    await win.webContents.debugger.sendCommand('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' })
    const startedAt = Date.now()
    const response = await inputAndScroll(`scale-${unrelated}-${sample}`)
    await delay(650)
    await win.webContents.debugger.sendCommand('Tracing.end'); await end
    win.webContents.debugger.removeListener('message', listener)
    const after = await operationFacts(), durationMs = Date.now() - startedAt
    const named = names => events.filter(event => names.includes(event.name) && event.ph === 'X')
    const measures = Object.fromEntries(Object.entries({ style: ['UpdateLayoutTree', 'RecalculateStyles'], layout: ['Layout'], paint: ['Paint'] }).map(([name, kinds]) => {
      const values = named(kinds); return [name, { events: values.length, durationMs: values.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000 }]
    }))
    const observed = { unrelated, sample, durationMs, measures, response,
      projectionReads: after.counters.projection - before.counters.projection,
      cardMutations: after.counters.cardMutations - before.counters.cardMutations,
      streamLines: after.counters.streamLines - before.counters.streamLines, traceEvents: events.length }
    assert.ok(events.length > 0 && observed.streamLines > 0, 'Native browser cost sample and concurrent ordered output are nonempty')
    own.costSamples.push(observed)
    return observed
  }

  await originalTerminalReady()
  await size(1180, 850)
  const initial = await facts()
  assert.ok(initial.origins.length >= 2 && await evaluate(`${cards}.querySelectorAll('button[data-session-id]').length>=2`), 'At least two actual projection-driven source cards are mounted')
  if (mode === 'first') {
    own.scenarios.push('production-card-source-identities')
    await evaluate('takeoverProbe.operations.stream(true)')
    await delay(400)
    await frame('ops-01-original-healthy-workface')
    const slow = await beginStop(1), fast = await beginStop(2)
    own.scenarios.push('independent-confirmed-stops')
    assert.deepEqual((await facts()).drafts, initial.drafts, 'Multiple confirmed Stops preserve every original unsent draft')
    await frame('ops-02-stop-in-flight-dark')
    const startMotion = await motionSample('stop-start')
    const active = startMotion.rows.filter(row => row.phase === 'pending')
    assert.ok(active.length >= 2 && active.every(row => row.label?.includes('停止中')), 'Real cards use short Stop labels with active feedback')
    assert.ok(active.some(row => row.animations.some(animation => animation.playState === 'running')), 'The production border actually animates')
    const duration = Math.max(...active.flatMap(row => row.animations.map(animation => Number(animation.duration))).filter(Number.isFinite))
    assert.ok(duration > 0, 'A real animation cycle has a known duration')
    for (let quarter = 1; quarter <= 4; quarter++) {
      await delay(duration / 4); await motionSample(`stop-quarter-${quarter}`)
      if (quarter === 1 || quarter === 3) await frame(`ops-03-stop-motion-${quarter}`, false)
    }
    const distances = own.motion.slice(0, 5).flatMap(sample => sample.rows.flatMap(row => row.trail?.distance ?? []))
    assert.ok(new Set(distances).size >= 3, 'The actual edge trace advances over a complete cycle; this does not sign subjective motion quality')
    assert.ok((await operationFacts()).counters.cardMutations > 0, 'Mounted card observer saw actual nonempty state changes before zero-increment cost checks')
    own.scenarios.push('actual-cycle-ordered-output')

    for (const theme of ['dark', 'light']) for (const width of [1180, 620]) {
      await evaluate(`takeoverProbe.appearance(${JSON.stringify(theme)})`); await size(width, 850)
      await frame(`ops-04-stop-${theme}-${width}`)
    }
    await evaluate('takeoverProbe.appearance("dark")'); await size(1180, 850)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await delay(100)
    const reduced = await motionSample('reduced-motion')
    assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), true)
    assert.ok(reduced.rows.every(row => !row.animations.some(animation => animation.playState === 'running')), 'Reduced motion has no running edge animation')
    await frame('ops-05-reduced-motion')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    await evaluate('takeoverProbe.operations.showCards(false)'); await delay(150)
    await pausedWork('hidden')
    await evaluate('takeoverProbe.operations.showCards(true);takeoverProbe.operations.offscreen(true)'); await delay(150)
    await pausedWork('offscreen')
    await evaluate('takeoverProbe.operations.offscreen(false)'); await delay(100)
    own.scenarios.push('reduced-hidden-offscreen-pause')
    if (nativeMutant === 'hidden-motion-runs') { own.mutationSurvived = true; own.passed = true; return }
    result.stage = 'agent-operation-native-cost'

    for (let sample = 0; sample < 3; sample++) for (const unrelated of [0, 384]) await browserCost(unrelated, sample)
    await evaluate('takeoverProbe.operations.unrelated(0)')
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    const group = count => own.costSamples.filter(sample => sample.unrelated === count)
    const growth = (384 + 3) / 3
    // A scale contradiction, not an invented absolute latency budget: unrelated membership
    // must not turn fixed visible operation work into one pass per retained Session.
    assert.ok(group(384).every(sample => sample.cardMutations === 0), 'Unrelated retained membership causes no steady-state visible card DOM mutations')
    for (const field of ['style', 'layout', 'paint']) {
      const small = group(0).map(sample => sample.measures[field].durationMs / sample.durationMs)
      const large = group(384).map(sample => sample.measures[field].durationMs / sample.durationMs)
      const noise = Math.max(...small) - Math.min(...small)
      assert.ok(median(large) <= (median(small) + noise + Number.EPSILON) * Math.sqrt(growth), `Native ${field} cost stays sublinear to unrelated retained membership; raw repeated samples are retained`)
    }
    const smallInputs = group(0).map(sample => sample.response.inputMs), largeInputs = group(384).map(sample => sample.response.inputMs)
    assert.ok(median(largeInputs) <= (median(smallInputs) + Math.max(...smallInputs) - Math.min(...smallInputs) + Number.EPSILON) * Math.sqrt(growth), 'Native input latency remains sublinear to unrelated retained membership')
    own.scenarios.push('native-browser-related-consumer-scale')

    await evaluate(`takeoverProbe.operations.resolve(${JSON.stringify(fast.operationId)},'success')`)
    await wait(`!${sourceCard(2)}`, 'Confirmed exact Stop retires only its own card')
    assert.equal((await operationFacts()).pending.some(item => item.operationId === slow.operationId), true, 'A slow original Stop is independent of its neighbor completion')
    await frame('ops-06-stop-independent-completion')
    await evaluate(`takeoverProbe.operations.resolve(${JSON.stringify(slow.operationId)},'lost')`)
    await wait(`${feedback('stop')}?.dataset.phase==='unconfirmed'`)
    const beforeCheck = await operationFacts()
    await click(`${feedback('stop')}.querySelector('summary')`)
    await click(`([...${feedback('stop')}.querySelectorAll('button')].find(node=>node.textContent.includes('核对原操作')))`)
    await wait(`takeoverProbe.operations.facts().calls.filter(call=>call.kind==='stop-inspect').length>0`)
    assert.equal((await operationFacts()).calls.filter(call => call.kind === 'stop').length, beforeCheck.calls.filter(call => call.kind === 'stop').length, 'Read-only unknown Stop inspection does not resend')
    await frame('ops-07-stop-unconfirmed-static')
    own.scenarios.push('stop-unknown-read-only-inspection')

    const fork = await beginFork()
    await frame('ops-09-fork-in-flight')
    await evaluate(`takeoverProbe.operations.resolve(${JSON.stringify(fork.operationId)},'partial')`)
    await wait(`Object.values(takeoverProbe.operations.facts().operations).some(item=>item.kind==='fork'&&item.phase==='partial')`)
    const forkAfter = await operationFacts(), realFork = reference(forkAfter, 'fork')
    assert.ok(realFork.report?.agent?.agentSessionId, 'Partial Fork retains its actual new Native Agent')
    const beforeForkCheck = forkAfter.calls.filter(call => call.kind === 'creation').length
    await click(`${feedback('fork')}.querySelector('summary')`)
    await click(`([...${feedback('fork')}.querySelectorAll('button')].find(node=>node.textContent.includes('核对原操作')))`)
    await delay(200)
    assert.equal((await operationFacts()).calls.filter(call => call.kind === 'creation').length, beforeForkCheck, 'Partial creation inspection never creates again')
    await frame('ops-10-partial-real-result')
    own.scenarios.push('fork-real-original-controller', 'partial-result-inspection-without-create')
    const final = await facts()
    assert.deepEqual(final.drafts, initial.drafts, 'Operation completion and unknown preserve original drafts')
    assert.deepEqual(final.nativeSessions.find(session => session.id === initial.origins[0].sessionId)?.control, initial.sessions.find(session => session.id === initial.origins[0].sessionId)?.control, 'Healthy neighbor keeps its exact Run')
    own.inputAndScroll = await inputAndScroll('after-all-operations')
    await evaluate('takeoverProbe.operations.stream(false)')
    await wait('takeoverProbe.saved()', 'Actual production writers saved operation references, original drafts and Core workface')
    const sealed = await evaluate('takeoverProbe.seal()')
    const core = await spatial.read()
    assert.ok(Object.keys(sealed.persistedOperations).length > 0, 'Restart baseline contains actual unresolved original references')
    assert.deepEqual(Object.keys(sealed.requests), [fork.operationId], 'The exact original Fork is the only creation request in this qualification')
    const completedOperationKeys = Object.entries(sealed.operations).filter(([, operation]) => operation.phase === 'succeeded').map(([key]) => key)
    assert.ok(completedOperationKeys.length > 0, 'A completed Stop without a mounted card exercises finite, nonpersistent completion')
    assert.ok(completedOperationKeys.every(key => !Object.hasOwn(sealed.persistedOperations, key)), 'Actual production persistence omits confirmed completion decorations')
    await fs.writeFile(path.join(evidence, 'agent-operations-restart-baseline.json'), JSON.stringify({ ...sealed, operations: sealed.persistedOperations, completedOperationKeys, spatial: core }, null, 2))
    own.scenarios.push('persistent-original-operation-references')
  } else {
    const baseline = JSON.parse(await fs.readFile(path.join(evidence, 'agent-operations-restart-baseline.json'), 'utf8'))
    const restored = await facts(), before = await operationFacts()
    assert.deepEqual(before.inputs, [], 'Second-process startup replays no original Native input')
    assert.equal(restored.bootRestored, true)
    const byIdentity = sessions => [...sessions].sort((left, right) => JSON.stringify(left.control).localeCompare(JSON.stringify(right.control)))
    assert.deepEqual(byIdentity(restored.sessions), byIdentity(baseline.nativeSessions), 'Second Renderer restores exact surviving Host, Session and Run identities')
    assert.deepEqual(byIdentity(restored.nativeSessions), byIdentity(baseline.nativeSessions), 'Controlled Native retains the same surviving Host, Session and Run identities')
    assert.deepEqual(restored.tabs, baseline.tabs, 'Actual second Renderer restores the original workface with no topology reseed')
    assert.deepEqual(restored.layouts, baseline.layouts)
    assert.deepEqual(restored.drafts, baseline.drafts)
    assert.deepEqual(restored.requests, baseline.requests, 'Exact original creation requests survive process restart')
    assert.deepEqual(Object.keys(restored.operations).sort(), Object.keys(baseline.operations).sort(), 'Exact unresolved client references survive process restart')
    for (const [key, original] of Object.entries(baseline.operations)) {
      const actual = restored.operations[key]
      for (const field of ['kind', 'operationId', 'subject', 'control', 'report']) assert.deepEqual(actual[field], original[field], 'Restart retains original operation identity and any real partial result: ' + field)
    }
    assert.ok(baseline.completedOperationKeys.every(key => !Object.hasOwn(restored.operations, key)), 'Confirmed completion never reappears as a restart warning')
    assert.ok(Object.values(restored.operations).every(operation => operation.phase === 'unconfirmed'), 'Restored references are unknown observations, never fabricated active work')
    assert.equal(restored.launches.length, 0, 'Startup never recreates a previous operation')
    await frame('ops-11-restart-original-references')
    for (const node of await evaluate(`[...${cards}.querySelectorAll('.agent-operation-feedback summary')].map((node,index)=>index)`)) {
      await click(`${cards}.querySelectorAll('.agent-operation-feedback summary')[${node}]`)
    }
    const checks = await evaluate(`[...${cards}.querySelectorAll('.agent-operation-feedback button')].filter(node=>node.textContent.includes('核对原操作')).length`)
    assert.ok(checks > 0)
    for (let index = 0; index < checks; index++) {
      // Re-query after each real check because confirmed operations can legitimately retire their projection.
      const target = `([...${cards}.querySelectorAll('.agent-operation-feedback button')].filter(node=>node.textContent.includes('核对原操作'))[${Math.min(index, checks - 1)}])`
      if (await evaluate(`Boolean(${target})`)) await click(target)
      await delay(80)
    }
    assert.equal((await facts()).launches.length, 0)
    const afterChecks = await operationFacts(), afterFacts = await facts()
    assert.deepEqual(byIdentity(afterFacts.sessions), byIdentity(baseline.nativeSessions), 'Read-only reconciliation preserves exact surviving Renderer identities')
    assert.deepEqual(byIdentity(afterFacts.nativeSessions), byIdentity(baseline.nativeSessions), 'Read-only reconciliation preserves exact surviving Native identities')
    assert.equal(afterChecks.calls.filter(call => call.kind === 'stop' || call.kind === 'creation').length, 0, 'Restart checks do not replay Stop or Start')
    assert.deepEqual(afterChecks.inputs, [], 'Restart inspection replays no original Native input')
    await frame('ops-12-restart-read-only-reconciliation')
    own.scenarios.push('second-real-process-no-reseed', 'restored-unknown-checks-without-replay')
    own.restart = { noWorkfaceReseed: true, operationReferencesPreserved: true, noReplay: true, checks, before, after: afterChecks, identitiesBefore: { sessions: restored.sessions, nativeSessions: restored.nativeSessions }, identitiesAfter: { sessions: afterFacts.sessions, nativeSessions: afterFacts.nativeSessions } }
    result.restart = own.restart
  }
  exports.assertStopForkScenarios(own.scenarios, mode)
  own.passed = true
}
