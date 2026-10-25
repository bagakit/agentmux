const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { gzipSync } = require('node:zlib')

module.exports = async function personalization({ window, read, facts, until, pointer, key, type, preserved, shot, pause, receipt, evidence }) {
  const send = (method, params = {}) => window.webContents.debugger.sendCommand(method, params)
  await until('personalized start page mounted', () => read('window.startPageProof?.ready && document.querySelectorAll(".browser-start-history__card").length===12 && Boolean(document.querySelector(".browser-start-atmosphere__plane"))'))
  await until('real source images decoded', () => read('(()=>{const images=[...document.querySelectorAll(".browser-start-history__card img")];return images.length===4&&images.every(image=>image.complete&&image.naturalWidth>0)})()'))
  receipt.initial = await facts(); preserved(receipt.initial)
  receipt.boundary += ' Personalization additionally traverses actual SettingsNavigation/BrowserStartPageSettings/FileReader/ConfigOwner.edit/ConfigStore.save/confirmSaved through a private IPC bridge. Native pointer and CDP timeline observations certify this isolated Renderer only.'
  await shot('p01-default-dark.png')
  await send('Performance.enable')
  const planeStyle = () => read('(()=>{const p=document.querySelector(".browser-start-atmosphere__plane");return p?{inline:p.style.transform,computed:getComputedStyle(p).transform}:null})()')
  const surfaceBox = () => read('document.querySelector(".browser-start-page").getBoundingClientRect().toJSON()')
  const move = async (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  let box = await surfaceBox()
  await move(box.x + box.width * .12, box.y + 20); await pause(260)
  receipt.pointerLeft = await planeStyle(); await shot('p02-pointer-left.png', false)
  await move(box.x + box.width * .88, box.y + 20); await pause(260)
  receipt.pointerRight = await planeStyle(); await shot('p03-pointer-right.png', false)
  assert.notEqual(receipt.pointerLeft.inline, receipt.pointerRight.inline, 'Actual native pointer moves the rendered layer')
  assert.notEqual(receipt.pointerLeft.computed, receipt.pointerRight.computed, 'Computed native transforms differ after settling')

  function unionMs(events) {
    let duration = 0, end = -Infinity
    for (const event of events.sort((a, b) => a.ts - b.ts)) { duration += Math.max(0, event.ts + event.dur - Math.max(event.ts, end)); end = Math.max(end, event.ts + event.dur) }
    return duration / 1000
  }
  async function metrics() { return Object.fromEntries((await send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value])) }
  async function sample(label, work) {
    await pause(260)
    await read('(()=>{window.startPageStyleWrites=[];window.startPageStyleObserver?.disconnect();const p=document.querySelector(".browser-start-atmosphere__plane");if(p){window.startPageStyleObserver=new MutationObserver(records=>{for(const r of records)window.startPageStyleWrites.push({at:performance.now(),value:r.target.style.transform})});window.startPageStyleObserver.observe(p,{attributes:true,attributeFilter:["style"]})}})()')
    const start = await metrics(), beforePlane = await planeStyle(), beforeFacts = await facts()
    let complete, stream, tracing = false
    const done = new Promise(resolve => { complete = resolve })
    const listener = (_event, method, value) => { if (method === 'Tracing.tracingComplete') complete(value) }
    window.webContents.debugger.on('message', listener)
    try {
      await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,toplevel,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReturnAsStream' }); tracing = true
      const startTime = Date.now(); await work(); const elapsedMs = Date.now() - startTime
      await send('Tracing.end'); tracing = false
      const finished = await Promise.race([done, pause(10000).then(() => { throw new Error('The original native cost trace did not finish') })])
      assert.equal(finished.dataLossOccurred, false); assert.ok(finished.stream); stream = finished.stream
      const chunks = []
      for (;;) { const chunk = await send('IO.read', { handle: stream, size: 1024 * 1024 }); chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8')); if (chunk.eof) break }
      await send('IO.close', { handle: stream }); stream = undefined
      const bytes = Buffer.concat(chunks), events = JSON.parse(bytes.toString()).traceEvents
      await fs.writeFile(path.join(evidence, label + '.trace.json.gz'), gzipSync(bytes))
      const rendererPid = window.webContents.getOSProcessId(), mainTid = events.find(event => event.pid === rendererPid && event.name === 'thread_name' && event.args?.name === 'CrRendererMain')?.tid
      assert.ok(mainTid, 'Actual renderer main thread present in the native trace')
      const main = events.filter(event => event.pid === rendererPid && event.tid === mainTid && event.ph === 'X'), statistics = {}
      assert.ok(main.length > 0, 'A nonempty native pipeline was observed')
      for (const event of main) { const row = statistics[event.name] ??= { count: 0, totalMs: 0 }; row.count++; row.totalMs += event.dur / 1000 }
      const end = await metrics(), delta = {}
      for (const name of ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'ScriptDuration']) delta[name] = end[name] - start[name]
      const writes = await read('(()=>{window.startPageStyleObserver?.disconnect();return window.startPageStyleWrites})()')
      const result = { label, elapsedMs, rendererPid, mainTid, beforePlane, afterPlane: await planeStyle(), beforeRetained: beforeFacts.retained, afterRetained: (await facts()).retained,
        visibleAtmospheres: await read('[...document.querySelectorAll("[data-start-atmosphere]")].filter(e=>e.getClientRects().length&&!e.closest("[hidden]")).length'),
        metrics: delta, documents: end.Documents, nodes: end.Nodes, writes, trace: label + '.trace.json.gz', traceEvents: events.length, statistics,
        taskUnionMs: unionMs(main.filter(event => event.name === 'ThreadControllerImpl::RunTask')),
        layoutEvents: main.filter(event => event.name === 'Layout').map(event => ({ durationMs: event.dur / 1000, args: event.args })),
        invalidationExamples: events.filter(event => event.pid === rendererPid && /InvalidationTracking/.test(event.name)).slice(0, 12).map(event => ({ name: event.name, args: event.args })) }
      receipt.costs.push(result)
      return result
    } finally {
      if (tracing) await send('Tracing.end')
      if (stream) await send('IO.close', { handle: stream })
      window.webContents.debugger.off('message', listener)
    }
  }
  const trajectory = async () => {
    const rect = await surfaceBox()
    // The original page's empty top strip avoids adding card hover work to atmosphere cost.
    for (let index = 0; index < 48; index++) {
      const unit = index % 24 / 23, x = rect.x + rect.width * (.12 + .76 * (index < 24 ? unit : 1 - unit))
      await move(x, rect.y + 20); await pause(16)
    }
    await pause(220)
  }
  receipt.costs = []
  for (const count of [100, 1000]) {
    await read(`window.startPageProof.retainTabs(${count})`)
    await until('retained scale ' + count, async () => (await facts()).retained === count)
    const result = await sample('cost-pointer-' + count, trajectory)
    assert.equal(result.visibleAtmospheres, 1)
    assert.ok(result.writes.length > 5, 'Real pointer work reaches the actual layer')
    assert.equal(result.layoutEvents.length, 0, 'Pointer decoration does not schedule native Layout')
  }
  const [small, large] = receipt.costs
  assert.ok(large.metrics.RecalcStyleCount <= small.metrics.RecalcStyleCount * 1.5 + 4, 'Style work does not scale with unrelated retained Tabs')
  assert.ok(large.metrics.TaskDuration <= Math.max(.15, small.metrics.TaskDuration * 3), 'Unrelated retained Tabs do not amplify the same pointer workload')
  const idle = await sample('cost-idle-1000', () => pause(1300))
  assert.equal(idle.writes.length, 0, 'A still page schedules no decoration writes')
  assert.deepEqual(idle.beforePlane, idle.afterPlane)
  assert.equal(idle.layoutEvents.length, 0)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pause(250)
  const reduced = await sample('cost-reduced-motion-1000', trajectory)
  assert.equal(reduced.writes.length, 0, 'Reduced motion removes pointer-driven decoration work')
  assert.deepEqual(reduced.beforePlane, reduced.afterPlane)
  await shot('p04-reduced-motion.png')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await read('window.startPageProof.retainTabs(0)'); await pause(250)

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
  const off = await sample('cost-background-off', trajectory)
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
}
