const assert = require('node:assert/strict')

// The production original owner and projection slots are real. The selected host is
// a controlled fixture selection, never a claim about the installed user's App.
module.exports = async function ({ evaluate, element, viewport, wait, paint, click, frame, assertGeometry, report, capturePolish, escape }) {
  const revealActions = async surface => {
    await evaluate(`(${surface}).querySelector('[data-section="terminal"]').scrollIntoView({block:'nearest'})`); await paint()
    const boxes = await evaluate(`(()=>{const s=${surface};return[...s.querySelectorAll('.launcher-primary-actions button,[data-section="terminal"] button')].map(e=>{const r=e.getBoundingClientRect();return{label:e.getAttribute('aria-label')??e.textContent,top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight}})})()`)
    assert.ok(boxes.length>=3,'Actual host has primary and Terminal actions')
    for (const box of boxes) assert.ok(box.height>0&&box.top>=0&&box.bottom<=box.viewport,'Actual host action is fully reachable after scrolling: '+box.label)
  }
  const original = await evaluate('launchpad.facts()')
  assert.equal(original.sections, undefined, 'Fresh ordinary defaults are not stored preferences')
  await wait('Boolean(launchpad.terminalFacts())'); const originalTerminal = await evaluate('launchpad.terminalFacts()')
  assert.ok(originalTerminal.fontSize > 0 && originalTerminal.lines.length > 0, 'Actual original xterm is populated')
  assert.equal(await evaluate(`${element('[data-section="terminal"]')}.dataset.mode`), 'expanded')
  await viewport(1180, 790); await evaluate('launchpad.scene()'); await paint()
  const body = element('.launch-terminal__body')
  const metrics = await evaluate(`(()=>{const e=${body},r=e.getBoundingClientRect(),region=e.closest('[data-workbench-region-id]');return{body:r.height,region:region.getBoundingClientRect().height,font:getComputedStyle(e.querySelector('.xterm')).fontSize,container:getComputedStyle(e.closest('.launch-surface')).containerType}})()`)
  assert.ok(metrics.region >= 720, 'Ordinary fixture has a real Region at least 720px high')
  assert.ok(metrics.body >= 280, 'Region 720px Terminal body is at least 280px without shrinking text')
  assert.equal(metrics.container, 'size', 'Terminal height uses its own Region container')
  assert.equal((await evaluate('launchpad.terminalFacts()')).fontSize,originalTerminal.fontSize,'Region allocation preserves the same original terminal font')
  await evaluate(`${body}.scrollIntoView({block:'nearest'})`); await paint(); await frame('terminal-host-ordinary-720-body-dark')
  const sameRegionHeight = metrics.body
  // Vary only window height while pinning the same actual Workbench Region height.
  await evaluate("document.querySelector('#fixture-workbench').style.cssText='flex:none;height:750px'")
  await viewport(1180, 1050)
  const pinned = await evaluate(`(()=>{const e=${body};return{body:e.getBoundingClientRect().height,region:e.closest('[data-workbench-region-id]').getBoundingClientRect().height}})()`)
  await viewport(1180, 850)
  const secondPinned = await evaluate(`(()=>{const e=${body};return{body:e.getBoundingClientRect().height,region:e.closest('[data-workbench-region-id]').getBoundingClientRect().height}})()`)
  assert.deepEqual(secondPinned, pinned, 'Same Region retains Terminal height when only the window height changes')
  await evaluate("document.querySelector('#fixture-workbench').style.cssText=''")

  const untouched = await evaluate('launchpad.facts()')
  for (const [host, entity, width, height, theme] of [
    ['survey','tab',1180,790,'dark'], ['survey','zone',520,590,'light']
  ]) {
    await viewport(width,height); await evaluate('document.documentElement.dataset.appearance='+JSON.stringify(theme))
    await evaluate('launchpad.host('+JSON.stringify(host)+','+JSON.stringify(entity)+')'); await paint()
    assert.equal(await evaluate(`${element('[data-section="terminal"]')}.dataset.mode`),'collapsed','Actual '+host+' '+entity+' destination collapses absent Terminal preference')
    assert.equal(await evaluate(`Boolean(${element('.launch-terminal__body')})`),false)
    const facts=await evaluate('launchpad.facts()')
    assert.equal(facts.sections,undefined); assert.equal(facts.warmRun,untouched.warmRun); assert.equal(facts.calls.stops.length,0)
    assert.equal(facts.sourceDraft,untouched.sourceDraft); await revealActions(element('.launch-surface')); await assertGeometry()
    assert.equal(await evaluate('document.querySelectorAll(".global-survey-surface .survey-view-controls").length'),1,'Survey uses its production host chrome')
    await frame('terminal-host-'+host+'-'+entity+'-'+theme)
  }
  await evaluate('launchpad.host("ordinary")'); await paint()
  assert.equal(await evaluate(`${element('[data-section="terminal"]')}.dataset.mode`),'expanded')
  assert.equal((await evaluate('launchpad.facts()')).warmRun,original.warmRun)
  await viewport(1180,790); await evaluate('document.documentElement.dataset.appearance="dark"'); await evaluate('launchpad.motes()'); await paint()
  await evaluate('launchpad.host("original-mote")'); await paint()
  report.originalMoteHost = await evaluate('launchpad.moteHostFacts()')
  const mote = 'launchpad.moteLauncher()'
  await wait('Boolean('+mote+')')
  assert.equal(await evaluate(`${mote}.querySelector('[data-section="terminal"]').dataset.mode`),'collapsed','Original actual MoteWorkface defaults collapsed')
  assert.equal(await evaluate(`Boolean(${mote}.querySelector('.launch-terminal__body'))`),false)
  assert.equal(await evaluate('launchpad.facts().calls.stops.length'),0)
  assert.equal(await evaluate('launchpad.facts().allSections["__scratch__"]'),undefined,'Original Mote default does not persist a section preference')
  await frame('terminal-host-original-mote-dark')
  await viewport(520,590); await evaluate('document.documentElement.dataset.appearance="light"'); await paint(); await revealActions(mote); await frame('terminal-host-original-mote-narrow-light')
  const floatingMote = 'launchpad.moteLauncher()'
  for (const [width,height,theme,label] of [[1180,790,'dark','wide'],[520,590,'light','narrow']]) {
    await viewport(width,height); await evaluate('document.documentElement.dataset.appearance='+JSON.stringify(theme))
    await evaluate('launchpad.host("mote")'); await wait('Boolean('+floatingMote+')'); await paint()
    assert.equal(await evaluate(`${floatingMote}.querySelector('[data-section="terminal"]').dataset.mode`),'collapsed','Actual floating Mote defaults collapsed')
    assert.equal(await evaluate('launchpad.facts().allSections["__scratch__"]'),undefined)
    await revealActions(floatingMote); await assertGeometry(); await frame('terminal-host-mote-floating-'+label+'-'+theme)
  }
  // A hidden Scratch preference is exercised through the real Mote controls. We
  // do not expand a different-cwd shell just to capture it and stop the original
  // Project prewarm; the same-Scratch expanded precedence is mounted separately.
  await click(`${floatingMote}.querySelector('[aria-label="Close Terminal"]')`)
  assert.equal(await evaluate('launchpad.facts().allSections["__scratch__"].terminal'),'hidden')
  await viewport(1180,790); await evaluate('document.documentElement.dataset.appearance="dark"'); await paint()
  await evaluate(`${floatingMote}.querySelector('[aria-label="Restore Terminal"]').scrollIntoView({block:'nearest'})`); await paint()
  await frame('terminal-host-mote-explicit-hidden-dark')
  await evaluate('launchpad.host("ordinary")'); await viewport(1180,790); await evaluate('document.documentElement.dataset.appearance="dark"'); await paint()
  await click(element('[aria-label="Collapse Terminal"]'))
  assert.equal((await evaluate('launchpad.facts()')).sections.terminal,'collapsed')
  await evaluate('launchpad.host("survey","tab")'); await paint(); await click(element('[aria-label="Expand Terminal"]'))
  assert.equal((await evaluate('launchpad.facts()')).sections.terminal,'expanded')
  assert.equal(await evaluate(`${element('[data-section="terminal"]')}.dataset.mode`),'expanded','Explicit expanded preference outranks actual Survey destination')
  await evaluate(`${body}.scrollIntoView({block:'nearest'})`); await paint(); await frame('terminal-host-survey-explicit-expanded-dark')
  await click(element('[aria-label="Close Terminal"]')); await evaluate('launchpad.host("survey","zone")'); await paint()
  assert.ok(await evaluate(`Boolean(${element('[aria-label="Restore Terminal"]')})`),'Explicit hidden preference outranks actual Survey Zone')
  await evaluate(`${element('[aria-label="Restore Terminal"]')}.scrollIntoView({block:'nearest'})`); await paint()
  await frame('terminal-host-survey-explicit-hidden-dark')
  await click(element('[aria-label="Restore Terminal"]')); await evaluate('launchpad.host("ordinary")'); await paint()
  // All host switches used the same resource, draft and original warm Run, with no stop.
  const after=await evaluate('launchpad.facts()'); assert.equal(after.warmRun,original.warmRun);assert.equal(after.sourceDraft,original.sourceDraft);assert.equal(after.calls.stops.length,0)
  report.scenarios.push({name:'Actual destination and original Mote host defaults; explicit preferences; Region height allocation',passed:true,metrics,pinned,secondPinned,sameRegionHeight,original,after})
  // Resume remains reachable in the short/narrow integrated workface.
  await viewport(720,410); await evaluate('launchpad.scene()'); await paint(); await click(element('.launcher-resume-trigger'))
  await wait('Boolean(document.querySelector(".launcher-resume"))'); await frame('terminal-host-resume-project-short')
  await viewport(520,590); await evaluate('document.documentElement.dataset.appearance="light"'); await click(`[...document.querySelectorAll('.launcher-resume__scope button')].find(e=>e.textContent.includes('All projects'))`)
  await frame('terminal-host-resume-global-narrow-light'); await escape()
  await capturePolish()
}

// This independent process starts with the real Scratch cwd as its warm owner.
// It never replaces the main Project scene's shell or borrows its preservation proof.
module.exports.mote = async function ({ evaluate, viewport, wait, paint, click, frame, assertGeometry, report }) {
  const surface = 'launchpad.moteLauncher()'
  const control = selector => `${surface}.querySelector(${JSON.stringify(selector)})`
  await wait('Boolean('+surface+')')
  const before = await evaluate('launchpad.facts()')
  report.sameHostMoteOriginal = before
  assert.equal(before.calls.stops.length,0,'Independent Mote has only its original same-cwd warm owner')
  assert.equal(before.allSections.__scratch__,undefined,'Independent real Mote starts with absent preferences')
  assert.equal(await evaluate(`${control('[data-section="terminal"]')}.dataset.mode`),'collapsed')
  await viewport(1180,790); await evaluate('document.documentElement.dataset.appearance="dark"'); await paint()
  await frame('terminal-host-mote-same-cwd-default-dark')
  await click(control('[aria-label="Expand Terminal"]'))
  await wait('Boolean(launchpad.moteTerminalFacts()?.lines.some(line=>line.includes("$")))')
  const actual = await evaluate('launchpad.moteTerminalFacts()')
  assert.ok(actual.fontSize>0&&actual.lines.length>0,'Real same-cwd Mote owns a populated unchanged xterm')
  assert.equal(await evaluate(`${control('[data-section="terminal"]')}.dataset.mode`),'expanded','Actual Mote accepts its explicit expanded preference')
  assert.equal(await evaluate('launchpad.facts().allSections.__scratch__.terminal'),'expanded')
  await evaluate(`${control('.launch-terminal__body')}.scrollIntoView({block:'nearest'})`); await paint()
  await frame('terminal-host-mote-same-cwd-expanded-dark')
  await viewport(520,590); await evaluate('document.documentElement.dataset.appearance="light"'); await paint()
  await evaluate(`${control('.launch-terminal__body')}.scrollIntoView({block:'nearest'})`); await paint()
  await assertGeometry(); await frame('terminal-host-mote-same-cwd-expanded-narrow-light')
  await viewport(520,410); await evaluate('document.documentElement.dataset.appearance="dark"'); await click(control('[aria-label="Collapse Terminal"]'))
  await evaluate(`${control('[data-section="terminal"]')}.scrollIntoView({block:'nearest'})`); await paint()
  const actions = await evaluate(`(()=>{const s=${surface};return[...s.querySelectorAll('.launcher-primary-actions button,[data-section="terminal"] button')].map(e=>{const r=e.getBoundingClientRect();return{height:r.height,top:r.top,bottom:r.bottom,viewport:innerHeight}})})()`)
  assert.ok(actions.length>=3); for (const action of actions) assert.ok(action.height>0&&action.top>=0&&action.bottom<=action.viewport,'Short Mote actions remain fully visible after scrolling')
  await frame('terminal-host-mote-same-cwd-short-actions-dark')
  const after = await evaluate('launchpad.facts()')
  assert.equal(after.warmRun,before.warmRun,'Same-cwd Mote keeps its own original warm Run')
  assert.equal(after.calls.stops.length,0,'Independent same-cwd Mote never stops its original warm Run')
  assert.deepEqual(after.agentDrafts,before.agentDrafts,'Independent Mote keeps all original drafts')
  report.scenarios.push({name:'Independent real Mote same-cwd warm owner explicit expanded and short controls',passed:true,before,after,actual,boundary:'Separate private capture-only process with controlled preview API and original Scratch warm owner. Not the main Project preservation scene; not Core native PTY qualification.'})
}
