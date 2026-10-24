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
  verifyScreenAnchors(anchors)
}
function verifyScreenAnchors(anchors) {
  for (const [before, after] of [[anchors.beforeFold, anchors.folded], [anchors.beforeExpand, anchors.expanded]]) {
    assert.equal(after.areaId, before.areaId)
    assert.equal(after.inViewport, true, 'The exact original region retains a discoverable native fold/expand entry')
    assert.equal(after.labelInside, true, 'The complete label and its internal connection disclosure remain inside the actual canvas')
    assert.ok(Math.abs(after.summary.x - before.summary.x) < 1.5 && Math.abs(after.summary.y - before.summary.y) < 1.5, 'Fold/expand preserves the actually clicked summary row, including a clamped context heading')
    assert.ok(Math.abs(after.button.x - before.button.x) < 1.5 && Math.abs(after.button.y - before.button.y) < 1.5, 'The original fold action stays at the actual clicked screen point when internal connections change the full label height')
    assert.ok(Math.abs(after.zoom - before.zoom) < 1e-6, 'Fold/expand preserves the actual reading scale')
  }
}

function verifyVisualSample(sample, phase) {
  assert.ok(sample && sample.phase === phase && sample.count === 1, 'Exactly one original visual subject is mandatory: ' + phase)
  assert.ok(sample.text?.trim() && sample.characters?.length === [...sample.text].filter(character => !/\s/.test(character)).length, 'Every nonempty original text character has an actual Range: ' + phase)
  assert.ok(sample.characters.every(character => character.width > 0 && character.height > 0 && character.inside), 'The complete original text stays inside its actual button/proxy and canvas: ' + phase)
  assert.ok(Number.isFinite(sample.fontSize) && sample.fontSize >= (phase.endsWith('fold') ? 10 : 11))
  if (phase.endsWith('fold')) {
    assert.equal(sample.text, '2 internal connections', 'The short original disclosure retains its complete actual content')
    assert.ok(sample.lineCount >= 1 && sample.lineCount <= 2, 'The short original internal-connection disclosure cannot become a vertical character column')
    assert.equal(sample.internalAbove, phase === 'bottom-fold')
  } else {
    assert.equal(sample.text, 'LOD 绘制')
    assert.equal(sample.subject, JSON.stringify(['local', 'fixture-terrain-a']))
    assert.equal(sample.anchorSession, 'fixture-terrain-a')
    assert.equal(sample.readers, phase === 'held-reader' ? 1 : 0)
    assert.ok(sample.characters.every(character => character.proxyFirst === true && character.paintStack?.length), 'The accurate held name is painted above adjacent glyphs at every actual character: ' + phase)
  }
}
function verifyVisualRecord(record) {
  const folded = record.phase?.endsWith('fold')
  assert.equal(record.rule?.selector, folded ? '.collaboration-area__overview-label' : '.collaboration-canvas .react-flow__node-agent:has(> .collaboration-agent > .collaboration-agent__focus-proxy)')
  assert.equal(record.rule.property, folded ? 'display' : 'z-index')
  assert.equal(record.rule.counterfactualValue, folded ? 'block' : '1')
  assert.ok(record.rule.originalValue && record.rule.originalValue !== record.rule.counterfactualValue)
  assert.equal(record.before?.effectiveValue, record.rule.originalValue, 'The real original rule controls the sampled element')
  assert.equal(record.mutant?.effectiveValue, record.rule.counterfactualValue, 'The actual CSS withdrawal reaches the sampled element')
  assert.ok(record.rule.beforeCssText && record.rule.mutatedCssText !== record.rule.beforeCssText)
  assert.equal(record.rule.restoredCssText, record.rule.beforeCssText, 'The original CSS declaration is restored byte-for-byte at the CSSOM boundary')
  assert.deepEqual(Object.keys(record.preserved ?? {}).sort(), ['sameActiveElement', 'sameAgent', 'sameAnchor', 'sameCamera', 'sameDeliveredLayout', 'sameLayoutOwner', 'sameMap', 'sameReader', 'sameTarget'].sort())
  assert.ok(Object.values(record.preserved).every(value => value === true), 'The synchronous visual counterfactual preserves all original subjects, reading and geometry')
  verifyVisualSample(record.before, record.phase)
  for (const field of ['count', 'text', 'fontSize']) assert.equal(record.mutant?.[field], record.before[field], 'The CSS withdrawal cannot substitute a missing or different text subject')
  assert.equal(record.mutant.characters?.length, record.before.characters.length, 'The CSS withdrawal still measures every original character')
  if (folded) assert.ok(record.areaId && record.before.areaId === record.areaId && record.mutant.areaId === record.areaId && record.restored.areaId === record.areaId, 'Both fold directions measure the same exact original terrain')
  assert.throws(() => verifyVisualSample(record.mutant, record.phase), assert.AssertionError, 'Withdrawing the actual original CSS must fail the same real visual guard')
  if (folded) assert.ok(record.mutant.lineCount > 2, 'The actual display withdrawal reproduces the character-column defect')
  else {
    const geometry = ({ effectiveValue, ...sample }) => ({ ...sample, characters: sample.characters.map(({ proxyFirst, paintStack, ...character }) => character) })
    assert.deepEqual(geometry(record.mutant), geometry(record.before), 'The z-index withdrawal changes paint order, not the accurate name, Reader or geometry')
    assert.ok(record.mutant.characters.some(character => !character.proxyFirst && character.paintStack?.some(hit => hit.glyph && hit.subject && hit.subject !== record.before.subject)), 'The paint counterfactual must expose an actual adjacent original glyph, not an unrelated missing sample')
  }
  verifyVisualSample(record.restored, record.phase)
  assert.deepEqual(record.restored, record.before, 'The same original visual sample is completely restored')
}
function verifyVisualGuards(evidence, frames, originalAreaId) {
  assert.ok(typeof originalAreaId === 'string' && originalAreaId)
  assert.deepEqual(evidence?.map(record => record.phase), ['top-fold', 'bottom-fold', 'held-reader', 'held-focus'], 'Both original fold directions and both original held-name states require actual CSS counterfactuals')
  for (const record of evidence) { verifyVisualRecord(record); if (record.phase.endsWith('fold')) assert.equal(record.areaId, originalAreaId) }
  for (const label of ['terrain-folded-dark', 'terrain-bottom-folded-dark', 'terrain-held-reader-overview', 'terrain-held-focus-overview']) assert.ok(frames.some(frame => frame.label === label), 'Missing complete original readability frame: ' + label)
}

// Runs synchronously inside the private original App. Only the actual CSS rule
// and a pointer-events observation override change; no input or completion state
// is synthesized, and finally restores both before another browser task can run.
function visualCounterfactual({ phase, areaId }) {
  const folded = phase.endsWith('fold'), selector = folded ? '.collaboration-area__overview-label' : '.collaboration-canvas .react-flow__node-agent:has(> .collaboration-agent > .collaboration-agent__focus-proxy)'
  const property = folded ? 'display' : 'z-index', counterfactualValue = folded ? 'block' : '1'
  const candidates = [...document.querySelectorAll(folded ? '.collaboration-area__overview-label' : '.collaboration-agent__focus-proxy')].filter(element => folded ? element.dataset.areaId === areaId : element.closest('[data-collaboration-agent]')?.dataset.collaborationAgent === JSON.stringify(['local', 'fixture-terrain-a']))
  if (candidates.length !== 1) throw Error('Expected one exact original visual subject: ' + phase)
  const target = candidates[0], agent = target.closest('[data-collaboration-agent]'), anchor = window.__terrainAnchor ?? null, reader = document.querySelector('.agent-information-reader'), active = document.activeElement
  const map = document.querySelector('.collaboration-map'), viewport = map.querySelector('.react-flow__viewport'), camera = viewport.getAttribute('style'), layoutOwner = globalThis.__collaborationCaptureLayout
  if (!layoutOwner?.boxes?.size || !layoutOwner.paths?.size || !map.isConnected || !viewport.isConnected) throw Error('Original Map and delivered layout must be nonempty for the CSS counterfactual')
  const delivered = JSON.stringify(window.graphCapture.deliveredLayout()), originalPointerStyle = target.style.cssText
  const rules = []
  const visit = sheet => { for (const rule of sheet.cssRules) { if (rule.selectorText === selector) rules.push(rule); if (rule.cssRules) visit(rule) } }
  for (const sheet of document.styleSheets) visit(sheet)
  if (rules.length !== 1) throw Error('Expected one actual original CSS rule: ' + selector)
  const rule = rules[0], beforeCssText = rule.style.cssText, originalValue = rule.style.getPropertyValue(property), priority = rule.style.getPropertyPriority(property)
  const box = rectangle => ({ x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height })
  const inside = (outer, inner) => inner.left >= outer.left - .1 && inner.right <= outer.right + .1 && inner.top >= outer.top - .1 && inner.bottom <= outer.bottom + .1
  const sample = () => {
    const element = folded ? target.querySelector('.collaboration-area__internal') : target.querySelector('strong')
    if (!element) return { phase, count: 0 }
    const bounds = (folded ? element : target).getBoundingClientRect(), canvas = map.querySelector('.collaboration-canvas').getBoundingClientRect(), characters = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let text; (text = walker.nextNode());) for (let offset = 0; offset < text.length; offset++) {
      if (/\s/.test(text.textContent[offset])) continue
      const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1)
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) {
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        const paintStack = folded ? undefined : document.elementsFromPoint(point.x, point.y).slice(0, 12).map(hit => ({ tag: hit.tagName, class: hit.getAttribute('class'), subject: hit.closest('[data-collaboration-agent]')?.dataset.collaborationAgent ?? null, proxy: target.contains(hit), glyph: Boolean(hit.closest('.collaboration-agent__identity-layer')) }))
        characters.push({ text: text.textContent[offset], ...box(rect), inside: inside(bounds, rect) && inside(canvas, rect), ...(paintStack ? { proxyFirst: paintStack[0]?.proxy === true, paintStack } : {}) })
      }
    }
    const lineTops = []
    for (const character of characters) if (!lineTops.some(y => Math.abs(y - character.y) < 1)) lineTops.push(character.y)
    return { phase, count: folded ? target.querySelectorAll('.collaboration-area__internal').length : candidates.length, text: element.textContent.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize), effectiveValue: getComputedStyle(folded ? target : target.closest('.react-flow__node-agent')).getPropertyValue(property), bounds: box(bounds), characters, lineCount: lineTops.length,
      ...(folded ? { areaId: target.dataset.areaId, internalAbove: target.dataset.internalAbove === 'true' } : { subject: agent.dataset.collaborationAgent, anchorSession: anchor?.dataset.sessionId, readers: document.querySelectorAll('.agent-information-reader').length }) }
  }
  let before, mutant, restored, mutatedCssText
  try {
    if (!folded) target.style.setProperty('pointer-events', 'auto', 'important')
    before = sample()
    rule.style.setProperty(property, counterfactualValue, priority)
    mutatedCssText = rule.style.cssText
    mutant = sample()
  } finally {
    rule.style.cssText = beforeCssText
    try { restored = sample() } finally { target.style.cssText = originalPointerStyle }
  }
  return { phase, ...(folded ? { areaId } : {}), rule: { selector, property, originalValue, counterfactualValue, beforeCssText, mutatedCssText, restoredCssText: rule.style.cssText }, before, mutant, restored,
    preserved: { sameMap: document.querySelector('.collaboration-map') === map, sameTarget: target.isConnected && candidates[0] === target && target.style.cssText === originalPointerStyle,
      sameAgent: folded ? agent === null : target.closest('[data-collaboration-agent]') === agent, sameAnchor: (window.__terrainAnchor ?? null) === anchor && (!anchor || anchor.isConnected), sameReader: document.querySelector('.agent-information-reader') === reader,
      sameActiveElement: document.activeElement === active, sameCamera: viewport.getAttribute('style') === camera, sameLayoutOwner: globalThis.__collaborationCaptureLayout === layoutOwner, sameDeliveredLayout: JSON.stringify(window.graphCapture.deliveredLayout()) === delivered } }
}

/** Native input over the original App/Graph/Worker. No camera or geometry is assigned. */
module.exports = async function terrain({ win, result, read, click, key, move, frame, check, intact, mapReady, closeReader, closeDetails, locate, pause, until, matrix, measure, dragCanvas }) {
  const original = await read('window.graphCapture.terrain()')
  assert.equal(original.areas.length, 3); assert.equal(original.agents.length, 3)
  const areaId = id => JSON.stringify(['area', id])
  const nodeId = (area, agent) => JSON.stringify([area, JSON.stringify(['local', agent])])
  const boxes = () => read('window.graphCapture.deliveredLayout().boxes')
  const settleLayout = () => until('the actual delivered terrain layout settles', () => read(`(()=>{const layout=window.graphCapture.deliveredLayout();return layout?.busy===false&&!layout.transitioning})()`))
  const foldedState = (id, folded) => until('original delivered ancestor reaches its requested folded state', () => read(`(()=>{const layout=window.graphCapture.deliveredLayout();return layout?.busy===false&&!layout.transitioning&&layout.boxes.some(box=>box.id===${JSON.stringify(id)}&&box.folded===${folded})})()`))
  const zoom = () => read(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`)
  const visualGuard = async phase => {
    const record = await read(`(${visualCounterfactual.toString()})(${JSON.stringify({ phase, areaId: areaId(original.areas[0].id) })})`)
    ;(result.terrainVisualGuards ??= []).push(record)
    verifyVisualRecord(record)
    await intact()
  }
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
    const labelAnchor = async action => read(`(()=>{
      const labels=[...document.querySelectorAll(${JSON.stringify(labelSelector)})].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.closest('[hidden],[inert]')&&getComputedStyle(e).visibility==='visible'})
      if(labels.length!==1)throw Error('Expected exactly one visible original terrain heading')
      const label=labels[0],r=label.getBoundingClientRect(),canvas=document.querySelector('.collaboration-canvas').getBoundingClientRect()
      const button=[...label.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')===${JSON.stringify(action + ' 协作地形')})
      if(!button)throw Error('The same accurate heading has no requested fold action')
      const b=button.getBoundingClientRect(),summary=label.querySelector('.collaboration-area__summary').getBoundingClientRect()
      const camera=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
      const box=window.graphCapture.deliveredLayout().boxes.find(box=>box.id===label.dataset.areaId)
      return{areaId:label.dataset.areaId,x:r.left-canvas.left,y:r.bottom-canvas.top,zoom:camera.a,
        label:{x:r.left-canvas.left,y:r.top-canvas.top,width:r.width,height:r.height,measuredWidth:label.dataset.labelWidth,measuredHeight:label.dataset.labelHeight,summaryBottom:label.style.getPropertyValue('--collaboration-summary-bottom'),internalAbove:label.dataset.internalAbove,context:label.dataset.context},
        summary:{x:summary.left-canvas.left,y:summary.bottom-canvas.top,width:summary.width,height:summary.height},
        button:{x:b.x+b.width/2-canvas.left,y:b.y+b.height/2-canvas.top,width:b.width,height:b.height},
        camera:{x:camera.e,y:camera.f,zoom:camera.a},
        projectedHeading:box?{x:(box.x+box.heading.x)*camera.a+camera.e,y:(box.y+box.heading.y+box.heading.height)*camera.a+camera.f}:null,
        labelInside:r.left>=canvas.left&&r.top>=canvas.top&&r.right<=canvas.right&&r.bottom<=canvas.bottom,
        inViewport:b.left>=canvas.left&&b.top>=canvas.top&&b.right<=canvas.right&&b.bottom<=canvas.bottom&&button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}
    })()`)

    const foldClick = action => click(labelSelector + ' [aria-label=' + JSON.stringify(action + ' 协作地形') + ']')
    await click('[aria-label^="Locate 协作地形 ·"]')
    await until('parent terrain enters one of its actual readable descendant occurrences', () => read(`(()=>{const canvas=document.querySelector('.collaboration-canvas').getBoundingClientRect();return ['fixture-terrain-tool','fixture-terrain-a','fixture-terrain-b'].some(id=>{const card=document.querySelector('.collaboration-agent__detail-layer:not([inert]) .focus-context[data-session-id="'+id+'"]');if(!card)return false;const r=card.getBoundingClientRect(),layer=card.closest('[data-map-layer]');return getComputedStyle(layer).opacity==='1'&&r.x>=canvas.x&&r.y>=canvas.y&&r.right<=canvas.right&&r.bottom<=canvas.bottom})})()`))
    await frame('terrain-parent-readable-destination')
    await locate('fixture-terrain-a'); await closeDetails(); await frame('terrain-nested-dark')
    const camera = await matrix()
    const anchors = { beforeFold: await labelAnchor('Collapse') }
    // Persist before validation so a failure retains every actual screen observation.
    result.terrainFold = { anchors, before, occurrences: originalOccurrences, areaIds: [root.id, tools.id, deep.id], controlIds: [control.area.id, ...control.members.map(box => box.id)] }
    await foldClick('Collapse'); await foldedState(root.id, true)
    anchors.folded = await labelAnchor('Expand')
    const folded = await boxes(), foldedIds = new Set(folded.map(box => box.id))
    assert.ok(foldedIds.has(root.id) && !foldedIds.has(tools.id) && !foldedIds.has(deep.id), 'Only the accurate visible ancestor represents its folded subtree')
    await frame('terrain-folded-dark')
    await visualGuard('top-fold')
    anchors.beforeExpand = await labelAnchor('Expand')
    await foldClick('Expand'); await foldedState(root.id, false)
    anchors.expanded = await labelAnchor('Collapse')
    const expanded = await boxes(), controlIds = [control.area.id, ...control.members.map(box => box.id)]
    result.terrainFold.folded = folded; result.terrainFold.expanded = expanded
    verifyFoldRoundTrip({ before, folded, expanded, occurrences: originalOccurrences, areaIds: [root.id, tools.id, deep.id], controlIds, anchors })
    const expandedLayout = await read('window.graphCapture.deliveredLayout()')
    assert.deepEqual(expandedLayout.issues, []); assert.deepEqual(input.edges.filter(edge => !expandedLayout.pathIds.includes(edge.id)).map(edge => edge.id), [], 'Every original relationship returns with its accurate expanded endpoints')
    const settledJobs = await read('window.graphCapture.workerSamples().length')
    await pause(300); assert.deepEqual(await boxes(), expanded, 'The finite local adjustment stops without another structural input'); assert.equal(await read('window.graphCapture.workerSamples().length'), settledJobs, 'A settled fold episode does not continue simulating')
    await frame('terrain-expanded-dark')
    // Move through original bounded native pointer gestures; never assign the camera.
    for (let attempt = 0; attempt < 12; attempt++) {
      const delta = await read(`(()=>{const canvas=document.querySelector('.collaboration-canvas').getBoundingClientRect(),camera=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform),box=window.graphCapture.deliveredLayout().boxes.find(box=>box.id===${JSON.stringify(root.id)});return canvas.height-12-((box.y+box.heading.y+box.heading.height)*camera.a+camera.f)})()`)
      if (Math.abs(delta) < 1) break
      await dragCanvas(0, Math.max(-180, Math.min(180, delta)))
    }
    const bottomAnchors = { beforeFold: await labelAnchor('Collapse') }
    result.terrainBottomFold = { anchors: bottomAnchors }
    const bottomCanvasHeight = await read(`document.querySelector('.collaboration-canvas').getBoundingClientRect().height`)
    assert.ok(Math.abs(bottomAnchors.beforeFold.summary.y - (bottomCanvasHeight - 12)) < 1.5, 'The actual native drag exposes the same accurate summary at the lower edge')
    await foldClick('Collapse'); await foldedState(root.id, true)
    bottomAnchors.folded = await labelAnchor('Expand')
    assert.equal(bottomAnchors.folded.label.internalAbove, 'true', 'Original internal connections disclose above the stable bottom row')
    await frame('terrain-bottom-folded-dark')
    await visualGuard('bottom-fold')
    bottomAnchors.beforeExpand = await labelAnchor('Expand')
    await foldClick('Expand'); await foldedState(root.id, false)
    bottomAnchors.expanded = await labelAnchor('Collapse')
    verifyScreenAnchors(bottomAnchors)
    await frame('terrain-bottom-expanded-dark')
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
    await visualGuard('held-reader')
    await key('Escape'); await until('Reader returns to its exact original anchor', () => read(`!document.querySelector('.agent-information-reader')&&document.activeElement===window.__terrainAnchor`))
    const focusVisibility = `(()=>{const proxy=window.__terrainAnchor.closest('[data-collaboration-agent]').querySelector('.collaboration-agent__focus-proxy'),r=proxy?.getBoundingClientRect(),canvas=document.querySelector('.collaboration-canvas').getBoundingClientRect();if(!r)return null;const overlapping=[...document.querySelectorAll('.collaboration-area__overview-label')].filter(label=>{const b=label.getBoundingClientRect();return b.left<r.right&&b.right>r.left&&b.top<r.bottom&&b.bottom>r.top}).map(label=>label.dataset.regionId);return{name:proxy.textContent,fontSize:parseFloat(getComputedStyle(proxy).fontSize),bounds:{x:r.x,y:r.y,width:r.width,height:r.height},inside:r.left>=canvas.left&&r.right<=canvas.right&&r.top>=canvas.top&&r.bottom<=canvas.bottom,overlapping}})()`
    await until('the original held focus name clears every actual region heading', async () => {
      const visible = await read(focusVisibility)
      return visible?.inside && visible.fontSize >= 11 && visible.bounds.width > 40 && visible.bounds.height >= 15 && !visible.overlapping.length
    })
    const visibleFocus = await read(focusVisibility)
    assert.ok(visibleFocus.name.includes('LOD 绘制'))
    await frame('terrain-held-focus-overview')
    await visualGuard('held-focus')
    verifyVisualGuards(result.terrainVisualGuards, result.frames, areaId(original.areas[0].id))
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
module.exports.verifyVisualGuards = verifyVisualGuards
