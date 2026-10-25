const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { gzipSync } = require('node:zlib')

// A bounded observation helper for this actual App scene, not a product profiler.
module.exports = async function observeAtmosphere({ window, read, facts, pause, receipt, evidence }) {
  const send = (method, params = {}) => window.webContents.debugger.sendCommand(method, params)
  let layers = [], painted = [], layerError
  const layerListener = (_event, method, value) => {
    if (method === 'LayerTree.layerTreeDidChange') layers = value.layers ?? []
    if (method === 'LayerTree.layerPainted') painted.push(value)
  }
  window.webContents.debugger.on('message', layerListener)
  try { await send('LayerTree.enable') } catch (error) { layerError = error.message }
  await send('Performance.enable')
  const layerStyle = () => read('(()=>Object.fromEntries(["plane","sheen"].map(name=>{const p=document.querySelector(".browser-start-atmosphere__"+name);return[name,p?{inline:p.style.transform,computed:getComputedStyle(p).transform,opacity:p.style.opacity,computedOpacity:getComputedStyle(p).opacity}:null]})))()')
  const surfaceBox = () => read('document.querySelector(".browser-start-page").getBoundingClientRect().toJSON()')
  const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]))
  function unionMs(events) {
    let duration = 0, end = -Infinity
    for (const event of events.sort((a, b) => a.ts - b.ts)) { duration += Math.max(0, event.ts + event.dur - Math.max(event.ts, end)); end = Math.max(end, event.ts + event.dur) }
    return duration / 1000
  }
  function statistics(events) {
    const result = {}
    for (const event of events) { const row = result[event.name] ??= { count: 0, totalMs: 0, maxMs: 0 }; row.count++; row.totalMs += (event.dur ?? 0) / 1000; row.maxMs = Math.max(row.maxMs, (event.dur ?? 0) / 1000) }
    return result
  }
  async function layerSnapshot() {
    if (layerError) return { status: 'unknown', reason: layerError }
    const root = await send('DOM.getDocument', { depth: 0 }), targets = new Map()
    for (const name of ['plane', 'sheen']) {
      const found = await send('DOM.querySelector', { nodeId: root.root.nodeId, selector: '.browser-start-atmosphere__' + name })
      if (!found.nodeId) continue
      const { node } = await send('DOM.describeNode', { nodeId: found.nodeId, depth: -1 })
      function visit(value) { targets.set(value.backendNodeId, name); for (const child of value.children ?? []) visit(child) }
      visit(node)
    }
    const dpr = await read('devicePixelRatio')
    const content = layers.filter(layer => layer.drawsContent).map(layer => ({ layerId: layer.layerId, backendNodeId: layer.backendNodeId, owner: targets.get(layer.backendNodeId) ?? null,
      width: layer.width, height: layer.height, areaNativePixels: layer.width * layer.height, paintCount: layer.paintCount,
      estimatedSingleRgbaBackingBytes: Math.ceil(layer.width) * Math.ceil(layer.height) * 4 }))
    const useful = content.filter(layer => layer.owner)
    const domBoxes = await read('Object.fromEntries([\"plane\",\"sheen\"].map(name=>{const p=document.querySelector(\".browser-start-atmosphere__\"+name);return[name,p?.getBoundingClientRect().toJSON()]}))')
    for (const layer of useful) {
      layer.domCssBox = domBoxes[layer.owner]
      layer.observedNativeToCssScale = layer.domCssBox?.width ? layer.width / layer.domCssBox.width : null
      try { layer.compositingReasons = (await send('LayerTree.compositingReasons', { layerId: layer.layerId })).compositingReasons } catch (error) { layer.compositingReasonsUnknown = error.message }
    }
    return { status: layers.length ? 'observed' : 'unknown', reason: layers.length ? undefined : 'No native LayerTree update', devicePixelRatio: dpr,
      backingEstimateBoundary: 'Native LayerTree width × height × 4, one hypothetical RGBA surface; DPR is not multiplied twice. Native-to-DOM scale is separately observed. Not measured GPU memory; excludes tiling, clipping, pooling, double buffers and device allocation.',
      contentLayerCount: content.length, totalContentAreaNativePixels: content.reduce((sum, layer) => sum + layer.areaNativePixels, 0),
      atmosphereLayers: useful, largestContentLayers: content.sort((a, b) => b.areaNativePixels - a.areaNativePixels).slice(0, 5),
      allContentIdentity: content.map(({ layerId, backendNodeId, owner }) => ({ layerId, backendNodeId, owner })) }
  }
  async function sample(label, work) {
    await pause(360)
    await read('(()=>{window.startPageStyleWrites=[];window.startPageStyleObserver?.disconnect();window.startPageStyleObserver=new MutationObserver(records=>{for(const r of records)window.startPageStyleWrites.push({at:performance.now(),layer:r.target.className,transform:r.target.style.transform,opacity:r.target.style.opacity})});for(const p of document.querySelectorAll(".browser-start-atmosphere__plane,.browser-start-atmosphere__sheen"))window.startPageStyleObserver.observe(p,{attributes:true,attributeFilter:["style"]})})()')
    const start = await metrics(), beforeLayers = await layerStyle(), beforeFacts = await facts(), layerTreeBefore = await layerSnapshot()
    painted = []
    let complete, stream, tracing = false
    const done = new Promise(resolve => { complete = resolve })
    const listener = (_event, method, value) => { if (method === 'Tracing.tracingComplete') complete(value) }
    window.webContents.debugger.on('message', listener)
    try {
      await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,toplevel,disabled-by-default-devtools.timeline.invalidationTracking,cc,gpu,viz', transferMode: 'ReturnAsStream' }); tracing = true
      const startTime = Date.now(), input = await work(), elapsedMs = Date.now() - startTime
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
      const main = events.filter(event => event.pid === rendererPid && event.tid === mainTid && event.ph === 'X')
      assert.ok(main.length > 0, 'A nonempty native pipeline was observed')
      const end = await metrics(), delta = {}
      for (const name of ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'ScriptDuration']) delta[name] = end[name] - start[name]
      const writes = await read('(()=>{window.startPageStyleObserver?.disconnect();return window.startPageStyleWrites})()'), layerTreeAfter = await layerSnapshot()
      const ownership = new Map([...layerTreeBefore.allContentIdentity ?? [], ...layerTreeAfter.allContentIdentity ?? []].map(layer => [layer.layerId, layer.owner]))
      const gpuPids = events.filter(event => event.name === 'process_name' && /gpu/i.test(event.args?.name ?? '')).map(event => event.pid)
      const result = { label, elapsedMs, rendererPid, mainTid, beforeLayers, afterLayers: await layerStyle(), beforeRetained: beforeFacts.retained, afterRetained: (await facts()).retained,
        scene: { appearance: beforeFacts.appearance, cardCount: beforeFacts.count, pane: beforeFacts.pane, background: Boolean(beforeFacts.savedStartPage?.backgroundImage),
          documentHidden: await read('document.hidden'), windowVisible: window.isVisible(), viewport: window.getContentSize() },
        visibleAtmospheres: await read('[...document.querySelectorAll("[data-start-atmosphere]")].filter(e=>e.getClientRects().length&&!e.closest("[hidden]")).length'),
        input, metrics: delta, documents: end.Documents, nodes: end.Nodes, writes, trace: label + '.trace.json.gz', traceEvents: events.length, statistics: statistics(main),
        taskUnionMs: unionMs(main.filter(event => event.name === 'ThreadControllerImpl::RunTask')),
        longMainTasks: main.filter(event => event.name === 'ThreadControllerImpl::RunTask' && event.dur >= 50000).map(event => ({ durationMs: event.dur / 1000, timestamp: event.ts })),
        renderWork: statistics(events.filter(event => event.ph === 'X' && /Paint|Raster|Composite|DrawFrame|Layerize|Commit/.test(event.name))),
        gpuProcessTrace: { status: gpuPids.length ? 'observed-cpu-side-events' : 'unknown', processIds: gpuPids, statistics: statistics(events.filter(event => gpuPids.includes(event.pid) && event.ph === 'X')),
          actualGpuExecutionTime: 'unknown: these trace slices are CPU-side Chromium GPU-process work, not device execution or power counters', actualGpuMemory: 'unknown: native LayerTree gives dimensions, not allocated device memory' },
        layerTreeBefore, layerTreeAfter, layerPaintEvents: painted.map(event => ({ ...event, owner: ownership.get(event.layerId) ?? null })),
        layoutEvents: main.filter(event => event.name === 'Layout').map(event => ({ durationMs: event.dur / 1000, args: event.args })),
        invalidationExamples: events.filter(event => event.pid === rendererPid && /InvalidationTracking/.test(event.name)).slice(0, 12).map(event => ({ name: event.name, args: event.args })) }
      receipt.costs.push(result)
      await fs.writeFile(path.join(evidence, 'actual.progress.json'), JSON.stringify(receipt, null, 2) + '\n')
      return result
    } finally {
      if (tracing) await send('Tracing.end')
      if (stream) await send('IO.close', { handle: stream })
      window.webContents.debugger.off('message', listener)
    }
  }
  const trajectory = async () => {
    const rect = await surfaceBox(), dispatchAckMs = []
    // Empty top strip avoids adding card hover work to atmosphere cost.
    for (let index = 0; index < 48; index++) {
      const unit = index % 24 / 23, x = rect.x + rect.width * (.12 + .76 * (index < 24 ? unit : 1 - unit)), start = performance.now()
      await move(x, rect.y + 20); dispatchAckMs.push(performance.now() - start); await pause(16)
    }
    await pause(360)
    return { events: 48, dispatchAckMs, boundary: 'Native CDP pointer dispatch acknowledgement; not input-to-photon latency.' }
  }
  return { send, layerStyle, surfaceBox, move, sample, trajectory, cleanup: async () => { window.webContents.debugger.off('message', layerListener); if (!layerError) await send('LayerTree.disable') } }
}
