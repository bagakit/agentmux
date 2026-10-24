const assert = require('node:assert/strict')
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
const distance = (a, b) => Math.hypot(center(a).x - center(b).x, center(a).y - center(b).y)
const map = sample => new Map(sample.boxes.map(box => [box.id, box]))
const frames = ['adaptive-before-dark', 'adaptive-add-intermediate-dark', 'adaptive-added-dark', 'adaptive-delete-before-narrow-light', 'adaptive-deleted-narrow-light', 'adaptive-redraw-motion-off-narrow-light', 'adaptive-gesture-before-dark', 'adaptive-gesture-after-dark']
const phaseNames = ['add', 'remove-membership', 'redraw-motion-off', 'redraw-gesture']
const close = (a, b, message, tolerance = 1e-5) => assert.ok(Math.abs(a - b) <= tolerance, message + ': ' + a + ' versus ' + b)
function movement(a, b) { return Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(a[key] - b[key]))) }
function sameGeometry(a, b) { return movement(a, b) < 1e-8 && (a.kind !== 'area' || b.kind === 'area' && movement(a.heading, b.heading) < 1e-8) }
function progress(before, after, sample) {
  const a = map(before), b = map(after), current = map(sample)
  const changed = [...a].flatMap(([id, old]) => b.has(id) && current.has(id) && movement(old, b.get(id)) > 1 ? [{ id, old, next: b.get(id), value: current.get(id) }] : [])
  if (!changed.length) return null
  const first = changed[0], key = ['x', 'y', 'width', 'height'].sort((a, b) => Math.abs(first.next[b] - first.old[b]) - Math.abs(first.next[a] - first.old[a]))[0]
  const t = (first.value[key] - first.old[key]) / (first.next[key] - first.old[key])
  if (t <= .02 || t >= .98) return null
  for (const { old, next, value } of changed) {
    for (const key of ['x', 'y', 'width', 'height']) close(value[key], old[key] + (next[key] - old[key]) * t, 'One original presentation progress: ' + value.id + ' ' + key)
    if (old.kind === 'area' && next.kind === 'area') for (const key of ['x', 'y', 'width', 'height']) close(value.heading[key], old.heading[key] + (next.heading[key] - old.heading[key]) * t, 'The same heading progress: ' + value.id + ' ' + key)
  }
  return t
}
function painted(sample, required = false) {
  assert.deepEqual(sample.issues, [], 'No original route is hidden behind a native layout diagnostic')
  const boxes = map(sample), matrix = sample.transform, surface = sample.surface
  assert.ok(matrix && surface && sample.zoom > 0)
  for (const node of sample.nodes) {
    const box = boxes.get(node.id); assert.ok(box, 'Every observed DOM node uses the actual presented frame')
    close(node.bounds.x, surface.x + box.x * matrix.a + matrix.e, 'Actual node x consumes the current presented box', 1.5)
    close(node.bounds.y, surface.y + box.y * matrix.d + matrix.f, 'Actual node y consumes the current presented box', 1.5)
    close(node.bounds.width, box.width * matrix.a, 'Actual node width consumes the current presented box', 1.5)
    close(node.bounds.height, box.height * matrix.d, 'Actual node height consumes the current presented box', 1.5)
  }
  const complete = sample.edges.filter(edge => edge.endpoints.length === 2)
  if (required) assert.ok(complete.length > 0 && sample.envelopes.some(area => area.members.length > 0 && area.corners.length >= 8), 'A real intermediate frame has actual complete arrows and member envelopes')
  for (const edge of sample.edges) for (const endpoint of edge.endpoints) {
    const { point, body, radius } = endpoint, x = Math.abs(point.x - body.x - body.width / 2) - body.width / 2 + radius,
      y = Math.abs(point.y - body.y - body.height / 2) - body.height / 2 + radius
    const error = Math.abs(Math.hypot(Math.max(x, 0), Math.max(y, 0)) + Math.min(Math.max(x, y), 0) - radius)
    assert.ok(error < 1.5, 'The actual original arrow meets its current visible body: ' + edge.id + ' ' + endpoint.id + ' error=' + error)
  }
  for (const area of sample.envelopes) assert.ok(area.corners.length >= 4 && area.corners.every(point => point.inside), 'The drawn original contour encloses its current complete members and heading: ' + area.id)
}
function verify(data, actualFrames) {
  assert.ok(data && data.scope?.members?.length === 12 && new Set(data.scope.members.map(member => member.nodeId)).size === 12)
  assert.deepEqual(data.phases?.map(phase => phase.name), phaseNames, 'Every native structural and intent phase is mandatory')
  assert.ok(data.scope.areas.length === 5 && data.scope.control.nodeId && data.readerNodeId && data.farthestNodeId)
  for (const label of frames) assert.ok(actualFrames.some(frame => frame.label === label), 'Missing complete adaptive native frame: ' + label)
  for (const phase of data.phases) {
    assert.ok(phase.trace.samples.length >= 2 && phase.workers.length > 0 && phase.target?.geometry?.length > 0, 'No empty native structural phase: ' + phase.name)
    assert.ok(phase.workers.some(worker => worker.request?.type === 'reconcile' && worker.complete), 'The original structural Worker actually completes: ' + phase.name)
    assert.ok(phase.workers.every(worker => worker.request?.type !== 'arrange'), 'A local structure change never becomes another global Arrange')
    const before = map(phase.before), after = map(phase.after), target = new Map(phase.target.geometry.map(box => [box.id, box]))
    for (const id of [data.readerNodeId, data.scope.control.nodeId, data.scope.control.areaId]) assert.deepEqual(after.get(id), before.get(id), 'The accurate reading occurrence and unrelated control stay fixed: ' + id)
    for (const [id, box] of after) assert.deepEqual(box, target.get(id), 'Final presentation reaches the same actual Worker target: ' + id)
    assert.ok(phase.before.held.sameReader && phase.after.held.sameReader && phase.after.held.sameAnchor && phase.after.held.sameSubject && phase.after.held.readers === 1 && phase.after.held.subject === data.scope.reader && phase.after.held.hostId === 'local' && phase.after.held.runId === phase.before.held.runId, 'The sole original Reader, exact request subject/Run and its anchor remain mounted')
    assert.equal(phase.after.held.sameFocus, true, 'The latest real keyboard or gesture owner retains focus')
    const middle = phase.trace.samples.filter(sample => sample.transitioning && progress(phase.before, phase.after, sample) !== null)
    if (phase.name === 'redraw-motion-off') {
      assert.equal(phase.after.motion, 'false'); assert.equal(phase.after.packets, 0)
      assert.ok(phase.trace.samples.every(sample => !sample.transitioning), 'Motion Off never starts a presentation clock')
      for (const sample of phase.trace.samples) for (const box of sample.boxes) if (before.has(box.id) && after.has(box.id)) assert.ok(
        sameGeometry(box, before.get(box.id)) || sameGeometry(box, after.get(box.id)), 'Motion Off commits the same complete target directly, without an unreported intermediate body')
      assert.equal(middle.length, 0)
    } else {
      assert.ok(middle.length > 0, 'Native rAF observes a genuine finite intermediate geometry: ' + phase.name)
      for (const sample of middle) { painted(sample, true); assert.equal(sample.held.sameReader, true); assert.equal(sample.held.sameAnchor, true) }
    }
    if (phase.name === 'redraw-gesture') {
      assert.ok(phase.trace.gesture?.trusted && phase.trace.gesture.inCanvas && phase.trace.gesture.transitioning, 'A real native pointer gesture interrupts the still-active transition')
      assert.notEqual(phase.after.camera, phase.before.camera)
      assert.equal(phase.later.camera, phase.after.camera); assert.deepEqual(phase.later.boxes, phase.after.boxes)
    } else {
      assert.equal(phase.after.camera, phase.before.camera, 'Structure cannot move the camera')
      assert.ok(phase.trace.samples.every(sample => sample.camera === phase.before.camera && sample.held.sameFocus), 'The original reader focus and camera survive every structural frame')
      for (const key of ['x', 'y', 'width', 'height']) close(phase.after.held.readerBounds[key], phase.before.held.readerBounds[key], 'The held original Reader stays at its current reading anchor', 1.5)
    }
    painted(phase.after, true)
  }
  const added = data.phases[0], before = map(added.before), after = map(added.after), fresh = after.get(added.fact.member.nodeId)
  assert.equal(added.fact.evidence.length, 64); assert.equal(new Set(added.fact.evidence.map(row => row.id)).size, 64)
  assert.ok(added.fact.evidence.every(row => row.hostId === 'local' && row.live === false))
  assert.ok(distance(before.get(data.farthestNodeId), after.get(data.farthestNodeId)) > 1, 'A surviving original neighbor really moves on addition')
  assert.ok(distance(fresh, after.get(data.readerNodeId)) + distance(fresh, after.get(data.farthestNodeId)) < distance(before.get(data.readerNodeId), before.get(data.farthestNodeId)) * .95, 'The independently fixed two-edge span improves by at least five percent')
  const strong = added.target.input.edges.filter(edge => edge.source === fresh.id && [data.readerNodeId, data.farthestNodeId].includes(edge.target))
  assert.equal(strong.length, 2); assert.ok(strong.every(edge => edge.strength >= 16), 'Both known strong relationships reached the real Worker through the original bounded reader')
  const removed = data.phases[1], old = map(removed.before), surviving = map(removed.after)
  assert.ok(old.has(removed.fact.oldNodeId) && !surviving.has(removed.fact.oldNodeId) && surviving.has(removed.fact.nodeId), 'Membership removal preserves the same Session in its actual new area')
  const hole = values => data.surrounding.reduce((sum, id) => sum + distance(values.get(id), old.get(removed.fact.oldNodeId)), 0)
  assert.equal(data.surrounding.length, 2); assert.ok(hole(surviving) < hole(old) * .95, 'Two preselected old neighbors reclaim the internal vacancy by at least five percent')
  assert.ok(data.surrounding.some(id => distance(old.get(id), surviving.get(id)) > 1))
  assert.ok(data.phases[2].fact.active && !data.phases[3].fact.active)
  assert.deepEqual([map(data.phases[2].after).get(data.phases[2].fact.nodeId).width, map(data.phases[2].after).get(data.phases[2].fact.nodeId).height], [250, 94], 'The exact original non-reader receives its active footprint')
  assert.deepEqual([map(data.phases[3].after).get(data.phases[3].fact.nodeId).width, map(data.phases[3].after).get(data.phases[3].fact.nodeId).height], [154, 38], 'The same original non-reader returns to its compact footprint')
  assert.ok(data.intact, 'Original durable workface, draft, spatial selection and no-Run-control checks completed')
}

module.exports = async function adaptive({ win, result, read, click, key, move, frame, check, intact, mapReady, closeDetails, locate, pause, until, matrix, dragCanvas }) {
  await check('adaptive-original-structure-and-motion-consumers', async () => {
    const scope = await read('window.graphCapture.adaptivePrepare()')
    const data = result.adaptive = { scope, phases: [], readerNodeId: scope.members[0].nodeId }
    const sample = () => read('window.graphCapture.adaptiveSample()')
    const settled = async () => {
      let previous = '', since = 0
      await until('the actual presented adaptive frame and pending source facts settle', async () => {
        const status = await read('window.graphCapture.adaptiveStatus()'), key = JSON.stringify(status)
        if (status.busy || status.reading || key !== previous) { previous = key; since = Date.now(); return false }
        return Date.now() - since >= 200
      })
    }
    for (const member of scope.members) { await locate(member.id); await closeDetails(); await mapReady() }
    const previousJobs = await read('window.graphCapture.workerSamples().length')
    await click('[aria-label="Arrange map"]')
    await until('the explicit original adaptive arrangement completes', () => read(`window.graphCapture.workerSamples().slice(${previousJobs}).some(worker=>worker.request?.type==='arrange'&&worker.complete)`)); await settled()
    const layout = await read('window.graphCapture.deliveredLayout()'), original = new Map(layout.boxes.map(box => [box.id, box]))
    for (const member of scope.members) { const box = original.get(member.nodeId); assert.ok(box, 'Every exact original adaptive member has actual world geometry'); assert.deepEqual([box.width, box.height], [154, 38], 'The original native idle facts reach their exact compact slots') }
    const arrangement = (await read('window.graphCapture.workerSamples()')).filter(worker => worker.request?.type === 'arrange' && worker.complete).at(-1)
    assert.equal(arrangement.input.areas.find(area => area.id === scope.areas[1].id)?.parentId, scope.areas[0].id)
    assert.equal(arrangement.input.areas.find(area => area.id === scope.areas[2].id)?.parentId, scope.areas[1].id)
    assert.equal(arrangement.input.edges.filter(edge => edge.kind === 'communication' && scope.members.some(member => member.nodeId === edge.source) && scope.members.some(member => member.nodeId === edge.target)).length, 11)
    const farthest = scope.members.filter(member => member.id !== scope.reader).sort((a, b) => distance(original.get(b.nodeId), original.get(data.readerNodeId)) - distance(original.get(a.nodeId), original.get(data.readerNodeId)) || a.nodeId.localeCompare(b.nodeId))[0]
    data.farthestNodeId = farthest.nodeId
    async function wheelTo(target) {
      for (let count = 0; count < 24; count++) {
        const current = await read(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`)
        if (Math.abs(Math.log(target / current)) < .001) return
        const point = await read(`(()=>{const canvas=document.querySelector('.collaboration-canvas'),r=canvas.getBoundingClientRect();for(const [x,y] of [[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]]){const point={x:r.x+r.width*x,y:r.y+r.height*y},hit=document.elementFromPoint(point.x,point.y);if(hit?.closest('.collaboration-canvas')===canvas&&!hit.closest('.collaboration-region-labels,.collaboration-canvas__hud,.agent-information-reader'))return point}throw Error('No actual native wheel surface')})()`)
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: Math.max(-180, Math.min(180, -Math.log2(target / current) / .002)) }); await pause(100)
      }
      throw Error('The actual adaptive native camera did not reach its readable scale')
    }
    async function fitWork(target) {
      await wheelTo(target)
      for (let attempt = 0; attempt < 16; attempt++) {
        const delta = await read(`(()=>{const layout=window.graphCapture.deliveredLayout(),box=layout.boxes.find(box=>box.id===${JSON.stringify(scope.areas[2].id)}),canvas=document.querySelector('.react-flow__renderer').getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);return{x:canvas.width*.44-(box.x+box.width/2)*m.a-m.e,y:canvas.height*.5-(box.y+box.height/2)*m.a-m.f}})()`)
        if (Math.abs(delta.x) < 2 && Math.abs(delta.y) < 2) break
        await dragCanvas(Math.max(-80, Math.min(80, delta.x)), Math.max(-80, Math.min(80, delta.y)))
      }
      await settled()
    }
    async function holdReader() {
      await read(`(()=>{const anchor=document.querySelector('.collaboration-agent__identity-layer:not([inert]) [data-session-id="fixture-adaptive-00"]');if(!anchor)throw Error('The real adaptive identity anchor must be in this view');window.__adaptiveAnchor=anchor;anchor.focus()})()`)
      await key('ArrowDown'); await until('the exact original adaptive anchor enters its own Reader', () => read(`(()=>{const anchor=window.__adaptiveAnchor,id=anchor?.getAttribute('aria-describedby'),reader=id&&document.getElementById(id);return anchor?.isConnected&&reader?.matches('.agent-information-reader')&&reader.contains(document.activeElement)})()`))
      if (await read(`Boolean(document.querySelector('[aria-label="Pin Agent bookmark"]'))`)) await click('[aria-label="Pin Agent bookmark"]')
      await move('.agent-information-reader__reading'); await read('window.graphCapture.adaptiveRemember()')
    }
    await locate(scope.reader); await closeDetails(); await fitWork(.55); await holdReader(); await frame('adaptive-before-dark')
    async function phase(name, expression, { middle, after, gesture = false } = {}) {
      const before = await sample(), first = await read('window.graphCapture.workerSamples().length')
      await read(`window.graphCapture.adaptiveTraceStart(${JSON.stringify(name)})`)
      const fact = await read(expression)
      if (name !== 'redraw-motion-off') {
        await until('a genuine original adaptive intermediate frame', async () => { const value = await sample(); return value.transitioning && value.boxes.some(box => { const old = before.boxes.find(old => old.id === box.id); return old && movement(old, box) > .2 }) })
        if (middle) await frame(middle, { motion: true })
        if (gesture) { await dragCanvas(36, 20); await read('window.graphCapture.adaptiveRememberFocus()') }
      }
      await settled()
      const current = await sample(), trace = await read('window.graphCapture.adaptiveTraceStop()'), workers = (await read('window.graphCapture.workerSamples()')).slice(first)
      const target = workers.filter(worker => worker.request?.type === 'reconcile' && worker.complete && worker.geometry).at(-1)
      const record = { name, before, after: current, trace, workers, target, fact }
      if (gesture) { await pause(300); record.later = await sample() }
      data.phases.push(record); if (after) await frame(after); await intact()
      return record
    }
    const added = await phase('add', `window.graphCapture.adaptiveAdd(${JSON.stringify(farthest.id)})`, { middle: 'adaptive-add-intermediate-dark', after: 'adaptive-added-dark' })
    const addedBoxes = map(added.after), fresh = addedBoxes.get(added.fact.member.nodeId)
    const internal = scope.members.filter(member => member.id !== scope.reader && member.id !== farthest.id).sort((a, b) => distance(addedBoxes.get(a.nodeId), fresh) - distance(addedBoxes.get(b.nodeId), fresh) || a.nodeId.localeCompare(b.nodeId))[0]
    data.surrounding = [...scope.members, added.fact.member].filter(member => member.id !== scope.reader && member.id !== internal.id)
      .sort((a, b) => distance(addedBoxes.get(a.nodeId), addedBoxes.get(internal.nodeId)) - distance(addedBoxes.get(b.nodeId), addedBoxes.get(internal.nodeId)) || a.nodeId.localeCompare(b.nodeId)).slice(0, 2).map(member => member.nodeId)
    await closeDetails(); await read('window.graphCapture.appearance("light")'); win.setContentSize(680, 820); await pause(180); await fitWork(.42); await holdReader(); await frame('adaptive-delete-before-narrow-light')
    await phase('remove-membership', `window.graphCapture.adaptiveRemoveMember(${JSON.stringify(internal.id)})`, { after: 'adaptive-deleted-narrow-light' })
    await click('[aria-label="Map animations"]'); await until('the original effective motion choice is off', () => read(`document.querySelector('[aria-label="Map animations"]').getAttribute('aria-pressed')==='false'&&document.querySelector('[aria-label="Map animations"]').getAttribute('aria-busy')!=='true'`)); await holdReader()
    const resize = scope.members.find(member => member.id !== scope.reader && member.id !== internal.id && member.id !== farthest.id)
    await phase('redraw-motion-off', `window.graphCapture.adaptiveTier(${JSON.stringify(resize.id)},true)`, { after: 'adaptive-redraw-motion-off-narrow-light' })
    await click('[aria-label="Map animations"]'); await until('the original effective motion choice is on', () => read(`document.querySelector('[aria-label="Map animations"]').getAttribute('aria-pressed')==='true'&&document.querySelector('[aria-label="Map animations"]').getAttribute('aria-busy')!=='true'`))
    await closeDetails(); win.setContentSize(1440, 900); await read('window.graphCapture.appearance("dark")'); await pause(180); await fitWork(.55); await holdReader(); await frame('adaptive-gesture-before-dark')
    await phase('redraw-gesture', `window.graphCapture.adaptiveTier(${JSON.stringify(resize.id)},false)`, { after: 'adaptive-gesture-after-dark', gesture: true })
    await intact(); data.intact = true; verify(data, result.frames)
  })
}
module.exports.verify = verify
