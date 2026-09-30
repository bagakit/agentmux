const assert = require('node:assert/strict')

module.exports = async function projectLinksScenes({ evaluate, size, click, capture, waitFor, result }) {
  const nativeOnly = async scene => {
    await waitFor('document.querySelectorAll(".conversation-native-thread__record").length===1')
    const facts = await evaluate(`({ nativeRecords: document.querySelectorAll('.conversation-native-thread__record').length,
      meaningfulBody: document.querySelector('.conversation-native-thread')?.textContent.includes('The entry point is') ?? false,
      observationItems: goalsProjectLinks.facts().timelineItemCount,
      rulerCount: document.querySelectorAll('.activity-feed .activity-ruler').length })`)
    assert.deepEqual(facts, { nativeRecords: 1, meaningfulBody: true, observationItems: 0, rulerCount: 0 })
    result.observations.push({ scene, facts })
  }
  await evaluate('goalsProjectLinks.seed("local")'); await size(1280)
  await waitFor('document.querySelectorAll("button.md-link--file").length===3')
  assert.equal(await evaluate('document.querySelector("[data-file-reference-scope]").textContent.includes("current Goal project: Project Alpha")'), true)
  await nativeOnly('local-native-body-empty-observations')
  const original = await evaluate('goalsProjectLinks.facts().session.control')
  await capture('1280-dark-current-goal-project-links', 1280)
  await click('document.querySelector("button.md-link--file")')
  await waitFor('goalsProjectLinks.facts().reads.length===1')
  await waitFor('document.querySelectorAll(".monaco-editor").length>0')
  const opened = await evaluate('goalsProjectLinks.facts()')
  assert.deepEqual(opened.reads, [{ workspaceId: opened.projectWorkspaceId, path: 'src/a.ts' }])
  const fileTab = Object.values(opened.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file'))
  assert.ok(fileTab, 'Actual File Region exists')
  assert.ok(opened.layouts["__scratch__"].groups.find(group => group.id === opened.originalGroup).tabOrder.includes(fileTab.id))
  const displayFacts = `(() => {
    const tabId = ${JSON.stringify(fileTab.id)}, groupId = ${JSON.stringify(opened.originalGroup)}, regionId = ${JSON.stringify(fileTab.layout.activeRegionId)};
    const slots = [...document.querySelectorAll('.workbench-tab-slot')].filter(slot => slot.dataset.workbenchTabId === tabId && slot.dataset.workbenchGroupId === groupId);
    const bodies = [...document.querySelectorAll('[data-workbench-region-id]')].filter(body => body.dataset.workbenchRegionId === regionId);
    return { slotCount: slots.length, bodyCount: bodies.length, containsBody: slots[0]?.contains(bodies[0]) ?? false,
      monacoCount: slots[0]?.querySelectorAll('.monaco-editor').length ?? 0, sourceVisible: /Project\\s+Alpha/.test(slots[0]?.textContent ?? '') };
  })()`
  await waitFor(`(${displayFacts}).sourceVisible`)
  const displayed = await evaluate(displayFacts)
  assert.deepEqual(displayed, { slotCount: 1, bodyCount: 1, containsBody: true, monacoCount: 1, sourceVisible: true })
  assert.deepEqual(opened.session.control, original)
  result.observations.push({ scene: 'actual-project-file', facts: opened, displayed })
  await capture('1280-dark-project-file-original-group', 1280)
  await evaluate('goalsProjectLinks.seed("remote")'); await size(620)
  await waitFor('document.querySelectorAll("button.md-link--file").length===2')
  assert.equal(await evaluate('document.querySelector(".activity-feed").textContent.includes("~/projects/alpha/src/a.ts:12:3")'), true)
  assert.equal(await evaluate('document.querySelector("[data-file-reference-scope]").textContent.includes("Home paths are unconfirmed")'), true)
  await nativeOnly('remote-native-body-empty-observations')
  await capture('620-light-remote-home-unconfirmed', 620)
  await evaluate('goalsProjectLinks.seed("missing")'); await size(620)
  await waitFor('Boolean(document.querySelector(".service-window"))')
  assert.equal(await evaluate('document.querySelectorAll("button.md-link--file").length'), 0)
  assert.equal(await evaluate('document.querySelector(".service-window").textContent.includes("The PMO keeps running")'), true)
  assert.deepEqual(await evaluate('goalsProjectLinks.facts().session.control'), original)
  await nativeOnly('missing-association-native-body-empty-observations')
  await capture('620-light-project-association-unconfirmed', 620)
  assert.equal(result.frames.length, 4)
}
