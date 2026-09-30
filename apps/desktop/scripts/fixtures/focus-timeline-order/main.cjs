const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const actual = { passed: false, pid: process.pid, frames: [], controls: [], boundary: 'Compiled production Timeline/Store with isolated typed presentation I/O and trusted CDP. Not public Reader, actual Run, Runtime, App restart or installation.' }
let win
app.whenReady().then(async () => {
 try {
  win = new BrowserWindow({ width: 1200, height: 620, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(html); win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const js = code => win.webContents.executeJavaScript(code)
  const until = async code => { for (let i = 0; i < 200; i++) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error(`Did not settle: ${code}`) }
  const point = selector => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing target');const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===n}})()`)
  const click = async selector => { const p = await point(selector); assert.equal(p.hit, true, `Actual center hit: ${selector}`); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) }
  const wheel = async (deltaX, shift = false) => { const p = await point('.recent-focus__time-scale'); assert.equal(p.hit, true); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: shift ? 0 : deltaX, deltaY: shift ? deltaX : 0, modifiers: shift ? 8 : 0 }) }
  const state = () => js('orderSceneState()')
  const keys = value => value.projects.map(p => ({ key: p.key, tracks: p.tracks.map(t => t.id) }))
  const expected = [{ key: '["private","beta"]', tracks: ['d'] }, { key: '["private","alpha"]', tracks: ['b', 'c', 'a'] }]
  const settledPreview = async () => {
    await until(`(()=>{const n=document.querySelector('.recent-focus__message-preview');if(!n)return false;const c=getComputedStyle(n),r=n.getBoundingClientRect();return c.visibility==='visible'&&Number(c.opacity)>=.999&&r.width>0&&r.height>0&&n.getAnimations().every(a=>a.playState!=='running')})()`)
    await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  }
  const readingGeometry = () => js(`(()=>{
    const surface=document.querySelector('.recent-focus__message-preview'),body=document.querySelector('[data-input-preview-id]'),text=window.originalOrderText,close=document.querySelector('[aria-label="Close message"]');
    if(!surface||!body||!text?.isConnected||!close)throw new Error('Original reading targets missing');
    const rect=n=>{const r=n.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},
      box=rect(surface);
    const ancestorClip=target=>{
      const result={left:Math.max(0,box.left+surface.clientLeft),top:Math.max(0,box.top+surface.clientTop),right:Math.min(innerWidth,box.left+surface.clientLeft+surface.clientWidth),bottom:Math.min(innerHeight,box.top+surface.clientTop+surface.clientHeight)};
      for(let n=target.parentElement;n&&n!==surface;n=n.parentElement){const c=getComputedStyle(n),r=n.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(c.overflowX)){result.left=Math.max(result.left,r.left+n.clientLeft);result.right=Math.min(result.right,r.left+n.clientLeft+n.clientWidth)}if(/auto|scroll|hidden|clip/.test(c.overflowY)){result.top=Math.max(result.top,r.top+n.clientTop);result.bottom=Math.min(result.bottom,r.top+n.clientTop+n.clientHeight)}}
      return result
    };
    const clip=ancestorClip(text),closeClip=ancestorClip(close);
    const range=document.createRange();range.selectNodeContents(text);
    const lines=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,hit:body.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}));
    const inside=(r,bounds=clip)=>r.left>=bounds.left-.5&&r.top>=bounds.top-.5&&r.right<=bounds.right+.5&&r.bottom<=bounds.bottom+.5;
    const target=n=>{const r=rect(n),x=r.left+r.width/2,y=r.top+r.height/2;return{bounds:r,x,y,hit:document.elementFromPoint(x,y)?.closest('[aria-label="'+n.getAttribute('aria-label')+'"]')===n}};
    const controlNames=['Zoom out Focus timeline','Zoom in Focus timeline','Return to current focus window'];
    return{previewStyle:{visibility:getComputedStyle(surface).visibility,opacity:Number(getComputedStyle(surface).opacity),runningAnimations:surface.getAnimations().filter(a=>a.playState==='running').length},surface:box,clip,scroll:{top:surface.scrollTop,height:surface.scrollHeight,clientHeight:surface.clientHeight},text:range.toString(),lines,wholeTextVisible:lines.length>0&&lines.every(r=>inside(r)&&r.hit),sameBody:body===window.originalOrderBody,selection:getSelection().toString(),close:{...target(close),clip:closeClip,inside:inside(rect(close),closeClip)},timelineControls:controlNames.map(label=>{const n=document.querySelector('[aria-label="'+label+'"]');if(!n)throw new Error('Missing original control: '+label);return{label,...target(n)}})};
  })()`)
  const revealOriginalBody = async name => {
    await settledPreview()
    const records=[]
    let geometry=await readingGeometry()
    actual.readingFrames??=[]
    const readingFrame={name,initial:geometry,scrollSteps:records,geometry}
    actual.readingFrames.push(readingFrame)
    for(let i=0;i<8&&!geometry.wholeTextVisible;i++){
      assert.ok(geometry.lines.length>0,'Original whole-text line boxes are nonempty')
      const room=geometry.scroll.height-geometry.scroll.clientHeight-geometry.scroll.top
      const first=Math.min(...geometry.lines.map(r=>r.top)),last=Math.max(...geometry.lines.map(r=>r.bottom))
      const deltaY=last>geometry.clip.bottom?Math.min(room,Math.max(16,last-geometry.clip.bottom+6)):Math.max(-geometry.scroll.top,first-geometry.clip.top-6)
      assert.ok(Math.abs(deltaY)>.5,'Original body cannot be revealed by existing natural scroll')
      const p={x:geometry.surface.left+5,y:geometry.surface.bottom-7}
      assert.equal(await js(`document.elementFromPoint(${p.x},${p.y})?.closest('.recent-focus__message-preview')===document.querySelector('.recent-focus__message-preview')`),true,'Trusted wheel hits original surface padding')
      const prior=geometry.scroll.top
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:0,deltaY})
      await until(`Math.abs(document.querySelector('.recent-focus__message-preview').scrollTop-${prior})>.5`)
      await settledPreview()
      geometry=await readingGeometry()
      records.push({wheel:{...p,deltaY},geometry})
      readingFrame.geometry=geometry
    }
    readingFrame.geometry=geometry
    assert.equal(geometry.wholeTextVisible,true,'Original entire selected text is within actual clip and line-center hit')
    assert.equal(geometry.text,actual.selection,'Read the original selected text')
    assert.equal(geometry.sameBody,true);assert.equal(geometry.selection,actual.selection)
    assert.equal(geometry.close.inside,true,'Original Close must remain inside actual panel clip')
    assert.equal(geometry.close.hit,true,'Original Close center hit after natural scroll')
    assert.ok(geometry.timelineControls.length===3)
    for(const control of geometry.timelineControls)assert.equal(control.hit,true,`Original timeline control center hit: ${control.label}`)
    return geometry
  }
  const shot = async (name, before) => {
    const geometry=await revealOriginalBody(name)
    const s=await state();assert.deepEqual(keys(s),expected);assert.deepEqual(s.counts,before.counts);assert.equal(s.inputs,before.inputs)
    const image=`${name}.png`;await fs.writeFile(path.join(evidence,image),(await win.webContents.capturePage()).toPNG())
    actual.frames.push({image,width:await js('innerWidth'),state:s,reading:geometry})
  }
  await until('window.orderSceneState && orderSceneState().counts.catalog===1')
  await click('[aria-label="View input records"]')
  await js(`(()=>{const s=document.querySelector('[aria-label="Input records Context"]');s.value='a';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await until('orderSceneState().inputs===91'); await click('[data-input-message-id]')
  await until('!!document.querySelector("[data-input-preview-id]")')
  actual.initial = await state(); assert.deepEqual(actual.initial.counts, { catalog: 1, page: 3, timeline: 1 }); assert.deepEqual(keys(actual.initial), expected)
  actual.selection = await js(`(()=>{const n=document.querySelector('[data-input-preview-id]');window.originalOrderBody=n;const walker=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let t;while(t=walker.nextNode()){if(t.textContent.includes('Original retained task'))break}if(!t)throw new Error('No original text');window.originalOrderText=t;const r=document.createRange();r.selectNodeContents(t);getSelection().removeAllRanges();getSelection().addRange(r);const v=document.querySelector('.recent-focus__viewport');v.scrollLeft=0;window.originalOrderSelection=getSelection().toString();return window.originalOrderSelection})()`)
  assert.ok(actual.selection.length > 0)
  for (const width of [1200, 360]) {
    win.setContentSize(width, 620); await until(`innerWidth===${width}`); await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    await shot(`${width}-before`, actual.initial)
    const before = await state(); await wheel(-20); await until(`orderSceneState().start<${before.start}`)
    await shot(`${width}-after`, actual.initial)
    await click('[aria-label="Return to current focus window"]')
  }
  for (let i = 0; i < 100; i++) { await wheel(i % 2 ? -2 : 2, i % 3 === 0); await click(`[aria-label="${i % 10 === 9 ? 'Return to current focus window' : i % 2 ? 'Zoom in Focus timeline' : 'Zoom out Focus timeline'}"]`) }
  actual.after200 = await state(); assert.deepEqual(actual.after200.counts, actual.initial.counts); assert.deepEqual(keys(actual.after200), expected)
  actual.preservation = await js(`({sameBody:window.originalOrderBody===document.querySelector('[data-input-preview-id]'),selection:getSelection().toString(),draft:document.querySelector('#original-draft').value})`)
  assert.equal(actual.preservation.sameBody, true); assert.equal(actual.preservation.selection, actual.selection); assert.equal(actual.preservation.draft, 'Keep the original draft')
  actual.controls = (await state()).controls; assert.deepEqual(actual.controls, []); actual.passed = true
 } catch (error) { actual.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
 finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1) }
})
