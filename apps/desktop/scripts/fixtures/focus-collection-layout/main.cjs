const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path')
const {app,BrowserWindow}=require('electron')
const [html,root,evidence]=process.argv.slice(2)
app.setPath('userData',path.join(root,'user-data'));app.setPath('sessionData',path.join(root,'session-data'))
const result={schema:'agentmux.focus-collection-scene-actual.v1',passed:false,frames:[],userRuntimeTouched:false}
let win
app.whenReady().then(async()=>{try{
  win=new BrowserWindow({width:1200,height:960,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
  await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  const read=source=>win.webContents.executeJavaScript(source)
  async function until(label,predicate){const end=Date.now()+12000;do{if(await predicate())return;await new Promise(done=>setTimeout(done,30))}while(Date.now()<end);throw new Error('Private collection scene did not settle: '+label)}
  const painted=()=>read(`(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))})()`)
  async function shot(file,state){await painted();const bytes=(await win.webContents.capturePage()).toPNG();assert.ok(bytes.length>0);await fs.writeFile(path.join(evidence,file),bytes);result.frames.push({file,state})}
  const resize=async width=>{await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:960,deviceScaleFactor:1,mobile:false});await painted()}
  async function mode(value){await read(`collectionProof.mode(${JSON.stringify(value)})`);await until('actual mode '+value,()=>read(`document.querySelector('.global-focus-surface')?.dataset.focusTopicPresentation===${JSON.stringify(value)}`));await painted()}
  async function click(selector){const r=await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing control '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',inline:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...r,button:'left',clickCount:1})}
  const cards=()=>read(`[...document.querySelectorAll('.global-focus-main button.focus-context[data-session-id]')].map(n=>n.dataset.sessionId).sort()`)
  async function scanStart(){
    await until('scan top and visible original first Collection',()=>read(`(async()=>{const rows=document.querySelector('.global-focus-main .focus-project-lanes__rows');rows.scrollTop=0;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));const first=rows.querySelector('.focus-project-lanes__row'),r=rows.getBoundingClientRect(),f=first.getBoundingClientRect();return rows.scrollTop===0&&f.top>=r.top-1&&f.top<r.bottom})()`))
  }
  async function inspectPreview(){
    await click('[data-settings-preview-open="project-scanning"]')
    await until('actual narrow preview reached through original View preview action',()=>read(`(()=>{const pane=document.querySelector('[data-settings-pane]'),preview=document.querySelector('.focus-settings-preview'),a=pane.getBoundingClientRect(),b=preview.getBoundingClientRect();return document.activeElement===preview&&b.top>=a.top-1&&b.bottom<=Math.min(a.bottom,innerHeight)+1&&b.width>0})()`))
    await painted()
  }

  async function board(){await read(`collectionProof.view('board')`);await until('original board',()=>read(`!!document.querySelector('.global-focus-surface:not([hidden]) .focus-project-lanes__row[data-focus-source="collection"]')`));await painted()}
  await until('current source board',()=>read(`window.collectionProof?.ready&&document.querySelectorAll('.global-focus-main button.focus-context[data-session-id]').length===9`))
  const expected=await cards();assert.equal(new Set(expected).size,9)
  result.before=await read('collectionProof.facts()')
  for(const theme of ['dark','light'])for(const width of [1200,360]){
    await resize(width);await read(`collectionProof.theme(${JSON.stringify(theme)})`)
    for(const value of ['cards','sections']){
      await board();await mode(value)
      await scanStart()
      assert.deepEqual(await cards(),expected,'Mode/width/theme never duplicates or drops an original Agent')
      const geometry=await read(`(()=>{const root=document.querySelector('.global-focus-main'),r=root.getBoundingClientRect();return{left:r.left,right:r.right,viewport:innerWidth,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth}})()`)
      assert.ok(geometry.left>=0&&geometry.right<=geometry.viewport+1&&geometry.scrollWidth<=geometry.clientWidth+1,JSON.stringify(geometry))
      if(value==='cards')assert.equal(await read(`document.querySelectorAll('.global-focus-main [data-focus-topic-section]').length`),0)
      else assert.ok(await read(`document.querySelectorAll('.global-focus-main [data-focus-topic-section]').length`)>0)
      if(value==='cards'){
        const longTitle=await read(`(()=>{const n=[...document.querySelectorAll('.global-focus-main .focus-context__topic > span')].find(n=>n.textContent.length>40);if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{name:n.textContent,height:r.height,fontSize:parseFloat(s.fontSize),clamp:s.webkitLineClamp,accessible:n.parentElement.getAttribute('aria-label')}})()`)
        assert.ok(longTitle&&longTitle.height>=longTitle.fontSize*2&&longTitle.clamp==='2'&&longTitle.accessible.includes(longTitle.name),'Actual long Topic spans two visible lines with complete accessible title')
        result.longTopic??=[];result.longTopic.push({theme,width,...longTitle})
      }
      await shot(`board-${value}-${theme}-${width}.png`,`${value} · ${theme} · ${width} · original Collection and Project scan`)
      if(theme==='dark'){
        await read(`(()=>{const rows=document.querySelector('.focus-project-lanes__rows');rows.scrollTop=rows.scrollHeight})()`);await painted()
        await shot(`sources-${value}-${width}.png`,`${value} · ${width} · all memberships, confirmed unclassified and unknown sources`)
      }
    }
  }
  await resize(1200);await read(`collectionProof.theme('dark')`);await mode('cards');await read(`collectionProof.metadataError(true)`);await painted()
  await scanStart()
  await until('original visible Category service notice',()=>read(`!![...document.querySelectorAll('.focus-project-lanes__recovery')].find(n=>n.textContent==='Details unconfirmed')`))
  const notice=await read(`(()=>{const n=[...document.querySelectorAll('.focus-project-lanes__collection-notice')].find(n=>n.textContent==='Details unconfirmed'),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,text:n.textContent}})()`)
  assert.ok(notice.width>0&&notice.scrollWidth<=notice.clientWidth+1,'Complete unconfirmed service meaning is visibly readable')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:notice.x,y:notice.y,buttons:0})
  await until('original full Category failure tooltip visible',()=>read(`document.querySelector('.workbench-tab-name-tooltip')?.textContent.includes('Private Category metadata read failed')`))
  await painted()
  result.categoryNotice={...notice,fullExplanation:await read(`document.querySelector('.workbench-tab-name-tooltip').textContent`)}
  await shot('category-service-notice.png' ,'Original Category read failure keeps membership and Agent capability')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2,buttons:0});await read(`collectionProof.metadataError(false)`);await painted()
  for(const width of [1200,360]){
    await resize(width);await read(`collectionProof.view('settings')`)
    await until('original settings',()=>read(`!!document.querySelector('.focus-settings [data-settings-field="topic-presentation"]')`))
    await click('[data-settings-field="topic-presentation"] input[value="sections"]')
    await until('same shared preview uses sections',()=>read(`!!document.querySelector('.focus-settings-preview [data-focus-topic-section]')`))
    await shot(`settings-sections-${width}.png`,'Actual settings draft changes the original shared preview before save')
    if(width===360){await inspectPreview();await shot('settings-preview-sections-360.png','Original View preview reaches the complete narrow shared Topic sections')}
    assert.equal(await read('collectionProof.facts().mode'),'cards','Unsaved draft does not change actual Focus')
    await click('[data-settings-field="topic-presentation"] input[value="cards"]')
    await until('shared preview returns cards',()=>read(`!document.querySelector('.focus-settings-preview [data-focus-topic-section]')`))
    await shot(`settings-cards-${width}.png`,'Actual settings default card Topic treatment')
    if(width===360){await inspectPreview();await shot('settings-preview-cards-360.png','Original View preview reaches the complete narrow shared Topic card provenance')}
  }
  await resize(1200);await click('[data-settings-field="topic-presentation"] input[value="sections"]')
  await click('[data-settings-save-bar] button')
  await until('original authored preference saved via private transport',()=>read(`collectionProof.facts().mode==='sections'`))
  await board();await until('actual scan matches saved mode',()=>read(`document.querySelector('.global-focus-surface').dataset.focusTopicPresentation==='sections'`))
  await shot('saved-mode-on-board.png','Saved authored preference reaches actual Focus; private transport only')
  result.after=await read('collectionProof.facts()')
  for(const key of ['sameSessions','sameTabs','sameLayouts','sameDrafts','sameFocus'])assert.equal(result.after[key],true,key)
  assert.deepEqual(result.after.controls,{stop:0,resume:0,write:0,launchAgent:0,interrupt:0})
  assert.deepEqual(await cards(),expected)
  result.passed=true
}catch(error){if(win)try{result.previewDiagnostics=await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('[data-settings-pane]'),v=document.querySelector('.focus-settings-preview');return{visibility:document.visibilityState,active:document.activeElement?.outerHTML.slice(0,300),pane:p?.getBoundingClientRect().toJSON(),scroll:[p?.scrollTop,p?.scrollHeight,p?.clientHeight],preview:v?.getBoundingClientRect().toJSON(),enabled:v?.dataset.active}})()`)}catch{};result.failure={name:error?.name??typeof error,message:error?.message??String(error),stack:error?.stack};if(win)try{await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}catch{}}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(result,null,2)+'\n');if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}})
