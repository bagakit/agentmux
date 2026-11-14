const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), { gzipSync } = require('node:zlib')
const { app, BrowserWindow } = require('electron')
const [url, privateRoot, evidence] = process.argv.slice(2)
for (const name of ['home', 'appData', 'userData', 'sessionData']) app.setPath(name, path.join(privateRoot, name))
const result = { schema: 'agentmux.shared-motion-native.v1', passed: false, frames: [], observations: [], rendererErrors: [], transitions: [], nativeGuards: [], electron: process.versions.electron, chromium: process.versions.chrome, physicalRefreshQualified: false }
let win
app.whenReady().then(async () => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  try {
    win = new BrowserWindow({ width: 1100, height: 1060, useContentSize: true, x: -10000, y: -10000, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') result.rendererErrors.push(event.message) })
    const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }, send = (method, params) => win.webContents.debugger.sendCommand(method, params)
    const settle = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const until = async predicate => { const end = Date.now() + 8000; do { if (await predicate()) return; await pause(30) } while (Date.now() < end); throw Error('Shared native consumer did not reach the declared state') }
    const facts = async () => read(`(()=>{const bounds=element=>{const rect=element.getBoundingClientRect();return{x:rect.x,y:rect.y,width:rect.width,height:rect.height}},panels=[...document.querySelectorAll('.conversation-disclosure')].map(element=>({open:element.dataset.open,inert:element.inert,hidden:element.getAttribute('aria-hidden'),...bounds(element)}));return{at:performance.now(),...window.sharedMotion.facts(),panels,animations:document.getAnimations().map(animation=>({target:animation.effect?.target?.getAttribute('class'),time:animation.currentTime,progress:animation.effect?.getComputedTiming().progress,duration:animation.effect?.getComputedTiming().duration})),reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,appearance:document.documentElement.dataset.appearance,viewport:[innerWidth,innerHeight]}})()`)
    const frame = async label => { const before = await facts(), file = label + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); const after = await read('performance.now()'); result.frames.push({ label, file, viewport: win.getContentSize(), captureRangeMS: [before.at, after] }); result.observations.push({ label, ...before }) }
    const point = async selector => read(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing original shared control: '+${JSON.stringify(selector)});element.scrollIntoView({block:'center'});const rect=element.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`)
    const pointer = async (selector, type) => { const position = await point(selector); await send('Input.dispatchMouseEvent', { type, ...position, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) }) }
    const click = async selector => { await pointer(selector, 'mouseMoved'); await pointer(selector, 'mousePressed'); await pointer(selector, 'mouseReleased'); await settle() }
    const key = async (value, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: value, code: value, modifiers, ...(value === 'Tab' ? { windowsVirtualKeyCode: 9 } : {}) }) }
    const markButton = async (text, attribute) => { assert.ok(await read(`(()=>{const button=[...document.querySelectorAll('button')].find(element=>element.textContent.trim()===${JSON.stringify(text)}||element.getAttribute('aria-label')===${JSON.stringify(text)});if(!button)return false;button.setAttribute(${JSON.stringify(attribute)},'');return true})()`), text); return '[' + attribute + ']' }
    const transition = async (label, action) => {
      let count = 0, pending = Promise.resolve()
      const listener = (_event, method, params) => {
        if (method !== 'Page.screencastFrame') return
        void send('Page.screencastFrameAck', { sessionId: params.sessionId })
        if (count >= 8) return
        const index = count++, file = label + '-native-' + index + '.png'
        pending = pending.then(async () => { await fs.writeFile(path.join(evidence, file), Buffer.from(params.data, 'base64')); result.frames.push({ label: label + '-native-' + index, file, viewport: win.getContentSize(), screencastMetadata: params.metadata }) })
      }
      win.webContents.debugger.on('message', listener)
      try { await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }); const before = await facts(); await action(); await pause(420); const after = await facts(); result.transitions.push({ label, before, after, nativeFrames: count }); await frame(label + '-settled') }
      finally { await send('Page.stopScreencast'); win.webContents.debugger.off('message', listener); await pending }
    }
    await win.loadURL(url); win.webContents.debugger.attach('1.3')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until(() => read('Boolean(window.sharedMotion&&document.querySelector(".agent-interaction"))')); await settle()
    result.hostTokens = await read(`(()=>{const style=getComputedStyle(document.documentElement),button=getComputedStyle(document.querySelector('[data-fixture-primary]'));return{spacing:style.getPropertyValue('--sp-2').trim(),duration:style.getPropertyValue('--dur-enter').trim(),easing:style.getPropertyValue('--ease-enter').trim(),bodyFont:style.getPropertyValue('--fs-body').trim(),buttonPadding:button.padding}})()`)
    for (const token of ['spacing', 'duration', 'easing', 'bodyFont']) assert.ok(result.hostTokens[token], 'Original host density/motion token must actually resolve: ' + token)
    assert.equal(await read('document.querySelectorAll(".conversation-tool-trace__payload").length'), 0)
    await frame('shared-dark-initial')
    await pointer('[data-fixture-primary]', 'mouseMoved'); await frame('shared-button-hover')
    await pointer('[data-fixture-primary]', 'mousePressed'); await frame('shared-button-pressed'); await pointer('[data-fixture-primary]', 'mouseReleased'); await settle(); await frame('shared-button-busy')
    await key('Tab'); await frame('shared-button-keyboard-focus')
    const tool = '.conversation-tool-trace[data-trace-kind="tool-call"] .conversation-tool-trace__row'
    await transition('shared-tool-opening', () => click(tool))
    const copy = await markButton('Copy tool input', 'data-fixture-copy')
    await click(copy); assert.equal((await facts()).copied.length, 1)
    const format = await markButton('Format JSON', 'data-fixture-format'); await click(format)
    await read('document.querySelector("[data-fixture-copy]").focus()')
    await transition('shared-tool-closing', () => read(`document.querySelector(${JSON.stringify(tool)}).click()`))
    const protection = await read(`(()=>{const button=document.querySelector(${JSON.stringify(tool)}),panel=document.querySelector('.conversation-tool-trace[data-trace-kind="tool-call"] .conversation-disclosure');return{focusReturned:document.activeElement===button,inert:panel?.inert??document.querySelector('.conversation-tool-trace__payload')?.inert,hidden:panel?.getAttribute('aria-hidden')}})()`)
    await key('Tab'); protection.tabEnteredClosed = await read('Boolean(document.activeElement?.closest(".conversation-tool-trace__payload"))'); result.closedFocus = protection
    if (protection.hidden !== undefined && protection.hidden !== null) result.nativeGuards.push({ name: 'tool-state-close-returns-inner-copy-focus', passed: protection.focusReturned === true && protection.inert === true && protection.tabEnteredClosed === false, observed: protection })
    assert.equal(protection.tabEnteredClosed, false)
    await transition('shared-tool-reopening', () => click(tool)); await frame('shared-tool-format-retained')
    for (const mode of ['native-completed', 'saved', 'unknown', 'sending', 'failure']) {
      await read(`window.sharedMotion.setMode(${JSON.stringify(mode)})`); await settle()
      const allow = await markButton('Allow once', 'data-fixture-allow')
      if (mode === 'native-completed') {
        await click(allow)
        const beforeFocus = await read(`(()=>{const parameter=document.querySelector('.agent-interaction pre');parameter.tabIndex=-1;parameter.focus();return{inside:document.activeElement===parameter,tag:document.activeElement.tagName,tabIndex:parameter.tabIndex}})()`)
        await transition('shared-request-' + mode, () => read('window.sharedMotion.completePending()'))
        const afterFocus = await read(`(()=>{const details=document.querySelector('.agent-interaction__details-toggle'),panel=document.querySelector('.agent-interaction .conversation-disclosure');return{detailsPresent:Boolean(details),detailsFocused:document.activeElement===details,activeTag:document.activeElement.tagName,panelInert:panel?.inert,completed:document.querySelector('.agent-interaction').dataset.completed}})()`)
        result.requestClosureFocus = { before: beforeFocus, after: afterFocus, boundary: 'Only fixture observation adds tabindex=-1 to the original parameter pre; actual native focus then an exact original deferred receipt changes original Card state. No toggle click, focus shim, inert replacement or product alteration.' }
        if (afterFocus.detailsPresent) result.nativeGuards.push({ name: 'request-state-completion-returns-parameter-focus', passed: beforeFocus.inside === true && afterFocus.detailsFocused === true && afterFocus.panelInert === true, observed: result.requestClosureFocus })
      } else await transition('shared-request-' + mode, () => click(allow))
      if (mode !== 'native-completed') assert.notEqual((await facts()).completed, 'true')
      if (mode === 'native-completed' && await read('Boolean(document.querySelector(".agent-interaction__details-toggle"))')) await transition('shared-request-completed-details', () => click('.agent-interaction__details-toggle'))
    }
    await read('window.sharedMotion.setMode("native-completed");window.sharedMotion.theme("light")'); await settle(); await frame('shared-light-request')
    win.setContentSize(620, 1060); await settle(); await frame('shared-narrow-light')
    await read('window.sharedMotion.theme("dark")'); await settle(); await frame('shared-narrow-dark')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await transition('shared-reduced-tool-close', () => click(tool)); await frame('shared-reduced-static')
    win.setContentSize(1100, 1060); await settle()
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    let resolveTrace, stream, tracing = false
    const traceDone = new Promise(resolve => { resolveTrace = resolve })
    const traceListener = (_event, method, params) => { if (method === 'Tracing.tracingComplete') resolveTrace(params) }
    win.webContents.debugger.on('message', traceListener)
    try {
      await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,toplevel,disabled-by-default-devtools.timeline.invalidationTracking,blink.user_timing,cc,gpu,viz,input,latencyInfo', transferMode: 'ReturnAsStream' }); tracing = true
      await read('performance.mark("shared-motion-begin")')
      await click(tool); await pause(320); await click(tool); await pause(320)
      const input = await point('[aria-label="Unsent review note"]'); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...input, button: 'left', clickCount: 1 })
      await read('globalThis.__sharedInputStart=performance.now()'); await send('Input.insertText', { text: ' · retained' })
      result.inputLatency = await read('new Promise(resolve=>requestAnimationFrame(()=>resolve({nextFrameMS:performance.now()-globalThis.__sharedInputStart,focused:document.activeElement?.getAttribute("aria-label")})))')
      await pause(200); await read('performance.mark("shared-motion-end")'); await send('Tracing.end'); tracing = false
      const complete = await Promise.race([traceDone, pause(8000).then(() => { throw Error('Shared native trace completion is unknown') })])
      assert.equal(complete.dataLossOccurred, false); stream = complete.stream; assert.ok(stream)
      const chunks = []
      for (;;) { const part = await send('IO.read', { handle: stream, size: 1024 * 1024 }); chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8')); if (part.eof) break }
      await send('IO.close', { handle: stream }); stream = undefined
      const bytes = Buffer.concat(chunks), events = JSON.parse(bytes.toString()).traceEvents, rendererPid = win.webContents.getOSProcessId(), mainTid = events.find(event => event.pid === rendererPid && event.name === 'thread_name' && event.args?.name === 'CrRendererMain')?.tid
      const begin = events.find(event => event.pid === rendererPid && event.name === 'shared-motion-begin')?.ts, end = events.find(event => event.pid === rendererPid && event.name === 'shared-motion-end')?.ts
      assert.ok(mainTid && Number.isFinite(begin) && end > begin)
      const main = events.filter(event => event.pid === rendererPid && event.tid === mainTid && event.ph === 'X' && event.ts >= begin && event.ts <= end), statistics = {}
      for (const event of main) if (/Layout|Style|Paint|Layerize|Commit|Intersection/.test(event.name)) { const entry = statistics[event.name] ??= { count: 0, inclusiveMS: 0, maxMS: 0 }; entry.count++; entry.inclusiveMS += event.dur / 1000; entry.maxMS = Math.max(entry.maxMS, event.dur / 1000) }
      const tasks = main.filter(event => event.name === 'ThreadControllerImpl::RunTask').map(event => [event.ts, Math.min(end, event.ts + event.dur)]).sort((first, second) => first[0] - second[0])
      let taskUnionUS = 0, taskEnd = -Infinity
      for (const [start, finish] of tasks) { taskUnionUS += Math.max(0, finish - Math.max(taskEnd, start)); taskEnd = Math.max(taskEnd, finish) }
      assert.ok(tasks.length); await fs.writeFile(path.join(evidence, 'shared-motion.trace.json.gz'), gzipSync(bytes))
      result.cost = { trace: 'shared-motion.trace.json.gz', rendererPid, mainTid, events: events.length, observedMS: (end - begin) / 1000, taskUnionMS: taskUnionUS / 1000, statistics,
        invalidationExamples: events.filter(event => event.pid === rendererPid && /InvalidationTracking/.test(event.name) && event.ts >= begin && event.ts <= end).slice(0, 24).map(event => ({ name: event.name, args: event.args })),
        compositionEvents: events.filter(event => event.ts >= begin && event.ts <= end && /DrawFrame|DrawAndSwap|SubmitCompositorFrame|RasterTask/.test(event.name)).length,
        boundary: 'One original shared tree, natural open/close transitions and native input. Inclusive pipeline categories overlap and are not added; task union is occupied wall time, not CPU or total GPU cost. Native tracing/protocol/query overhead is uncalibrated and not subtracted. No screenshots or screencast inside this cost window. Unrelated-scale evidence belongs to the separate original Focus App scene, not this bounded component scene.' }
    } finally { win.webContents.debugger.off('message', traceListener); if (tracing) await send('Tracing.end').catch(() => {}); if (stream) await send('IO.close', { handle: stream }).catch(() => {}) }
    result.finalFacts = await facts(); result.inputValue = await read(`document.querySelector('[aria-label="Unsent review note"]').value`); assert.ok(result.inputValue.includes('retained'))
    assert.deepEqual(result.rendererErrors, []); assert.ok(result.frames.length >= 20)
    result.nativeGuardStatus = result.nativeGuards.length ? 'observed' : 'not-applicable-original-baseline'
    if (!process.env.COLLABORATION_CAPTURE_SOURCE_REF) assert.ok(result.nativeGuards.length >= 2, 'Candidate native focus guards must actually execute')
    result.passed = true
    for (const guard of result.nativeGuards) if (!guard.passed) result.passed = false
    if (!result.passed) result.failure = { message: 'Actual native focus handback failed', guards: result.nativeGuards.filter(guard => !guard.passed) }
  } catch (error) { result.failure = { message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) }
})
