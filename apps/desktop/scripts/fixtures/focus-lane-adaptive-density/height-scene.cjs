const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')

module.exports = async ({ win, evidence, phase, read, until, settle, click, move, key }) => {
  const result = { frames: [], scenes: [], heightScene: true, geometryPass: false, passed: false, phase }
  const laneSelector = '.focus-project-board > .focus-project-lanes [data-project-id="alpha"]'
  await until('original Store startup', () => read('window.laneProof?.heightReady()'))
  if (phase === 'first') await read('window.laneProof.seedHeight()')
  await until('original restored Focus work surface', () => read('document.querySelector("[data-fixture-session=original]")&&document.querySelector(".focused-tab-workspace")'))
  result.restored = await read('window.laneProof.heightFacts()')
  assert.equal(result.restored.originalInitialize, true); assert.equal(result.restored.initialized, true)
  assert.equal(result.restored.seedCount, phase === 'first' ? 1 : 0)
  assert.equal(result.restored.draft, 'Original unsent draft'); assert.equal(result.restored.focus, 'original')
  assert.ok(result.restored.tabs.original); assert.ok(result.restored.layouts.alpha)
  assert.equal(result.restored.original.run.runId, 'typed-lane-original')
  assert.deepEqual(result.restored.leaves, [{ session: 'original', tab: 'original', region: 'original-region' }])
  if (phase === 'second') {
    await until('restored work surface is visible and startup has cleared', () => read(`(() => {
      const surface = document.querySelector('[data-fixture-session="original"]')
      const draft = surface?.querySelector('textarea')
      if (!surface || !draft || document.body.innerText.includes('Restoring your workspace')) return false
      const rect = draft.getBoundingClientRect(), style = getComputedStyle(surface)
      return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' &&
        surface.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    })()`))
    await settle()
    await new Promise(done => setTimeout(done, 120))
    await settle()
    result.restored.visibleDraft = await read('document.querySelector("[data-fixture-session=original] textarea")?.value')
    assert.equal(result.restored.visibleDraft, result.restored.draft)
    await fs.writeFile(path.join(evidence, 'restart-restored.png'), (await win.webContents.capturePage()).toPNG())
    result.frames.push({ file: 'restart-restored.png', label: 'original-Store-restored-without-second-seed', viewport: 1440 })
    result.passed = true; return result
  }
  await click('[aria-label="Close Focus workspace"]')
  await until('projection closed without removing original Tab', () => read('!document.querySelector(".global-session-workspace")'))
  const geometry = () => read(`(()=>{const lane=document.querySelector(${JSON.stringify(laneSelector)})||document.querySelector('.focus-project-board > .focus-project-lanes [data-lane-id]'),groups=lane.querySelector('.focus-project-lanes__groups');const rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom}};return{width:groups.clientWidth,slots:Number(groups.dataset.focusCardSlots),maxRows:Number(groups.dataset.focusMaxRows),lane:rect(lane),overflow:groups.scrollWidth>groups.clientWidth+1,states:[...groups.children].map(section=>({state:section.dataset.bucket,empty:section.dataset.empty==='true',rect:rect(section),header:rect(section.querySelector('header')),cards:[...section.querySelectorAll('.focus-context')].map(card=>({id:card.dataset.sessionId,rect:rect(card)}))}))}})()`)
  const qualify = g => {
    assert.deepEqual(g.states.map(state => state.state), ['attention', 'working', 'results', 'idle', 'disconnected'])
    assert.equal(g.overflow, false)
    for (const state of g.states) {
      assert.ok(state.rect.width > 0 && state.rect.height > 0)
      if (state.state === 'disconnected') { assert.ok(state.rect.width <= 32.5); assert.equal(state.cards.length, 0) }
      else if (state.empty) assert.ok(state.rect.width <= 24.5)
      for (const card of state.cards) assert.ok(card.rect.width >= 179 && card.rect.width <= 320.5, 'Actual readable card width')
    }
    const content = g.states.filter(state => state.cards.length)
    if (g.slots >= content.length) {
      const actualMax = Math.max(...content.map(state => new Set(state.cards.map(card => Math.round(card.rect.top))).size))
      assert.equal(actualMax, g.maxRows, 'Actual CSS rows match the integer minimum')
    }
  }
  const frame = async (file, label) => {
    await move('[aria-label="Search contexts"]')
    if (await read('!!document.querySelector(".focus-filter-menu")')) await key('Escape')
    await until('unobstructed lane capture', () => read('!document.querySelector(".focus-filter-menu,.focus-context-hover")'))
    await settle()
    const actual = await geometry(); qualify(actual); result.scenes.push({ label, actual })
    await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label, viewport: await read('innerWidth') })
    return actual
  }
  await read('window.laneProof.heightMode("skewed")')
  await until('real 12/5/1', () => read('document.querySelectorAll("[data-bucket=working] .focus-context").length===12&&document.querySelectorAll("[data-bucket=results] .focus-context").length===5'))
  for (const width of [320, 640, 799, 801, 1440]) { win.setContentSize(width, 800); await settle(); await frame('height-skewed-' + width + '.png', 'skewed-' + width) }
  const green = await geometry()
  const oldCSS = ".focus-context-group:not([data-empty='true']):not([data-bucket='disconnected']){flex:var(--height-old-weight,1) 1 180px;width:auto}.focus-context-group__cards{grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))}"
  await read(`(()=>{document.querySelectorAll('.focus-context-group').forEach(section=>section.style.setProperty('--height-old-weight',Math.min(section.querySelectorAll('.focus-context').length,3)));const style=document.createElement('style');style.id='height-old-capped';style.textContent=${JSON.stringify(oldCSS)};document.head.append(style)})()`)
  await settle(); const red = await geometry()
  let redFailure
  try { qualify(red) } catch (error) { redFailure = error }
  assert.ok(redFailure, 'Loaded old capped CSS must fail the actual geometry assertion')
  assert.equal(redFailure.name, 'AssertionError')
  result.loadedCSSRed = { failure: { name: redFailure.name, message: redFailure.message }, actual: red, loadedSHA256: crypto.createHash('sha256').update(oldCSS).digest('hex') }
  assert.ok(red.lane.height > green.lane.height, 'Same content and width have lower actual lane height')
  await fs.writeFile(path.join(evidence, 'height-old-capped-1440.png'), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file: 'height-old-capped-1440.png', label: 'loaded-old-capped-actual-counterexample', viewport: 1440 })
  await read('document.getElementById("height-old-capped").remove()'); await settle(); qualify(await geometry())
  result.improvement = { previousHeight: red.lane.height, currentHeight: green.lane.height }
  await read('window.laneProof.heightMode("single-topic")'); await settle()
  const single = await frame('height-single-topic.png', 'single-Topic-bounded-group')
  assert.ok(single.states.find(state => state.state === 'working').rect.width <= 320.5)
  await read('window.laneProof.heightMode("double-results")'); await settle()
  const double = await frame('height-double-results.png', 'two-results-real-adjacent-gap')
  const cards = double.states.find(state => state.state === 'results').cards
  assert.ok(cards.length === 2); assert.ok(Math.abs(cards[1].rect.left - cards[0].rect.left - cards[0].rect.width - 2) < 1)
  await read('window.laneProof.heightMode("mixed")'); await settle()
  assert.equal(await read('document.querySelector("[data-session-id=failure] .focus-context__detail")?.textContent'), 'Agent startup failed: executable not found')
  await frame('height-mixed-1440.png', 'mixed-recap-tool-request-failure')
  win.setContentSize(640, 800); await settle(); await frame('height-mixed-640.png', 'mixed-narrow-readable')
  win.setContentSize(1440, 800); await read('window.laneProof.heightMode("restore"); window.laneProof.enter()'); await settle()
  await click('button.surface-navigation__focus'); await click('[data-session-id="original"]')
  await until('original Focus projection for persistence', () => read('document.querySelector(".focused-tab-workspace")?.dataset.focusTabId==="original"'))
  await read('window.laneProof.flushHeight()'); win.webContents.session.flushStorageData()
  result.persisted = await read('window.laneProof.heightFacts()')
  assert.equal(result.persisted.seedCount, 1); assert.equal(result.persisted.draft, 'Original unsent draft')
  result.geometryPass = true; result.passed = true; return result
}
