import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
const [html, privateRoot, evidence, producerPath] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const producer = JSON.parse(await fs.readFile(producerPath, 'utf8'))
const actual = { passed: false, pid: process.pid, frames: [], reads: { page: 0, timeline: 0, catalog: 0 },
  controls: [], messages: [], boundary: 'Compiled production Focus/API/Store with sealed genuine public producer inputs and isolated read transport. Not new Reader/Writer, real Run/PID, ordinary restart or user installation.' }
ipcMain.handle('focus-metadata-initial', () => producer)
ipcMain.handle('focus-metadata-sources', () => { actual.reads.catalog++; return producer.sources })
ipcMain.handle('focus-metadata-page', (_, reference) => { assert.equal(reference.agentSessionId, producer.sessionId); actual.reads.page++; return producer.nativePage })
ipcMain.handle('focus-metadata-timeline', (_, reference) => { assert.equal(reference.agentSessionId, producer.sessionId); actual.reads.timeline++; return producer.captured })
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1000, height: 800, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: path.join(privateRoot, 'preload.cjs') } })
    win.webContents.on('console-message', (_, level, message) => actual.messages.push({ level, message }))
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const js = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) { const value = await js(expression); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) }
      throw new Error(`Did not settle: ${expression}`)
    }
    const paint = () => js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const click = async selector => {
      await paint()
      const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing actual target');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      assert.equal(await js(`!!document.elementFromPoint(${point.x},${point.y})?.closest(${JSON.stringify(selector)})`), true)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
    }
    const key = async (key, code, number) => {
      for (const type of ['rawKeyDown', 'char', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code,
        windowsVirtualKeyCode: number, ...(type === 'char' ? { text: key === 'Enter' ? '\r' : '', unmodifiedText: key === 'Enter' ? '\r' : '' } : {}) })
    }
    const shot = async name => {
      await until(`(()=>{const p=document.querySelector('.recent-focus__message-preview');if(!p||Number(getComputedStyle(p).opacity)<.999||p.getAnimations().some(a=>a.playState==='running'))return false;const r=p.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})()`)
      await paint()
      const geometry = await js(`(()=>{const p=document.querySelector('.recent-focus__message-preview'),d=p.querySelector('section[aria-label="Message details"]'),h=p.querySelector('header'),close=p.querySelector('[aria-label="Close message"]');return{panel:p.getBoundingClientRect().toJSON(),header:h.getBoundingClientRect().toJSON(),details:d?.getBoundingClientRect().toJSON(),close:close.getBoundingClientRect().toJSON(),scrollHeight:p.scrollHeight,clientHeight:p.clientHeight}})()`)
      const state = await js('focusMetadataSceneState()'), image = name + '.png'
      await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage()).toPNG())
      const validationStyles = await js('document.querySelectorAll("style[data-focus-header-counterfactual]").length')
      assert.equal(validationStyles, 0, 'No validation CSS remains in final product frames')
      actual.frames.push({ image, width: await js('innerWidth'), geometry, state, validationStyles })
    }
    const headerMetrics = () => js(`(()=>{const p=document.querySelector('.recent-focus__message-preview'),h=p.querySelector(':scope > header'),title=h.querySelector('strong'),close=h.querySelector('[aria-label="Close message"]'),details=p.querySelector('section[aria-label="Message details"]'),css=getComputedStyle(h),panel=p.getBoundingClientRect().toJSON(),header=h.getBoundingClientRect().toJSON(),border=parseFloat(getComputedStyle(p).borderTopWidth),point={x:panel.x+panel.width/2,y:panel.y+border+.5},hit=document.elementFromPoint(point.x,point.y);return{panel,header,border,title:title.getBoundingClientRect().toJSON(),close:close.getBoundingClientRect().toJSON(),details:details?.getBoundingClientRect().toJSON(),stickyTop:css.top,computed:{marginTop:css.marginTop,marginRight:css.marginRight,marginBottom:css.marginBottom,marginLeft:css.marginLeft,paddingTop:css.paddingTop,paddingRight:css.paddingRight,paddingBottom:css.paddingBottom,paddingLeft:css.paddingLeft},point,hit:hit?.tagName,covered:header.top<=panel.top+border+.01&&header.left<=panel.left+border+.01&&header.right>=panel.right-border-.01&&!!hit&&h.contains(hit),scrollTop:p.scrollTop,validationStyles:document.querySelectorAll('style[data-focus-header-counterfactual]').length}})()`)
    const assertHeaderCover = metrics => {
      assert.equal(metrics.border, 1, 'Actual panel border is the allowed coverage boundary')
      assert.ok(metrics.scrollTop > 0, 'Actual Info panel must be scrolled')
      assert.equal(metrics.covered, true, 'Scrolled sticky header must cover the inner panel top without old rows leaking above it')
    }
    const agentMarker = '.recent-focus__message[data-message-author="agent"]', info = '[data-input-preview-id] [aria-label="Message details"]'
    await until('window.focusMetadataSceneState&&focusMetadataSceneState().markerIDs.length===4')
    await click(agentMarker); await until('focusMetadataSceneState().turn?.currentProject==="peer-own-project"')
    assert.deepEqual((await js('focusMetadataSceneState()')).fullDetailReads, [])
    assert.equal((await js('focusMetadataSceneState()')).turn.relation, 'other-agent')
    await shot('agent-wide')
    await js(`(()=>{window.metadataBody=document.querySelector('.log-turn__body');const w=document.createTreeWalker(metadataBody,NodeFilter.SHOW_TEXT);let t;while(t=w.nextNode()){if(t.textContent.includes('Same body'))break}if(!t)throw new Error('Actual body required');window.metadataRange=document.createRange();metadataRange.setStart(t,0);metadataRange.setEnd(t,9);getSelection().removeAllRanges();getSelection().addRange(metadataRange);window.metadataSelection=getSelection().toString()})()`)
    const beforeReads = { ...actual.reads }
    await click(info); await until('focusMetadataSceneState().turn?.details?.includes("Exact sender goal")')
    actual.infoContinuity = await js('({body:metadataBody===document.querySelector(".log-turn__body"),range:getSelection().rangeCount===1&&getSelection().getRangeAt(0)===metadataRange,text:getSelection().toString(),original:metadataSelection})')
    assert.equal(actual.infoContinuity.body, true); assert.equal(actual.infoContinuity.range, true)
    assert.equal(actual.infoContinuity.text, actual.infoContinuity.original)
    assert.deepEqual(actual.reads, beforeReads)
    assert.deepEqual((await js('focusMetadataSceneState()')).fullDetailReads, [producer.senderId])
    win.setContentSize(332, 840); await until('innerWidth===332'); await shot('agent-info-332')
    actual.resizedContinuity = await js('({body:metadataBody===document.querySelector(".log-turn__body"),range:getSelection().rangeCount===1&&getSelection().getRangeAt(0)===metadataRange,text:getSelection().toString(),original:metadataSelection})')
    assert.deepEqual(actual.resizedContinuity, actual.infoContinuity)
    actual.loadedCSS = await js(`(()=>{const h=document.querySelector('.recent-focus__message-preview > header'),stylesheets=[...document.styleSheets].filter(s=>s.href),rules=stylesheets.flatMap(s=>[...s.cssRules].filter(r=>r.selectorText?.includes('[data-interactive=')&&r.selectorText.endsWith(' > header')&&h.matches(r.selectorText)).map(r=>({href:s.href,selector:r.selectorText,cssText:r.cssText,margin:r.style.margin,padding:r.style.padding,top:r.style.top})));return{stylesheets:stylesheets.map(s=>({href:s.href,rules:s.cssRules.length})),rules}})()`)
    assert.equal(actual.loadedCSS.rules.length, 1, 'Exactly one real compiled interactive-header rule must be loaded')
    assert.ok(actual.loadedCSS.rules[0].margin.length > 0); assert.ok(actual.loadedCSS.rules[0].padding.length > 0)
    actual.headerCover = { initial: await headerMetrics(), counterfactual: {}, restored: null,
      boundary: 'One compile of repaired Source. The old computed margin/padding are reproduced only by this uniquely scoped validation rule in the actual compiled page.' }
    const counterRule = '.recent-focus__message-preview[data-interactive="true"] > header { top: 0; margin: 0; padding: 0; }'
    await js(`(()=>{const s=document.createElement('style');s.dataset.focusHeaderCounterfactual='original-computed-header';s.textContent=${JSON.stringify(counterRule)};document.head.append(s)})()`)
    await paint()
    actual.headerCover.counterfactual.rule = counterRule
    actual.headerCover.counterfactual.initial = await headerMetrics()
    assert.equal(actual.headerCover.counterfactual.initial.validationStyles, 1)
    assert.equal(actual.headerCover.counterfactual.initial.stickyTop, '0px')
    assert.deepEqual(Object.values(actual.headerCover.counterfactual.initial.computed), Array(8).fill('0px'))
    for (const part of ['title', 'close', 'details']) for (const dimension of ['x', 'y', 'width', 'height'])
      assert.equal(actual.headerCover.initial[part][dimension], actual.headerCover.counterfactual.initial[part][dimension], `Original ${part} initial flow/position is preserved`)

    const popupPoint = await js('(()=>{const r=document.querySelector(".recent-focus__message-preview").getBoundingClientRect();return{x:r.left+10,y:r.top+r.height/2}})()')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...popupPoint, deltaX: 0, deltaY: 800 })
    await until('(()=>{const p=document.querySelector(".recent-focus__message-preview"),n=p.querySelector(":scope > button:last-child"),r=n.getBoundingClientRect(),b=p.getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n})()')
    actual.scrolledContinuity = await js('({body:metadataBody===document.querySelector(".log-turn__body"),range:getSelection().rangeCount===1&&getSelection().getRangeAt(0)===metadataRange,text:getSelection().toString(),original:metadataSelection})')
    assert.deepEqual(actual.scrolledContinuity, actual.infoContinuity); assert.deepEqual(actual.reads, beforeReads)
    actual.headerCover.counterfactual.scrolled = await headerMetrics()
    actual.headerCover.counterfactual.image = 'header-top-strip-red-332.png'
    await fs.writeFile(path.join(evidence, actual.headerCover.counterfactual.image), (await win.webContents.capturePage()).toPNG())
    assert.throws(() => assertHeaderCover(actual.headerCover.counterfactual.scrolled), error => {
      assert.equal(error.name, 'AssertionError')
      actual.headerCover.counterfactual.failure = { name: error.name, message: error.message, stack: error.stack }; return true
    }, 'Original header computation must produce a real coverage AssertionRED')
    await js(`(()=>{const styles=document.querySelectorAll('style[data-focus-header-counterfactual]');if(styles.length!==1)throw new Error('Counterfactual rule is not unique');styles[0].remove()})()`)
    await paint()
    actual.headerCover.restored = await headerMetrics(); assertHeaderCover(actual.headerCover.restored)
    assert.equal(actual.headerCover.restored.validationStyles, 0)
    actual.headerCover.continuity = await js('({body:metadataBody===document.querySelector(".log-turn__body"),range:getSelection().rangeCount===1&&getSelection().getRangeAt(0)===metadataRange,text:getSelection().toString(),original:metadataSelection})')
    assert.deepEqual(actual.headerCover.continuity, actual.infoContinuity); assert.deepEqual(actual.reads, beforeReads)
    assert.equal((await js('focusMetadataSceneState()')).draft, 'Keep the original draft')
    assert.equal(await js('(()=>{const p=document.querySelector(".recent-focus__message-preview"),n=p.querySelector(":scope > button:last-child"),r=n.getBoundingClientRect(),b=p.getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n})()'), true)
    await shot('agent-info-bottom-332')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...popupPoint, deltaX: 0, deltaY: -800 })
    await until('document.querySelector(".recent-focus__message-preview").scrollTop===0')
    await click(info); await js(`document.querySelector(${JSON.stringify(info)}).focus()`); await key('Enter', 'Enter', 13)
    await until("!!document.querySelector('section[aria-label=\"Message details\"]')")
    assert.deepEqual((await js('focusMetadataSceneState()')).fullDetailReads, [producer.senderId, producer.senderId])
    await click('[aria-label="Close message"]'); await until('!document.querySelector(".recent-focus__message-preview")')
    await click('.recent-focus__message[data-message-author="unknown"]'); await click(info)
    await until('focusMetadataSceneState().turn?.details?.includes("native-timed")')
    assert.equal((await js('focusMetadataSceneState()')).sourceRole, 'unknown')
    await shot('native-unknown-332')
    await click('[aria-label="Close message"]'); await until('!document.querySelector(".recent-focus__message-preview")')
    await js('focusMetadataMissingProject()'); win.setContentSize(1000, 800); await until('innerWidth===1000')
    await click(agentMarker); await click(info); await until('focusMetadataSceneState().turn?.details?.includes("Project not recorded.")')
    assert.equal((await js('focusMetadataSceneState()')).turn.currentProject, undefined)
    await shot('missing-project-wide')
    actual.final = await js('focusMetadataSceneState()'); assert.deepEqual(actual.final.controls, [])
    assert.equal(actual.final.draft, 'Keep the original draft'); actual.controls = actual.final.controls; actual.passed = true
  } catch (error) {
    actual.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      actual.failureDom = await win.webContents.executeJavaScript('({html:document.body.innerHTML,proof:!!window.focusMetadataProof,preload:!!window.agentmux})')
      await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    await fs.writeFile(path.join(evidence, 'scene.json'), JSON.stringify(actual, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1)
  }
})
