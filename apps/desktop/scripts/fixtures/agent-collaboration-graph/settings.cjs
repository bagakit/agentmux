const assert = require('node:assert/strict')
const readerSelector = '.agent-information-reader'

function verifyReadingEndpoints(records) {
  assert.deepEqual(records?.map(record => record.label), ['saved-profile-reading', 'restore-after-information'], 'Both explicit saved-profile reading endpoints must be observed')
  for (const record of records) {
    assert.equal(record.reached, true, 'The actual original camera must reach the saved reading endpoint within the bounded wait')
    assert.ok(record.before && record.final && record.samples?.length > 0, 'Reading endpoint evidence cannot be empty')
    assert.deepEqual(record.samples[0], record.before)
    assert.deepEqual(record.samples.at(-1), record.final)
    for (const sample of record.samples) {
      assert.ok(Number.isFinite(sample.zoom) && sample.zoom > 0 && typeof sample.camera === 'string' && sample.camera.includes('scale('), 'Record the actual viewport transform')
      assert.equal(sample.profile?.boundary, 'polygon')
      assert.equal(sample.profile?.levels?.length, 4)
      assert.deepEqual(sample.profile.levels[3], { form: 'card', information: 'summary', from: .92, to: 1.12 })
      assert.deepEqual(sample.profile, records[0].before.profile, 'The camera consumes the same original saved profile throughout both explicit locates')
    }
    assert.ok(record.final.zoom >= 1.119 && record.final.zoom <= 1.121, 'The observed final camera reaches the original strict endpoint')
  }
}

function verifyInformation(samples) {
  assert.deepEqual(samples?.map(sample => sample.budget), ['summary', 'status', 'identity'], 'All three actual information budgets must be observed in order')
  const first = samples[0]
  assert.ok(first.nodeId && first.expectedName)
  for (const [index, sample] of samples.entries()) {
    assert.deepEqual(sample.subject, { hostId: 'local', agentSessionId: 'fixture-terrain-a' }, 'Information changes retain the exact original subject')
    assert.equal(sample.nodeId, first.nodeId, 'Information changes use the same original occurrence')
    assert.ok(Math.abs(sample.zoom - [1.12, .75, .47][index]) < .002, 'Actual native wheel scale reaches this information budget')
    assert.equal(sample.readers, 0, 'A held Reader does not substitute for the original budget')
    const owners = sample.layers.filter(layer => layer.semantic)
    assert.equal(owners.length, 1, 'Exactly one original layer owns Agent input')
    assert.equal(owners[0].kind, index === 0 ? 'detail' : 'identity')
    assert.deepEqual(owners[0].buttonSubjects, ['fixture-terrain-a'])
    const names = sample.ink.names.filter(ink => ink.visible), statuses = sample.ink.statuses.filter(ink => ink.visible), summaries = sample.ink.summaries.filter(ink => ink.visible)
    assert.equal(names.length, 1, 'One readable original name remains visible')
    assert.equal(names[0].text, first.expectedName)
    assert.ok(names[0].screenFont >= 10.9, 'The actual projected name respects its screen text budget')
    assert.equal(statuses.length, index < 2 ? 1 : 0, 'Status-only adds actual visible status to identity-only')
    assert.equal(summaries.length, index === 0 ? 1 : 0, 'Only the summary budget exposes the optional content region')
    if (statuses.length) assert.ok(statuses[0].text && statuses[0].text === first.ink.statuses.find(ink => ink.visible)?.text)
    if (summaries.length) assert.ok(summaries[0].text)
    for (const kind of ['conversation', 'body']) {
      assert.ok(Number.isInteger(sample.readsBefore[kind]) && sample.readsBefore[kind] >= 0 && Number.isInteger(sample.readsAfter[kind]) && sample.readsAfter[kind] >= 0)
      if (index) assert.equal(sample.readsAfter[kind], sample.readsBefore[kind], 'A settled lower information budget does not acquire summary or original body reads')
    }
    if (index) assert.equal(sample.zeroBodyDemand, true, 'Lower information budgets relinquish the visible body working set')
  }
}

/** Original settings and Map, driven by Chromium input. Reads never assign a
 * control value, camera transform, world coordinate or product identity. */
module.exports = async function settings({ win, result, read, click, key, move, frame, check, intact, closeDetails, locate, pause, until, matrix }) {
  const evidence = result.mapSettings = { phases: [], hitTests: [], controlEdits: [], informationSamples: [], readingEndpoints: [], boundary: 'Original App/Focus settings/ConfigOwner and original Graph/Reader; controlled platform facts only. No real user configuration, Session or Run touched.' }
  const profile = () => read('window.graphCapture.preferences()?.map')
  const layout = () => read('window.graphCapture.deliveredLayout().boxes')
  const readerCount = () => read(`document.querySelectorAll(${JSON.stringify(readerSelector)}).length`)
  const settled = () => until('original settings world has settled', () => read('window.graphCapture.deliveredLayout()?.busy===false'))
  async function readingEndpoint(label) {
    const observe = () => read(`(()=>{const viewport=document.querySelector('.react-flow__viewport');return{zoom:new DOMMatrix(getComputedStyle(viewport).transform).a,camera:viewport.getAttribute('style'),profile:window.graphCapture.preferences()?.map}})()`)
    const before = await observe(), record = { label, before, samples: [before], final: before, reached: false }
    evidence.readingEndpoints.push(record)
    // An actionable mark and an idle layout can precede the end of setCenter.
    // Observe the original camera; neither a sleep nor a camera assignment proves its destination.
    await until('original camera reaches the exact saved reading endpoint: ' + label, async () => {
      const current = await observe()
      if (JSON.stringify(current) !== JSON.stringify(record.samples.at(-1))) record.samples.push(current)
      record.final = current
      return current.zoom >= 1.119 && current.zoom <= 1.121
    })
    record.reached = true
  }
  async function reveal(selector) { await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Original control missing');e.scrollIntoView({block:'center'});return true})()`); await pause(60) }
  async function choose(label, value) {
    const selector = `select[aria-label="${label}"]`
    await reveal(selector)
    const options = await read(`[...document.querySelector(${JSON.stringify(selector)}).options].map(option=>({value:option.value,label:option.text}))`)
    const option = options.find(option => option.value === String(value)); assert.ok(option)
    // macOS native popup menus do not receive CDP Home/arrow input in a hidden
    // window. Focus the visible original select, then use its real typeahead.
    // No option value or synthetic DOM change/input event is assigned.
    const character = option.label[0].toLowerCase()
    assert.equal(options.filter(option => option.label[0].toLowerCase() === character).length, 1, 'This native typeahead character identifies exactly one actual option')
    // A new focus episode also resets Chromium's previous typeahead prefix.
    const before = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.blur();e.focus({preventScroll:true});if(document.activeElement!==e)throw Error('Original select must own input');return e.value})()`)
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: character,
      code: /[0-9]/.test(character) ? 'Digit' + character : 'Key' + character.toUpperCase(), windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0),
      ...(type === 'keyDown' ? { text: character, unmodifiedText: character } : {}) })
    await until('native select commits ' + label, () => read(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(String(value))}`))
    evidence.controlEdits.push({ label, before, requested: String(value), observed: await read(`document.querySelector(${JSON.stringify(selector)}).value`), input: 'original focused select native character typeahead', character })
  }
  async function number(label, value) {
    const selector = `input[aria-label="${label}"]`; await reveal(selector); await click(selector); await key('a', 4)
    await win.webContents.debugger.sendCommand('Input.insertText', { text: String(value) }); await key('Tab')
    assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`), String(value))
  }
  async function open() {
    await click('[aria-label="Map settings"]')
    await until('original Focus Map settings receives focus', () => read(`document.activeElement===document.querySelector('[data-settings-pane="focus"] [data-settings-field="map"]')`))
  }
  async function save() {
    const selector = '[data-settings-pane="focus"] [data-settings-save-bar] button'; await reveal(selector)
    assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).disabled`), false)
    await click(selector)
    await until('original Focus durable save completes', () => read(`document.querySelector('[data-settings-pane="focus"] [data-settings-save-bar]').textContent.includes('Changes saved')`))
  }
  async function close() { await click('[aria-label="Close settings"]'); await until('original settings closes', () => read(`!document.querySelector('.settings-page:not([hidden])')`)); await settled() }
  async function wheelTo(target) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const current = await read(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`)
      if (Math.abs(Math.log(target / current)) < .0008) return current
      const point = await read(`(()=>{const canvas=document.querySelector('.collaboration-canvas'),r=canvas.getBoundingClientRect(),candidates=[[.52,.52],[.82,.3],[.18,.3],[.82,.72],[.18,.72],...Array.from({length:36},(_,i)=>[(i%6+2)/9,(Math.floor(i/6)+2)/9])];for(const [x,y] of candidates){const p={x:r.x+r.width*x,y:r.y+r.height*y};if(document.elementFromPoint(p.x,p.y)?.classList.contains('react-flow__pane'))return p}throw Error('No actual Map background for native information-budget wheel input')})()`)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: Math.max(-180, Math.min(180, -Math.log2(target / current) / .002)) })
      await pause(120)
    }
    assert.ok(Math.abs(Math.log(target / await read(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`))) < .002, 'Native wheel reaches the information-budget scale')
  }
  const bodyReads = () => read(`(()=>{const reads=window.graphCapture.facts().reads;return{conversation:reads.filter(row=>row.kind==='conversation').length,body:reads.filter(row=>row.kind==='body').length}})()`)
  async function informationSample(budget, expectedName, inputReads) {
    const lower = budget !== 'summary'
    if (lower) await until('the lower information budget releases body demand', () => read(`document.querySelector('[aria-label="Map sources"]').title.includes('0 participants observed')&&!document.querySelector('.collaboration-map__reading')`))
    const readsBefore = inputReads ?? await bodyReads(); await pause(250)
    const sample = await read(`(()=>{
      const subjectKey=JSON.stringify(['local','fixture-terrain-a']),nodes=[...document.querySelectorAll('[data-collaboration-agent]')].filter(node=>node.dataset.collaborationAgent===subjectKey);
      if(nodes.length!==1)throw Error('Exactly one original terrain-a occurrence must be mounted');
      const node=nodes[0],surface=document.querySelector('.collaboration-canvas').getBoundingClientRect(),zoom=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a;
      const ink=selector=>[...node.querySelectorAll(selector)].map(element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);let opacity=1,shown=true;for(let e=element;e;e=e.parentElement){const s=getComputedStyle(e);opacity*=Number(s.opacity);if(s.display==='none'||s.visibility!=='visible'||e.hidden)shown=false}return{text:element.textContent.trim(),opacity,screenFont:parseFloat(style.fontSize)*zoom,visible:shown&&opacity>.05&&rect.width>0&&rect.height>0&&rect.right>surface.left&&rect.left<surface.right&&rect.bottom>surface.top&&rect.top<surface.bottom}});
      const [hostId,agentSessionId]=JSON.parse(node.dataset.collaborationAgent);
      return{subject:{hostId,agentSessionId},nodeId:node.closest('.react-flow__node').dataset.id,zoom,readers:document.querySelectorAll(${JSON.stringify(readerSelector)}).length,
        layers:[...node.querySelectorAll('[data-map-layer]')].map(layer=>({kind:layer.dataset.mapLayer,semantic:!layer.inert&&layer.getAttribute('aria-hidden')!=='true',buttonSubjects:[...layer.querySelectorAll('button[data-session-id]')].map(button=>button.dataset.sessionId)})),
        ink:{names:ink('.collaboration-agent__mark strong,.focus-context__identity strong'),statuses:ink('.collaboration-agent__status small,.focus-context__state small'),summaries:ink('.focus-context__detail')},
        zeroBodyDemand:document.querySelector('[aria-label="Map sources"]').title.includes('0 participants observed')};
    })()`)
    const record = { ...sample, budget, expectedName, readsBefore, readsAfter: await bodyReads() }
    evidence.informationSamples.push(record)
    return record
  }
  await check('settings-original-edit-save-reopen-and-map-consumers', async () => {
    await closeDetails(); await settled()
    const before = { profile: await profile(), boxes: await layout(), camera: await matrix(), jobs: await read('window.graphCapture.workerSamples().length') }
    await open()
    await choose('LOD levels', 2); await frame('settings-two-level-draft')
    assert.deepEqual(await profile(), before.profile, 'The example draft does not commit configuration')
    await choose('LOD levels', 3); await choose('LOD levels', 4)
    await reveal('input[name="focus-map-boundary"]')
    await click('.focus-map-settings__boundaries label:nth-of-type(2) input')
    await number('Level 4 start zoom', 40)
    assert.equal(await read(`document.querySelector('[data-settings-pane="focus"] [data-settings-save-bar] button').disabled`), true)
    assert.ok(await read(`document.querySelector('.focus-map-preview [role="status"]')?.textContent.includes('last valid')`))
    await frame('settings-invalid-kept-draft')
    await number('Level 4 start zoom', 92); await number('Level 4 complete zoom', 112)
    await reveal('[data-settings-preview-open="map"]'); await click('[data-settings-preview-open="map"]')
    await frame('settings-custom-four-level-dark')
    win.setContentSize(680, 820); await pause(200); await frame('settings-custom-narrow-dark')
    await read('window.graphCapture.appearance("light")'); await pause(150); await frame('settings-custom-narrow-light')
    await read('window.graphCapture.appearance("dark")'); await pause(150)
    win.setContentSize(1360, 900); await pause(150)
    await save()
    const saved = await profile(); assert.equal(saved.boundary, 'polygon'); assert.equal(saved.levels.length, 4)
    assert.deepEqual(saved.levels[3], { form: 'card', information: 'summary', from: .92, to: 1.12 })
    await close()
    assert.deepEqual(await layout(), before.boxes, 'Saving presentation changes no world slot')
    assert.equal(await matrix(), before.camera, 'Saving presentation changes no camera')
    assert.equal(await read('window.graphCapture.workerSamples().length'), before.jobs, 'Settings preview and save do not request layout')
    await open()
    assert.equal(await read(`document.querySelector('[aria-label="LOD levels"]').value`), '4')
    assert.equal(await read(`document.querySelector('[aria-label="Level 4 start zoom"]').value`), '92')
    await frame('settings-saved-profile-reopened')
    await close()
    await locate('fixture-terrain-a'); await closeDetails(); await settled()
    await readingEndpoint('saved-profile-reading')
    const zoom = await read(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`)
    assert.ok(zoom >= 1.119 && zoom <= 1.121, 'Explicit later reading consumes the saved LOD endpoint')
    const outlines = await read(`[...document.querySelectorAll('.collaboration-area__envelope path')].map(path=>path.getAttribute('d'))`)
    assert.ok(outlines.length > 0 && outlines.every(path => !path.includes(' Q ')), 'Actual Map draws the saved polygon profile')
    await frame('settings-polygon-map-custom-reading')
    const expectedName = (await read('window.graphCapture.terrain()')).agents.find(agent => agent.id === 'fixture-terrain-a').name
    const informationGeometry = await layout()
    await informationSample('summary', expectedName)
    const statusInputReads = await bodyReads()
    await wheelTo(.75); await informationSample('status', expectedName, statusInputReads); await frame('settings-status-only-map')
    const identityInputReads = await bodyReads()
    await wheelTo(.47); await informationSample('identity', expectedName, identityInputReads); await frame('settings-identity-only-map')
    verifyInformation(evidence.informationSamples)
    assert.deepEqual(await layout(), informationGeometry, 'Changing information budget by native wheel changes no world slot')
    await locate('fixture-terrain-a'); await closeDetails(); await settled()
    await readingEndpoint('restore-after-information')
    assert.ok(Math.abs(await read(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`) - 1.12) < .002, 'The next explicit locate restores the same saved reading endpoint')
    verifyReadingEndpoints(evidence.readingEndpoints)
    evidence.phases.push({ phase: 'custom-saved-reopened', before, saved, zoom, outlines })
    await intact()

    await open(); await choose('LOD levels', 2); await choose('Level 2 form', 'point'); await save(); await close()
    await locate('fixture-terrain-a'); await closeDetails(); await settled()
    const emptyHit = await read(`(()=>{const mark=document.querySelector('.collaboration-agent__dot[data-session-id="fixture-terrain-a"]'),node=mark?.closest('.react-flow__node'),body=node?.querySelector('.collaboration-agent__body');if(!mark||!node||!body)throw Error('Original point occurrence absent');const slot=node.getBoundingClientRect(),hull=body.getBoundingClientRect(),canvas=document.querySelector('.collaboration-canvas').getBoundingClientRect();const points=[[.08,.1],[.92,.1],[.08,.9],[.92,.9]].map(([x,y])=>({x:slot.x+slot.width*x,y:slot.y+slot.height*y}));const point=points.find(p=>{const hit=document.elementFromPoint(p.x,p.y);return p.x>canvas.x&&p.y>canvas.y&&p.x<canvas.right&&p.y<canvas.bottom&&!(p.x>=hull.x&&p.x<=hull.right&&p.y>=hull.y&&p.y<=hull.bottom)&&hit?.closest('.collaboration-canvas')&&!hit.closest('.collaboration-agent,.react-flow__edge,.collaboration-region-labels,.collaboration-canvas__hud')});if(!point)throw Error('No original slot whitespace available for a real pointer test');const hit=document.elementFromPoint(point.x,point.y);return{point,slot:{x:slot.x,y:slot.y,width:slot.width,height:slot.height},hull:{x:hull.x,y:hull.y,width:hull.width,height:hull.height},hit:{tag:hit.tagName,class:hit.className.baseVal??hit.className},readerBefore:Boolean(document.querySelector('.agent-information-reader'))}})()`)
    assert.equal(emptyHit.readerBefore, false)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...emptyHit.point }); await pause(650)
    for (const type of ["mousePressed", "mouseReleased"]) await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type, ...emptyHit.point, button: "left", clickCount: 1 })
    await pause(250)
    assert.equal(await read(`Boolean(document.querySelector('.agent-information-reader'))`), false, 'Invisible original slot whitespace does not initiate Agent reading')
    evidence.hitTests.push({ phase: 'point-slot-whitespace', ...emptyHit, readerAfter: false })
    const pointSelector = '.collaboration-agent[data-collaboration-agent=' + JSON.stringify(JSON.stringify(['local', 'fixture-terrain-a'])) + '] .collaboration-agent__dot'
    await move(pointSelector); await click(pointSelector); await key('ArrowDown')
    await until('original point opens its accurate Reader', () => read(`Boolean(document.querySelector('.agent-information-reader'))`))
    evidence.readerMeasurement = { selector: readerSelector, count: await readerCount() }
    assert.equal(evidence.readerMeasurement.count, 1, 'The same actual Reader selector must also observe the existing positive Reader case')
    assert.equal(await read(`document.querySelector('.collaboration-agent[data-reading="true"] [data-session-id="fixture-terrain-a"]')!==null`), true)
    await frame('settings-all-point-accurate-reader')
    evidence.phases.push({ phase: 'point-only-real-hit-and-reader', profile: await profile(), zoom: await read(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a`) })
    await closeDetails(); await open()
    await reveal('[data-settings-field="map"] > header button'); await click('[data-settings-field="map"] > header button'); await save(); await close()
    assert.equal((await profile()).boundary, 'bezier'); assert.equal((await profile()).levels.length, 3)
    await frame('settings-map-defaults-restored')
    evidence.phases.push({ phase: 'defaults-restored', profile: await profile() })
    await intact()
    result.mapSettings = evidence
  })
}
module.exports.verify = (evidence, frames) => {
  assert.ok(evidence?.phases?.length === 3, 'All three original settings consumer phases must execute')
  assert.deepEqual(evidence.phases.map(phase => phase.phase), ['custom-saved-reopened', 'point-only-real-hit-and-reader', 'defaults-restored'])
  assert.ok(evidence.hitTests.length > 0 && evidence.hitTests.every(hit => hit.readerBefore === false && hit.readerAfter === false))
  assert.deepEqual(evidence.readerMeasurement, { selector: readerSelector, count: 1 }, 'Reader absence samples require a nonempty measurement of the existing actual Reader')
  verifyReadingEndpoints(evidence.readingEndpoints)
  verifyInformation(evidence.informationSamples)
  for (const label of ['settings-two-level-draft', 'settings-invalid-kept-draft', 'settings-custom-four-level-dark', 'settings-custom-narrow-dark', 'settings-custom-narrow-light', 'settings-saved-profile-reopened', 'settings-polygon-map-custom-reading', 'settings-status-only-map', 'settings-identity-only-map', 'settings-all-point-accurate-reader', 'settings-map-defaults-restored']) assert.ok(frames.some(frame => frame.label === label), 'Missing original native settings frame ' + label)
}
module.exports.verifyInformation = verifyInformation
