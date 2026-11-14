const assert = require('node:assert/strict')
const subjects = { project: 'fixture-ui', topic: 'fixture-review', mote: 'fixture-design' }
const names = { project: 'Agent protocol', topic: 'Read model notes', mote: 'Interaction design' }
const frames = ['headers-project-wide-dark-static', 'headers-project-narrow-light-static', 'headers-topic-wide-light-static', 'headers-topic-narrow-dark-static', 'headers-mote-wide-dark-static', 'headers-mote-narrow-light-static', 'headers-project-wide-dark-hover', 'headers-topic-wide-light-hover', 'headers-mote-narrow-light-hover', 'headers-project-wide-light-keyboard', 'headers-topic-narrow-dark-fold-keyboard', 'headers-mote-narrow-light-folded']
const absent = content => content === 'none' || content === 'normal'

function observe(selector) {
  const area = document.querySelector(selector)
  if (!area) return null
  const summary = area.querySelector('.collaboration-area__summary'), title = area.querySelector('strong'), meta = area.querySelector('em'), count = area.querySelector('small'), icon = area.querySelector('.collaboration-area__identity'), fold = area.querySelector('.collaboration-area__fold')
  const bounds = element => element?.getBoundingClientRect().toJSON(), pick = (element, properties, pseudo) => {
    const computed = getComputedStyle(element, pseudo)
    return Object.fromEntries(properties.map(property => [property, computed[property]]))
  }
  const probe = document.createElement('span')
  probe.style.cssText = 'position:fixed;width:0;height:0;visibility:hidden;pointer-events:none'
  document.body.append(probe)
  const surfaces = {}
  for (const token of ['--surface-1', '--surface-2']) { probe.style.backgroundColor = `var(${token})`; surfaces[token] = getComputedStyle(probe).backgroundColor }
  probe.remove()
  const rectangle = summary.getBoundingClientRect(), hit = document.elementFromPoint(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2)
  const reachable = [[.5,.5],[.75,.5],[.25,.5],[.75,.75],[.25,.75],[.5,.75],[.5,.25]].some(([horizontal, vertical]) => summary.contains(document.elementFromPoint(rectangle.x + rectangle.width * horizontal, rectangle.y + rectangle.height * vertical)))
  const layout = window.graphCapture.deliveredLayout(), cameraOwner = globalThis.__collaborationCaptureCamera
  return { kind: area.dataset.kind, id: area.dataset.regionId, boxId: area.dataset.areaId, current: area.dataset.current === 'true', label: summary.getAttribute('aria-label'), title: title.textContent, type: meta.textContent, count: count.textContent,
    settlement: { busy: layout?.busy, transitioning: layout?.transitioning, box: layout?.boxes.find(box => box.id === area.dataset.areaId), initialized: cameraOwner?.initialized.current, applied: cameraOwner?.applied.current === cameraOwner?.locate?.token, active: Boolean(cameraOwner?.cameraAnimation.current), ready: cameraOwner?.ready },
    area: bounds(area), summary: bounds(summary), icon: { bounds: bounds(icon), source: icon.querySelector('[data-space-icon-source]')?.getAttribute('data-space-icon-source'), monogram: icon.querySelector('[data-monogram],[data-space-icon-source="automatic"]')?.textContent?.trim() ?? null, graphics: [...icon.querySelectorAll('svg,img,canvas')].map(element => ({ tag: element.tagName, bounds: bounds(element), reference: element.getAttribute('src') ?? element.querySelector('use')?.getAttribute('href') })) },
    style: pick(area, ['backgroundColor', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'boxShadow', 'filter']), stripe: pick(area, ['content', 'width', 'backgroundColor'], '::before'),
    dot: pick(meta, ['content', 'position', 'width', 'height', 'left', 'pointerEvents'], '::before'), surfaces,
    typography: pick(title, ['fontSize', 'fontWeight', 'lineHeight']), summaryStyle: pick(summary, ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'backgroundColor', 'outlineStyle', 'outlineWidth']),
    focus: { summary: document.activeElement === summary, fold: document.activeElement === fold, visible: Boolean(document.activeElement?.matches(':focus-visible')) },
    hit: summary.contains(hit), reachable, centerTarget: { tag: hit?.tagName, control: hit?.closest('button')?.className, text: hit?.closest('button')?.textContent?.trim() }, foldExpanded: fold?.getAttribute('aria-expanded'), viewport: [innerWidth, innerHeight], theme: { attribute: document.documentElement.getAttribute('data-theme'), colorScheme: getComputedStyle(document.documentElement).colorScheme },
    scrollOwners: (() => { const owners = []; for (let element = area.parentElement; element; element = element.parentElement) owners.push({ className: element.className, top: element.scrollTop, left: element.scrollLeft, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }); return owners })(),
    camera: document.querySelector('.collaboration-map .react-flow__viewport')?.getAttribute('style'), zoom: new DOMMatrix(getComputedStyle(document.querySelector('.collaboration-map .react-flow__viewport')).transform).a, locateAreaIds: globalThis.__collaborationCaptureCamera?.locate?.areaIds ?? [],
    paths: [...document.querySelectorAll('.collaboration-map .react-flow__edge')].map(edge => ({ id: edge.dataset.id, path: edge.querySelector('.react-flow__edge-path')?.getAttribute('d') })),
    labels: [...document.querySelectorAll('.collaboration-area__overview-label')].map(element => ({ id: element.dataset.regionId, current: element.dataset.current === 'true', kind: element.dataset.kind, title: element.querySelector('strong')?.textContent, bounds: bounds(element) })) }
}

function verifyStyle(sample) {
  assert.ok(sample && Object.hasOwn(subjects, sample.kind))
  assert.equal(sample.title, names[sample.kind]); assert.ok(sample.type && sample.count && sample.label.includes(sample.title))
  assert.equal(sample.reachable ?? sample.hit, true, 'The exact original summary has a native input point, not necessarily its occluded center'); assert.ok(sample.icon.bounds.width > 0 && sample.icon.source && (sample.icon.graphics.some(graphic => graphic.bounds.width > 0 && graphic.bounds.height > 0) || sample.icon.monogram === names[sample.kind][0].toUpperCase()), 'Original region icon or exact original automatic monogram is actually present')
  assert.ok(sample.summary.x >= 0 && sample.summary.y >= 0 && sample.summary.right <= sample.viewport[0] + 1 && sample.summary.bottom <= sample.viewport[1] + 1, 'The complete original summary stays in the window')
  assert.equal(sample.style.borderTopWidth, '1px'); assert.equal(sample.style.borderTopColor, 'rgba(0, 0, 0, 0)'); assert.equal(sample.style.boxShadow, 'none'); assert.equal(sample.style.filter, 'none')
  assert.ok(absent(sample.stripe.content), 'The old left stripe does not paint')
  assert.equal(sample.style.backgroundColor, sample.surfaces[sample.current ? '--surface-2' : '--surface-1'])
  assert.deepEqual(sample.typography, { fontSize: '12px', fontWeight: '600', lineHeight: '16px' })
  for (const [property, value] of Object.entries({ paddingTop: '6px', paddingRight: '26px', paddingBottom: '6px', paddingLeft: '11px', gap: '9px' })) assert.equal(sample.summaryStyle[property], value)
  if (sample.current) {
    assert.ok(!absent(sample.dot.content)); assert.equal(sample.dot.position, 'absolute'); assert.equal(sample.dot.width, '3px'); assert.equal(sample.dot.height, '3px'); assert.equal(sample.dot.left, '-6px'); assert.equal(sample.dot.pointerEvents, 'none')
    assert.ok(sample.locateAreaIds.includes(sample.id), 'Current is produced by the original area Locate request')
  } else assert.ok(absent(sample.dot.content))
}

function stable(before, after) {
  assert.equal(after.camera, before.camera, 'Material/keyboard focus does not move the original camera')
  assert.deepEqual(after.paths, before.paths, 'Original paths and placement survive a material state change')
  assert.deepEqual(after.labels, before.labels, 'Original label placement is not overridden')
  assert.deepEqual(after.summary, before.summary); assert.deepEqual(after.typography, before.typography)
}

function verify(data, captured) {
  assert.equal(data?.schema, 'agentmux.region-headers-native.v1')
  assert.ok(data.source?.revision && data.source.baselineRevision && Object.keys(data.source.geometryInputs).length === 6)
  assert.deepEqual(data.stages.map(stage => stage.label), frames)
  assert.deepEqual(captured.map(frame => frame.label), frames)
  for (const stage of data.stages) { verifyStyle(stage.observed); if (!stage.reusedFrom) assert.equal(stage.observed.theme.colorScheme, stage.label.includes('-dark-') ? 'dark' : 'light'); else { assert.equal(stage.reusedFrom, data.materialReuse.receiptSHA256); assert.ok(data.materialReuse.originalEvidence) } if (stage.before) stable(stage.before, stage.observed) }
  for (const kind of Object.keys(subjects)) {
    const samples = data.stages.filter(stage => stage.observed.kind === kind)
    assert.ok(samples.some(stage => stage.observed.current) && samples.some(stage => !stage.observed.current))
    assert.ok(samples.some(stage => stage.observed.viewport[0] === 620) && samples.some(stage => stage.observed.viewport[0] === 1440))
  }
  const summary = data.stages.find(stage => stage.label.endsWith('wide-light-keyboard')).observed
  assert.ok(summary.focus.summary && summary.focus.visible); assert.equal(summary.summaryStyle.outlineStyle, 'solid'); assert.equal(summary.summaryStyle.outlineWidth, '2px')
  const keyboard = data.stages.find(stage => stage.label.endsWith('fold-keyboard')).observed
  assert.ok(keyboard.focus.fold && keyboard.focus.visible)
  assert.equal(data.stages.at(-1).observed.foldExpanded, 'false'); assert.ok(data.stages.at(-1).observed.focus.fold)
  assert.equal(data.folds.length, 3)
  assert.ok(data.summaryPointerTargets.length > 0)
  for (const target of data.summaryPointerTargets) assert.equal(target.chosen.hit, true)
  for (const fold of data.folds) { assert.equal(fold.closed.foldExpanded, 'false'); assert.equal(fold.expanded.foldExpanded, 'true'); assert.ok(Math.abs(fold.before.zoom - fold.closed.zoom) < 1e-6 && Math.abs(fold.before.zoom - fold.expanded.zoom) < 1e-6); for (const sample of [fold.closed, fold.expanded]) { assert.ok(Math.abs(sample.summary.x - fold.before.summary.x) < 1.5 && Math.abs(sample.summary.y - fold.before.summary.y) < 1.5); assert.equal(sample.settlement.busy, false); assert.equal(sample.settlement.transitioning, false); assert.equal(sample.settlement.box.folded, sample.foldExpanded === 'false'); assert.equal(sample.settlement.active, false); assert.equal(sample.settlement.applied, true) } }
  assert.equal(data.counterfactuals.length, 2)
  assert.deepEqual(data.counterfactuals.map(record => record.name), ['current-dot-withdrawal', 'original-left-stripe-restored'])
  for (const record of data.counterfactuals) { verifyStyle(record.before); assert.throws(() => verifyStyle(record.changed)); verifyStyle(record.restored); stable(record.before, record.changed); stable(record.before, record.restored); assert.equal(record.red, true); assert.equal(record.restoredGreen, true) }
  assert.deepEqual(data.after.controls, []); assert.equal(data.after.sameDrafts, true); assert.equal(data.after.layoutsPreserved, true)
}

module.exports = async function regionHeaders({ win, result, read, click, key, move, frame, check, facts, intact, mapReady, closeDetails, locate, pause, until, settle, waitCamera }) {
  const data = result.regionHeaders = { schema: 'agentmux.region-headers-native.v1', source: JSON.parse(process.env.COLLABORATION_CAPTURE_HEADER_SOURCE), stages: [], preparations: [], summaryPointerTargets: [], folds: [], counterfactuals: [],
    boundary: 'Original App/Store/Worker/RegionLabels/camera/CSS and native pointer/keyboard. A zero-sized transient observation probe resolves actual surface tokens. Temporary CSSOM counterfactuals are restored before every PNG. No real Provider/Run, cost matrix, public focus/input-owner, restart or aesthetic approval.' }
  const selector = kind => `.collaboration-area__overview-label[data-kind="${kind}"]` + `[data-region-id=${JSON.stringify(data.ids[kind])}]`
  const sample = kind => read(`(${observe.toString()})(${JSON.stringify(selector(kind))})`)
  const depart = async () => { await closeDetails(); await move('[aria-label="Find Agent in map"]'); await waitCamera('frame', 'header-original-reader-departed'); await pause(220); await settle() }
  const guardedCheck = async (name, action) => { await check(name, action); if (result.failures.length) throw Error('Heading scene stopped at its first failed native criterion: ' + name) }
  const clickSummary = async kind => {
    const target = selector(kind) + ' .collaboration-area__summary'
    let observation
    await until('exact original summary has a native exposed input point', async () => {
      observation = await read(`(()=>{const button=document.querySelector(${JSON.stringify(target)}),bounds=button.getBoundingClientRect(),describe=element=>element?{tag:element.tagName,className:element.getAttribute('class'),control:element.closest('button')?.getAttribute('class'),label:element.closest('button')?.getAttribute('aria-label'),text:element.closest('button')?.textContent?.trim()}:null;const points=[[.5,.5],[.75,.5],[.25,.5],[.75,.75],[.25,.75],[.5,.75],[.5,.25]].map(([horizontal,vertical])=>{const x=bounds.x+bounds.width*horizontal,y=bounds.y+bounds.height*vertical,hit=document.elementFromPoint(x,y);return{x,y,hit:button.contains(hit),actual:describe(hit)}});return{selector:${JSON.stringify(target)},areaId:button.closest('[data-region-id]').dataset.regionId,bounds:bounds.toJSON(),center:points[0],chosen:points.find(point=>point.hit),camera:document.querySelector('.react-flow__viewport')?.getAttribute('style')}})()`)
      return Boolean(observation.chosen)
    })
    data.summaryPointerTargets.push(observation)
    const point = observation.chosen
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
    await settle()
  }
  const prepare = async (kind, narrow, theme, ordinary = false) => {
    await read(`window.graphCapture.appearance(${JSON.stringify(theme)})`)
    win.setContentSize(...(narrow ? [620, 820] : [1440, 900])); await settle()
    await locate(subjects[ordinary ? { project: 'topic', topic: 'mote', mote: 'project' }[kind] : kind])
    if (ordinary) { await click('[aria-label="Overview"]'); await waitCamera('frame', 'header-ordinary-overview') }
    await depart()
    const found = await read(`(()=>{const areas=[...document.querySelectorAll('.collaboration-area__overview-label[data-kind="${kind}"]')];return areas.find(area=>area.querySelector('strong')?.textContent===${JSON.stringify(names[kind])})?.dataset.regionId})()`)
    assert.ok(found, 'The exact original named region is exposed by the original camera')
    data.ids[kind] = found
    if (!ordinary) { await clickSummary(kind); await waitCamera('frame', 'header-original-area-locate'); await depart() }
    const observed = await sample(kind); data.preparations.push({ kind, narrow, theme, ordinary, observed }); verifyStyle(observed); assert.equal(observed.current, !ordinary)
    return observed
  }
  const capture = async (label, kind, before) => { const observed = await sample(kind); verifyStyle(observed); if (before) stable(before, observed); data.stages.push({ label, ...(before ? { before } : {}), observed }); await frame(label, observed.foldExpanded === 'false' ? { layoutOwner: { areaId: observed.boxId, folded: true } } : {}) }
  const foldedState = async (kind, folded) => {
    let previous = '', since = 0
    await until('original delivered fold and screen anchor settle', async () => {
      const observed = await sample(kind), state = observed.settlement
      const ready = state.busy === false && !state.transitioning && state.box?.folded === folded && state.initialized && state.applied && !state.active
      const signature = JSON.stringify({ ready, row: observed.summary, camera: observed.camera })
      if (!ready || signature !== previous) { previous = signature; since = Date.now(); return false }
      return Date.now() - since >= 100
    })
  }
  const keyboard = async (kind, fold) => {
    await clickSummary(kind); await waitCamera('frame', 'header-keyboard-original-locate'); await depart()
    const before = await sample(kind)
    const target = selector(kind) + (fold ? ' .collaboration-area__fold' : ' .collaboration-area__summary')
    await key('Tab'); if (!fold) await key('Tab', 8)
    assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(target)})&&document.activeElement.matches(':focus-visible')`), true, 'Adjacent original summary/fold controls are reached by real Tab and Shift+Tab')
    return before
  }
  data.ids = {}
  await click('button.surface-navigation__focus'); await click('[aria-label="Map"]'); await mapReady(); await read('window.graphCapture.rememberMap()'); await pause(3300)
  await guardedCheck('region-headers-native-material-and-placement', async () => {
    if (process.env.COLLABORATION_CAPTURE_HEADER_MATERIAL_FILE) {
      const material = JSON.parse(require('node:fs').readFileSync(process.env.COLLABORATION_CAPTURE_HEADER_MATERIAL_FILE, 'utf8'))
      assert.equal(material.frames.length, 9); assert.equal(material.stages.length, 9)
      data.materialReuse = { receiptSHA256: material.receiptSHA256, originalEvidence: material.originalEvidence, originalOverallPassed: material.originalOverallPassed, boundary: material.boundary }
      for (const stage of material.stages) { verifyStyle(stage.observed); data.stages.push({ ...stage, reusedFrom: material.receiptSHA256 }) }
      result.frames.push(...material.frames)
      return
    }
    for (const [kind, narrow, theme] of [['project', false, 'dark'], ['project', true, 'light'], ['topic', false, 'light'], ['topic', true, 'dark'], ['mote', false, 'dark'], ['mote', true, 'light']]) {
      await prepare(kind, narrow, theme, !narrow); await capture(`headers-${kind}-${narrow ? 'narrow' : 'wide'}-${theme}-static`, kind)
    }
    for (const [kind, narrow, theme] of [['project', false, 'dark'], ['topic', false, 'light'], ['mote', true, 'light']]) {
      const before = await prepare(kind, narrow, theme); await move(selector(kind) + ' .collaboration-area__summary'); await pause(220); await capture(`headers-${kind}-${narrow ? 'narrow' : 'wide'}-${theme}-hover`, kind, before)
      assert.notEqual(data.stages.at(-1).observed.summaryStyle.backgroundColor, 'rgba(0, 0, 0, 0)')
    }
  })
  if (data.materialReuse) result.checks.at(-1).reusedFrom = data.materialReuse
  await guardedCheck('region-headers-native-keyboard-and-fold', async () => {
    await prepare('project', false, 'light'); let before = await keyboard('project', false); await capture('headers-project-wide-light-keyboard', 'project', before)
    await prepare('topic', true, 'dark'); before = await keyboard('topic', true); await capture('headers-topic-narrow-dark-fold-keyboard', 'topic', before)
    for (const kind of ['project', 'topic', 'mote']) {
      await prepare(kind, kind !== 'project', kind === 'topic' ? 'dark' : 'light'); const original = await keyboard(kind, true); await key('Enter'); await foldedState(kind, true); await pause(220)
      const closed = await sample(kind)
      if (kind === 'mote') await capture('headers-mote-narrow-light-folded', kind)
      await key('Enter'); await foldedState(kind, false); await pause(220)
      data.folds.push({ kind, before: original, closed, expanded: await sample(kind) })
    }
  })
  await guardedCheck('region-headers-native-css-counterfactuals', async () => {
    await prepare('project', false, 'dark')
    for (const name of ['current-dot-withdrawal', 'original-left-stripe-restored']) {
      const before = await sample('project')
      const source = await read(`(()=>{const rules=[];const visit=list=>{for(const rule of list){if(rule.selectorText)rules.push(rule);if(rule.cssRules)visit(rule.cssRules)}};for(const sheet of document.styleSheets)visit(sheet.cssRules);if(${JSON.stringify(name)}==='current-dot-withdrawal'){const rule=rules.find(rule=>rule.selectorText.includes('data-current')&&rule.selectorText.includes('.collaboration-area__meta em')&&rule.style.content);if(!rule)throw Error('The actual current-dot stylesheet rule was not found');globalThis.__headerCSSRestore={rule,cssText:rule.style.cssText};rule.style.setProperty('content','none','important');return{selector:rule.selectorText,cssText:globalThis.__headerCSSRestore.cssText}}const sheet=document.styleSheets[document.styleSheets.length-1],index=sheet.cssRules.length;sheet.insertRule(${JSON.stringify(data.source.stripeRule)},index);globalThis.__headerCSSRestore={sheet,index};return{cssText:${JSON.stringify(data.source.stripeRule)},baseline:${JSON.stringify(data.source.baselineRevision)}}})()`)
      try {
        await settle(); const changed = await sample('project'); let red = false
        try { verifyStyle(changed) } catch { red = true }
        assert.equal(red, true, 'Withdrawing the effective native CSS mechanism must reject the header')
        await read(`(()=>{const state=globalThis.__headerCSSRestore;if(state.rule)state.rule.style.cssText=state.cssText;else state.sheet.deleteRule(state.index);delete globalThis.__headerCSSRestore;return true})()`)
        await settle(); await pause(220); const restored = await sample('project'); verifyStyle(restored)
        data.counterfactuals.push({ name, source, before, changed, red, restored, restoredGreen: true })
      } finally { await read(`(()=>{const state=globalThis.__headerCSSRestore;if(!state)return true;if(state.rule)state.rule.style.cssText=state.cssText;else state.sheet.deleteRule(state.index);delete globalThis.__headerCSSRestore;return true})()`) }
    }
  })
  data.after = await intact(); verify(data, result.frames)
}
module.exports.verify = verify
