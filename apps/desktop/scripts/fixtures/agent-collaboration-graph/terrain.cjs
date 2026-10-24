const assert = require('node:assert/strict')

/** Native input over the original App/Graph/Worker. No camera or geometry is assigned. */
module.exports = async function terrain({ win, result, read, click, key, move, frame, check, intact, mapReady, closeReader, locate, pause, until, matrix, measure }) {
  const original = await read('window.graphCapture.terrain()')
  assert.equal(original.areas.length, 3); assert.equal(original.agents.length, 3)
  const areaId = id => JSON.stringify(['area', id])
  const nodeId = (area, agent) => JSON.stringify([area, JSON.stringify(['local', agent])])
  const boxes = () => read('window.graphCapture.workerSamples().filter(sample=>sample.geometry).at(-1).geometry')
  const settleLayout = () => until('terrain layout and reading settle', () => read(`!document.querySelector('.collaboration-canvas__progress')&&!document.querySelector('.collaboration-map__reading')`))
  const closeDetails = async () => { await closeReader(); if (await read(`Boolean(document.querySelector('[aria-label="Close map details"]'))`)) await click('[aria-label="Close map details"]') }
  const zoom = () => read(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`)
  async function wheelTo(target) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const current = await zoom()
      if (Math.abs(Math.log(target / current)) < .0008) return current
      const point = await read(`(()=>{const r=document.querySelector('.collaboration-canvas').getBoundingClientRect();return{x:r.x+r.width*.52,y:r.y+r.height*.52}})()`)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: Math.max(-180, Math.min(180, -Math.log2(target / current) / .002)) })
      await pause(120)
    }
    assert.ok(Math.abs(Math.log(target / await zoom())) < .002, 'Native wheel reaches the intended intermediate reading scale')
    return zoom()
  }
  await check('terrain-original-nesting-fold-and-exact-reveal', async () => {
    for (const agent of original.agents) { await locate(agent.id); await closeDetails() }
    await click('[aria-label="Arrange map"]'); await settleLayout()
    const before = await boxes(), byId = new Map(before.map(box => [box.id, box]))
    const [root, tools, deep] = original.areas.map(area => byId.get(areaId(area.id)))
    assert.ok(root && tools && deep, 'All original registered project levels have Worker boxes')
    const contains = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height
    assert.ok(contains(root, tools) && contains(tools, deep), 'Complete descendants lie inside their actual ancestor boxes')
    const input = await read('window.graphCapture.workerSamples().filter(sample=>sample.request?.type==="arrange"&&sample.geometry).at(-1).input')
    assert.equal(input.areas.find(area => area.id === root.id).members, 0, 'A parent with no direct Agent is still a full terrain')
    assert.equal(input.areas.find(area => area.id === tools.id).parentId, root.id)
    assert.equal(input.areas.find(area => area.id === deep.id).parentId, tools.id)
    assert.ok(input.edges.some(edge => edge.source === nodeId(original.areas[2].id, 'fixture-terrain-b')), 'The explicitly read original external relationship enters the actual solve')
    await locate('fixture-terrain-a'); await closeDetails(); await frame('terrain-nested-dark')
    const camera = await matrix()
    await click('[aria-label="Collapse 协作地形"]'); await settleLayout()
    const folded = await boxes(), foldedIds = new Set(folded.map(box => box.id))
    assert.ok(foldedIds.has(root.id) && !foldedIds.has(tools.id) && !foldedIds.has(deep.id), 'Only the accurate visible ancestor represents its folded subtree')
    await frame('terrain-folded-dark')
    await click('[aria-label="Expand 协作地形"]'); await settleLayout()
    const expanded = await boxes(), restored = new Map(expanded.map(box => [box.id, box]))
    for (const area of original.areas) for (const agent of original.agents) {
      const id = nodeId(area.id, agent.id), old = byId.get(id)
      if (old) assert.deepEqual(restored.get(id), old, 'The real hook retains each original descendant slot through ancestor fold/expand')
    }
    await frame('terrain-expanded-dark')
    await click('[aria-label="Collapse 协作地形"]'); await settleLayout()
    await locate('fixture-terrain-b'); await closeDetails(); await settleLayout()
    assert.ok((await boxes()).some(box => box.id === deep.id), 'Exact Agent search expands its required ancestors')
    await frame('terrain-deep-agent-revealed')
    await intact()
    result.terrain = { original, input, before, folded, expanded, camera, afterCamera: await matrix() }
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
    await intact();result.terrainHeld={held,offCamera:immediate}
  })
}
