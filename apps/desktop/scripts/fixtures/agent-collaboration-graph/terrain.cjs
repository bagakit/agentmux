const assert = require('node:assert/strict')
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
const contains = (outer, inner) => outer.x <= inner.x + 1e-6 && outer.y <= inner.y + 1e-6 && outer.x + outer.width + 1e-6 >= inner.x + inner.width && outer.y + outer.height + 1e-6 >= inner.y + inner.height
const overlaps = (a, b) => a.x < b.x + b.width - 1e-6 && a.x + a.width > b.x + 1e-6 && a.y < b.y + b.height - 1e-6 && a.y + a.height > b.y + 1e-6
function verifyFoldRoundTrip({ before, folded, expanded, occurrences, areaIds, controlIds, anchors }) {
  const previous = new Map(before.map(box => [box.id, box])), restored = new Map(expanded.map(box => [box.id, box]))
  assert.deepEqual(expanded.filter(box => box.kind === 'agent' && areaIds.includes(box.areaId)).map(box => box.id).sort(), occurrences.slice().sort(), 'Expansion restores every exact original occurrence once, without assigning a new identity')
  const [root, tools, deep] = areaIds.map(id => restored.get(id))
  assert.ok(root?.kind === 'area' && tools?.kind === 'area' && deep?.kind === 'area' && !root.folded && !tools.folded && !deep.folded)
  assert.ok(contains(root, tools) && contains(tools, deep), 'Expansion restores complete true recursive containment')
  for (const area of [root, tools, deep]) assert.ok(contains(area, { ...area.heading, x: area.x + area.heading.x, y: area.y + area.heading.y }), 'Each full original heading remains inside its own terrain')
  const limit = Math.hypot(previous.get(areaIds[0]).width, previous.get(areaIds[0]).height)
  assert.ok(limit > 0)
  for (const id of occurrences) {
    const old = previous.get(id), box = restored.get(id)
    assert.deepEqual([box.kind, box.areaId, box.width, box.height, box.folded], [old.kind, old.areaId, old.width, old.height, old.folded], 'Fold/expand preserves the exact occurrence, actual footprint and original membership')
    assert.ok(contains(restored.get(box.areaId), box), 'Every original member stays fully contained in its accurate area')
    assert.ok(Math.hypot(center(box).x - center(old).x, center(box).y - center(old).y) <= limit, 'A local fold episode cannot teleport an old member beyond one original subtree diameter')
    for (const obstacle of expanded) {
      if (obstacle.id === id) continue
      const body = obstacle.kind === 'area' ? { ...obstacle.heading, x: obstacle.x + obstacle.heading.x, y: obstacle.y + obstacle.heading.y } : obstacle
      assert.ok(!overlaps(box, body), 'The restored accurate member clears every actual node and heading: ' + id + ' / ' + obstacle.id)
    }
  }
  for (let first = 0; first < occurrences.length; first++) for (const second of occurrences.slice(first + 1)) {
    const a = center(previous.get(occurrences[first])), b = center(previous.get(second)), nextA = center(restored.get(occurrences[first])), nextB = center(restored.get(second))
    if (Math.hypot(a.x - b.x, a.y - b.y) > 32) assert.ok((b.x - a.x) * (nextB.x - nextA.x) + (b.y - a.y) * (nextB.y - nextA.y) > 0, 'The original discernible neighbor direction cannot reverse on fold/expand')
  }
  assert.ok(controlIds.length >= 2, 'An independently qualified unrelated area and its original member are mandatory')
  for (const values of [folded, expanded]) {
    const actual = new Map(values.map(box => [box.id, box]))
    for (const id of controlIds) assert.deepEqual(actual.get(id), previous.get(id), 'The far unrelated control retains its exact world geometry: ' + id)
  }
  for (const [before, after] of [[anchors.beforeFold, anchors.folded], [anchors.beforeExpand, anchors.expanded]]) {
    assert.equal(after.areaId, before.areaId)
    assert.equal(after.inViewport, true, 'The exact original region retains a discoverable native fold/expand entry')
    assert.ok(Math.abs(after.x - before.x) < 1.5 && Math.abs(after.y - before.y) < 1.5, 'Fold/expand preserves the actually clicked screen heading, including a clamped context heading')
    assert.ok(Math.abs(after.zoom - before.zoom) < 1e-6, 'Fold/expand preserves the actual reading scale')
  }
}

/** Native input over the original App/Graph/Worker. No camera or geometry is assigned. */
module.exports = async function terrain({ win, result, read, click, key, move, frame, check, intact, mapReady, closeReader, closeDetails, locate, pause, until, matrix, measure }) {
  const original = await read('window.graphCapture.terrain()')
  assert.equal(original.areas.length, 3); assert.equal(original.agents.length, 3)
  const areaId = id => JSON.stringify(['area', id])
  const nodeId = (area, agent) => JSON.stringify([area, JSON.stringify(['local', agent])])
  const boxes = () => read('window.graphCapture.deliveredLayout().boxes')
  const settleLayout = () => until('the actual delivered terrain layout settles', () => read(`(()=>{const layout=window.graphCapture.deliveredLayout();return layout?.busy===false&&!layout.transitioning})()`))
  const foldedState = (id, folded) => until('original delivered ancestor reaches its requested folded state', () => read(`(()=>{const layout=window.graphCapture.deliveredLayout();return layout?.busy===false&&!layout.transitioning&&layout.boxes.some(box=>box.id===${JSON.stringify(id)}&&box.folded===${folded})})()`))
  const zoom = () => read(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`)
  async function wheelTo(target) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const current = await zoom()
      if (Math.abs(Math.log(target / current)) < .0008) return current
      const point = await read(`(()=>{const canvas=document.querySelector('.collaboration-canvas'),r=canvas.getBoundingClientRect(),anchor=window.__terrainAnchor?.isConnected?window.__terrainAnchor.getBoundingClientRect():null,candidates=[...(anchor?[{x:anchor.x+anchor.width/2,y:anchor.y+anchor.height/2}]:[]),...[ [.52,.52],[.82,.3],[.18,.3],[.82,.72],[.18,.72] ].map(([x,y])=>({x:r.x+r.width*x,y:r.y+r.height*y}))];const point=candidates.find(p=>{const hit=document.elementFromPoint(p.x,p.y);return hit?.closest('.collaboration-canvas')===canvas&&!hit.closest('.collaboration-region-labels,.collaboration-canvas__hud,.agent-information-reader')});if(!point)throw Error('No real Map surface exposed for native wheel input');return point})()`)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: Math.max(-180, Math.min(180, -Math.log2(target / current) / .002)) })
      await pause(120)
    }
    assert.ok(Math.abs(Math.log(target / await zoom())) < .002, 'Native wheel reaches the intended intermediate reading scale')
    return zoom()
  }
  await check('terrain-original-nesting-fold-and-exact-reveal', async () => {
    for (const agent of original.agents) { await locate(agent.id); await closeDetails() }
    const previousJobs = await read('window.graphCapture.workerSamples().length')
    await click('[aria-label="Arrange map"]')
    await until('this explicit Arrange reaches the original receiver', () => read(`window.graphCapture.workerSamples().slice(${previousJobs}).some(sample=>sample.request?.type==='arrange'&&sample.complete)`))
    await settleLayout()
    const before = await boxes(), byId = new Map(before.map(box => [box.id, box]))
    const originalOccurrences = original.agents.map(agent => nodeId(agent.areaId, agent.id))
    assert.equal(new Set(originalOccurrences).size, 3)
    assert.ok(originalOccurrences.every(id => byId.get(id)?.kind === 'agent'), 'All three original terrain bindings are present before any fold comparison')
    assert.equal(before.filter(box => box.kind === 'agent' && original.areas.some(area => areaId(area.id) === box.areaId)).length, originalOccurrences.length, 'The exact original subtree occurrence census is complete')
    const [root, tools, deep] = original.areas.map(area => byId.get(areaId(area.id)))
    assert.ok(root && tools && deep, 'All original registered project levels have Worker boxes')
    assert.ok(contains(root, tools) && contains(tools, deep), 'Complete descendants lie inside their actual ancestor boxes')
    const input = await read('window.graphCapture.workerSamples().filter(sample=>sample.request?.type==="arrange"&&sample.geometry).at(-1).input')
    const delivered = await read('window.graphCapture.deliveredLayout()')
    assert.deepEqual(delivered.issues, [], 'Every original connection in this native terrain scene has a validated route')
    assert.deepEqual(input.edges.filter(edge => !delivered.pathIds.includes(edge.id)).map(edge => edge.id), [], 'No original observed relationship is hidden to simplify this scene')
    assert.equal(input.areas.find(area => area.id === root.id).members, 0, 'A parent with no direct Agent is still a full terrain')
    assert.equal(input.areas.find(area => area.id === tools.id).parentId, root.id)
    assert.equal(input.areas.find(area => area.id === deep.id).parentId, tools.id)
    assert.ok(input.edges.some(edge => edge.source === nodeId(original.areas[2].id, 'fixture-terrain-b')), 'The explicitly read original external relationship enters the actual solve')
    assert.equal(input.edges.find(edge => edge.source === nodeId(original.areas[2].id, 'fixture-terrain-a') && edge.target === nodeId(original.areas[2].id, 'fixture-terrain-b') && edge.kind === 'communication')?.strength, 3, 'Explicit Arrange consumes three distinct original messages without counting their delivery event twice')
    const incident = new Set(input.edges.flatMap(edge => [edge.source, edge.target])), parents = new Set(input.areas.flatMap(area => area.parentId ? [area.parentId] : []))
    const candidates = before.filter(box => box.kind === 'area' && !input.areas.find(area => area.id === box.id)?.parentId && !parents.has(box.id) && !original.areas.some(area => areaId(area.id) === box.id))
      .map(area => ({ area, members: before.filter(box => box.kind === 'agent' && box.areaId === area.id) }))
      .filter(({ members }) => members.length > 0 && members.every(box => !incident.has(box.id)))
      .sort((a, b) => Math.hypot(center(b.area).x - center(root).x, center(b.area).y - center(root).y) - Math.hypot(center(a.area).x - center(root).x, center(a.area).y - center(root).y) || a.area.id.localeCompare(b.area.id))
    const control = candidates[0]
    assert.ok(control && Math.hypot(center(control.area).x - center(root).x, center(control.area).y - center(root).y) > Math.hypot(root.width, root.height) * 2, 'The independent control is a genuinely far disconnected region with an actual member')
    const labelSelector = '.collaboration-region-labels .collaboration-area__overview-label[data-area-id=' + JSON.stringify(root.id) + ']'
    const labelAnchor = async action => read(`(()=>{const labels=[...document.querySelectorAll(${JSON.stringify(labelSelector)})].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.closest('[hidden],[inert]')&&getComputedStyle(e).visibility==='visible'});if(labels.length!==1)throw Error('Expected exactly one visible original terrain heading');const label=labels[0],r=label.getBoundingClientRect(),canvas=document.querySelector('.collaboration-canvas').getBoundingClientRect(),button=[...label.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')===${JSON.stringify(action + ' 协作地形')});if(!button)throw Error('The same accurate heading has no requested fold action');const b=button.getBoundingClientRect();return{areaId:label.dataset.areaId,x:r.left-canvas.left,y:r.bottom-canvas.top,zoom:new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a,inViewport:b.left>=canvas.left&&b.top>=canvas.top&&b.right<=canvas.right&&b.bottom<=canvas.bottom&&button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}})()`)
    const foldClick = action => click(labelSelector + ' [aria-label=' + JSON.stringify(action + ' 协作地形') + ']')
    await click('[aria-label^="Locate 协作地形 ·"]')
    await until('parent terrain enters one of its actual readable descendant occurrences', () => read(`(()=>{const canvas=document.querySelector('.collaboration-canvas').getBoundingClientRect();return ['fixture-terrain-tool','fixture-terrain-a','fixture-terrain-b'].some(id=>{const card=document.querySelector('.collaboration-agent__detail-layer:not([inert]) .focus-context[data-session-id="'+id+'"]');if(!card)return false;const r=card.getBoundingClientRect(),layer=card.closest('[data-map-layer]');return getComputedStyle(layer).opacity==='1'&&r.x>=canvas.x&&r.y>=canvas.y&&r.right<=canvas.right&&r.bottom<=canvas.bottom})})()`))
    await frame('terrain-parent-readable-destination')
    await locate('fixture-terrain-a'); await closeDetails(); await frame('terrain-nested-dark')
    const camera = await matrix()
    const anchors = { beforeFold: await labelAnchor('Collapse') }
    await foldClick('Collapse'); await foldedState(root.id, true)
    anchors.folded = await labelAnchor('Expand')
    const folded = await boxes(), foldedIds = new Set(folded.map(box => box.id))
    assert.ok(foldedIds.has(root.id) && !foldedIds.has(tools.id) && !foldedIds.has(deep.id), 'Only the accurate visible ancestor represents its folded subtree')
    await frame('terrain-folded-dark')
    anchors.beforeExpand = await labelAnchor('Expand')
    await foldClick('Expand'); await foldedState(root.id, false)
    anchors.expanded = await labelAnchor('Collapse')
    const expanded = await boxes(), controlIds = [control.area.id, ...control.members.map(box => box.id)]
    verifyFoldRoundTrip({ before, folded, expanded, occurrences: originalOccurrences, areaIds: [root.id, tools.id, deep.id], controlIds, anchors })
    const expandedLayout = await read('window.graphCapture.deliveredLayout()')
    assert.deepEqual(expandedLayout.issues, []); assert.deepEqual(input.edges.filter(edge => !expandedLayout.pathIds.includes(edge.id)).map(edge => edge.id), [], 'Every original relationship returns with its accurate expanded endpoints')
    const settledJobs = await read('window.graphCapture.workerSamples().length')
    await pause(300); assert.deepEqual(await boxes(), expanded, 'The finite local adjustment stops without another structural input'); assert.equal(await read('window.graphCapture.workerSamples().length'), settledJobs, 'A settled fold episode does not continue simulating')
    await frame('terrain-expanded-dark')
    await click('[aria-label="Collapse 协作地形"]'); await foldedState(root.id, true)
    await locate('fixture-terrain-b'); await closeDetails(); await settleLayout()
    assert.ok((await boxes()).some(box => box.id === deep.id), 'Exact Agent search expands its required ancestors')
    await frame('terrain-deep-agent-revealed')
    await intact()
    result.terrain = { original, input, before, folded, expanded, camera, afterCamera: await matrix(), anchors, controlIds, displacementBound: 'One original subtree diameter; relative directions and all exact identity/containment/collision/route constraints independently checked.' }
  })
  await check('terrain-native-continuous-lod-and-selection-cost', async () => {
    await locate('fixture-terrain-a'); await closeDetails()
    const before = await boxes(), jobs = await read('window.graphCapture.workerSamples().length')
    const samples = []
    for (const target of [.319, .321, .44, .46, .62, .72, .82]) {
      const actual = await wheelTo(target)
      if (target === .319 || target === .321) assert.equal(actual < .32, target < .32, 'The actual camera crosses the glyph boundary on the declared side')
      await frame('terrain-lod-' + String(target).replace('.', '-'))
      samples.push({ target, actual, census: await read('window.graphCapture.census()') })
    }
    assert.deepEqual(await boxes(), before, 'Intermediate zooming changes no original world geometry')
    assert.equal(await read('window.graphCapture.workerSamples().filter(sample=>sample.request?.type!=="route").length'), await read(`window.graphCapture.workerSamples().slice(0,${jobs}).filter(sample=>sample.request?.type!=="route").length`), 'LOD never requests structural Worker work')
    await measure('terrain-live-message-in-nested-neighborhood', async () => { await read('window.graphCapture.live(true,"fixture-terrain-a","fixture-terrain-b")'); await pause(800) })
    await frame('terrain-nested-communication-live', { motion: true })
    await read('window.graphCapture.appearance("light")'); await frame('terrain-lod-light')
    win.setContentSize(680, 820); await pause(200); await locate('fixture-terrain-a'); await closeDetails(); await wheelTo(.62)
    await frame('terrain-narrow-light')
    await read('window.graphCapture.appearance("dark")'); await frame('terrain-narrow-dark')
    result.terrainLod = { samples, conditions: 'Actual native wheel input, original shared card and visible hull, unchanged Worker geometry; full frames are independent-review inputs.' }
    await intact()
  })
  await check('terrain-held-reader-keyboard-and-motion-choice', async () => {
    win.setContentSize(1440, 900); await pause(200)
    await locate('fixture-terrain-a'); await closeDetails(); await wheelTo(.9)
    // Exact DOM focus is an observation/keyboard entry, not a Store or camera seed.
    await read(`(()=>{const anchor=document.querySelector('.collaboration-agent__detail-layer:not([inert]) .focus-context[data-session-id="fixture-terrain-a"]');if(!anchor)throw Error('No original shared card anchor');window.__terrainAnchor=anchor;anchor.focus()})()`)
    await key('ArrowDown')
    await until('keyboard enters the sole original Reader', () => read(`Boolean(document.activeElement?.closest('.agent-information-reader'))`))
    await read(`window.__terrainReader=document.querySelector('.agent-information-reader')`)
    await wheelTo(.34)
    const held = await read(`(()=>{const anchor=window.__terrainAnchor,layer=anchor.closest('[data-map-layer]');return{sameReader:window.__terrainReader===document.querySelector('.agent-information-reader'),readers:document.querySelectorAll('.agent-information-reader').length,sameAnchor:anchor.isConnected,opacity:getComputedStyle(layer).opacity,inert:layer.inert,proxy:anchor.closest('[data-collaboration-agent]').querySelector('.collaboration-agent__focus-proxy')?.textContent}})()`)
    assert.equal(held.sameReader,true);assert.equal(held.readers,1);assert.equal(held.sameAnchor,true);assert.equal(held.opacity,'1');assert.equal(held.inert,false);assert.ok(held.proxy?.includes('LOD 绘制'))
    await frame('terrain-held-reader-overview')
    await key('Escape'); await until('Reader returns to its exact original anchor', () => read(`!document.querySelector('.agent-information-reader')&&document.activeElement===window.__terrainAnchor`))
    const focusVisibility = `(()=>{const proxy=window.__terrainAnchor.closest('[data-collaboration-agent]').querySelector('.collaboration-agent__focus-proxy'),r=proxy?.getBoundingClientRect(),canvas=document.querySelector('.collaboration-canvas').getBoundingClientRect();if(!r)return null;const overlapping=[...document.querySelectorAll('.collaboration-area__overview-label')].filter(label=>{const b=label.getBoundingClientRect();return b.left<r.right&&b.right>r.left&&b.top<r.bottom&&b.bottom>r.top}).map(label=>label.dataset.regionId);return{name:proxy.textContent,fontSize:parseFloat(getComputedStyle(proxy).fontSize),bounds:{x:r.x,y:r.y,width:r.width,height:r.height},inside:r.left>=canvas.left&&r.right<=canvas.right&&r.top>=canvas.top&&r.bottom<=canvas.bottom,overlapping}})()`
    await until('the original held focus name clears every actual region heading', async () => {
      const visible = await read(focusVisibility)
      return visible?.inside && visible.fontSize >= 11 && visible.bounds.width > 40 && visible.bounds.height >= 15 && !visible.overlapping.length
    })
    const visibleFocus = await read(focusVisibility)
    assert.ok(visibleFocus.name.includes('LOD 绘制'))
    await frame('terrain-held-focus-overview')
    await click('[aria-label="Find Agent in map"]'); await wheelTo(.72)
    const toggle='[aria-label="Map animations"]'
    if(await read(`document.querySelector('${toggle}').getAttribute('aria-pressed')!=='false'`))await click(toggle)
    await until('original effective motion off', () => read(`document.querySelector('${toggle}').getAttribute('aria-pressed')==='false'&&document.querySelector('${toggle}').getAttribute('aria-busy')!=='true'`))
    await click('[aria-label="Overview"]'); const immediate=await matrix();await pause(100);assert.equal(await matrix(),immediate,'Motion Off completes the explicit camera action immediately')
    await read('window.graphCapture.live(true,"fixture-terrain-a","fixture-terrain-b")');await pause(100)
    assert.equal(await read(`document.querySelectorAll('.collaboration-edge__packet,.collaboration-edge__pulse').length`),0,'Motion Off retains static facts without moving packets')
    await frame('terrain-motion-off-static')
    await click(toggle);await until('original explicit motion on', () => read(`document.querySelector('${toggle}').getAttribute('aria-pressed')==='true'&&document.querySelector('${toggle}').getAttribute('aria-busy')!=='true'`))
    await intact();result.terrainHeld={held,visibleFocus,offCamera:immediate}
  })
}
module.exports.verifyFoldRoundTrip = verifyFoldRoundTrip
