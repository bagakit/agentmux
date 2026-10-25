const assert = require('node:assert/strict'), path = require('node:path')

module.exports = async function personalization({ window, read, facts, until, pointer, key, type, preserved, shot, pause, receipt, evidence }) {
  await until('branded start page mounted', () => read('window.startPageProof?.ready && document.querySelectorAll(".browser-start-history__card").length===12 && Boolean(document.querySelector(".browser-start-atmosphere__sheen"))'))
  await until('real source images decoded', () => read('(()=>{const images=[...document.querySelectorAll(".browser-start-history__card img")];return images.length===4&&images.every(image=>image.complete&&image.naturalWidth>0)})()'))
  receipt.initial = await facts(); preserved(receipt.initial)
  receipt.boundary += ' Personalization additionally traverses actual SettingsNavigation/BrowserStartPageSettings/FileReader/ConfigOwner.edit/ConfigStore.save/confirmSaved through a private IPC bridge. Native pointer and CDP timeline observations certify this isolated Renderer only.'
  const profile = await require('./native-atmosphere-cost.cjs')({ window, read, facts, pause, receipt, evidence })
  const { send, layerStyle, surfaceBox, move, sample, trajectory } = profile
  await shot('p01-default-dark.png')
  await read('window.startPageProof.theme("light")'); await pause(360); await shot('p01a-default-light.png')
  window.setContentSize(740, 860); await pause(360); await shot('p01b-default-narrow-light.png')
  await read('window.startPageProof.theme("dark")'); await pause(360); await shot('p01c-default-narrow-dark.png')
  window.setContentSize(1920, 1080); await pause(360); await shot('p01d-default-large-dark.png')
  window.setContentSize(1440, 950); await pause(360)
  const box = await surfaceBox()
  await move(box.x + box.width * .12, box.y + 20); await pause(360)
  receipt.pointerLeft = await layerStyle(); await shot('p02-pointer-left.png', false)
  await move(box.x + box.width * .88, box.y + 20); await pause(360)
  receipt.pointerRight = await layerStyle(); await shot('p03-pointer-right.png', false)
  for (const name of ['plane', 'sheen']) {
    assert.notEqual(receipt.pointerLeft[name].inline, receipt.pointerRight[name].inline, 'Actual native pointer moves ' + name)
    assert.notEqual(receipt.pointerLeft[name].computed, receipt.pointerRight[name].computed, 'Computed native transforms differ after settling: ' + name)
  }
  assert.notEqual(receipt.pointerRight.plane.inline, receipt.pointerRight.sheen.inline, 'Distinct foreground and background depth')

  receipt.costs = []
  for (const count of [100, 1000]) {
    await read(`window.startPageProof.retainTabs(${count})`)
    await until('retained scale ' + count, async () => (await facts()).retained === count)
    const result = await sample('cost-pointer-' + count, trajectory)
    assert.equal(result.visibleAtmospheres, 1)
    for (const name of ['plane', 'sheen']) assert.ok(result.writes.filter(write => write.layer === 'browser-start-atmosphere__' + name).length > 5, 'Real pointer work reaches ' + name)
    assert.ok(new Set(result.writes.filter(write => write.layer.endsWith('__sheen')).map(write => write.opacity)).size > 2, 'Native pointer changes sheen intensity')
    assert.equal(result.layoutEvents.length, 0, 'Pointer decoration does not schedule native Layout')
  }
  const [small, large] = receipt.costs
  assert.ok(large.metrics.RecalcStyleCount <= small.metrics.RecalcStyleCount * 1.5 + 4, 'Style work does not scale with unrelated retained Tabs')
  assert.ok(large.metrics.TaskDuration <= Math.max(.15, small.metrics.TaskDuration * 3), 'Unrelated retained Tabs do not amplify the same pointer workload')
  const idle = await sample('cost-idle-1000', () => pause(1300))
  assert.equal(idle.writes.length, 0, 'A still page schedules no decoration writes')
  assert.deepEqual(idle.beforeLayers, idle.afterLayers); assert.equal(idle.layoutEvents.length, 0)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pause(360)
  const reduced = await sample('cost-reduced-motion-1000', trajectory)
  assert.equal(reduced.writes.length, 0, 'Reduced motion removes pointer-driven decoration work')
  assert.deepEqual(reduced.beforeLayers, reduced.afterLayers)
  await shot('p04-reduced-motion.png')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  // Hidden pages may not acknowledge CDP mouse dispatch. Make one bounded native
  // visibility observation with nonblocking Electron input, then always restore.
  const boundedRead = code => Promise.race([read(code), pause(1500).then(() => { throw new Error('Hidden Renderer observation did not reply within 1500 ms') })])
  try {
    window.webContents.setBackgroundThrottling(true); window.hide(); await pause(360)
    const hidden = await boundedRead('document.hidden')
    if (!hidden) receipt.hiddenObservation = { status: 'unavailable', reason: 'Native window hide did not change document.hidden' }
    else {
      await boundedRead('(()=>{window.startPageHiddenWrites=[];window.startPageHiddenObserver=new MutationObserver(records=>window.startPageHiddenWrites.push(...records.map(r=>({layer:r.target.className,transform:r.target.style.transform,opacity:r.target.style.opacity}))));for(const p of document.querySelectorAll(".browser-start-atmosphere__plane,.browser-start-atmosphere__sheen"))window.startPageHiddenObserver.observe(p,{attributes:true,attributeFilter:["style"]})})()')
      for (let i = 0; i < 24; i++) { window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.x + box.width * (.12 + .76 * i / 23)), y: Math.round(box.y + 20) }); await pause(16) }
      await pause(360)
      receipt.hiddenObservation = { status: 'observed', windowVisible: window.isVisible(), ...await boundedRead('(()=>{window.startPageHiddenObserver.disconnect();return{documentHidden:document.hidden,writes:window.startPageHiddenWrites}})()'),
        input: '24 native Electron sendInputEvent requests; hidden platform input delivery is not claimed. Actual hidden guard also has source-qualified tests.' }
    }
  } catch (error) { receipt.hiddenObservation = { status: 'unavailable', reason: error.message } }
  finally { window.showInactive(); window.webContents.setBackgroundThrottling(false) }
  await until('native document visible again', () => read('!document.hidden'))
  await read('window.startPageHiddenObserver?.disconnect()')
  if (receipt.hiddenObservation.status === 'observed') {
    assert.equal(receipt.hiddenObservation.documentHidden, true); assert.equal(receipt.hiddenObservation.windowVisible, false)
    assert.equal(receipt.hiddenObservation.writes.length, 0, 'Observed native hidden page writes no decoration styles')
  }

  async function setInteractive(enabled) {
    await pointer('.browser-start-page__customize')
    await until('original interactive setting', () => read('Boolean(document.querySelector("[data-settings-field=start-interactive-background] input"))'))
    assert.notEqual(await read('document.querySelector("[data-settings-field=start-interactive-background] input").checked'), enabled)
    await pointer('input[aria-label="Interactive start page background"]')
    await pointer('[data-settings-save-bar] button')
    await until('baseline setting durable', () => read('document.querySelector("[data-settings-save-bar]")?.textContent.includes("Changes saved")'))
    await pointer('button[aria-label="Close settings"]')
    await until('original homepage returned', () => read('Boolean(document.querySelector(".browser-start-page"))'))
    assert.equal((await read('window.startPageNativeConfig.read()')).browser.startPage.interactiveBackground, enabled)
  }
  await setInteractive(false)
  for (const count of [100, 1000]) {
    await read(`window.startPageProof.retainTabs(${count})`)
    await until('off retained scale ' + count, async () => (await facts()).retained === count)
    const off = await sample('cost-default-off-' + count, trajectory)
    assert.equal(off.visibleAtmospheres, 0); assert.equal(off.writes.length, 0)
    const on = count === 100 ? small : large
    assert.deepEqual(off.scene, on.scene, 'On/off uses the same viewport, page, appearance and history')
    receipt.baselineComparisons ??= []
    receipt.baselineComparisons.push({ retainedTabs: count, on: on.label, off: off.label,
      taskDeltaMs: (on.metrics.TaskDuration - off.metrics.TaskDuration) * 1000,
      styleCountDelta: on.metrics.RecalcStyleCount - off.metrics.RecalcStyleCount,
      layerCountDelta: on.layerTreeAfter.contentLayerCount - off.layerTreeAfter.contentLayerCount,
      contentAreaDeltaNativePixels: on.layerTreeAfter.totalContentAreaNativePixels - off.layerTreeAfter.totalContentAreaNativePixels,
      boundary: 'Same actual native pointer trajectory and scene; whole Renderer totals include collection overhead and machine noise. Device GPU time/memory remain unknown.' })
  }
  await setInteractive(true)
  await read('window.startPageProof.retainTabs(0)'); await pause(360)

  const central = 'input[aria-label="Search or enter a web address"]', draft = 'Keep this research draft while customizing'
  await type(central, draft); await key('Escape')
  await pointer('.browser-start-page__customize')
  await until('actual Survey settings', () => read('Boolean(document.querySelector("[data-settings-field=start-title] input"))'))
  assert.equal(await read('document.querySelector(".settings-survey")!==null'), true)
  await type('input[aria-label="Start page title"]', 'Your next discovery')
  await type('input[aria-label="Cards on first view"]', '6')
  await pointer('input[aria-label="Interactive start page background"]')
  const document = await send('DOM.getDocument', { depth: 0 })
  const selected = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[aria-label="Select background image file"]' })
  assert.ok(selected.nodeId)
  const imageFile = path.join(evidence, 'preview-studio.jpg')
  await send('DOM.setFileInputFiles', { nodeId: selected.nodeId, files: [imageFile] })
  receipt.operations.push({ action: 'select-local-background', file: imageFile, consumer: 'Actual file input -> FileReader -> draft' })
  await until('original FileReader image ready', () => read('document.querySelector("[data-settings-field=start-background]")?.textContent.includes("Image selected")'))
  await shot('p05-settings-draft.png')
  await pointer('[data-settings-save-bar] button')
  await until('original owner save acknowledged', () => read('document.querySelector("[data-settings-save-bar]")?.textContent.includes("Changes saved")'))
  const disk = await read('window.startPageNativeConfig.read()')
  assert.equal(disk.browser.startPage.title, 'Your next discovery'); assert.equal(disk.browser.startPage.historyLimit, 6)
  assert.equal(disk.browser.startPage.interactiveBackground, false); assert.match(disk.browser.startPage.backgroundImage, /^data:image\/jpeg;base64,/)
  receipt.savedRead = { title: disk.browser.startPage.title, historyLimit: disk.browser.startPage.historyLimit, interactiveBackground: disk.browser.startPage.interactiveBackground, backgroundBytes: disk.browser.startPage.backgroundImage.length }
  await pointer('button[aria-label="Close settings"]')
  await until('same personalized page', () => read('document.querySelector(".browser-start-page h1")?.textContent==="Your next discovery"&&document.querySelectorAll(".browser-start-history__card").length===6'))
  const saved = await facts(); preserved(saved)
  assert.equal(saved.central.value, draft); assert.equal(saved.toolbar.value, draft); assert.equal(saved.plane, null)
  assert.equal(await read('document.querySelector(".browser-start-page__background")?.complete'), true)
  await shot('p06-custom-background-off.png')
  const off = await sample('cost-custom-background-off', trajectory)
  assert.equal(off.visibleAtmospheres, 0); assert.equal(off.writes.length, 0)

  await pointer('.browser-start-page__customize')
  await until('settings reopen original values', () => read('document.querySelector("[data-settings-field=start-title] input")?.value==="Your next discovery"'))
  await pointer('input[aria-label="Interactive start page background"]')
  await pointer('[data-settings-save-bar] button')
  await until('interactive change saved', () => read('document.querySelector("[data-settings-save-bar]")?.textContent.includes("Changes saved")'))
  await pointer('button[aria-label="Close settings"]')
  await until('same custom page interactive', () => read('Boolean(document.querySelector(".browser-start-atmosphere__plane"))'))
  await shot('p07-custom-background-dark.png')
  await read('window.startPageProof.theme("light")'); await pause(220); await shot('p08-custom-background-light.png')
  window.setContentSize(740, 860); await pause(220); await read('window.startPageProof.theme("dark")'); await pause(180)
  await shot('p09-custom-background-narrow.png')
  receipt.final = await facts(); preserved(receipt.final)
  assert.equal(receipt.final.central.value, draft); assert.equal(receipt.final.count, 6)
  assert.deepEqual(receipt.final.calls.navigate, [])
  assert.equal((await read('window.startPageNativeConfig.read()')).browser.startPage.interactiveBackground, true)
  await profile.cleanup()
}
