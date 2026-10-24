const assert = require('node:assert/strict')
const expectedFrames = ['endpoints-dark-parallel', 'endpoints-prepared', 'endpoints-prepared-tooltip', 'endpoints-retired-selected', 'endpoints-light-parallel', 'endpoints-grayscale-parallel', 'endpoints-point-motion-off', 'endpoints-mixed-folded', 'endpoints-mixed-keyboard-tooltip']
const canonical = (host, id) => JSON.stringify([host, id])
const pairOf = edge => JSON.parse(edge.id).slice(1).map(id => JSON.parse(id)[1]).sort().join('|')
const within = (p, v) => p && p.x >= 0 && p.y >= 44 && p.x <= v.width && p.y <= v.height - 24

function verifyScene(sample, scope, { point = false, mixed = false } = {}) {
  assert.ok(sample?.label && Number.isFinite(sample.zoom) && sample.zoom > 0)
  assert.ok(sample.edges?.length && sample.captions?.length && sample.geometry?.boxes > 0 && sample.geometry?.paths > 0, 'Original endpoint scene cannot be empty')
  assert.deepEqual(sample.geometry.issues, [], 'No hidden failed route may stand in for a clearer endpoint')
  assert.equal(sample.geometry.missingPaths.length, 0, 'Every original route remains available')
  for (const edge of sample.edges) {
    assert.ok(edge.id && edge.source && edge.target && edge.label && edge.path && edge.length > 0)
    assert.equal(edge.role, 'button'); assert.equal(edge.tabIndex, 0)
    const marker = edge.marker
    assert.ok(marker?.id && edge.markerEnd.includes(marker.id), 'The actual BaseEdge references its actual endpoint marker')
    assert.equal(marker.orient, 'auto-start-reverse'); assert.equal(marker.units, 'userSpaceOnUse')
    assert.deepEqual(marker.viewBox, [0, 0, 20, 12]); assert.equal(marker.refX, 19); assert.equal(marker.refY, 6)
    assert.ok(Math.abs(marker.width * sample.zoom - 20) < .02 && Math.abs(marker.height * sample.zoom - 12) < .02, 'Marker size is compensated by the actual camera scale')
    assert.equal(marker.direction, edge.kind === 'creation' ? 'open' : 'filled')
    assert.ok(marker.headPath && marker.display !== 'none' && marker.visibility === 'visible')
    if (edge.kind === 'creation') {
      assert.equal(marker.icon?.name, 'object.agent-creation'); assert.ok(marker.icon.href && marker.icon.symbol, 'The original semantic icon resolves through the actual theme sprite')
      assert.notEqual(marker.icon.display, 'none'); assert.equal(marker.icon.visibility, 'visible')
      assert.equal(marker.headFill, 'none')
    }
    if (edge.targetVisible) {
      assert.ok(within(edge.end, sample.viewport), 'The observed target tip is actually in the native viewport')
      assert.ok(edge.targetBody && Math.abs(edge.targetDistance) <= 2, 'The true directional tip reaches the actual visible target hull')
      assert.ok(Math.hypot(edge.tangent.x, edge.tangent.y) > 0, 'The endpoint has a real final direction')
    }
  }
  const prepared = canonical(scope.hostId, scope.prepared), retired = canonical(scope.hostId, scope.retired)
  const active = canonical(scope.hostId, scope.active), source = canonical(scope.hostId, scope.source)
  for (const id of (mixed ? [active, source] : [prepared, retired, active, source])) assert.ok(sample.subjects.includes(id), 'Every original currently unfolded endpoint has actual delivered geometry')
  if (point) {
    const preparedNodes = sample.nodes.filter(node => node.subject === prepared)
    assert.ok(preparedNodes.length > 0, 'The exact original prepared point must actually be mounted')
    assert.ok(sample.zoom < .32 && preparedNodes.every(node => node.overview), 'Point evidence records actual point LOD, not a frame name')
  }
  const expectedTarget = sample.label.includes('parallel') ? active : sample.label === 'endpoints-retired-selected' ? retired : prepared
  if (!mixed) assert.ok(sample.edges.some(edge => edge.kind === 'creation' && edge.targetSubject === expectedTarget && edge.targetVisible), 'The declared original target and its actual endpoint are in the native viewport')
  if (!mixed) {
    const edge = sample.edges.find(edge => edge.kind === 'creation' && edge.targetSubject === prepared)
    assert.ok(edge, 'The original preparation relation remains present')
    const caption = sample.captions.find(caption => caption.id === edge.id)
    assert.equal(caption?.text, 'Creation unconfirmed'); assert.equal(caption.unconfirmed, 'true')
    if (edge.targetVisible) assert.ok(caption.visible && caption.fontSize >= 10 && !caption.overflow, 'Preparation remains readable at its currently visible endpoint')
  } else {
    const edge = sample.edges.find(edge => edge.kind === 'creation' && edge.target === scope.unplacedArea)
    assert.ok(edge?.targetVisible, 'The actual folded original group is a visible target')
    const caption = sample.captions.find(caption => caption.id === edge.id)
    assert.equal(caption?.text, 'Creation records · includes unconfirmed'); assert.equal(caption.unconfirmed, 'true')
    assert.ok(caption.visible && !caption.overflow && caption.fontSize >= 10)
  }
}

function verifyTooltip(record, scope, title) {
  assert.ok(record?.id && record.anchor?.path && record.anchor?.held, 'Tooltip retains the actual BaseEdge anchor')
  assert.equal(record.role, 'tooltip'); assert.equal(record.title, title)
  assert.ok(record.detail?.includes(' → ') && /\d+ original records?/.test(record.detail))
  assert.equal(record.aria, record.title + ': ' + record.detail, 'Full ARIA retains ordered endpoints and count independently of the short first line')
  assert.equal(record.layer, 'tooltip'); assert.equal(record.inMap, false)
  assert.ok(record.visible && !record.overflow && record.bounds.width > 0 && record.bounds.height > 0)
  assert.ok(record.bounds.x >= 0 && record.bounds.y >= 0 && record.bounds.x + record.bounds.width <= record.viewport.width + .5 && record.bounds.y + record.bounds.height <= record.viewport.height + .5)
  assert.equal(record.pointerEvents, 'none')
  assert.equal(record.hitTooltip, false, 'The original tooltip passes pointer input through')
  assert.ok(record.detail.includes(scope.names[scope.source]), 'The accurate source name remains in tooltip detail')
}

function verify(data, frames, workers) {
  assert.equal(data?.schema, 'agentmux.collaboration-endpoints-native.v1')
  const scope = data.scope
  assert.ok(scope && typeof scope.hostId === 'string' && ['source', 'active', 'prepared', 'retired', 'unplacedArea'].every(key => typeof scope[key] === 'string' && scope[key]))
  assert.equal(new Set([scope.source, scope.active, scope.prepared, scope.retired]).size, 4)
  assert.ok(scope.records?.length === 3 && scope.snapshotIds?.length > 0 && scope.historyIds?.length > 0)
  assert.ok(!scope.snapshotIds.includes(scope.prepared) && !scope.historyIds.includes(scope.prepared), 'Prepared is only an exact reference, with no invented Session or history')
  assert.ok(!scope.snapshotIds.includes(scope.retired) && scope.historyIds.includes(scope.retired))
  for (const [id, phase] of [[scope.active, 'active'], [scope.prepared, 'prepared'], [scope.retired, 'retired']]) {
    const record = scope.records.find(record => record.agentSessionId === id)
    assert.equal(record?.phase, phase); assert.equal(record.creation.createdBy.agentSessionId, scope.source)
    if (phase !== 'active') assert.equal(record.currentRun, null)
    if (phase === 'prepared') assert.equal(record.creation.createdRun, undefined, 'The only-reference preparation has no invented past Run either')
  }
  assert.ok(workers?.length > 0, 'The original raw Worker request observations are required')
  assert.deepEqual(data.samples?.map(sample => sample.label), expectedFrames)
  for (const sample of data.samples) verifyScene(sample, scope, { point: sample.label === 'endpoints-point-motion-off', mixed: sample.label.startsWith('endpoints-mixed-') })
  for (const sample of data.samples) {
    const original = workers.find(worker => worker.request?.id === sample.structuralInput?.requestId && worker.complete && worker.input?.ids?.length)
    assert.ok(original, 'Each scene joins its actual completed original structural request')
    assert.deepEqual(sample.structuralInput.subjects, original.input.ids.map(id => JSON.parse(id)[1]))
    for (const id of [scope.source, scope.active, scope.prepared, scope.retired]) assert.ok(sample.structuralInput.subjects.includes(canonical(scope.hostId, id)), 'Folding presentation never removes an accurate endpoint from the original world input')
  }
  for (const label of expectedFrames) assert.equal(frames.filter(frame => frame.label === label && frame.file === label + '.png').length, 1, 'Missing or duplicate complete endpoint frame: ' + label)
  const dark = data.samples[0], pair = [canonical(scope.hostId, scope.source), canonical(scope.hostId, scope.active)].sort().join('|')
  const parallels = dark.edges.filter(edge => pairOf(edge) === pair)
  assert.deepEqual(parallels.map(edge => edge.kind).sort(), ['communication', 'communication', 'creation', 'supervision'])
  assert.equal(new Set(parallels.map(edge => edge.path)).size, 4, 'Reverse messages and same-direction relation kinds have independent actual paths')
  for (const edge of parallels) assert.ok(edge.targetVisible, 'Every parallel target tip is visible in the dark reading frame')
  assert.deepEqual(parallels.filter(edge => edge.kind !== 'communication').map(edge => [edge.sourceSubject, edge.targetSubject]), [[canonical(scope.hostId, scope.source), canonical(scope.hostId, scope.active)], [canonical(scope.hostId, scope.source), canonical(scope.hostId, scope.active)]])
  for (const label of ['endpoints-dark-parallel', 'endpoints-light-parallel', 'endpoints-grayscale-parallel']) {
    const sample = data.samples.find(sample => sample.label === label)
    assert.ok(sample.zoom >= .7 && sample.edges.some(edge => edge.kind === 'creation' && edge.targetSubject === canonical(scope.hostId, scope.active) && sample.captions.some(caption => caption.id === edge.id && caption.text === 'Created' && caption.unconfirmed === 'false' && caption.visible)))
  }
  const retiredView = data.samples.find(sample => sample.label === 'endpoints-retired-selected')
  const retiredEdge = retiredView.edges.find(edge => edge.kind === 'creation' && edge.targetSubject === canonical(scope.hostId, scope.retired))
  assert.ok(retiredView.captions.some(caption => caption.id === retiredEdge.id && caption.text === 'Created' && caption.unconfirmed === 'false' && caption.visible), 'Retired history remains a readable creation provenance, never pending or online')
  assert.notEqual(dark.surface, data.samples.find(sample => sample.label === 'endpoints-light-parallel').surface, 'Light/dark must change the original rendered theme')
  assert.deepEqual(data.grayscale, { protocol: 'Emulation.setEmulatedVisionDeficiency', type: 'achromatopsia', restored: true })
  const off = data.samples.find(sample => sample.label === 'endpoints-point-motion-off')
  assert.equal(off.motion, 'off'); assert.equal(off.packets, 0); assert.equal(off.pulses, 0)
  verifyTooltip(data.pointerTooltip, scope, 'Creation unconfirmed')
  verifyTooltip(data.keyboardTooltip, scope, 'Creation records · includes unconfirmed')
  assert.equal(data.keyboardTooltip.focused, true)
  assert.deepEqual(data.selections?.map(selection => selection.phase), ['retired', 'mixed'])
  assert.ok(data.selections[0].evidence.includes(scope.retired) && data.selections[0].evidence.includes('Recorded retired'))
  assert.ok(data.selections[1].evidence.includes(scope.prepared) && data.selections[1].evidence.includes('Recorded prepared'))
  assert.equal(data.selections[1].grouped, 2, 'Mixed selection preserves both exact original relations')
  assert.equal(data.escapeCleared, true)
  assert.ok(data.sourceReads?.some(read => read.kind === 'spawns' && read.participant === scope.source))
  assert.deepEqual(data.beforeControls, []); assert.deepEqual(data.afterControls, [])
  assert.equal(data.bodyReads, 0, 'Endpoint observation never opens original message bodies')
}

// Read-only measurement of original SVG, DOM and delivered geometry. No route,
// camera, selection, lifecycle or phase is substituted by the observer.
function observe(label) {
  const viewport = document.querySelector('.collaboration-map .react-flow__viewport'), zoom = new DOMMatrix(getComputedStyle(viewport).transform).a
  const bounds = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  const visible = rect => rect.x >= 0 && rect.y >= 44 && rect.x + rect.width <= innerWidth && rect.y + rect.height <= innerHeight - 24
  const nodes = [...document.querySelectorAll('.collaboration-map [data-collaboration-agent]')].map(node => ({ subject: node.dataset.collaborationAgent, overview: node.dataset.overview === 'true' }))
  const edges = [...document.querySelectorAll('.collaboration-map .react-flow__edge')].map(edge => {
    const [kind, source, target] = JSON.parse(edge.dataset.id), path = edge.querySelector('.react-flow__edge-path'), length = path.getTotalLength(), transform = path.getScreenCTM()
    const screen = p => { const q = new DOMPoint(p.x, p.y).matrixTransform(transform); return { x: q.x, y: q.y } }
    const start = screen(path.getPointAtLength(0)), end = screen(path.getPointAtLength(length)), prior = screen(path.getPointAtLength(Math.max(0, length - 1)))
    const markerEnd = path.getAttribute('marker-end'), markerId = markerEnd.match(/#([^)"]+)/)?.[1], marker = document.getElementById(markerId), head = marker?.querySelector('[data-direction-head]'), icon = marker?.querySelector('[data-semantic-icon]'), href = icon?.querySelector('use')?.getAttribute('href'), symbol = href?.startsWith('#') ? document.getElementById(href.slice(1)) : null
    const targetNode = [...document.querySelectorAll('.react-flow__node')].find(node => node.dataset.id === target), body = targetNode?.querySelector('.collaboration-agent__body,.collaboration-area'), targetBody = body ? bounds(body) : null
    const radius = body ? Math.min(parseFloat(getComputedStyle(body).borderTopLeftRadius) * zoom || 0, targetBody.width / 2, targetBody.height / 2) : 0
    const qx = targetBody ? Math.abs(end.x - targetBody.x - targetBody.width / 2) - (targetBody.width / 2 - radius) : 0, qy = targetBody ? Math.abs(end.y - targetBody.y - targetBody.height / 2) - (targetBody.height / 2 - radius) : 0
    const distance = targetBody ? Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius : null
    return { id: edge.dataset.id, kind, source, target, sourceSubject: JSON.parse(source)[1], targetSubject: JSON.parse(target)[1], role: edge.getAttribute('role'), tabIndex: edge.tabIndex, label: edge.getAttribute('aria-label'), selected: edge.getAttribute('aria-pressed'), path: path.getAttribute('d'), length, start, end, tangent: { x: end.x - prior.x, y: end.y - prior.y }, targetBody, targetDistance: distance, targetVisible: Boolean(targetBody && visible(targetBody)), markerEnd,
      marker: marker && { id: markerId, orient: marker.getAttribute('orient'), units: marker.getAttribute('markerUnits'), viewBox: marker.getAttribute('viewBox').split(' ').map(Number), refX: Number(marker.getAttribute('refX')), refY: Number(marker.getAttribute('refY')), width: Number(marker.getAttribute('markerWidth')), height: Number(marker.getAttribute('markerHeight')), direction: head?.dataset.directionHead, headPath: head?.getAttribute('d'), headFill: head?.getAttribute('fill'), display: getComputedStyle(head).display, visibility: getComputedStyle(head).visibility,
        icon: icon && { name: icon.dataset.semanticIcon, href, symbol: symbol?.innerHTML, display: getComputedStyle(icon).display, visibility: getComputedStyle(icon).visibility } } }
  })
  const captions = [...document.querySelectorAll('.collaboration-edge__caption')].map(element => ({ id: element.dataset.relationId, text: element.textContent, unconfirmed: element.dataset.creationUnconfirmed, visible: visible(bounds(element)) && getComputedStyle(element).visibility === 'visible' && Number(getComputedStyle(element).opacity) > 0, overflow: element.scrollWidth > element.clientWidth + 1, fontSize: parseFloat(getComputedStyle(element).fontSize), bounds: bounds(element) }))
  const owner = globalThis.__collaborationCaptureLayout
  return { label, zoom, viewport: { width: innerWidth, height: innerHeight }, camera: viewport.getAttribute('style'), motion: document.querySelector('.collaboration-canvas').dataset.motion, surface: getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim(), edges, captions, nodes,
    subjects: [...owner.boxes.values()].filter(box => box.kind === 'agent').map(box => JSON.parse(box.id)[1]),
    geometry: { boxes: owner.boxes.size, paths: owner.paths.size, pathIds: [...owner.paths.keys()], issues: [...owner.issues] }, packets: document.querySelectorAll('.collaboration-edge__packet').length, pulses: document.querySelectorAll('.collaboration-edge__pulse').length }
}

module.exports = async function endpoints({ win, result, read, click, key, move, frame, check, facts, intact, matrix, mapReady, closeReader, closeDetails, locate, pause, until, settle, fillSearch, waitCamera, rect }) {
  const data = result.endpoints = { schema: 'agentmux.collaboration-endpoints-native.v1', scope: await read('window.graphCapture.endpoints()'), samples: [], selections: [], boundary: 'Exact source App/Graph/Worker and original input. Only private typed platform facts and unrelated painting are controlled. No user profile, Run, Provider, real message or persistence claim.' }
  data.beforeControls = (await facts()).controls
  const scope = data.scope
  async function locateTarget(id) {
    if (![scope.prepared, scope.retired].includes(id)) return locate(id)
    await read('globalThis.__collaborationCapturePreviousLocate=globalThis.__collaborationCaptureCamera?.locate?.token; true')
    await fillSearch(id)
    await until('exact original reference search result', () => read(`document.querySelector('[aria-label="Matching Agents"] [role="option"]')?.textContent.includes(${JSON.stringify(id)})`))
    await key('Enter')
    await until('original reference combobox committed', () => read(`document.querySelector('[aria-label="Find Agent in map"]').value===''&&!document.querySelector('[aria-label="Matching Agents"]')`))
    await waitCamera('locate', id, id)
    const selector = '[data-capture-reference-target]'
    await until('exact original reference has an actionable mark', () => read(`(()=>{for(const e of document.querySelectorAll('${selector}'))e.removeAttribute('data-capture-reference-target');const node=[...document.querySelectorAll('.collaboration-map [data-collaboration-agent]')].find(e=>e.dataset.collaborationAgent===${JSON.stringify(canonical(scope.hostId, id))}),button=node?.querySelector('[data-map-layer]:not([inert]) button');if(!button)return false;button.setAttribute('data-capture-reference-target','');return true})()`))
    assert.equal((await rect(selector)).hit, true, 'The original only-reference mark stays actionable without inventing a Session context')
  }
  const edgeSelector = (kind, target) => `.react-flow__edge[data-capture-endpoint=${JSON.stringify(kind + '-' + target)}]`
  const markEdge = async (kind, target) => {
    const selector = edgeSelector(kind, target)
    assert.ok(await read(`(()=>{const edge=[...document.querySelectorAll('.collaboration-map .react-flow__edge')].find(e=>{const [kind,from,to]=JSON.parse(e.dataset.id);return kind===${JSON.stringify(kind)}&&JSON.parse(from)[1]===${JSON.stringify(canonical(scope.hostId, scope.source))}&&(to===${JSON.stringify(target)}||JSON.parse(to)[1]===${JSON.stringify(canonical(scope.hostId, target))})});if(!edge)return false;edge.setAttribute('data-capture-endpoint',${JSON.stringify(kind + '-' + target)});return true})()`), 'The exact original semantic relation must exist')
    return selector
  }
  const sample = async label => {
    await until('original endpoint layout settles', () => read('globalThis.__collaborationCaptureLayout?.busy===false'))
    await settle(); const measured = await read(`(${observe.toString()})(${JSON.stringify(label)})`)
    const workers = await read('window.graphCapture.workerSamples()'), latest = workers.filter(worker => worker.request?.type === 'route' && worker.complete).at(-1)
    assert.ok(latest?.request?.connectionIds?.length, 'A nonempty original route request must have completed'); measured.geometry.missingPaths = latest.request.connectionIds.filter(id => !measured.geometry.pathIds.includes(id))
    const structure = workers.filter(worker => worker.complete && worker.input?.ids?.length).at(-1)
    assert.ok(structure?.request?.id, 'The original full structural input must exist before observing an endpoint')
    measured.structuralInput = { requestId: structure.request.id, subjects: structure.input.ids.map(id => JSON.parse(id)[1]) }
    data.samples.push(measured); await frame(label); return measured
  }
  const wheelTo = async target => {
    for (let iteration = 0; iteration < 10; iteration++) {
      const zoom = await read(`new DOMMatrix(getComputedStyle(document.querySelector('.collaboration-map .react-flow__viewport')).transform).a`)
      if (Math.abs(zoom - target) < .002) return
      const pane = await read(`(()=>{const r=document.querySelector('.collaboration-canvas').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...pane, deltaX: 0, deltaY: Math.max(-180, Math.min(180, -Math.log2(target / zoom) / .002)), modifiers: 0 })
      await pause(120)
    }
    throw Error('Actual native wheel did not reach endpoint scale')
  }
  const tooltip = async selector => read(`(()=>{const edge=document.querySelector(${JSON.stringify(selector)}),path=edge?.querySelector('.react-flow__edge-path'),id=edge?.getAttribute('aria-describedby'),panel=id&&document.getElementById(id);if(!panel)return null;const r=panel.getBoundingClientRect(),style=getComputedStyle(panel),x=r.x+r.width/2,y=r.y+r.height/2;return{id:edge.dataset.id,aria:edge.getAttribute('aria-label'),title:panel.querySelector('strong')?.textContent,detail:panel.querySelector('span')?.textContent,role:panel.getAttribute('role'),focused:document.activeElement===edge,anchor:{path:path.getAttribute('d'),held:path===globalThis.__endpointTooltipAnchor},layer:panel.closest('[data-overlay-layer]')?.dataset.overlayLayer,inMap:Boolean(panel.closest('.collaboration-map')),visible:style.visibility==='visible'&&Number(style.opacity)>0,overflow:panel.scrollWidth>panel.clientWidth+1||panel.scrollHeight>panel.clientHeight+1,pointerEvents:style.pointerEvents,hitTooltip:document.elementsFromPoint(x,y).some(hit=>panel.contains(hit)),bounds:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight}}})()`)
  const focusEdge = async selector => { await read(`(()=>{const edge=document.querySelector(${JSON.stringify(selector)});globalThis.__endpointTooltipAnchor=edge.querySelector('.react-flow__edge-path');edge.focus()})()`); await until('original focused relation tooltip', async () => Boolean((await tooltip(selector))?.visible)) }
  async function select(selector, phase) {
    await focusEdge(selector); await key('Enter')
    await until('original exact relation detail', () => read(`Boolean(document.querySelector('.collaboration-evidence article'))`))
    const selected = await read(`(()=>{const edge=document.querySelector(${JSON.stringify(selector)});return{phase:${JSON.stringify(phase)},pressed:edge.getAttribute('aria-pressed'),title:document.querySelector('.collaboration-inspector__heading h3')?.textContent,endpoints:[...document.querySelectorAll('.collaboration-endpoints button')].map(e=>e.textContent),evidence:document.querySelector('.collaboration-evidence')?.textContent,grouped:document.querySelector('[aria-label="Grouped connections"]')?.children.length??1}})()`)
    assert.equal(selected.pressed, 'true'); data.selections.push(selected)
  }
  await check('endpoints-original-phases-parallel-and-input', async () => {
    await click('button.surface-navigation__focus'); await click('[aria-label="Map"]'); await mapReady(); await read('window.graphCapture.rememberMap()')
    await locateTarget(scope.source); await mapReady()
    await until('all three original creation phases arrive', () => read(`document.querySelectorAll('.collaboration-edge-group--creation').length>=3`))
    await click('[aria-label="Arrange map"]'); await mapReady(); await locateTarget(scope.active); await wheelTo(.8); await closeDetails()
    await sample('endpoints-dark-parallel')
    await locateTarget(scope.prepared); await wheelTo(.8); await closeDetails(); await sample('endpoints-prepared')
    const prepared = await markEdge('creation', scope.prepared)
    const point = await read(`(()=>{const edge=document.querySelector(${JSON.stringify(prepared)}),path=edge.querySelector('.react-flow__edge-path'),length=path.getTotalLength(),matrix=path.getScreenCTM();globalThis.__endpointTooltipAnchor=path;for(const fraction of [.8,.65,.5,.35,.2]){const p=path.getPointAtLength(length*fraction),q=new DOMPoint(p.x,p.y).matrixTransform(matrix);if(q.x>8&&q.y>44&&q.x<innerWidth-8&&q.y<innerHeight-44&&edge.contains(document.elementFromPoint(q.x,q.y)))return{x:q.x,y:q.y}}throw Error('Prepared path is not exposed to original pointer input')})()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await until('original pointer relation tooltip', async () => Boolean((await tooltip(prepared))?.visible)); data.pointerTooltip = await tooltip(prepared); await sample('endpoints-prepared-tooltip')
    await locateTarget(scope.retired); await wheelTo(.8); await closeDetails(); const retired = await markEdge('creation', scope.retired); await select(retired, 'retired'); await sample('endpoints-retired-selected'); await key('Escape'); await closeDetails(); await intact()
  })
  await check('endpoints-original-theme-point-and-static', async () => {
    await locateTarget(scope.active); await wheelTo(.8); await closeDetails(); await read('window.graphCapture.appearance("light")'); await pause(200); await sample('endpoints-light-parallel')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' }); data.grayscale = { protocol: 'Emulation.setEmulatedVisionDeficiency', type: 'achromatopsia', restored: false }
    try { await sample('endpoints-grayscale-parallel') } finally { await win.webContents.debugger.sendCommand('Emulation.setEmulatedVisionDeficiency', { type: 'none' }); data.grayscale.restored = true }
    await read('window.graphCapture.appearance("dark")'); await locateTarget(scope.prepared); await wheelTo(.3); await closeDetails()
    if (await read(`document.querySelector('[aria-label="Map animations"]').getAttribute('aria-pressed')==='true'`)) await click('[aria-label="Map animations"]')
    await until('original Motion Off saved', () => read(`document.querySelector('.collaboration-canvas').dataset.motion==='off'&&!document.querySelector('[aria-label="Map animations"]').hasAttribute('aria-busy')`))
    await sample('endpoints-point-motion-off'); await intact()
  })
  await check('endpoints-original-mixed-group-and-keyboard', async () => {
    await locateTarget(scope.prepared); await wheelTo(.8); await closeDetails()
    const selector = '.collaboration-area__fold[aria-label="Collapse Area unconfirmed"]'
    await click(selector)
    await until('actual original unplaced group is folded', () => read(`globalThis.__collaborationCaptureLayout?.boxes.get(${JSON.stringify(scope.unplacedArea)})?.folded===true&&!globalThis.__collaborationCaptureLayout?.busy`))
    await sample('endpoints-mixed-folded')
    const mixed = await markEdge('creation', scope.unplacedArea); await select(mixed, 'mixed'); data.keyboardTooltip = await tooltip(mixed); await sample('endpoints-mixed-keyboard-tooltip')
    await key('Escape'); data.escapeCleared = await read(`document.querySelector(${JSON.stringify(mixed)})?.getAttribute('aria-pressed')==='false'&&!document.querySelector('.collaboration-evidence')`)
    await closeDetails(); await intact()
  })
  const final = await facts(); data.sourceReads = final.reads; data.afterControls = final.controls; data.bodyReads = final.reads.filter(read => read.kind === 'body').length
  verify(data, result.frames, await read('window.graphCapture.workerSamples()'))
}
module.exports.verify = verify
