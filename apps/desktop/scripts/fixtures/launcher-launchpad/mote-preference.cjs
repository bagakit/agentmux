const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')

// Pointer and keyboard interaction runs against compiled production Workbench
// and Launcher. The fixture controls only directory facts and avatar image I/O.
module.exports = async function motePreference({ phase, evaluate, element, wait, paint, viewport, click, escape, frame, assertGeometry, report, profile, evidence }) {
  const leader = 'launcher:leader', design = 'launcher:design', research = 'launcher:research'
  const create = element('.launcher-mote__create'), target = element('.launcher-mote__target')
  const icon = element('.launcher-mote__create .space-object-icon')
  const names = { design: 'Design & implementation partner with a long readable name', research: 'Research partner' }
  const menuItem = text => `[...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.includes(${JSON.stringify(text)}))`
  async function choose(name) {
    await click(target); await wait('Boolean(document.querySelector("[role=menuitem]"))')
    await click(menuItem(name)); await wait('!document.querySelector("[role=menuitem]")')
  }
  async function available() {
    return evaluate(`(()=>{const c=${create};const r=c.getBoundingClientRect();return{disabled:c.disabled,text:c.textContent.trim(),width:r.width,height:r.height}})()`)
  }
  async function assertAvatar(source, selectedRegion = 'launchpad-input') {
    const selected = `document.querySelector('[data-workbench-region-id="${selectedRegion}"] .launcher-mote__create .space-object-icon')`
    await wait(`Boolean(${selected}) && ${selected}.dataset.spaceIconSource===${JSON.stringify(source)}`)
    if (source === 'image') await wait(`Boolean(${selected}.querySelector('img')) && ${selected}.querySelector('img').complete && ${selected}.querySelector('img').naturalWidth>0`)
    const facts = await evaluate(`(()=>{const e=${selected},r=e.getBoundingClientRect(),img=e.querySelector('img'),face=e.querySelector('.mote-face');return{source:e.dataset.spaceIconSource,avatar:e.dataset.spaceAvatar??null,width:r.width,height:r.height,img:img?{src:img.src,complete:img.complete,naturalWidth:img.naturalWidth}:null,face:face?{palette:face.dataset.moteFacePalette,eyes:face.dataset.moteFaceEyes}:null}})()`)
    assert.ok(facts.width >= 13 && facts.height >= 13, 'The selected avatar retains its own readable slot')
    if (source === 'image') assert.equal(facts.avatar, 'a'.repeat(64) + '.png')
    if (source === 'face') assert.deepEqual(facts.face, { palette: 'peach', eyes: 'spark' })
    return facts
  }
  if (phase === 'restart') {
    const expected = JSON.parse(await fs.readFile(path.join(evidence, 'expected-durable.json'), 'utf8'))
    const before = await evaluate('launchpad.readBeforeFixtureSetup'), facts = await evaluate('launchpad.facts()')
    assert.equal(before.moteTopicId, expected.moteTopicId, 'A new Electron process reads the actual persisted preference before setup')
    assert.equal(facts.moteTopicId, design); assert.equal(JSON.parse(facts.storageBytes).state.moteTopicId, design)
    assert.equal(facts.persistenceIssue, null); assert.deepEqual(before.spaceObjectIcons, expected.spaceObjectIcons)
    assert.deepEqual(facts.tab, expected.tab); assert.deepEqual(facts.layout, expected.layout)
    assert.equal(facts.sourceDraft, expected.sourceDraft); assert.deepEqual(facts.agentDrafts, expected.agentDrafts)
    assert.equal(await evaluate(`${target}.textContent.trim()`), names.design)
    const avatar = await assertAvatar('image'); assert.equal((await available()).disabled, false)
    await assertGeometry(); await frame('mote-preference-renderer-profile-restart')
    report.durable = { passed: true, expected, actual: facts, beforeFixtureSetup: before, avatar,
      boundary: 'Two actual Electron processes reuse an isolated profile. This proves Launcher target and original avatar preference reads; controlled directory/image facts. No user Session, Run or native Runtime restart claim.' }
    return
  }

  await viewport(1180, 850); await wait(`Boolean(${element('.launch-terminal__body .xterm')})`)
  await evaluate('launchpad.motePreference()'); await paint()
  const original = await evaluate('launchpad.facts()')
  assert.equal(original.moteTopicId, null, 'Fresh private profile has no authored preference')
  assert.ok(await evaluate(`Boolean(${element('.launcher-mote__archive')})`))
  assert.equal((await available()).disabled, false, 'An archived default does not disable creation')
  await assertAvatar('automatic'); await assertGeometry(); await frame('mote-archived-default-wide-dark')
  await evaluate('launchpad.scene({theme:"light"})'); await paint(); await assertGeometry(); await frame('mote-archived-default-wide-light')
  for (const theme of ['dark', 'light']) {
    await viewport(780, 710); await evaluate(`launchpad.scene({split:true,long:true,theme:${JSON.stringify(theme)}})`)
    await evaluate('launchpad.motePreference({long:true})'); await paint()
    await assertGeometry(); assert.equal((await available()).disabled, false)
    await frame('mote-archived-default-long-narrow-' + theme)
  }

  await viewport(1180, 850); await evaluate('launchpad.scene()'); await evaluate('launchpad.motePreference()'); await paint()
  await click(target); await wait('Boolean(document.querySelector("[role=menuitem]"))')
  const menu = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map(item=>({text:item.textContent.trim(),source:item.querySelector('.space-object-icon')?.dataset.spaceIconSource,disabled:item.getAttribute('aria-disabled')}))`)
  assert.ok(menu.some(item => item.text.includes(names.design) && item.source === 'image'))
  assert.ok(menu.some(item => item.text.includes(names.research) && item.source === 'face'))
  assert.equal(menu.some(item => item.text === 'Mote'), false, 'Archived default is preserved as current target and excluded from new recommendations')
  await frame('mote-active-alternatives-and-avatars'); await escape()

  // The default has not been opened by the fixture. This genuine click must
  // keep creating with the archived original identity through first Tab setup.
  await click(create); await wait('launchpad.facts().calls.launches.length===1')
  await wait('launchpad.facts().floating?.open===true')
  const created = await evaluate('launchpad.facts()')
  assert.equal(created.floating.targetTopicId, leader)
  assert.equal(created.sourceDraft, original.sourceDraft); assert.equal(created.calls.stops.length, 0)
  assert.ok(created.calls.launches[0][0].prompt.includes(original.sourceDraft))
  await frame('mote-archived-default-real-creation')
  await click('document.querySelector(' + JSON.stringify('[data-pmo-teams-topic-floating] [aria-label="Close Mote"]') + ')'); await escape()

  // Remount the Launcher through its real workbench while preserving the
  // neighboring shell and existing Mote Tab. Selection itself opens nothing.
  await evaluate('launchpad.scene()'); await paint()
  const beforeSelect = await evaluate('launchpad.facts()')
  await choose(names.design); const selectedAvatar = await assertAvatar('image')
  const selected = await evaluate('launchpad.facts()')
  assert.equal(selected.moteTopicId, design); assert.equal(JSON.parse(selected.storageBytes).state.moteTopicId, design)
  assert.deepEqual(selected.floating, beforeSelect.floating, 'Chooser selection does not retarget or open the floating Mote')
  assert.deepEqual(selected.calls.launches, beforeSelect.calls.launches); assert.equal(selected.activeWorkspaceId, beforeSelect.activeWorkspaceId)
  assert.equal(selected.sourceDraft, original.sourceDraft)
  await assertGeometry(); await frame('mote-last-choice-image-wide-dark')
  await choose(names.research); const faceAvatar = await assertAvatar('face'); assert.equal((await evaluate('launchpad.facts()')).moteTopicId, research)
  await evaluate('launchpad.scene({theme:"light"})'); await paint(); await frame('mote-last-choice-face-wide-light')
  await choose(names.design); await assertAvatar('image')
  await evaluate('launchpad.anotherLauncher()'); await paint()
  const otherAvatar = await assertAvatar('image', 'launchpad-next-input')
  assert.equal(await evaluate('document.querySelector("[data-workbench-region-id=launchpad-next-input] .launcher-mote__target").textContent.trim()'), names.design)
  await frame('mote-last-choice-new-launcher')

  await evaluate('launchpad.scene({split:true,theme:"dark"})'); await evaluate(`launchpad.motePreferenceState(${JSON.stringify(design)},'archived')`); await paint()
  const archivedSelected = await evaluate('launchpad.facts()')
  assert.equal(archivedSelected.moteTopicId, design); await assertAvatar('image')
  assert.ok(await evaluate(`Boolean(${element('.launcher-mote__archive')})`)); assert.equal((await available()).disabled, false)
  await assertGeometry(); await frame('mote-last-choice-archived-long-narrow-dark')
  await evaluate('launchpad.scene({split:true,theme:"light"})'); await paint(); await assertGeometry(); await frame('mote-last-choice-archived-long-narrow-light')

  await evaluate('launchpad.motePreference({leader:"archived",design:"archived",research:"archived",failRestore:true})'); await paint()
  await click(target); await wait('Boolean(document.querySelector("[role=menuitem]"))')
  const empty = await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].map(item=>({text:item.textContent.trim(),disabled:item.getAttribute('aria-disabled')}))`)
  assert.deepEqual(empty, [{ text: 'No active Motes', disabled: 'true' }]); assert.equal((await available()).disabled, false)
  await frame('mote-zero-active-alternatives'); await escape()
  await click(element('.launcher-mote__archive .small-button'))
  await wait(`Boolean(${element('.launcher-mote .service-window')})`)
  const failedRestore = await evaluate('launchpad.facts()')
  assert.equal(failedRestore.moteTopicId, design); assert.equal(failedRestore.motePreferenceTopics.find(item=>item.id===design).moteArchive.state, 'archived')
  assert.equal((await available()).disabled, false); await assertGeometry(); await frame('mote-restore-failure-preserves-creation')

  await evaluate('launchpad.scene({split:true,theme:"dark"})'); await evaluate('launchpad.motePreference({design:"unknown"})'); await paint()
  assert.equal((await available()).disabled, false); assert.equal((await evaluate('launchpad.facts()')).moteTopicId, design)
  await assertAvatar('image'); await assertGeometry(); await frame('mote-unknown-archive-creation-available')
  await evaluate('launchpad.scene({split:true,theme:"light"})'); await evaluate('launchpad.motePreferenceUnavailable("read-failure")'); await paint()
  await wait(`Boolean(${element('.launcher-mote .service-window')})`)
  assert.ok(await evaluate(`${element('.launcher-mote')}.textContent.includes('Mote directory read needs attention')`))
  assert.equal((await available()).disabled, false); assert.equal((await evaluate('launchpad.facts()')).moteTopicId, design)
  await assertGeometry(); await frame('mote-directory-read-failure-narrow-light')
  await evaluate('launchpad.motePreference()'); await evaluate('launchpad.motePreferenceUnavailable("target-missing")'); await paint()
  await wait(`Boolean(${element('.launcher-mote .service-window')})`)
  assert.ok(await evaluate(`${element('.launcher-mote')}.textContent.includes('Selected Mote directory is unconfirmed')`))
  assert.equal((await available()).disabled, false); assert.equal((await evaluate('launchpad.facts()')).moteTopicId, design)
  await assertGeometry(); await frame('mote-confirmed-target-missing-narrow-light')
  await evaluate('launchpad.scene()'); await evaluate('launchpad.motePreference({design:"archived"})'); await paint()
  await click(element('.launcher-mote__archive .small-button'))
  await wait(`!${element('.launcher-mote__archive')}`)
  const restored = await evaluate('launchpad.facts()')
  assert.equal(restored.moteTopicId, design); assert.equal(restored.motePreferenceTopics.find(item=>item.id===design).moteArchive.state, 'active')
  assert.equal(restored.calls.stops.length, 0); await assertAvatar('image'); await frame('mote-restored-original-target')

  await viewport(720, 420); await evaluate('launchpad.scene({theme:"light"})'); await evaluate('launchpad.motePreference({design:"archived"})'); await paint()
  await click(target); await wait('Boolean(document.querySelector("[role=menuitem]"))'); await escape()
  await evaluate(`${create}.scrollIntoView({block:'nearest'})`); await paint()
  const reachable = await available(); assert.equal(reachable.disabled, false); await assertGeometry(); await frame('mote-archived-short-height-light')
  await captureShortActions({ evaluate, element, wait, paint, viewport, click, frame, assertGeometry, report })

  // Retain a clean, exact original target for the second independent process.
  await viewport(1180, 850); await evaluate('launchpad.scene()'); await evaluate('launchpad.motePreference({design:"active"})'); await paint()
  await evaluate('launchpad.flush()'); const durable = await evaluate('launchpad.facts()')
  assert.equal(durable.warmRun, original.warmRun); assert.deepEqual(durable.calls.stops, [])
  assert.equal(durable.sourceDraft, original.sourceDraft); assert.equal(durable.calls.launches.length, 1)
  report.scenarios.push({ name: 'Archived default and saved Mote target, genuine choice, avatars and durable read', passed: true,
    original, menu, created, selected, selectedAvatar, faceAvatar, otherAvatar, archivedSelected, empty, failedRestore, restored, reachable,
    creationNotBlockedByArchive: true, exactOriginalTarget: true, previewArchiveAndImageFacts: true })
  report.expectedDurable = { moteTopicId: durable.moteTopicId, spaceObjectIcons: durable.spaceObjectIcons, tab: durable.tab, layout: durable.layout,
    sourceDraft: durable.sourceDraft, agentDrafts: durable.agentDrafts, activeWorkspaceId: durable.activeWorkspaceId }
  await fs.writeFile(path.join(evidence, 'expected-durable.json'), JSON.stringify(report.expectedDurable, null, 2))
  await fs.writeFile(path.join(profile, 'boot.json'), JSON.stringify(await evaluate('launchpad.bootFacts()')))
}

async function captureShortActions({ evaluate, element, wait, paint, viewport, click, frame, assertGeometry, report }) {
  await viewport(720, 420); await evaluate('launchpad.scene({theme:"light"})'); await evaluate('launchpad.motePreference()'); await paint()
  if (await evaluate('launchpad.facts().moteTopicId!=="launcher:design"')) {
    await click(element('.launcher-mote__target')); await wait('Boolean(document.querySelector("[role=menuitem]"))')
    await click(`[...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.includes('Design & implementation partner'))`)
    await wait('!document.querySelector("[role=menuitem]")')
  }
  await evaluate('launchpad.motePreferenceState("launcher:design","archived")'); await paint()
  await wait(`Boolean(${element('.launcher-mote__create img')}) && ${element('.launcher-mote__create img')}.complete`)
  await evaluate(`${element('.launch-surface__footer')}.scrollIntoView({block:'center'})`); await paint()
  const actions = await evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};return{viewport:{width:innerWidth,height:innerHeight},region:box(document.querySelector('[data-workbench-region-id="launchpad-input"]')),controls:[...document.querySelectorAll('[data-workbench-region-id="launchpad-input"] .launch-surface__footer button')].map(e=>({text:e.textContent.trim(),disabled:e.disabled,box:box(e)}))}})()`)
  for (const text of ['Create with Mote', 'Restore Mote', 'Resume', 'Launch']) {
    const action = actions.controls.find(item => item.text === text)
    assert.ok(action, 'Short view retains the actual action: ' + text)
    assert.equal(action.disabled, false)
    assert.ok(action.box.top >= actions.region.top && action.box.bottom <= actions.region.bottom, 'The complete action is visible inside the short Region: ' + text)
  }
  await assertGeometry(); await frame('mote-archived-short-actions-light')
  report.scenarios.push({ name: 'Archived Mote actions visibly coexist in one short viewport', passed: true, actions,
    sourceDraft: await evaluate('launchpad.facts().sourceDraft'), creationTarget: await evaluate('launchpad.facts().moteTopicId') })
}
module.exports.short = captureShortActions
