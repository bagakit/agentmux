const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, privateRoot, evidence, scenario = 'readability'] = process.argv.slice(2)
for (const name of ['home', 'appData', 'userData', 'sessionData']) app.setPath(name, path.join(privateRoot, name))
const result = { schema: 'agentmux.collaboration-map-actual.v1', scenario: 'focus-map-' + scenario, passed: false, captureOnly: true, aestheticReview: 'not-performed', frames: [], checks: [], failures: [], rendererErrors: [], rendererMessages: [], performance: [],
  conditions: { nativeRenderer: true, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch, privateWindowShown: false, backgroundThrottling: false, focusEmulated: true, viewport: [1440, 900], physicalDisplayRefreshQualified: false,
    instrumentation: 'Transparent real Worker traffic observer; counter in original context function; LongTask and rAF during finite windows; DOM census at explicit boundaries, plus the declared finite adaptive neighborhood sampler with its own measured overhead. Callback, counter, Worker-observer and census costs are recorded. Clock-call, constructor-listener and O(1) actual presented-frame reference-publication overhead is uncalibrated; these are instrumented results, not an uninstrumented product claim.' },
  boundary: 'Original current source App/Space/Focus/Map/Worker/cards/sole Reader/Store. Only typed platform facts and unrelated PTY/Monaco paint are controlled. No Provider, real message, user Run, installed package, durability or aesthetic qualification.' }
let win, controlHost, controlExit, pendingCli, phase = 'initialize'
const checkpoint = async () => { result.phase = phase; const next = path.join(evidence, 'actual.next.json'); await fs.writeFile(next, JSON.stringify(result, null, 2) + '\n'); await fs.rename(next, path.join(evidence, 'actual.json')) }
const started = checkpoint()
app.whenReady().then(async () => {
  try {
    await started
    win = new BrowserWindow({ width: 1440, height: 900, x: -10000, y: -10000, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    result.nativeLifecycle = []
    const clock = () => ({ phase, at: new Date().toISOString(), mainMonotonicMS: Number(process.hrtime.bigint()) / 1e6 })
    const nativeEvent = (event, detail = {}) => { const fact={ event, ...clock(), ...detail }; result.nativeLifecycle.push(fact); require('node:fs').appendFileSync(path.join(evidence,'native-lifecycle.jsonl'),JSON.stringify(fact)+'\n') }
    win.on('closed', () => nativeEvent('window-closed'))
    win.webContents.on('render-process-gone', (_event, details) => nativeEvent('render-process-gone', details))
    win.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => nativeEvent('did-fail-load', { code, description, mainFrame }))
    app.on('before-quit', () => nativeEvent('before-quit'))
    win.webContents.on('console-message', event => { if (event.level === 'error') { result.rendererErrors.push(String(event.message).slice(0, 2000)); result.rendererMessages.push({ ...clock(), message: event.message, source: event.sourceId, line: event.lineNumber }) } })
    const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }
    const pause = ms => new Promise(done => setTimeout(done, ms))
    const until = async (label, predicate) => { const end = Date.now() + 12000; do { if (await predicate()) return; await pause(40) } while (Date.now() < end); throw Error('Scene did not settle: ' + label) }
    const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const rect = async selector => {
      const point = await read(`(()=>{const candidates=[...document.querySelectorAll(${JSON.stringify(selector)})],visible=candidates.filter(e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e);return r.width>0&&r.height>0&&!e.closest('[hidden],[inert]')&&style.visibility==='visible'&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight}),e=visible[0];if(!e)return{missing:true,matches:candidates.length,visible:visible.length};const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hit:e.contains(hit),matches:candidates.length,visible:visible.length,hitTag:hit?.tagName,hitClass:hit?.getAttribute('class')}})()`)
      ;(result.pointerTargets ??= []).push({ selector, ...point }); assert.equal(point.missing, undefined, 'Missing actual visible control ' + selector); return point
    }
    const move = async selector => { const point = await rect(selector); assert.ok(point.hit, 'Real pointer target ' + selector); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }) }
    const click = async selector => { const point = await rect(selector); assert.ok(point.hit, 'Real click target ' + selector); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }); await settle() }
    const key = async (value, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code: value === 'a' ? 'KeyA' : value, modifiers, ...(value === 'Enter' ? { windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) } : {}), ...(type === 'keyDown' && value === 'a' && modifiers === 4 ? { commands: ['selectAll'] } : type === 'keyDown' && value === 'Backspace' ? { commands: ['deleteBackward'] } : {}) }) }
    const frame = async (name, { motion = false } = {}) => {
      await settle()
      if (!motion && !name.endsWith('-live')) await until('finite entrance settled', () => read(`![...document.getAnimations()].some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().iterations)&&a.effect?.target?.closest?.('.collaboration-map,.agent-information-reader,.collaboration-filter-menu'))`))
      const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label: name, viewport: win.getContentSize() }); await checkpoint()
    }
    const check = async (name, action) => { phase = name; await read(`window.graphCapture.diagnosticPhase(${JSON.stringify(name)})`); const startedAt = clock(); try { await action(); result.checks.push({ name, passed: true, startedAt, completedAt: clock() }) } catch (error) { result.checks.push({ name, passed: false, startedAt, completedAt: clock() }); result.failures.push({ name, ...clock(), message: error.message, stack: error.stack }); await frame('failure-' + name) } finally { await checkpoint() } }
    const facts = () => read('window.graphCapture.facts()')
    const activity = () => read('window.graphCapture.activity()')
    const motionFrame = async (label, event, offset) => {
      await pause(Math.max(0, event.at + offset - await read('performance.now()')))
      const observed = await activity(); await frame(label, { motion: true })
      const sample = { label, requestedOffsetMS: offset, elapsedMS: observed.at - event.at, ...observed }
      ;(result.activityFrames ??= []).push(sample); return sample
    }
    const intact = async (selection = true, focus = true) => { const state = await facts(); for (const field of ['sameTabs', 'layoutsPreserved', 'sameDrafts', ...(focus ? ['sameFocus'] : []), ...(selection ? ['selectionPreserved'] : []), 'draftMounted', 'sameDraft']) assert.equal(state[field], true, field + ': ' + JSON.stringify(state.tabDifference ?? state.layoutDifference ?? state.selectionDifference ?? null)); assert.equal(state.draft, 'Original unsent reply · retain this exact draft.'); assert.equal(state.storedDraft, state.draft); assert.deepEqual(state.range, [4, 12]); assert.deepEqual(state.controls, result.before.controls); assert.deepEqual(state.chrome.preferences,result.before.chrome.preferences,'Map keeps original sidebar preferences'); return state }
    const matrix = () => read(`document.querySelector('.collaboration-map .react-flow__viewport')?.getAttribute('style')`)
    const regionSnapshot = () => read(`(()=>{const bounds=element=>{if(!element)return null;const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}},text=element=>element?{text:element.textContent,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,bounds:bounds(element)}:null;return[...document.querySelectorAll('.collaboration-region-labels .collaboration-area__summary')].map(button=>{const area=button.closest('[data-area-id]'),activity=button.querySelector('.collaboration-area__activity'),style=activity&&getComputedStyle(activity);return{id:area.dataset.areaId,kind:area.dataset.kind,label:button.getAttribute('aria-label'),title:button.title,bounds:bounds(button),name:text(button.querySelector('strong')),count:text(button.querySelector('small')),type:bounds(button.querySelector('svg')),activity:activity?{bounds:bounds(activity),display:style.display,visibility:style.visibility,opacity:style.opacity,label:activity.getAttribute('aria-label')}:null}}).sort((a,b)=>a.id.localeCompare(b.id))})()`)
    const assertStableRegions = (before, after) => {
      assert.ok(before.length>0,'Original region labels are actually present')
      assert.deepEqual(after.map(region=>region.id),before.map(region=>region.id),'Activity retains the same exact original region labels')
      for(let index=0;index<before.length;index++) {
        const original=before[index], current=after[index]
        for(const field of ['kind','label','title','name','count','type','bounds']) assert.deepEqual(current[field],original[field],'Region activity preserves original '+field)
        assert.ok(original.activity&&current.activity,'Original region label reserves its activity slot before and during events')
        assert.deepEqual(current.activity.bounds,original.activity.bounds,'Activity does not claim extra region name space')
      }
    }
    const relationPointer = () => read(`(()=>{for(const element of document.querySelectorAll('[data-capture-semantic-edge],[data-capture-tooltip-anchor]')){element.removeAttribute('data-capture-semantic-edge');element.removeAttribute('data-capture-tooltip-anchor')}const edges=[...document.querySelectorAll('.collaboration-map .react-flow__edge')],pair=edge=>JSON.stringify(JSON.parse(edge.dataset.id).slice(1).sort()),candidates=[];for(const edge of edges){const path=edge.querySelector('.react-flow__edge-path'),length=path?.getTotalLength(),matrix=path?.getScreenCTM();if(!length||!matrix)continue;for(const fraction of [.5,.35,.65,.2,.8]){const p=path.getPointAtLength(length*fraction),point=new DOMPoint(p.x,p.y).matrixTransform(matrix);if(point.x<8||point.y<44||point.x>innerWidth-8||point.y>innerHeight-44||!edge.contains(document.elementFromPoint(point.x,point.y)))continue;candidates.push({edge,path,x:point.x,y:point.y,length,kind:JSON.parse(edge.dataset.id)[0],parallel:edges.filter(other=>pair(other)===pair(edge)).length});break}}candidates.sort((a,b)=>Number(b.parallel>1)-Number(a.parallel>1)||Number(b.kind==='communication')-Number(a.kind==='communication')||a.length-b.length);const candidate=candidates[0];if(!candidate)throw Error('No actual relation path is exposed to pointer input');candidate.edge.setAttribute('data-capture-semantic-edge','');candidate.path.setAttribute('data-capture-tooltip-anchor','');return{x:candidate.x,y:candidate.y,id:candidate.edge.dataset.id,label:candidate.edge.getAttribute('aria-label'),pathLength:candidate.length,parallel:candidate.parallel}})()`)
    const relationTooltip = () => read(`(()=>{const edge=document.querySelector('[data-capture-semantic-edge]');if(!edge)return null;const path=edge.querySelector('.react-flow__edge-path'),id=edge.getAttribute('aria-describedby'),tooltip=id&&document.getElementById(id),bounds=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}},matrix=path?.getScreenCTM(),anchor=path?{bounds:bounds(path),path:path.getAttribute('d'),held:path.hasAttribute('data-capture-tooltip-anchor'),matrix:matrix?{a:matrix.a,b:matrix.b,c:matrix.c,d:matrix.d,e:matrix.e,f:matrix.f}:null}:null;let panel=null;if(tooltip){const r=tooltip.getBoundingClientRect(),style=getComputedStyle(tooltip),x=r.x+r.width/2,y=r.y+r.height/2;panel={id:tooltip.id,role:tooltip.getAttribute('role'),text:tooltip.textContent,bounds:bounds(tooltip),display:style.display,visibility:style.visibility,opacity:style.opacity,pointerEvents:style.pointerEvents,clientWidth:tooltip.clientWidth,scrollWidth:tooltip.scrollWidth,clientHeight:tooltip.clientHeight,scrollHeight:tooltip.scrollHeight,inMap:Boolean(tooltip.closest('.collaboration-map')),windowLayer:tooltip.closest('[data-overlay-layer]')?.getAttribute('data-overlay-layer'),hitStack:document.elementsFromPoint(x,y).slice(0,8).map(element=>({tag:element.tagName,role:element.getAttribute('role'),class:element.getAttribute('class'),tooltip:Boolean(element.closest('[role="tooltip"]'))}))}}return{id:edge.dataset.id,label:edge.getAttribute('aria-label'),describedBy:id,focused:document.activeElement===edge,anchor,panel,viewport:{width:innerWidth,height:innerHeight},camera:document.querySelector('.collaboration-map .react-flow__viewport')?.getAttribute('style'),packets:[...edge.querySelectorAll('.collaboration-edge__packet')].map(bounds)}})()`)
    const assertReadableRelationTooltip = sample => {
      assert.ok(sample?.anchor?.held,'Tooltip retains the exact original stable BaseEdge path')
      assert.ok(sample.panel&&sample.describedBy===sample.panel.id,'The original edge describes its exact window tooltip')
      const panel=sample.panel, box=panel.bounds
      assert.equal(panel.role,'tooltip'); assert.equal(panel.text,sample.label,'The full original kind, ordered endpoints and count remain readable')
      assert.equal(panel.inMap,false,'Relation reading escapes the clipped Map canvas'); assert.equal(panel.windowLayer,'tooltip')
      assert.ok(box.width>0&&box.height>0&&panel.display!=='none'&&panel.visibility==='visible'&&Number(panel.opacity)>0,'Original tooltip is actually painted')
      assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=sample.viewport.width+.5&&box.y+box.height<=sample.viewport.height+.5,'The complete relation tooltip stays inside the actual window')
      assert.ok(panel.scrollWidth<=panel.clientWidth+1&&panel.scrollHeight<=panel.clientHeight+1,'The original full relation sentence fits without hidden overflow')
      assert.equal(panel.pointerEvents,'none','The short relation tooltip does not intercept Map input'); assert.ok(panel.hitStack.length>0&&!panel.hitStack.some(hit=>hit.tooltip),'Real hit testing passes through the tooltip to original input')
    }
    const showRelationTooltip = async label => {
      await click('[aria-label="Find Agent in map"]')
      await until('previous relation reading departed',()=>read(`![...document.querySelectorAll('.collaboration-map .react-flow__edge[aria-describedby]')].some(edge=>document.getElementById(edge.getAttribute('aria-describedby'))?.getAttribute('role')==='tooltip')`))
      const pointer=await relationPointer()
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:pointer.x,y:pointer.y})
      await until('original window relation tooltip is visible',async()=>{const sample=await relationTooltip();return sample?.panel?.visibility==='visible'&&sample.panel.text===pointer.label})
      const sample=await relationTooltip(); assertReadableRelationTooltip(sample)
      ;(result.relationTooltips ??= []).push({frame:label,pointer,...sample}); await frame(label); return {pointer,sample}
    }
    const fullMap = async () => { const state = await facts(), chrome = state.chrome; assert.equal(chrome.map.length,1); assert.equal(chrome.rail.length,0,'Focus Map has no visible Project Rail'); assert.equal(chrome.list.length,0,'Focus Map has no visible List'); assert.equal(chrome.dock.length,0,'Focus Map has no visible Space dock'); assert.ok(chrome.map[0].left<=2&&chrome.map[0].width>=chrome.viewportWidth-4,'Actual Focus Map fills its client width'); return chrome }
    const mapReady = async () => {
      await until('actual Focus Map', () => read(`Boolean(document.querySelector('.collaboration-map[data-desktop-focus-view="map"]:not([hidden])'))`))
      await until('native Worker world boxes', () => read(`window.graphCapture.workerSamples().some(sample=>sample.boxes?.agents>=8)`))
      await until('real visible nodes', () => read(`document.querySelectorAll('.collaboration-map:not([hidden]) [data-collaboration-agent]').length>0`))
      await until('original sources and layout settled', () => read(`!document.querySelector('.collaboration-map__reading')&&!document.querySelector('.collaboration-canvas__progress')`))
      if (!result.firstArrangement) {
        const first = (await read('window.graphCapture.workerSamples()')).find(sample => sample.request?.type === 'arrange' && sample.geometry && sample.input)
        assert.ok(first, 'Original initial arrangement must have actual Worker input and geometry')
        assert.ok(first.input.edges.length > 0, 'The first original arrangement consumes known relationships from this scene')
        const boxes = new Map(first.geometry.map(box => [box.id, box]))
        result.firstArrangement = { nodes: first.input.nodes, knownRelations: first.input.connections, related: first.input.edges.map(edge => {
          const source = boxes.get(edge.source), target = boxes.get(edge.target)
          assert.ok(source && target, 'First known relation retains both exact original endpoints')
          return { ...edge, sameArea: source.areaId === target.areaId, distance: Math.hypot(source.x + source.width / 2 - target.x - target.width / 2, source.y + source.height / 2 - target.y - target.height / 2) }
        }) }
      }
    }
    const closeReader = async () => { if (await read(`Boolean(document.querySelector('[aria-label="Close Agent reading"]'))`)) await click('[aria-label="Close Agent reading"]'); await until('Reader closed', () => read(`!document.querySelector('.agent-information-reader')`)) }
    const closeDetails = async () => {
      await closeReader()
      const visible = await read(`(()=>{const e=document.querySelector('[aria-label="Close map details"]');if(!e)return false;const r=e.getBoundingClientRect(),style=getComputedStyle(e);return r.width>0&&r.height>0&&!e.closest('[hidden],[inert]')&&style.visibility==='visible'&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight})()`)
      if (visible) await click('[aria-label="Close map details"]')
    }
    const markByText = async (selector, text, attribute) => {
      assert.ok(await read(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent?.trim()===${JSON.stringify(text)});if(!e)return false;e.setAttribute(${JSON.stringify(attribute)},'');return true})()`), 'Actual named control ' + text)
      return '[' + attribute + ']'
    }
    const fillSearch = async value => {
      const selector = '[aria-label="Find Agent in map"]'
      await click(selector); const before = await read(`document.querySelector(${JSON.stringify(selector)}).value`)
      assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),true,'Real search input owns keyboard focus')
      await key('a', 4); await win.webContents.debugger.sendCommand('Input.insertText', { text: value })
      await until('original search input equals requested text', () => read(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`))
      const focused = await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`); assert.equal(focused,true)
      ;(result.queryEdits ??= []).push({ before, requested: value, observed: await read(`document.querySelector(${JSON.stringify(selector)}).value`), focused, editingCommand: 'selectAll' })
    }
    const locate = async id => {
      await fillSearch(id)
      await until('exact original search result', () => read(`document.querySelector('[aria-label="Matching Agents"] [role="option"]')?.textContent.includes(${JSON.stringify(id)})`))
      await key('Enter')
      await until('original combobox committed', () => read(`document.querySelector('[aria-label="Find Agent in map"]').value===''&&!document.querySelector('[aria-label="Matching Agents"]')`))
      await until('located original card or mark', () => read(`Boolean(document.querySelector('.collaboration-map [data-session-id=${JSON.stringify(id)}]'))`))
      await until('located Agent is actually actionable after its finite camera transition', async () => (await rect(`.collaboration-map [data-session-id="${id}"]`)).hit)
    }
    const measure = async (label, action) => {
      // One bounded original pan profile identifies actual JS/layout costs. This
      // diagnostic run is explicitly instrumented, not an unprofiled benchmark.
      const profiling = label === 'perception-pan-240'
      let beforeMetrics
      if (profiling) {
        await win.webContents.debugger.sendCommand('Performance.enable')
        await win.webContents.debugger.sendCommand('Profiler.enable')
        await win.webContents.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 1000 })
        beforeMetrics = await win.webContents.debugger.sendCommand('Performance.getMetrics')
        await win.webContents.debugger.sendCommand('Profiler.start')
      }
      await read(`window.graphCapture.beginMeasurement(${JSON.stringify(label)})`)
      try { await action() } finally {
        const measurement = await read('window.graphCapture.endMeasurement()'); result.performance.push(measurement)
        if (profiling) {
          const { profile } = await win.webContents.debugger.sendCommand('Profiler.stop')
          const afterMetrics = await win.webContents.debugger.sendCommand('Performance.getMetrics')
          await win.webContents.debugger.sendCommand('Profiler.disable'); await win.webContents.debugger.sendCommand('Performance.disable')
          const file = 'perception-pan-240.cpuprofile', bytes = JSON.stringify(profile) + '\n'
          await fs.writeFile(path.join(evidence, file), bytes)
          const before = new Map(beforeMetrics.metrics.map(metric => [metric.name, metric.value]))
          measurement.profile = { file, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'), intervalMicroseconds: 1000,
            metricsDelta: Object.fromEntries(afterMetrics.metrics.map(metric => [metric.name, metric.value - before.get(metric.name)])),
            boundary: 'Original native pan under Chromium CPU sampling; same input, consumer and geometry. Sampling overhead is uncalibrated and not subtracted. No claim of uninstrumented frame latency.' }
        }
        await checkpoint()
      }
    }
    const worldProjection = () => read(`(()=>{
      const sample=window.graphCapture.workerSamples().filter(sample=>sample.geometry).at(-1),boxes=new Map(sample.geometry.map(box=>[box.id,box])),nodes=new Map([...document.querySelectorAll('.collaboration-map .react-flow__node')].map(node=>[node.dataset.id,node]));
      const envelopes=[],endpoints=[];
      for(const [id,node] of nodes){const path=node.querySelector('.collaboration-area__envelope path'),area=boxes.get(id);if(!path||area?.kind!=='area')continue;const members=sample.geometry.filter(box=>box.kind==='agent'&&box.areaId===area.areaId),rectangles=[area.heading,...members.map(box=>({...box,x:box.x-area.x,y:box.y-area.y}))],outside=[];for(const [index,r] of rectangles.entries())for(const x of [r.x,r.x+r.width])for(const y of [r.y,r.y+r.height])if(!path.isPointInFill(new DOMPoint(x,y)))outside.push({index,x,y});envelopes.push({id,members:members.length,corners:rectangles.length*4,rounded:path.getAttribute('d').includes(' Q '),outside})}
      for(const edge of document.querySelectorAll('.collaboration-map .react-flow__edge')){const [kind,source,target]=JSON.parse(edge.dataset.id),path=edge.querySelector('.react-flow__edge-path'),length=path?.getTotalLength(),matrix=path?.getScreenCTM();if(!length||!matrix)continue;for(const [id,at] of [[source,0],[target,length]]){const mark=nodes.get(id)?.querySelector('.collaboration-agent[data-overview="true"] .collaboration-agent__dot'),point=mark?.querySelector('.agent-avatar')?mark:mark?.querySelector('.collaboration-agent__point');if(!point)continue;const r=point.getBoundingClientRect(),p=path.getPointAtLength(at),screen=new DOMPoint(p.x,p.y).matrixTransform(matrix);endpoints.push({kind,id,agent:JSON.parse(id)[0]!=='area',radius:r.width/2,error:Math.abs(Math.hypot(screen.x-r.x-r.width/2,screen.y-r.y-r.height/2)-r.width/2)})}}
      return{envelopes,endpoints,unmatchedNodes:[...nodes.keys()].filter(id=>!boxes.has(id)),deliveredMembers:sample.geometry.filter(box=>box.kind==='agent').length,paths:document.querySelectorAll('.collaboration-map .react-flow__edge-path').length}
    })()`)
    const overview = async label => {
      if (await read(`Boolean(document.querySelector('.collaboration-inspector:not([hidden])'))`)) await click('[aria-label="Close map details"]')
      await move('[aria-label="Overview"]'); await until('original transient Reader departed', () => read(`!document.querySelector('.agent-information-reader:not([data-pinned])')`))
      // Observe the preceding view until its original peek release and debounced
      // visible-demand report have converged. This neither requests nor prewarms
      // history. Only the subsequent actual Overview action owns the zero-read budget.
      const previousView = () => read(`(()=>{const state=window.graphCapture.facts(),world=window.graphCapture.world(),geometry=new Map(world.geometry.map(box=>[box.id,box])),renderer=document.querySelector('.collaboration-map .react-flow__renderer'),r=renderer.getBoundingClientRect(),viewport={x:r.x,y:r.y,width:r.width,height:r.height},visibleSubjects=[...document.querySelectorAll('.collaboration-map [data-collaboration-agent]')].flatMap(element=>{const box=element.getBoundingClientRect(),node=element.closest('.react-flow__node'),original=geometry.get(node?.dataset.id);if(!original||box.width<=0||box.height<=0||box.right<=r.left||box.left>=r.right||box.bottom<=r.top||box.top>=r.bottom)return[];return[{subject:element.dataset.collaborationAgent,nodeId:node.dataset.id,world:original,screen:{x:box.x,y:box.y,width:box.width,height:box.height}}]});return{at:performance.now(),camera:world.camera,viewport,visibleSubjects,reads:state.reads,readingIndicatorVisible:Boolean(document.querySelector('[aria-label="Reading sources"]')),progress:Boolean(document.querySelector('.collaboration-canvas__progress'))}})()`)
      const admitted = await previousView(), samples = [admitted]; let stable = 0
      await until('preceding original visible demand settled', async () => {
        await pause(150); const current=await previousView(), previous=samples.at(-1)
        stable=!current.progress&&current.camera===previous.camera&&['x','y','width','height'].every(key=>current.viewport[key]===previous.viewport[key])&&current.reads.length===previous.reads.length ? stable+1 : 0
        samples.push(current); return stable>=3
      })
      const settled=samples.at(-1), readCount=settled.reads.length
      ;(result.overviewSettlements ??= []).push({label,readsBefore:admitted.reads.length,readsAfter:readCount,addedReads:settled.reads.slice(admitted.reads.length),samples:samples.map(({reads,...sample},index)=>({...sample,readCount:reads.length,addedReads:reads.slice(index?samples[index-1].reads.length:reads.length)}))})
      await click('[aria-label="Overview"]'); await pause(350); await until('original overview projection', () => read(`document.querySelectorAll('.collaboration-area[data-overview="true"]').length>0&&!document.querySelector('.collaboration-canvas__progress')`))
      const observation=await read(`({camera:document.querySelector('.collaboration-map .react-flow__viewport').getAttribute('style'),fullCards:document.querySelectorAll('.collaboration-map .focus-context[data-session-id]').length,agentLabels:document.querySelectorAll('.collaboration-agent[data-overview="true"] strong').length,areas:[...document.querySelectorAll('.collaboration-area__summary')].map(e=>({label:e.getAttribute('aria-label'),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})),paths:document.querySelectorAll('.collaboration-map .react-flow__edge-path').length})`)
      // Boxes commit before route completion; a later route job may supersede the original job.
      const geometry=await worldProjection(); (result.overviews ??= []).push({label,...observation,geometry,readCountBefore:readCount,readCountAfter:(await facts()).reads.length}); assert.deepEqual(geometry.unmatchedNodes,[],'Every actual native node belongs to the latest delivered Worker geometry'); assert.ok(geometry.envelopes.length>0&&geometry.envelopes.reduce((sum,area)=>sum+area.members,0)>0,'Original Worker member geometry reaches the visible envelopes'); assert.ok(geometry.envelopes.every(area=>area.rounded&&area.outside.length===0),'Every complete member and reserved heading stays inside its original native SVG envelope'); assert.ok(geometry.endpoints.length>0,'Original visible paths reach real overview points'); assert.ok(geometry.endpoints.every(endpoint=>endpoint.agent&&endpoint.error<1.5),'Overview retains original Agent endpoints at their painted circle boundary')
      assert.equal(observation.fullCards,0); assert.equal(observation.agentLabels,0,'Overview uses original Agent points instead of unreadable tiny labels'); assert.ok(observation.areas.length>0&&observation.areas.every(area=>area.width>0&&area.height>0)); assert.equal((await facts()).reads.length,readCount,'Overview does not read the whole world'); await fullMap(); await intact(); await frame(label)
    }
    const dragCanvas = async (dx, dy) => {
      const point = await read(`(()=>{const canvas=document.querySelector('.collaboration-canvas'),r=canvas.getBoundingClientRect();for(let row=2;row<8;row++)for(let col=2;col<8;col++){const x=r.left+r.width*col/9,y=r.top+r.height*row/9,e=document.elementFromPoint(x,y);if(x+${dx}<r.left+8||x+${dx}>r.right-8||y+${dy}<r.top+8||y+${dy}>r.bottom-8)continue;if(e?.classList.contains('react-flow__pane'))return{x,y}}throw Error('No actual canvas background for a bounded drag')})()`)
      const before = await matrix(); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      for (let at = 1; at <= 12; at++) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + dx * at / 12, y: point.y + dy * at / 12, buttons: 1 }); await pause(16) }
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + dx, y: point.y + dy, button: 'left', clickCount: 1 }); await pause(150)
      const after = await matrix(); (result.drags ??= []).push({ start: point, dx, dy, before, after, hit: 'react-flow__pane' }); assert.notEqual(after, before, 'Actual pointer drag changed the camera')
    }
    const pan = () => dragCanvas(-96, 36)
    const revealCanvasControl = async selector => {
      for (let attempt=0;attempt<12;attempt++) {
        const target=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),c=document.querySelector('.collaboration-canvas');if(!e||!c)return null;const r=e.getBoundingClientRect(),v=c.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{visible:x>v.left+24&&x<v.right-24&&y>v.top+24&&y<v.bottom-24,dx:Math.max(-400,Math.min(400,v.left+v.width/2-x)),dy:Math.max(-400,Math.min(400,v.top+v.height/2-y))}})()`)
        assert.ok(target,'Original canvas control exists before a real pan')
        if(target.visible)return
        await dragCanvas(target.dx,target.dy)
      }
      throw Error('Original canvas control remained outside the actual viewport after bounded pointer pans')
    }
    const observeDenseRelations = async () => {
      const beforeBodies = (await facts()).reads.filter(read => read.kind === 'body').length
      for (const subject of result.distribution.denseSubjects) {
        await locate(subject.agentSessionId)
        await until('original participant metadata loaded ' + subject.agentSessionId, async () => (await facts()).reads.some(read => read.kind === 'events' && read.participant === subject.agentSessionId))
        await mapReady()
      }
      assert.equal((await facts()).reads.filter(read => read.kind === 'body').length, beforeBodies, 'Visiting participants reads metadata without opening message bodies')
      const previous = new Set((await read('window.graphCapture.workerSamples()')).flatMap(sample => sample.request ? [sample.request.id] : []))
      await click('[aria-label="Arrange map"]')
      await until('explicit arrangement has its original request', async () => (await read('window.graphCapture.workerSamples()')).some(sample => sample.request?.type === 'arrange' && !previous.has(sample.request.id)))
      const request = (await read('window.graphCapture.workerSamples()')).find(sample => sample.request?.type === 'arrange' && !previous.has(sample.request.id)).request
      await until('that exact explicit arrangement completes', () => read(`window.graphCapture.workerSamples().some(sample=>sample.request?.id===${JSON.stringify(request.id)}&&sample.complete&&sample.input)`))
      const sample = (await read('window.graphCapture.workerSamples()')).find(sample => sample.request?.id === request.id)
      const actual = new Set(sample.input.edges.filter(edge => edge.kind === 'communication').map(edge => JSON.stringify([JSON.parse(edge.source)[1], JSON.parse(edge.target)[1]])))
      assert.equal(result.distribution.denseCommunication.length, 36)
      for (const expected of result.distribution.denseCommunication) assert.ok(actual.has(JSON.stringify([expected.sender, expected.recipient])), 'The actual Worker receives observed cross-area message ' + expected.messageId)
      assert.deepEqual(sample.input.areas.filter(area => result.distribution.emptyAreaNodeIds.includes(area.id) && area.members === 0).map(area => area.id).sort(), result.distribution.emptyAreaNodeIds.slice().sort())
      result.dense = { request, actualWorkerInput: sample.input, expectedCommunication: result.distribution.denseCommunication, visited: result.distribution.denseSubjects, bodyReads: beforeBodies }
      return beforeBodies
    }
    phase = 'load-original-app'; await checkpoint(); await win.loadURL(url); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until('original App initialize', () => read(`window.graphCapture?.ready&&!window.graphCapture.facts().loading&&window.graphCapture.facts().ids.includes('fixture-ui')`))
    await read('window.graphCapture.prepare();window.graphCapture.clearFocusForEntry()'); await until('original mounted workface', () => read(`Boolean(document.querySelector('[data-fixture-session="fixture-ui"] textarea'))`)); await read('window.graphCapture.remember()'); result.before = await facts(); result.entryBefore=result.before; result.distribution=await read('window.graphCapture.distribution()'); assert.deepEqual(result.before.controls, [], 'Initialization does not launch or operate a Run'); assert.equal(result.before.selectedSession,null); assert.equal(result.before.mapTarget,null); assert.ok(result.before.chrome.rail.length&&result.before.chrome.dock.length,'Original Space sidebar preferences are actually visible'); await frame('workbench-entry')
    await check('initial-gui-entry-keeps-accurate-context-and-full-width', async () => {
      await click('button.surface-navigation__focus'); await until('unselected original Focus List', () => read(`window.graphCapture.facts().focusView==='list'&&window.graphCapture.facts().selectedSession===null`)); await frame('unselected-focus-list')
      await click('[aria-label="Map"]'); await mapReady(); await read('window.graphCapture.rememberMap()'); const target=(await facts()).mapTarget; assert.equal(target.kind,'focus'); assert.deepEqual(target.subject,{hostId:'local',agentSessionId:'fixture-ui'},'An exact original Space Agent remains the real default target'); const chrome=await fullMap()
      await until('initial working area is readable', () => read(`document.querySelectorAll('.collaboration-map .focus-context[data-session-id]').length>0`)); const camera=await matrix(), sample=(await read('window.graphCapture.workerSamples()')).filter(sample=>sample.input&&sample.boxes).at(-1)
      const canonical=[...new Set(sample.boxes.ids.map(id=>JSON.parse(id)[1]))].sort(); assert.deepEqual(canonical,result.distribution.expectedInitialAgentKeys.slice().sort()); assert.deepEqual(sample.input.areas.filter(area=>result.distribution.emptyAreaNodeIds.includes(area.id)&&area.members===0).map(area=>area.id).sort(),result.distribution.emptyAreaNodeIds.slice().sort())
      result.initialView={chrome,camera,areas:sample.input.areas.length,emptyAreas:result.distribution.permanentEmptyAreas,canonicalAgents:canonical.length,entryIntent:'GUI List to Map without an explicit Agent argument',listExecutionSelection:null,target}; await intact(); await frame('map-first-context-readable')
      await click('button[aria-label="Space: show terminal and file workbench"]'); await until('original sidebar presentation returned', async () => { const state=await facts(); return state.chrome.rail.length>0&&state.chrome.dock.length>0 }); await intact()
    })
    // The next scenes retain the original exact workface and its independent
    // focus invariant. This seed does not open or replace the retained Map.
    await read('window.graphCapture.prepare();window.graphCapture.remember()'); result.before=await facts()
    await check('source-cli-original-app-admission-and-dom-inspect', async () => {
      const { fork } = require('node:child_process')
      assert.ok(process.env.COLLABORATION_CAPTURE_NODE, 'Original Node executable is required for source CLI')
      const nodeEnv = { ...process.env, AGENTMUX_DESKTOP_MAP_LOADED: path.join(evidence, 'control-loaded.jsonl') }; delete nodeEnv.ELECTRON_RUN_AS_NODE
      controlHost = fork(path.join(__dirname, 'server-host.mjs'), [privateRoot], { execPath: process.env.COLLABORATION_CAPTURE_NODE, execArgv: [], env: nodeEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      result.publicControl = { pid: controlHost.pid, sourceCli: true, originalAdmission: true, steps: [], stderr: '', exitConfirmed: false }
      controlHost.on('error', error => { result.publicControl.startError = error.message }); controlHost.stderr.setEncoding('utf8'); controlHost.stderr.on('data', text => { result.publicControl.stderr += text })
      controlExit = new Promise(resolve => controlHost.once('exit', (code, signal) => { Object.assign(result.publicControl, { exitConfirmed: true, exitCode: code, exitSignal: signal }); resolve() }))
      controlHost.on('message', message => {
        if (message?.kind === 'ready') result.publicControl.ready = true
        else if (message?.kind === 'execute') {
          const input = message.request
          read(`window.graphCapture.publicControl(${JSON.stringify(input)})`).then(result => controlHost.connected && controlHost.send({ kind: 'execute-result', id: input.requestId, result }), error => controlHost.connected && controlHost.send({ kind: 'execute-result', id: input.requestId, error: { message: error.message, code: error.code } }))
        } else if (message?.kind === 'cancel') void read(`window.graphCapture.cancelPublicControl(${JSON.stringify(message.id)})`)
        else if (message?.kind === 'cli-result' && pendingCli) { const receive = pendingCli; pendingCli = undefined; receive(message) }
      })
      await until('private source Core server ready', () => result.publicControl.ready)
      const cli = async step => {
        const outcome = await new Promise((resolve, reject) => { const timeout = setTimeout(() => { pendingCli = undefined; reject(Error('Private source CLI result exceeded its boundary')) }, 12000); pendingCli = message => { clearTimeout(timeout); message.error ? reject(Error(message.error)) : resolve(message.result) }; controlHost.send({ kind: 'run', step }) })
        const output = JSON.parse(outcome.stdout); result.publicControl.steps.push({ step, ...outcome, output }); assert.equal(output.ok, true, outcome.stderr); assert.ok(outcome.code === 0 || outcome.code === 1)
        return output.result
      }
      const map = await cli('map'); await mapReady(); await read('window.graphCapture.rememberMap()'); assert.equal(map.navigation.selection.surface, 'focus'); assert.equal(map.navigation.selection.focusView, 'map'); assert.equal(map.presentation.state, 'main-visible'); assert.equal(map.presentation.tabId, null); assert.equal(map.presentation.regionId, null); assert.notEqual(map.input.outcome, 'preserved', 'Hidden workface input cannot be preserved')
      const inspectedMap = await cli('inspect'); assert.equal(inspectedMap.observation.desktop.selection.focusView, 'map'); assert.equal(inspectedMap.observation.desktop.presentation.state, 'main-visible'); assert.equal(inspectedMap.observation.desktop.presentation.tabId, null); assert.equal(inspectedMap.observation.desktop.presentation.regionId, null); await intact(); await frame('public-cli-map')
      const list = await cli('list'); assert.equal(list.navigation.selection.surface, 'focus'); assert.equal(list.navigation.selection.focusView, 'list'); await until('public original Focus List visible', () => read(`window.graphCapture.facts().mainSurface==='agents'&&window.graphCapture.facts().focusView==='list'&&!window.graphCapture.facts().graph`))
      const inspectedList = await cli('inspect'); assert.equal(inspectedList.observation.desktop.selection.focusView, 'list'); assert.equal(inspectedList.observation.desktop.presentation.state, 'main-visible'); assert.equal(inspectedList.observation.desktop.presentation.regionId, null); await intact(); await frame('public-cli-list')
      const target = { hostId: 'local', agentSessionId: 'fixture-core', presentationSessionId: 'fixture-core', state: 'visible' }
      const agent = await cli('agent'); assert.equal(agent.navigation.selection.focusView, 'list'); assert.equal(agent.navigation.state, 'applied')
      const inspectedAgent = await cli('inspect'); assert.deepEqual(inspectedAgent.observation.desktop.focus.agent, target, 'Public focus-agent joins the exact mounted original Focus card')
      assert.equal((await facts()).selectedSession, 'fixture-core', 'Explicit reveal selects the exact Focus execution context'); await intact(true, false); await frame('public-cli-exact-focus-agent')
      await click(await markByText('[aria-label="Focus Agent reveal"] button', 'End reveal', 'data-capture-public-end-reveal'))
      win.setContentSize(1440,320)
      try {
        await settle(); await click('[aria-label="Search contexts"]'); await win.webContents.debugger.sendCommand('Input.insertText',{text:'fixture-'})
        const retained=await cli('retired'), inspectedRetained=await cli('inspect'); result.retainedNavigation={receipt:retained,observation:inspectedRetained.observation.desktop}; await frame('public-cli-retained-focus-short-window'); assert.equal(retained.navigation.state,'applied'); assert.deepEqual(inspectedRetained.observation.desktop.focus.agent,{...target,agentSessionId:'fixture-retired-0',presentationSessionId:'fixture-retired-0'}); assert.equal((await facts()).selectedSession,'fixture-core','Retired identity never replaces the current execution choice')
        const painted=await read(`(()=>{const card=document.querySelector('[data-focus-agent-selected="true"][data-focus-agent-session="fixture-retired-0"]'),scroll=card.closest('[data-focus-reveal-scroll]'),r=card.getBoundingClientRect(),v=scroll.getBoundingClientRect();return{query:document.querySelector('[aria-label="Search contexts"]').value,searchRows:[...document.querySelectorAll('.global-focus-main[data-agent-reveal] > .focus-search-locations > *')].map(e=>{const b=e.getBoundingClientRect();return{height:b.height,contentHeight:e.scrollHeight,text:e.textContent}}),visible:r.bottom>Math.max(0,v.top)&&r.top<Math.min(innerHeight,v.bottom)&&r.right>v.left&&r.left<v.right,viewport:{top:v.top,bottom:v.bottom,height:v.height},card:{top:r.top,bottom:r.bottom,height:r.height}}})()`)
        assert.equal(painted.visible,true,'Retained card is actually visible inside the short original scrollport'); assert.equal(painted.query,'fixture-'); assert.ok(painted.searchRows.length>0&&painted.searchRows.every(row=>row.height>=row.contentHeight-1),'Short-height reveal keeps original search rows readable in their scrollport'); result.retainedReveal=painted
      } finally {
        win.setContentSize(1440,900); await settle(); await click('[aria-label="Search contexts"]'); await key('a',4); await key('Backspace'); await until('original Focus query cleared by native editing', () => read(`document.querySelector('[aria-label="Search contexts"]').value===''`))
        if(await read(`Boolean(document.querySelector('[aria-label="Focus Agent reveal"]'))`)) await click(await markByText('[aria-label="Focus Agent reveal"] button','End reveal','data-capture-retained-end'))
      }
      const space = await cli('space'); assert.equal(space.navigation.selection.surface, 'space'); assert.equal(space.navigation.selection.focusView, null); await until('public original Space visible', () => read(`window.graphCapture.facts().mainSurface==='workbench'&&!window.graphCapture.facts().graph`))
      const inspectedSpace = await cli('inspect'); assert.equal(inspectedSpace.observation.desktop.selection.focusView, null); assert.equal(inspectedSpace.observation.desktop.presentation.state, 'main-visible'); assert.equal(inspectedSpace.observation.desktop.presentation.regionId, 'region-fixture-ui'); assert.equal((await facts()).publicRequests.length, 10); await intact(true, false); await frame('public-cli-space')
    })
    // The explicit reveal changed Focus selection; ordinary view switches below must preserve it.
    await read('window.graphCapture.remember()'); result.before=await facts()
    await check('focus-list-map-and-original-return', async () => {
      await click('button.surface-navigation__focus'); await until('Focus remembers explicit List', () => read(`window.graphCapture.facts().mainSurface==='agents'&&window.graphCapture.facts().focusView==='list'`)); await frame('focus-entry')
      await click('[aria-label="Map"]'); await mapReady(); await read('window.graphCapture.rememberMap()')
      assert.equal(await read(`document.querySelectorAll('.collaboration-map').length`), 1); assert.equal(await read(`document.querySelectorAll('.collaboration-dialog').length`), 0); await intact(); await frame('map-dark')
      const camera = await matrix()
      await click('[aria-label="List"]'); await until('original Focus List returned', () => read(`window.graphCapture.facts().focusView==='list'&&!window.graphCapture.facts().graph`)); await intact(); await frame('focus-list-return')
      await click('[aria-label="Map"]'); await mapReady(); assert.equal((await facts()).sameMap, true); assert.equal(await matrix(), camera); await intact()
      await click('button[aria-label="Space: show terminal and file workbench"]'); await until('original Space returned', () => read(`window.graphCapture.facts().mainSurface==='workbench'&&!window.graphCapture.facts().graph`)); assert.equal((await facts()).focusView,'map'); await intact(); await frame('workbench-return')
      await click('button.surface-navigation__focus'); await mapReady(); assert.equal((await facts()).sameMap,true); assert.equal(await matrix(),camera)
    })
    if (scenario === 'perception' || scenario === 'perception-scale') {
      await require('./perception.cjs')({ win, result, read, click, key, frame, check, facts, activity, motionFrame, intact, matrix, mapReady, closeReader, locate, pause, until, settle, fullMap, measure, pan, overview, observeDenseRelations, denseOnly: scenario === 'perception-scale' })
      if (scenario === 'perception-scale') await require('./terrain.cjs')({ win, result, read, click, key, move, frame, check, intact, mapReady, closeReader, closeDetails, locate, pause, until, settle, matrix, measure })
      if (scenario === 'perception-scale') await require('./adaptive.cjs')({ win, result, read, click, key, move, frame, check, intact, mapReady, closeDetails, locate, pause, until, matrix, dragCanvas })
      if (scenario === 'perception-scale') await require('./settings.cjs')({ win, result, read, click, key, move, frame, check, intact, closeDetails, locate, pause, until, matrix })
    } else {
    await check('focus-locates-in-the-same-map', async () => {
      await click('[aria-label="List"]'); await until('original Focus Locate entry', () => read(`Boolean(document.querySelector('[aria-label="Locate Agent in map"]'))`)); await frame('focus-locate-entry')
      assert.equal((await facts()).focusAgentReveal,null,'The earlier explicit reveal has ended'); const selected = await read(`[...document.querySelectorAll('.global-focus-surface:not([hidden]) [data-focus-agent-selected="true"]')].map(e=>({hostId:e.dataset.focusAgentHost,agentSessionId:e.dataset.focusAgentSession}))`); assert.deepEqual(selected,[{hostId:'local',agentSessionId:'fixture-ui'}],'The actual original Focus card reflects the retained workface'); await click('[aria-label="Locate Agent in map"]'); await mapReady(); assert.equal((await facts()).sameMap, true); assert.deepEqual((await facts()).mapTarget.subject, selected[0]); await intact()
    })
    await check('map-reveals-exact-focus-agent-without-clearing-filters', async () => {
      await click('[aria-label="List"]'); await until('original Focus filter input', () => read(`Boolean(document.querySelector('.global-focus-surface:not([hidden]) [aria-label="Search contexts"]'))`))
      await click('[aria-label="Search contexts"]'); await key('a',4); await win.webContents.debugger.sendCommand('Input.insertText', { text: 'fixture-unmatched-context' })
      await click('[aria-label="Focus filters"]'); await until('original project filter choices', () => read(`Boolean(document.querySelector('[data-focus-project]:not([data-focus-project="all"])'))`))
      const project = await markByText('[data-focus-project]', 'Independent contributor 12', 'data-capture-project-filter'); await read(`document.querySelector(${JSON.stringify(project)}).scrollIntoView({block:'nearest'})`); await click(project)
      await until('original project selection closes menu', () => read(`!document.querySelector('[data-focus-project]')`))
      await click('[aria-label="Focus filters"]'); await until('original state filter choices', () => read(`Boolean(document.querySelector('[data-focus-state="idle"]'))`)); await click('[data-focus-state="idle"]')
      const filters = await read(`({query:document.querySelector('[aria-label="Search contexts"]').value,summary:document.querySelector('[aria-label="Focus filters"]').getAttribute('aria-description')})`)
      assert.equal(filters.query,'fixture-unmatched-context'); assert.ok(filters.summary.startsWith('Independent contributor 12'))
      await click('[aria-label="Map"]'); await mapReady(); await locate('fixture-core'); await closeReader(); const camera=await matrix()
      await click(await markByText('.collaboration-inspector__actions button','View in Focus','data-capture-view-focus'))
      await until('exact original card revealed', () => read(`Boolean(document.querySelector('.global-focus-surface:not([hidden]) [data-focus-agent-host="local"][data-focus-agent-session="fixture-core"][data-focus-agent-selected="true"][data-focus-card-body="mounted"]'))`))
      const focus = await read(`(()=>{const card=document.querySelector('[data-focus-agent-selected="true"][data-focus-agent-session="fixture-core"]'),rows=card.closest('.focus-project-lanes__rows'),r=card.getBoundingClientRect(),v=rows.getBoundingClientRect();return{host:card.dataset.focusAgentHost,session:card.dataset.focusAgentSession,presentation:card.dataset.focusPresentationSession,visible:r.right>v.left&&r.left<v.right&&r.bottom>v.top&&r.top<v.bottom,query:document.querySelector('[aria-label="Search contexts"]').value,summary:document.querySelector('[aria-label="Focus filters"]').getAttribute('aria-description'),notice:document.querySelector('[aria-label="Focus Agent reveal"]').textContent}})()`)
      assert.equal(focus.visible,true); assert.equal(focus.host,'local'); assert.equal(focus.session,'fixture-core'); assert.equal(focus.presentation,'fixture-core'); assert.equal(focus.query,filters.query); assert.equal(focus.summary,filters.summary); assert.match(focus.notice,/outside current filters/); await intact(); await frame('map-to-focus-filtered-original-agent')
      await click('[aria-label="Map"]'); await mapReady(); assert.equal(await matrix(),camera); await intact(); await frame('map-after-exact-focus-return')
      await click('[aria-label="List"]'); await click(await markByText('[aria-label="Focus Agent reveal"] button','End reveal','data-capture-end-reveal'))
      await until('temporary reveal ends without clearing filters', () => read(`!document.querySelector('[aria-label="Focus Agent reveal"]')&&Boolean(document.querySelector('.focus-project-lanes__clear'))`))
      assert.equal(await read(`document.querySelector('[aria-label="Search contexts"]').value`),filters.query)
      await click('.focus-project-lanes__clear'); await click('[aria-label="Map"]'); await mapReady(); result.focusReveal={filters,focus,camera,returnedCamera:await matrix()}
    })
    await check('space-context-locates-in-retained-focus-map', async () => {
      await click('button[aria-label="Space: show terminal and file workbench"]'); await click('[data-space-tool="agents"]'); await until('original Space context action', () => read(`Boolean(document.querySelector('[aria-label="Locate Space in Focus map"]'))`)); await frame('space-context-entry')
      await click('[aria-label="Locate Space in Focus map"]'); await mapReady(); const current = await facts(); assert.equal(current.mainSurface,'agents'); assert.equal(current.focusView,'map'); assert.equal(current.sameMap,true); assert.equal(current.mapTarget.kind,'focus'); assert.deepEqual(current.mapTarget.subject,{hostId:'local',agentSessionId:'fixture-ui'}); assert.equal(await read(`Boolean(document.querySelector('.collaboration-map [data-surface-tools-toggle]'))`),false); await intact(); await frame('space-context-in-focus-map')
      await click('button[aria-label="Space: show terminal and file workbench"]'); await until('original Space tools preference survives Map', () => read(`Boolean(document.querySelector('[aria-label="Hide Space tools"]'))`)); await click('button.surface-navigation__focus'); await mapReady(); await intact()
    })
    await check('compact-empty-areas-retain-closed-members', async () => {
      const sample = (await read('window.graphCapture.workerSamples()')).filter(sample=>sample.input&&sample.boxes).at(-1), empty = sample.input.areas.filter(area=>result.distribution.emptyAreaNodeIds.includes(area.id)&&area.members===0)
      assert.ok(empty.length>0,'Nonempty original empty-area sample'); const boxes = empty.map(area=>sample.boxes.areas.find(box=>box.id===area.id)); assert.ok(boxes.every(Boolean)); assert.ok(boxes.every(box=>box.height===32),'Actual empty areas use header-only world geometry')
      const closedIds = sample.boxes.ids.filter(id=>JSON.parse(JSON.parse(id)[1])[1].startsWith('fixture-retired-')); assert.equal(closedIds.length,4,'All original closed members retain actual boxes')
      assert.equal(empty.length,60,'Permanent empty areas remain present alongside occupied areas')
      await click('[aria-label="Overview"]'); await pause(350); await until('compact empty areas actually rendered', () => read(`document.querySelectorAll('.collaboration-area[data-empty="true"]').length>0&&document.querySelectorAll('.collaboration-agent--closed .collaboration-agent__point').length>0`))
      const rendered = await read(`[...document.querySelectorAll('.collaboration-area__overview-label[data-empty="true"]')].map(e=>({id:e.dataset.areaId,label:e.querySelector('.collaboration-area__summary')?.getAttribute('aria-label'),foldControls:e.querySelectorAll('[aria-expanded]').length,text:e.textContent}))`)
      assert.ok(rendered.length>0&&rendered.every(area=>boxes.find(box=>box.id===area.id)?.height===32&&area.foldControls===0&&area.label?.endsWith(' · 0 Agents'))); result.emptyAreas={boxes,rendered,closedIds}; await fullMap(); await frame('map-overview-compact-areas'); await locate('fixture-core'); await intact()
    })
    await check('nonempty-native-path-clearance', async () => {
      result.routing = await read(`(()=>{const cards=[...document.querySelectorAll('.collaboration-map [data-collaboration-agent]')].map(e=>({id:e.dataset.collaborationAgent,r:e.getBoundingClientRect()})),paths=[...document.querySelectorAll('.collaboration-map .react-flow__edge-path')],collisions=[];for(const path of paths){const matrix=path.getScreenCTM(),length=path.getTotalLength(),hit=new Set();if(!matrix||!length)continue;for(let at=1;at<100;at++){const p=path.getPointAtLength(length*at/100),point=new DOMPoint(p.x,p.y).matrixTransform(matrix);for(const card of cards){const r=card.r;if(point.x>r.left+3&&point.x<r.right-3&&point.y>r.top+3&&point.y<r.bottom-3)hit.add(card.id)}}for(const card of hit)collisions.push({edge:path.closest('.react-flow__edge')?.dataset.id,card})}return{cards:cards.length,paths:paths.length,collisions}})()`)
      assert.ok(result.routing.cards>=2&&result.routing.paths>=1, 'Actual nonempty geometry'); assert.deepEqual(result.routing.collisions, [])
    })
    await check('shared-reader-hover-pin-keyboard', async () => {
      await locate('fixture-core'); await move('.collaboration-map [data-session-id="fixture-core"]'); await until('original Reader', () => read(`Boolean(document.querySelector('.agent-information-reader'))`)); assert.equal((await facts()).readers, 1); await frame('map-hover')
      await move('.agent-information-reader__reading'); await pause(220); await click('[aria-label="Pin Agent bookmark"]'); await move('[aria-label="Find Agent in map"]'); await pause(250); assert.ok(await read(`Boolean(document.querySelector('[aria-label="Remove Agent bookmark"]'))`)); await frame('map-reader-pinned')
      await click('[aria-label="Agent information: usage, Goals, message relationships and source"]'); await frame('map-reader-details'); await click('[aria-label="Remove Agent bookmark"]'); await closeReader()
      await read(`document.querySelector('.collaboration-map [data-session-id="fixture-core"]').focus()`); await key('ArrowDown'); await until('keyboard enters original Reader', () => read(`Boolean(document.activeElement?.closest('.agent-information-reader'))`)); await frame('map-keyboard-reader'); await key('Escape'); await until('keyboard returns original anchor', () => read(`!document.querySelector('.agent-information-reader')&&document.activeElement?.getAttribute('data-session-id')==='fixture-core'`)); await intact()
    })
    await check('search-keyboard-candidates-and-explicit-location', async () => {
      const camera = await matrix(), workers = (await read('window.graphCapture.workerSamples()')).length, reads = (await facts()).reads.length
      await fillSearch('fixture-no-matching-member')
      await until('meaningful no-match result', () => read(`document.querySelector('.collaboration-map__results [role="status"]')?.textContent==='No matching Agent'&&document.querySelectorAll('[aria-label="Matching Agents"] [role="option"]').length===0`)); await frame('map-search-empty'); assert.equal(await matrix(),camera); assert.equal((await read('window.graphCapture.workerSamples()')).length,workers); assert.equal((await facts()).reads.length,reads)
      await fillSearch('fixture-')
      await until('multiple original candidates', () => read(`document.querySelectorAll('[aria-label="Matching Agents"] [role="option"]').length>1`))
      const selected = () => read(`document.querySelector('[aria-label="Matching Agents"] [aria-selected="true"] small')?.textContent`)
      const first = await selected(); await key('ArrowDown'); assert.notEqual(await selected(),first); await key('ArrowUp'); assert.equal(await selected(),first); await frame('map-search-candidates')
      await key('Escape'); assert.equal(await read(`document.querySelector('[aria-label="Find Agent in map"]').value`),'fixture-'); assert.equal(await read(`document.querySelector('[aria-label="Find Agent in map"]').getAttribute('aria-expanded')`),'false'); assert.equal(await matrix(),camera); assert.equal((await read('window.graphCapture.workerSamples()')).length,workers); assert.equal((await facts()).reads.length,reads)
      await key('ArrowDown'); assert.equal(await selected(),first); await key('Escape')
      // Commit a known original private SID through the real combobox. Candidate
      // labels include Host metadata and are deliberately not parsed as identity.
      await locate('fixture-core'); assert.equal(await read(`document.querySelector('.collaboration-identity code')?.textContent`),'fixture-core'); assert.equal(await read(`document.querySelector('[aria-label="Find Agent in map"]').value`),''); await intact()
    })
    await check('filters-original-body-and-pagination', async () => {
      await locate('fixture-core')
      const before = await matrix(); await click('[aria-label="Filter map relations"]'); await until('original relation menu', () => read(`Boolean(document.querySelector('.collaboration-filter-menu [role="menuitemcheckbox"][data-kind="communication"]'))`)); await frame('map-relation-menu')
      await click('.collaboration-filter-menu [data-kind="communication"]'); assert.equal(await read(`document.querySelector('.collaboration-filter-menu [data-kind="communication"]').getAttribute('aria-checked')`),'false'); await frame('map-filtered'); await click('.collaboration-filter-menu [data-kind="communication"]'); await key('Escape'); await until('filter routes settled', () => read(`!document.querySelector('.collaboration-canvas__progress')`)); assert.equal(await matrix(), before)
      await click('.collaboration-inspector .collaboration-relation[data-kind="communication"]'); await until('original evidence', () => read(`document.querySelectorAll('.collaboration-evidence article').length>0`)); assert.equal((await facts()).reads.filter(read=>read.kind==='body').length, 0); await frame('map-source')
      await click(await markByText('.collaboration-evidence button', 'Read original message', 'data-capture-read-original')); await until('explicit original body rendered', () => read(`Boolean(document.querySelector('.collaboration-evidence .composer-mailbox__detail .log-turn__body'))`)); await frame('map-original-message')
      const body = await read('window.graphCapture.rememberBody()'), bodyReads = (await facts()).reads.filter(read=>read.kind==='body').length
      assert.ok(body.text&&body.selection&&body.messageId,'Nonempty original message and real text selection')
      await click('[aria-label="Map sources"]'); assert.equal(await read(`document.querySelector('[aria-label="Map sources"]').getAttribute('aria-expanded')`),'true'); await frame('map-sources-panel')
      assert.ok(await read(`(()=>{const section=[...document.querySelectorAll('.collaboration-sources section')].find(e=>e.querySelector('strong')?.textContent==='fixture-ui'),button=[...section?.querySelectorAll('button')??[]].find(e=>e.textContent==='Earlier events');if(!button)return false;button.setAttribute('data-capture-earlier','');const owner=button.closest('.collaboration-inspector');if(!owner)return false;owner.scrollBy({top:button.getBoundingClientRect().top-owner.getBoundingClientRect().top-owner.clientHeight/2,behavior:'instant'});return true})()`)); await click('[data-capture-earlier]')
      await until('original backward page requested', async () => (await facts()).reads.some(read=>read.kind==='events'&&read.options?.beforeSequence!==undefined)); await frame('map-earlier-events'); assert.equal((await facts()).reads.filter(read=>read.kind==='body').length,bodyReads,'Hidden original Evidence does not read body')
      await click(await markByText('.collaboration-inspector button','Back to selection','data-capture-back-selection')); await until('original detail resumed', () => read(`document.querySelector('[aria-label="Map sources"]').getAttribute('aria-expanded')==='false'`)); await settle()
      const resumed = await read('window.graphCapture.bodyState()'); assert.equal(resumed.connected,true); assert.equal(resumed.sameBody,true); for(const field of ['text','selection','messageId'])assert.equal(resumed[field],body[field],'Original body '+field)
      result.sourceReading = { before:body, after:resumed, bodyReadsBefore:bodyReads, bodyReadsAfter:(await facts()).reads.filter(read=>read.kind==='body').length, boundary:'Hidden Evidence pauses reads. Returning preserves original DOM/MID/selection and permits the original Reader same-MID revalidation.' }; await frame('map-original-message-return'); await intact()
    })
    await check('folded-original-internal-relations', async () => {
      await locate('fixture-core')
      const heading = '[aria-label="Collapse Agent protocol"]', expanded = '[aria-label="Expand Agent protocol"]'
      await revealCanvasControl(heading); await click(heading); await until('actual internal relation badge', () => read(`Boolean(document.querySelector('.collaboration-area__internal'))`)); await revealCanvasControl('.collaboration-area__internal'); await click('.collaboration-area__internal')
      await until('all original internal relation IDs', () => read(`document.querySelectorAll('[aria-label="Grouped connections"] .collaboration-relation').length===4`))
      result.folded = await read(`({badge:document.querySelector('.collaboration-area__internal').textContent,relations:[...document.querySelectorAll('[aria-label="Grouped connections"] .collaboration-relation')].map(e=>({kind:e.dataset.kind,text:e.textContent})),selfPaths:[...document.querySelectorAll('.react-flow__edge')].filter(e=>{const id=JSON.parse(e.dataset.id);return id[1]===id[2]}).length})`)
      assert.equal(result.folded.selfPaths,0); await frame('map-folded'); await revealCanvasControl(expanded); await click(expanded); await mapReady(); await locate('fixture-core'); await intact()
    })
    await check('finite-live-without-camera-or-layout-reset', async () => {
      const camera = await matrix(), workers = (await read('window.graphCapture.workerSamples()')).length
      await read('window.graphCapture.live(false)'); await pause(150); assert.equal(await read(`document.querySelectorAll('.collaboration-edge__pulse').length`), 0)
      const event = await read('window.graphCapture.live(true)'); await until('actual finite source pulse', () => read(`document.querySelectorAll('.collaboration-edge__pulse').length>0`))
      const early = await motionFrame('map-message-early-live', event, 240), middle = await motionFrame('map-message-middle-live', event, 1300), late = await motionFrame('map-message-late-live', event, 2350)
      for (const sample of [early, middle, late]) { assert.ok(sample.markers.some(marker=>marker.label==='Message sent')); assert.ok(sample.markers.some(marker=>marker.label==='Message received')); assert.ok(sample.paths.some(path=>path.kind==='communication'&&Number(path.opacity)>0),'Actual message ink is visible during its finite phase') }
      const packet = early.packets.find(packet => packet.kind === 'communication' && packet.onscreen && packet.display !== 'none' && Number(packet.opacity) > 0)
      assert.ok(packet, 'A visible directional packet accompanies the original live event')
      const moved = middle.packets.find(candidate => candidate.id === packet.id)
      assert.ok(moved && Math.hypot(moved.x - packet.x, moved.y - packet.y) > 8, 'The same original packet actually moves on screen between timed native frames')
      assert.ok(packet.width >= 6 && packet.width <= 12 && packet.height >= 6 && packet.height <= 12, 'Message packet stays legible at actual screen scale')
      const finalPacket = late.packets.find(candidate => candidate.id === packet.id)
      assert.ok(finalPacket && parseFloat(finalPacket.distance) > parseFloat(moved.distance) && parseFloat(moved.distance) > parseFloat(packet.distance), 'The same packet advances along the original directed path instead of blinking or reversing phase')
      await pause(Math.max(0,event.at+await read('window.graphCapture.activityMS')+80-await read('performance.now()')))
      assert.equal((await activity()).paths.length,0); assert.equal((await activity()).packets.length,0); assert.equal((await activity()).markers.length,0); assert.equal(await matrix(), camera); assert.equal((await read('window.graphCapture.workerSamples()')).length, workers); await intact()
    })
    await check('metadata-reconcile-retains-unrelated-geometry-and-reader', async () => {
      await locate('fixture-core'); await mapReady(); await move('.collaboration-map [data-session-id="fixture-core"]'); await until('original Reader before metadata update', () => read(`Boolean(document.querySelector('.agent-information-reader'))`)); await move('.agent-information-reader__reading'); await click('[aria-label="Pin Agent bookmark"]'); await move('[aria-label="Find Agent in map"]'); await pause(240)
      const before = await read('window.graphCapture.world()'), firstWorker = (await read('window.graphCapture.workerSamples()')).length
      assert.equal(before.reader?.pinned,true)
      try {
        const update = await read('window.graphCapture.reviseSession("fixture-isolated-001")')
        result.stableMetadata = { update, before }
        await until('actual Store consumes updated original Session', async () => (await facts()).metadata.some(session=>session.id===update.id&&session.agentSessionUpdatedAt===update.observedAt&&session.currentActivityRevision===update.currentActivityRevision&&session.activity==='active'))
        await until('original incremental Worker consumes new physical tier', () => read(`window.graphCapture.workerSamples().slice(${firstWorker}).some(sample=>sample.request?.type==='reconcile'&&sample.geometry)`)); await mapReady()
        const after = await read('window.graphCapture.world()'), changed = before.geometry.find(box=>box.kind==='agent'&&JSON.parse(JSON.parse(box.id)[1])[1]===update.id)
        assert.ok(changed,'The changed original member had actual initial world geometry')
        const updated = after.geometry.find(box=>box.id===changed.id)
        assert.ok(updated&&[updated.width,updated.height].some((size,index)=>size!==[changed.width,changed.height][index]),'The actual original member changes its physical idle/active tier')
        const unrelated = boxes => boxes.filter(box=>box.areaId!==changed.areaId).map(({id,x,y,width,height})=>({id,x,y,width,height})).sort((a,b)=>a.id.localeCompare(b.id))
        assert.deepEqual(unrelated(after.geometry),unrelated(before.geometry),'Metadata and physical tier changes keep every unrelated absolute Worker box')
        const unchanged = new Set(unrelated(before.geometry).map(box=>box.id)), painted = nodes => nodes.filter(node=>unchanged.has(node.id)).sort((a,b)=>a.id.localeCompare(b.id))
        assert.deepEqual(painted(after.nodes),painted(before.nodes),'Actual unrelated DOM transforms and screen rectangles remain fixed'); assert.equal(after.camera,before.camera); assert.deepEqual(after.reader,before.reader,'The held sole Reader stays at its original reading anchor')
        result.stableMetadata = { update, before, after, workers:(await read('window.graphCapture.workerSamples()')).slice(firstWorker), boundary:'Original Core-shaped Session notification through App/Store; real Worker absolute boxes and DOM rectangles, no private xyflow state substitution.' }; await frame('map-stable-metadata-reader')
      } finally {
        if (await read(`Boolean(document.querySelector('[aria-label="Remove Agent bookmark"]'))`)) await click('[aria-label="Remove Agent bookmark"]')
        await closeReader()
      }
      await intact()
    })
    await check('overview-live-needs-no-history-or-body-read', async () => {
      await overview('map-before-overview-activity'); await pause(300)
      const regionsBefore=await regionSnapshot()
      assert.ok(regionsBefore.length>0&&regionsBefore.every(region=>region.activity&&region.activity.bounds.width>0),'Every original region reserves its physical activity slot at rest')
      const before = (await facts()).reads.length, camera = await matrix(), event = await read('window.graphCapture.live(true)')
      const observed = await motionFrame('map-overview-message-live',event,350)
      const regionsDuring=await regionSnapshot(); assertStableRegions(regionsBefore,regionsDuring)
      assert.ok(regionsDuring.some(region=>region.activity.visibility==='visible'&&region.activity.display!=='none'&&region.activity.label==='Recent message activity'),'The original event visibly uses the reserved region activity slot')
      assert.ok(observed.markers.some(marker=>marker.label==='Message sent'&&marker.onscreen)); assert.ok(observed.markers.some(marker=>marker.label==='Message received'&&marker.onscreen)); assert.ok(observed.paths.some(path=>path.kind==='communication'&&Number(path.opacity)>0))
      assert.equal((await facts()).reads.length,before,'Existing overview activity observes the event without any catalogue, identity, history or body read'); assert.equal(await matrix(),camera)
      result.overviewActivity = { event, observed, readsBefore:before, readsAfter:(await facts()).reads.length }
      await pause(Math.max(0,event.at+await read('window.graphCapture.activityMS')+60-await read('performance.now()'))); assert.equal((await activity()).markers.length,0)
      const regionsAfter=await regionSnapshot(); assertStableRegions(regionsBefore,regionsAfter)
      assert.ok(regionsAfter.every(region=>region.activity.visibility==='hidden'),'Expired activity leaves the reserved slot without changing region identity')
      result.regionActivity={before:regionsBefore,during:regionsDuring,after:regionsAfter}; await frame('map-overview-activity-expired')
      const tooltipReads=(await facts()).reads.length; await showRelationTooltip('map-overview-relation-tooltip'); assert.equal((await facts()).reads.length,tooltipReads,'Overview relation reading uses existing facts without additional source reads')
      await move('[aria-label="Find Agent in map"]')
    })
    await check('late-original-route-keeps-the-original-activity-phase', async () => {
      await locate('fixture-core'); await mapReady(); await closeReader()
      // Keep the explicit Core selection as the original metadata demand, and use
      // the real Overview action so both exact subjects are painted before input.
      await click('[aria-label="Overview"]'); await mapReady()
      const endpointRects = () => read(`(()=>{const world=window.graphCapture.world(),canvas=document.querySelector('.collaboration-canvas').getBoundingClientRect();return['fixture-core','fixture-design'].map(id=>{for(const node of document.querySelectorAll('[data-collaboration-agent]')){if(node.dataset.collaborationAgent!==JSON.stringify(['local',id]))continue;const button=node.querySelector('.collaboration-agent__dot');if(!button)continue;const r=button.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,onscreen=r.width>0&&r.height>0&&x>canvas.left&&x<canvas.right&&y>canvas.top&&y<canvas.bottom,hit=button.contains(document.elementFromPoint(x,y));if(onscreen&&hit)return{id,box:world.geometry.find(box=>box.id===node.closest('.react-flow__node').dataset.id),painted:{x:r.x,y:r.y,width:r.width,height:r.height},onscreen,hit}}return{id,onscreen:false}})})()`)
      await until('both original delayed-route endpoints are actually visible and actionable',async()=>{const endpoints=await endpointRects();return endpoints.length===2&&endpoints.every(endpoint=>endpoint.onscreen&&endpoint.hit&&endpoint.box)})
      assert.equal(await read(`document.querySelector('.collaboration-inspector .collaboration-identity code')?.textContent`),'fixture-core','The exact original selected source still owns metadata demand')
      const camera = await matrix(); result.delayedRouteSetup={camera,endpoints:await endpointRects()}
      await read('window.graphCapture.delayRoutes(1200)')
      try {
        const event = await read('window.graphCapture.live(true,"fixture-core","fixture-design")'), first = await motionFrame('map-delayed-route-endpoints-live',event,280)
        result.delayedRoute={event,first}
        assert.ok(first.markers.some(marker=>marker.subject===JSON.stringify(['local','fixture-core'])&&marker.label==='Message sent')); assert.ok(first.markers.some(marker=>marker.subject===JSON.stringify(['local','fixture-design'])&&marker.label==='Message received'))
        const incoming = sample => sample.paths.find(path=>{const id=JSON.parse(path.id);return id[0]==='communication'&&JSON.parse(JSON.parse(id[1])[1])[1]==='fixture-core'&&JSON.parse(JSON.parse(id[2])[1])[1]==='fixture-design'})
        assert.equal(incoming(first),undefined,'The original delayed path is not invented before Worker delivery')
        await until('original delayed route delivered during remaining activity', async () => Boolean(incoming(await activity())))
        const routed = await motionFrame('map-delayed-route-remaining-live',event,1750), pulse = incoming(routed)
        assert.ok(pulse&&pulse.delay<=-1000&&pulse.progress>.3,'A late-mounted original path starts at its original remaining phase')
        await pause(Math.max(0,event.at+await read('window.graphCapture.activityMS')+80-await read('performance.now()'))); assert.equal((await activity()).paths.length,0); assert.equal((await activity()).markers.length,0)
        assert.equal(await matrix(),camera); result.delayedRoute={event,first,routed,workers:(await read('window.graphCapture.workerSamples()')).filter(sample=>sample.request?.delayMS>0)}
      } finally { await read('window.graphCapture.delayRoutes(0)') }
      await read('window.graphCapture.delayRoutes(3600,"fixture-design","fixture-core")')
      try {
        const before = (await read('window.graphCapture.workerSamples()')).length, event = await read('window.graphCapture.live(true,"fixture-design","fixture-core")')
        await motionFrame('map-expiring-before-route-live',event,300)
        await until('the late original route completes after expiry',()=>read(`window.graphCapture.workerSamples().slice(${before}).some(sample=>sample.request?.type==='route'&&sample.complete)`))
        const observed = await activity(); assert.ok(observed.at-event.at>=await read('window.graphCapture.activityMS')); assert.equal(observed.paths.length,0,'An expired event cannot replay when the original route finally arrives'); assert.equal(observed.markers.length,0); result.expiredRoute={event,observed}; await frame('map-expired-route-no-replay')
      } finally { await read('window.graphCapture.delayRoutes(0)') }
      await intact()
    })
    await check('relation-legend-native-pointer-and-keyboard', async () => {
      await locate('fixture-core'); await closeReader(); const legend = await read(`document.querySelector('[aria-label="Relation legend"]')?.textContent`)
      for(const label of ['Messages','Created','Dispatch'])assert.ok(legend.includes(label),'Persistent legend names '+label)
      const relations = await read(`[...document.querySelectorAll('.collaboration-map .react-flow__edge')].map(edge=>({id:edge.dataset.id,label:edge.getAttribute('aria-label'),role:edge.getAttribute('role'),tabIndex:edge.tabIndex,title:edge.querySelector('title')?.textContent,marker:edge.querySelector('.react-flow__edge-path')?.getAttribute('marker-end')}))`)
      assert.ok(relations.some(edge=>JSON.parse(edge.id)[0]==='communication')); assert.ok(relations.every(edge=>edge.role==='button'&&edge.tabIndex===0&&!edge.title&&edge.marker))
      const hover=await showRelationTooltip('map-relation-pointer-label'), pointer=hover.pointer
      assert.ok(pointer.parallel>1,'The actual exposed short relation has parallel original connections')
      assert.ok(hover.sample.label.length>40&&hover.sample.panel.bounds.width>hover.sample.anchor.bounds.width,'A complete original sentence is readable beyond its short SVG path')
      await read(`document.querySelector('[data-capture-semantic-edge]').focus()`); await until('actual semantic edge owns keyboard focus',()=>read(`document.activeElement===document.querySelector('[data-capture-semantic-edge]')`))
      const focused=await relationTooltip(); assertReadableRelationTooltip(focused); await frame('map-relation-keyboard-label')
      const [,source,target]=JSON.parse(pointer.id), sender=JSON.parse(JSON.parse(source)[1])[1], recipient=JSON.parse(JSON.parse(target)[1])[1]
      assert.equal(JSON.parse(pointer.id)[0],'communication','The observed original tooltip path is the real message path')
      const event=await read(`window.graphCapture.live(true,${JSON.stringify(sender)},${JSON.stringify(recipient)})`)
      await pause(Math.max(0,event.at+300-await read('performance.now()'))); const movingBefore=await relationTooltip(); assertReadableRelationTooltip(movingBefore); await frame('map-relation-tooltip-live',{motion:true})
      await pause(Math.max(0,event.at+1150-await read('performance.now()'))); const movingAfter=await relationTooltip(); assertReadableRelationTooltip(movingAfter)
      assert.ok(movingBefore.packets.length>0&&movingAfter.packets.length>0,'The held original relation has a real live packet')
      assert.ok(Math.hypot(movingAfter.packets[0].x-movingBefore.packets[0].x,movingAfter.packets[0].y-movingBefore.packets[0].y)>4,'The original packet moves while relation reading is held')
      assert.deepEqual(movingAfter.anchor,movingBefore.anchor,'The tooltip anchor stays on the stable BaseEdge instead of moving packet geometry')
      assert.deepEqual(movingAfter.panel.bounds,movingBefore.panel.bounds,'Original relation reading does not drift with the packet')
      const wheelBefore=await relationTooltip(), pivot=await read(`(()=>{const r=document.querySelector('.collaboration-map .react-flow__renderer').getBoundingClientRect();return{x:Math.min(r.right-24,${pointer.x}+96),y:Math.min(r.bottom-24,${pointer.y}+64)}})()`)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...pivot,deltaX:0,deltaY:100})
      await until('real wheel changes the original camera',async()=>await matrix()!==wheelBefore.camera)
      await until('original wheel camera settled',async()=>{const before=await matrix();await pause(60);return await matrix()===before}); await settle()
      const wheelAfter=await relationTooltip(); assertReadableRelationTooltip(wheelAfter)
      assert.notDeepEqual(wheelAfter.anchor.matrix,wheelBefore.anchor.matrix,'The same original path receives the actual camera transform')
      assert.ok(Math.hypot(wheelAfter.panel.bounds.x-wheelBefore.panel.bounds.x,wheelAfter.panel.bounds.y-wheelBefore.panel.bounds.y)>1,'The visible window tooltip follows its transformed original path')
      await frame('map-relation-wheel-tooltip')
      await pan(); const afterPan=await relationTooltip()
      if(afterPan?.focused)assertReadableRelationTooltip(afterPan); else assert.ok(!afterPan?.panel,'A relation tooltip releases when native panning moves keyboard focus away')
      await read(`document.querySelector('[data-capture-semantic-edge]').focus()`); await until('relation tooltip after original pointer pan',async()=>Boolean((await relationTooltip())?.panel)); const panned=await relationTooltip(); assertReadableRelationTooltip(panned); await frame('map-relation-panned-tooltip')
      await key('Enter'); await until('keyboard opens original relation',()=>read(`document.querySelectorAll('.collaboration-endpoints button').length===2&&document.querySelector('.collaboration-inspector__eyebrow')?.textContent==='Relation'`)); await frame('map-relation-keyboard-details')
      await click('[aria-label="Find Agent in map"]'); await until('selected relation has no persistent reading overlay',()=>read(`!document.querySelector('[data-capture-semantic-edge]')?.getAttribute('aria-describedby')`)); assert.equal(await read(`document.querySelectorAll('.collaboration-edge__label').length`),0,'Selected relations do not keep full sentences behind cards')
      result.edgeSemantics={legend,relations,pointer,focused,movingBefore,movingAfter,wheel:{before:wheelBefore,after:wheelAfter,pivot},afterPan,panned}; await key('Escape'); await closeReader(); await intact()
    })
    await check('reduced-motion-retains-truthful-finite-endpoint-activity', async () => {
      await locate('fixture-core'); await closeReader(); await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
      try {
        const event = await read('window.graphCapture.live(true)'), observed = await motionFrame('map-reduced-motion-message-live',event,300)
        assert.equal(observed.reducedMotion,true); assert.ok(observed.markers.length>=2&&observed.markers.every(marker=>marker.animationName==='none'&&marker.display!=='none'&&Number(marker.opacity)>0),'Reduced motion keeps visible static endpoint feedback'); assert.ok(observed.paths.every(path=>path.display==='none'),'Reduced motion suppresses moving path ink'); assert.ok(observed.packets.every(packet=>packet.display==='none'),'Reduced motion suppresses moving packets while original static endpoint feedback remains')
        await pause(Math.max(0,event.at+await read('window.graphCapture.activityMS')+80-await read('performance.now()'))); assert.equal((await activity()).markers.length,0); result.reducedMotion={event,observed}
      } finally { await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]}) }
      await intact()
    })
    await check('local-source-failure-and-explicit-retry', async () => {
      await click('[aria-label="Map sources"]')
      const before = (await facts()).census.nodes; await read('window.graphCapture.fail(true)'); await click('[aria-label="Refresh graph sources"]'); await until('one original source failure', () => read(`document.querySelector('.collaboration-sources')?.textContent.includes('temporarily unavailable')`)); assert.equal(await read(`document.querySelector('[aria-label="Map sources"]').dataset.issue`),'true'); assert.ok((await facts()).census.nodes>=before); await frame('map-local-source-error'); await intact()
      await read('window.graphCapture.fail(false)'); await click('[aria-label="Refresh graph sources"]'); await until('explicit recovery', () => read(`!document.querySelector('.collaboration-sources')?.textContent.includes('temporarily unavailable')`)); await frame('map-source-recovered')
    })
    await check('dark-light-narrow-original-reader', async () => {
      await click('[aria-label="Close map details"]'); await read('window.graphCapture.appearance("light")'); await until('actual light appearance', () => read(`document.documentElement.dataset.appearance==='light'`)); await frame('map-light'); await showRelationTooltip('map-light-relation-tooltip'); await move('[aria-label="Find Agent in map"]'); const lightEvent=await read('window.graphCapture.live(true)'); await motionFrame('map-light-message-live',lightEvent,400); await read('window.graphCapture.appearance("dark")')
      win.setContentSize(390,844); try { await settle(); await frame('map-narrow'); await locate('fixture-core'); await showRelationTooltip('map-narrow-relation-tooltip'); await move('[aria-label="Find Agent in map"]'); const narrowEvent=await read('window.graphCapture.live(true)'); await motionFrame('map-narrow-message-live',narrowEvent,400); await move('.collaboration-map [data-session-id="fixture-core"]'); await until('narrow Reader', () => read(`Boolean(document.querySelector('.agent-information-reader'))`)); await frame('map-narrow-reader'); await closeReader() } finally { win.setContentSize(1440,900); await settle() }
      await intact()
    })
    await check('inactive-map-keeps-owner-and-does-no-reading', async () => {
      const tooltip=await showRelationTooltip('map-before-inactive-relation-tooltip')
      await click('[aria-label="List"]'); await until('Map is retained but inactive', () => read(`!window.graphCapture.facts().graph&&window.graphCapture.facts().sameMap`)); const count = async () => (await facts()).reads.filter(read=>read.kind==='events'||read.kind==='spawns').length
      await until('hidden retained Map releases its window tooltip',()=>read(`!document.getElementById(${JSON.stringify(tooltip.sample.panel.id)})`))
      const before = await count(); await read('window.graphCapture.live(true)'); await pause(200); assert.equal(await count(),before); assert.equal((await activity()).markers.length,0); assert.equal((await activity()).paths.length,0); result.inactive = { before, after: await count(),tooltip:tooltip.sample }; await intact(); await click('[aria-label="Map"]'); await mapReady(); assert.equal((await facts()).sameMap,true); assert.equal((await activity()).markers.length,0,'Showing retained Map does not replay hidden traffic'); assert.equal((await activity()).paths.length,0); assert.equal(await read(`Boolean(document.getElementById(${JSON.stringify(tooltip.sample.panel.id)}))`),false,'Showing retained Map does not replay the departed tooltip')
    })
    await check('open-workface-is-a-separate-original-action', async () => {
      await locate('fixture-core'); await move('.collaboration-map [data-session-id="fixture-core"]'); await until('Reader for original Open', () => read(`Boolean(document.querySelector('.agent-information-reader'))`)); await click('[aria-label="Open Agent"]'); await until('original workface opened', () => read(`!window.graphCapture.facts().graph&&Boolean(document.querySelector('[data-fixture-session="fixture-core"]'))`)); assert.equal((await facts()).selectedSession,'fixture-core'); assert.equal((await facts()).draft,'Original unsent reply · retain this exact draft.'); await frame('opened-original-workface')
      assert.equal((await facts()).mainSurface,'workbench'); assert.equal((await facts()).focusView,'map'); await click('button.surface-navigation__focus'); await mapReady(); await read('window.graphCapture.remember()')
    })
    await check('observed-dense-cross-area-overview-and-exact-reading', async () => {
      const beforeBodies = await observeDenseRelations()
      await overview('map-dense-observed-overview')
      // The name and count are rendered by the original area owner. Select that
      // exact public canvas action, rather than guessing a member from its label.
      const summary=await read(`(()=>{const e=[...document.querySelectorAll('.collaboration-area__summary')].find(e=>e.getAttribute('aria-label')?.startsWith('Locate Agent protocol · '));if(!e)return null;e.setAttribute('data-capture-dense-area','');return{label:e.getAttribute('aria-label')}})()`)
      assert.ok(summary)
      const point = await read(`(()=>{const label=document.querySelector('[data-capture-dense-area]').getBoundingClientRect(),candidates=[...document.querySelectorAll('.collaboration-agent[data-overview="true"] .collaboration-agent__point')].map(e=>{const r=e.getBoundingClientRect(),button=e.closest('button'),agent=e.closest('[data-collaboration-agent]');return{element:e,button,agent,x:r.left+r.width/2,y:r.top+r.height/2,distance:Math.hypot(r.left+r.width/2-label.left-label.width/2,r.top+r.height/2-label.top-label.height/2)}}).filter(item=>item.button&&item.agent&&item.x>0&&item.y>44&&item.x<innerWidth&&item.y<innerHeight-24).sort((a,b)=>a.distance-b.distance),nearest=candidates[0];if(!nearest)return null;nearest.button.setAttribute('data-capture-nearby-point','');return{agentId:nearest.agent.dataset.collaborationAgent,distance:nearest.distance,hit:nearest.button.contains(document.elementFromPoint(nearest.x,nearest.y))}})()`)
      assert.ok(point?.hit,'The original Agent point nearest the region title remains actionable'); await click('[data-capture-nearby-point]'); await until('nearby original point selects exact Agent', () => read(`document.querySelector('.collaboration-identity code')?.textContent===${JSON.stringify(JSON.parse(point.agentId)[1])}`)); await frame('map-overview-point-selected'); await closeReader(); await click('[aria-label="Close map details"]'); await settle()
      result.overviewTargets={summary,point}; await click('[data-capture-dense-area]'); await until('actual region activation enters readable detail', () => read(`document.querySelectorAll('.collaboration-agent:not([data-overview="true"])').length>0`)); await frame('map-dense-region-detail')
      const subject=result.distribution.denseSubjects[0]; await locate(subject.agentSessionId); await until('original active card at exact target', () => read(`Boolean(document.querySelector('.collaboration-map .focus-context[data-session-id="${subject.agentSessionId}"]'))`)); await frame('map-dense-exact-agent')
      await click('.collaboration-inspector .collaboration-relation[data-kind="communication"]'); await until('original dense message evidence', () => read(`document.querySelectorAll('.collaboration-evidence article').length>0`)); assert.equal((await facts()).reads.filter(read=>read.kind==='body').length,beforeBodies); await frame('map-dense-original-relation'); await intact()
    })
    await check('native-product-scale-and-viewport-consumption', async () => {
      for (const size of [240,480]) {
        await measure('grow-'+size, async () => { result['growth'+size]=await read(`window.graphCapture.grow(${size})`); await until('original snapshot membership '+size, () => read(`window.graphCapture.facts().ids.length===${size-4}`)); await until('full original Map world '+size, () => read(`document.querySelector('[aria-label="Map sources"]')?.title.includes('${size} Agents')`)); await until('all mixed world boxes '+size, () => read(`window.graphCapture.workerSamples().some(sample=>sample.input?.nodes>=${size}&&sample.boxes?.agents===sample.input.nodes)`)); await until('finite native layout '+size, () => read(`!document.querySelector('.collaboration-canvas__progress')`)); await pause(350) })
        const workers = await read('window.graphCapture.workerSamples()'), sample = workers.filter(sample=>sample.input?.nodes>=size&&sample.boxes?.agents===sample.input.nodes).at(-1)
        assert.ok(sample&&Object.keys(sample.input.sizes).length>=3,'Actual Worker places mixed sizes, including isolated/closed members'); const expected=result['growth'+size].expectedAgentKeys.slice().sort(), canonical=ids=>[...new Set(ids.map(id=>JSON.parse(id)[1]))].sort(); assert.deepEqual(canonical(sample.input.ids),expected,'Every original identity enters the real Worker'); assert.deepEqual(canonical(sample.boxes.ids),expected,'Every original identity receives actual world geometry'); result['world'+size]=sample
        assert.deepEqual(sample.input.areas.filter(area=>result.distribution.emptyAreaNodeIds.includes(area.id)&&area.members===0).map(area=>area.id).sort(),result.distribution.emptyAreaNodeIds.slice().sort()); await overview('map-world-overview-'+size)
        const routing = await read(`(()=>{const samples=window.graphCapture.workerSamples(),geometryIndex=samples.findLastIndex(sample=>sample.input?.nodes>=${size}),input=samples[geometryIndex].input,expected=[...new Set([...input.edges.map(edge=>edge.id),...samples.slice(geometryIndex).flatMap(sample=>sample.request?.connectionIds??[])])],painted=[...document.querySelectorAll('.collaboration-map .react-flow__edge')].map(edge=>edge.dataset.id),missing=expected.filter(id=>!painted.includes(id)),errors=samples.flatMap(sample=>(sample.errors??[]).map(error=>({...error,request:sample.request}))).filter(error=>expected.includes(error.connectionId));return{geometryRequest:samples[geometryIndex].request,expectedConnectionIds:expected,paintedConnectionIds:painted,missingConnectionIds:missing,originalErrors:errors,diagnostics:[...document.querySelectorAll('.collaboration-canvas__issue')].map(element=>element.textContent),boundary:'Same original native scale scene; exact original Worker error receipts and real Overview DOM. Earlier errors remain historical; only currently missing original IDs describe current absent ink.'}})()`)
        ;(result.scaleRouting ??= {})[size] = routing
        if (size === 480) {
          const fresh = await read(`(()=>{for(const button of document.querySelectorAll('.collaboration-agent__dot:not([data-session-id])')){const node=button.closest('[data-collaboration-agent]'),subject=JSON.parse(node.dataset.collaborationAgent),r=button.getBoundingClientRect();if(!subject[1].startsWith('fixture-isolated-')||r.left<8||r.top<44||r.right>innerWidth-8||r.bottom>innerHeight-44||!button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))continue;button.setAttribute('data-capture-fresh-point','');return{hostId:subject[0],agentSessionId:subject[1]}}throw Error('No original unread overview point is actionable')})()`)
          const before = (await facts()).reads.length
          await move('[data-capture-fresh-point]')
          await until('original unread point becomes a real Reader', () => read(`(()=>{const button=document.querySelector('.collaboration-map [data-session-id="${fresh.agentSessionId}"]'),reader=document.getElementById(button?.getAttribute('aria-describedby'));return Boolean(reader?.classList.contains('agent-information-reader'))})()`))
          result.freshOverviewHover = { subject: fresh, reads: (await facts()).reads.slice(before) }
          assert.ok(result.freshOverviewHover.reads.some(item=>item.kind==='conversation'&&item.participant===fresh.agentSessionId),'Actual original Reader reads the newly hovered exact subject')
          await frame('map-fresh-overview-reader'); await move('[aria-label="Overview"]'); await until('fresh transient Reader leaves', () => read(`!document.querySelector('.agent-information-reader:not([data-pinned])')`))
        }
        await locate('fixture-core'); await measure('idle-'+size, () => pause(500)); await measure('pan-'+size, pan)
        const arranged = (await read('window.graphCapture.workerSamples()')).filter(sample=>sample.input).length
        await measure('zoom-'+size, async () => { for(let at=0;at<4;at++){await click('[aria-label="Zoom out"]');await pause(90)}await pause(250) }); assert.equal((await read('window.graphCapture.workerSamples()')).filter(sample=>sample.input).length,arranged,'Zoom does not change original world box sizes'); assert.equal((await facts()).census.fullCards,0)
        await measure('locate-isolated-'+size, async () => { await locate('fixture-isolated-'+String(size-9).padStart(3,'0')); await pause(350) }); await frame('map-scale-'+size)
        const measurements=result.performance.filter(sample=>sample.label.endsWith('-'+size)); assert.ok(measurements.length>=5); assert.ok(measurements.every(sample=>sample.frameCount>=8),'Nonempty native frame sampling'); assert.ok(measurements.filter(sample=>!sample.label.startsWith('grow-')).every(sample=>sample.builtContextIds.length<128),'Actual context work follows visible demand'); assert.ok((await facts()).census.fullCards<128); assert.equal((await facts()).sameMap,true); assert.deepEqual((await facts()).controls,result.before.controls)
      }
      await click('button[aria-label="Space: show terminal and file workbench"]'); await until('original workface after isolated Map locate', () => read(`window.graphCapture.facts().mainSurface==='workbench'`)); const returned=await facts(); assert.equal(returned.focusView,'map'); assert.equal(returned.selectionPreserved,true); assert.equal(returned.selectedSession,'fixture-core'); assert.equal(returned.storedDraft,'Original unsent reply · retain this exact draft.'); await frame('workbench-after-scale')
    })
    await check('retained-resource-association-keeps-original-project-and-no-workface-authority', async () => {
      await click('button.surface-navigation__focus'); await mapReady(); await locate('fixture-retired-0'); await closeReader()
      await until('original retained project association is disclosed', () => read(`document.querySelector('[aria-label="Area affiliation"]')?.textContent.includes('Workspace association')`))
      const affiliation = await read(`({basis:document.querySelector('[aria-label="Area affiliation"]').textContent,actions:document.querySelector('.collaboration-inspector__actions')?.textContent,world:window.graphCapture.world()})`)
      const subject = JSON.stringify(['local','fixture-retired-0']), box = affiliation.world.geometry.find(box=>box.kind==='agent'&&JSON.parse(box.id)[1]===subject)
      assert.ok(box, 'Retained original subject has real map geometry'); assert.equal(box.areaId,result.distribution.projectAreaNodeId)
      assert.ok(affiliation.world.geometry.some(area=>area.kind==='area'&&area.id===box.areaId),'The retained occurrence belongs to its actual original project area node')
      assert.ok(affiliation.basis.includes('Agent protocol')&&!affiliation.basis.includes('Display binding'))
      assert.ok(!affiliation.actions?.includes('Open workface'), 'Resource association cannot invent a live original workface')
      result.retainedAffiliation={subject,box,basis:affiliation.basis}; await frame('map-retained-project-association'); await locate('fixture-core'); await intact()
    })
    await check('exact-related-reference-enriches-without-moving-established-world', async () => {
      await click('button.surface-navigation__focus'); await mapReady(); await locate('fixture-core'); await mapReady(); await closeReader(); const before = await read('window.graphCapture.world()'), bodyReads = (await facts()).reads.filter(read=>read.kind==='body').length
      await read('window.graphCapture.live(false,"fixture-core","fixture-relationship-only")')
      await until('the original relation-only endpoint reaches actual Map geometry',()=>read(`window.graphCapture.workerSamples().some(sample=>sample.geometry?.some(box=>box.kind==='agent'&&JSON.parse(JSON.parse(box.id)[1])[1]==='fixture-relationship-only'))`)); await mapReady()
      const discovered = await read('window.graphCapture.world()'), originalIds = new Set(before.geometry.map(box=>box.id)), original = boxes=>boxes.filter(box=>originalIds.has(box.id)).map(({id,x,y,width,height})=>({id,x,y,width,height})).sort((a,b)=>a.id.localeCompare(b.id))
      assert.deepEqual(original(discovered.geometry),original(before.geometry),'A newly discovered reference retains every established original absolute box'); assert.equal(discovered.camera,before.camera)
      await locate('fixture-relationship-only'); await until('exact original metadata and Provider are disclosed',()=>read(`document.querySelector('.collaboration-inspector dl.collaboration-identity')?.textContent.includes('claude')`)); await mapReady()
      const retainedPoint = () => read(`(()=>{const world=window.graphCapture.world(),box=world.geometry.find(box=>box.kind==='agent'&&JSON.parse(JSON.parse(box.id)[1])[1]==='fixture-relationship-only');if(!box)return null;const node=[...document.querySelectorAll('.collaboration-map .react-flow__node')].find(node=>node.dataset.id===box.id),mark=node?.querySelector('.collaboration-agent__mark[data-tier="closed"]');if(!mark)return null;const r=mark.getBoundingClientRect(),origin=document.querySelector('.collaboration-map .react-flow__renderer').getBoundingClientRect(),matrix=new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.collaboration-map .react-flow__viewport')).transform),zoom=matrix.a;return{box,painted:{x:(r.x-origin.x-matrix.e)/zoom,y:(r.y-origin.y-matrix.f)/zoom,width:r.width/zoom,height:r.height/zoom},world}})()`)
      await until('retired original point geometry and real DOM converge',async()=>{const point=await retainedPoint();return point&&point.box.width===24&&point.box.height===24&&['x','y','width','height'].every(key=>Math.abs(point.painted[key]-point.box[key])<.1)})
      const settledPoint = await retainedPoint()
      const metadata = await read(`({identity:document.querySelector('.collaboration-inspector .collaboration-identity')?.textContent,metadata:document.querySelector('.collaboration-inspector dl.collaboration-identity')?.textContent,actions:document.querySelector('.collaboration-inspector__actions')?.textContent,affiliation:document.querySelector('[aria-label="Area affiliation"]')?.textContent,details:document.querySelector('.collaboration-inspector')?.textContent})`)
      assert.ok(metadata.identity.includes('fixture-relationship-only')); assert.ok(metadata.metadata.includes('claude')); assert.ok(metadata.affiliation?.includes('Workspace association')&&metadata.affiliation.includes('Agent protocol'),'Exact retained workspace evidence is disclosed as an association'); assert.equal(settledPoint.box.areaId,result.distribution.projectAreaNodeId,'Confirmed original project evidence reaches actual Map geometry'); assert.ok(settledPoint.world.geometry.some(area=>area.kind==='area'&&area.id===settledPoint.box.areaId),'The enriched occurrence belongs to its actual original project area node'); assert.ok(!metadata.actions.includes('Open workface'),'Retained metadata does not invent an active control target'); assert.equal((await facts()).reads.filter(read=>read.kind==='body').length,bodyReads)
      const identityReads = (await facts()).reads.filter(read=>read.kind==='identity'&&read.participant==='fixture-relationship-only'); assert.ok(identityReads.length>0&&identityReads.every(read=>read.options.hostId==='local'),'Original exact-owner bridge is consumed by the real Map'); result.relatedIdentity={before,discovered,metadata,identityReads,settledPoint}; await frame('map-related-original-identity'); await intact()
    })
    }
    phase = 'native-visibility-capability'; await checkpoint()
    const visibility = new BrowserWindow({ width:160,height:120,x:-10000,y:-10000,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:true} })
    try {
      await visibility.loadURL('data:text/html,<title>Private visibility capability probe</title>'); const samples=[]
      for(const action of ['showInactive','hide','showInactive','minimize']){visibility[action]();await pause(100);samples.push({action,windowVisible:visibility.isVisible(),windowMinimized:visibility.isMinimized(),document:await Promise.race([visibility.webContents.executeJavaScript('({hidden:document.hidden,visibility:document.visibilityState})').catch(error=>({unavailable:error.message})),pause(500).then(()=>({unavailable:'Native document observation did not settle'}))])})}
      result.nativeVisibility={status:samples.some(sample=>sample.document.hidden===true)?'observed':'unavailable',samples,boundary:'Separate native capability probe only; no replaced visibility properties and no proof that the source Map window was natively hidden.'}
    } finally {visibility.destroy()}
    result.nativeWorkers = await read('window.graphCapture.workerSamples()'); result.after=await facts(); assert.ok(result.frames.length>=12); assert.equal(result.rendererErrors.length,0,'Original Renderer errors remain visible'); result.passed=result.failures.length===0
  } catch(error) {
    result.failures.push({name:'scene',phase,at:new Date().toISOString(),mainMonotonicMS:Number(process.hrtime.bigint())/1e6,message:error.message,stack:error.stack})
    if(win&&!win.isDestroyed()){result.diagnostics=await win.webContents.executeJavaScript(`({facts:window.graphCapture?.facts(),workers:window.graphCapture?.workerSamples(),map:document.querySelector('.collaboration-map')?.outerHTML.slice(0,14000)})`);await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}
  } finally {
    if (win && !win.isDestroyed()) {
      try { result.rendererDiagnostics = await win.webContents.executeJavaScript('window.graphCapture?.rendererDiagnostics()') }
      catch (error) { result.rendererDiagnosticObservationFailure = { phase, at: new Date().toISOString(), message: error.message } }
    }
    if (controlHost && !result.publicControl?.exitConfirmed) {
      if (controlHost.connected) controlHost.send({ kind: 'stop' })
      await Promise.race([controlExit, new Promise(resolve => setTimeout(resolve, 1200))])
      if (!result.publicControl.exitConfirmed) { result.publicControl.stopSignal = 'SIGTERM'; controlHost.kill('SIGTERM'); await Promise.race([controlExit, new Promise(resolve => setTimeout(resolve, 1200))]) }
      if (!result.publicControl.exitConfirmed) { result.publicControl.stopSignal = 'SIGKILL'; controlHost.kill('SIGKILL'); await Promise.race([controlExit, new Promise(resolve => setTimeout(resolve, 1200))]) }
      if (!result.publicControl.exitConfirmed || result.publicControl.exitCode !== 0) { result.passed = false; result.failures.push({ name: 'private-control-host-exit', message: 'The original private control host did not exit cleanly' }) }
    }
    await checkpoint();if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)
  }
})
