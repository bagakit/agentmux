const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises'), path = require('node:path')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.region-actions-render.v1', passed: false, frames: [], clicks: [], userRunTouched: false }
let win
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(25) }
  const observed=await evaluate(`({text:document.body.innerText.slice(0,800),generations:[...document.querySelectorAll('[data-region-actions-generation]')].map(n=>n.dataset.regionActionsGeneration),regions:[...document.querySelectorAll('[data-workbench-region-id]')].map(n=>n.dataset.workbenchRegionId)})`)
  throw new Error('Timed out: ' + expression + '; observed=' + JSON.stringify(observed))
}
async function click(expression) {
  const point = await evaluate(`(() => {const e=${expression};if(!e)throw new Error('Missing target');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
async function seed(mode) {
  const generation = await evaluate(`regionActions.mode(${JSON.stringify(mode)})`)
  await waitFor(`document.querySelector('[data-region-actions-generation="${generation}"]') && document.querySelectorAll('[data-workbench-region-id]').length===2`)
}
async function painted() {
  return evaluate(`(async () => {
    const running=()=>document.getAnimations().filter(animation=>animation.playState==='running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
    let finiteAnimations=0,cancelledAnimations=0,timer;
    const settle=async()=>{while(true){const animations=running();finiteAnimations+=animations.length;
      await Promise.all(animations.map(animation=>animation.finished.catch(error=>{if(animation.playState==='idle'){cancelledAnimations++;return}throw new Error('Animation wait rejected: '+String(error))})));
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      if(running().length===0)return {finiteAnimations,cancelledAnimations,animationWaitFinished:true,animationFrames:2}
    }};
    try{return await Promise.race([settle(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Finite animations did not settle')),3000)})])}finally{clearTimeout(timer)}
  })()`)
}
const visible = expression => `(() => { const node=${expression}; if(!node)return false;const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility==='visible'&&Number(s.opacity)>0 })()`
const target = 'document.querySelector(\'[data-workbench-region-id="region-actions-target"]\')'
const close = `${target}?.querySelector('.workbench-region__close')`
const geometry = `(() => {
  const region=${target}, button=${close};if(!region||!button)throw new Error('Missing real Region/close');
  const r=region.getBoundingClientRect(),b=button.getBoundingClientRect();
  const points=[[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]].map(([x,y])=>({x:b.x+b.width*x,y:b.y+b.height*y}));
  return { regionWidth:r.width,button:{x:b.x,y:b.y,width:b.width,height:b.height},
    hits:points.map(p=>({ ...p,hit:document.elementFromPoint(p.x,p.y)?.closest('.workbench-region__close')===button,
      actual:document.elementFromPoint(p.x,p.y)?.className })),
    historyActions:region.querySelectorAll('.terminal-history-action').length,
    historyHits: (()=>{const h=region.querySelector('.terminal-history-action');if(!h)return [];const b=h.getBoundingClientRect();return [[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]].map(([x,y])=>document.elementFromPoint(b.x+b.width*x,b.y+b.height*y)?.closest('.terminal-history-action')===h)})(),
    inline:!!region.querySelector('.session-history--inline'),notice:!!region.querySelector('.agent-launch-notice'),
    noticeClear: (()=>{const n=region.querySelector('.agent-launch-notice');return !n||n.querySelector('.service-window').getBoundingClientRect().right<=b.left})(),
    searchClear: (()=>{const s=region.querySelector('.terminal-search'),h=region.querySelector('.terminal-history-action');
      if(!s||!h)return null;const a=s.getBoundingClientRect(),d=h.getBoundingClientRect();return a.top>=d.bottom||a.right<=d.left||a.left>=d.right})(),
    search: (()=>{const search=region.querySelector('.terminal-search');if(!search)return null;
      const measure=node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,contained:b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom,
        hits:[[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]].map(([x,y])=>document.elementFromPoint(b.x+b.width*x,b.y+b.height*y)?.closest(node.tagName.toLowerCase())===node)}};
      return {box:measure(search),input:measure(search.querySelector('input')),buttons:[...search.querySelectorAll('button')].map(measure)}})() }
})()`
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true })
    win = new BrowserWindow({ show: false, width: 860, height: 780, webPreferences: { backgroundThrottling: false, sandbox: false } })
    result.consoleErrors=[]
    win.webContents.on('console-message', details => { if(details.level==='error')result.consoleErrors.push(details.message) })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('Boolean(window.regionActions)')
    for (const width of [640, 420, 320]) for (const mode of ['terminal', 'history', 'cold', 'notice', 'search']) {
      result.stage={width,mode,step:'seed'}
      await seed(['history','search'].includes(mode) ? 'terminal' : mode)
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: width * 2 + 1, height: 740, deviceScaleFactor: 1, mobile: false })
      await waitFor(visible(close))
      if (mode === 'history') {
        await click(`${target}.querySelector('.terminal-history-action')`)
        await waitFor(visible(`${target}.querySelector('.session-history:not(.session-history--inline)')`))
      }
      if (mode === 'cold') await waitFor(visible(`${target}.querySelector('.session-history--inline')`))
      if (mode === 'search') {
        await waitFor(`Boolean(${target}.querySelector('.xterm-helper-textarea'))`)
        await evaluate(`${target}.querySelector('.xterm-helper-textarea').focus()`)
        for (const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'f', code: 'KeyF', modifiers: 4, windowsVirtualKeyCode: 70 })
        await waitFor(visible(`${target}.querySelector('.terminal-search')`))
      }
      result.stage.step='paint'
      const paint = await painted()
      const frame = { width, mode, paint, ...await evaluate(geometry) }
      result.frames.push(frame)
      const png=(await win.webContents.capturePage()).toPNG()
      frame.pngSha256=createHash('sha256').update(png).digest('hex')
      await fs.writeFile(path.join(evidence, `${width}-${mode}.png`), png)
    }
    assert.equal(result.frames.length, 15)
    for (const frame of result.frames) {
      assert.ok(frame.regionWidth > 250 && frame.button.width === 22 && frame.button.height === 22, 'Real dimensions: ' + JSON.stringify(frame))
      assert.equal(frame.hits.length, 5, 'Every real target must provide center and four inset corner witnesses')
      assert.ok(frame.hits.every(point => point.hit), 'The entire Close split target must own its points: ' + JSON.stringify(frame))
      assert.equal(frame.historyActions, ['history', 'cold'].includes(frame.mode) ? 0 : 1)
      assert.equal(frame.historyHits.length,frame.historyActions?5:0)
      if(frame.historyActions)assert.ok(frame.historyHits.every(hit=>hit),'The History action must own its center and inset corner hit areas')
      if (frame.mode === 'notice') { assert.equal(frame.notice, true); assert.equal(frame.noticeClear, true) }
      if (frame.mode === 'search') {
        assert.equal(frame.searchClear, true)
        assert.equal(frame.search.box.contained,true,'The complete search bar must fit its actual Region: '+JSON.stringify(frame.search))
        assert.ok(frame.search.input.width>40&&frame.search.input.height>0&&frame.search.input.contained,'The actual search input must remain fully visible')
        assert.equal(frame.search.input.hits.length,5);assert.ok(frame.search.input.hits.every(hit=>hit),'The actual search input must own its hit area')
        assert.equal(frame.search.buttons.length,6)
        for(const button of frame.search.buttons){assert.equal(button.width,22);assert.equal(button.height,22);assert.equal(button.contained,true);assert.equal(button.hits.length,5);assert.ok(button.hits.every(hit=>hit))}
      }
    }
    for (const mode of ['terminal', 'history', 'cold']) {
      await seed(mode === 'history' ? 'terminal' : mode)
      await waitFor(visible(close))
      if (mode === 'history') { await click(`${target}.querySelector('.terminal-history-action')`); await waitFor(visible(`${target}.querySelector('.session-history')`)) }
      if (mode === 'cold') await waitFor(visible(`${target}.querySelector('.session-history--inline')`))
      await painted()
      const before = await evaluate('regionActions.facts()')
      if (mode === 'cold') {
        await evaluate(`${close}.focus()`)
        for (const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })
      } else await click(close)
      await waitFor(`document.querySelectorAll('[data-workbench-region-id]').length===1`)
      const after = await evaluate('regionActions.facts()')
      assert.deepEqual(Object.keys(after.tab.regions), ['region-actions-survivor'])
      assert.deepEqual(after.tab.layout.root, { type: 'leaf', regionId: 'region-actions-survivor' })
      assert.deepEqual(after.sessions, before.sessions); assert.equal(after.draft, before.draft)
      const activated = after.events.slice(before.events.length).filter(event => event.type === 'click' && event.close)
      assert.equal(activated.length, 1); assert.equal(activated[0].trusted, true); assert.equal(activated[0].regionId, 'region-actions-target')
      result.clicks.push({ mode, before, after })
    }
    result.passed = true
  } catch (error) { result.failure = { name: error?.name || typeof error, message: error?.message || String(error), stage:result.stage } }
  finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
