const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, evidence] = process.argv.slice(2)
assert.ok(evidence?.includes('/capture-'))
for (const [key, value] of Object.entries(process.env)) if (key.startsWith('AGENTMUX_') || key === 'AGENT_SESSION_STORE') assert.ok(value.startsWith(evidence + '/'))
app.setPath('userData', path.join(evidence, 'userData')); app.setPath('sessionData', path.join(evidence, 'userData', 'session')); Menu.setApplicationMenu(null)
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', images: [], geometry: [], operations: [], mutations: [], errors: [] }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'blob:', 'devtools:'].includes(new URL(details.url).protocol) }))
    win = new BrowserWindow({ width: 1240, height: 900, show: false, backgroundColor: '#181818', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadFile(html, { query: { workspacePath: path.join(evidence, 'workspace'), scenario: 'discussion-files' } }); win.webContents.focus()
    const read = script => win.webContents.executeJavaScript(script)
    const until = async (script, label) => { for (let i = 0; i < 150; i++) { if (await read(script)) return; await pause(30) } throw Error('Private Renderer condition timed out: ' + label) }
    const q = selector => `document.querySelector(${JSON.stringify(selector)})`
    const tab = label => `[...document.querySelectorAll('[aria-label="Mote pages"] [role="tab"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`
    const click = async (expression, modifiers = []) => {
      const point = await read(`(()=>{const e=${expression};if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!(hit===e||e.contains(hit)))throw Error('Control not hittable: '+e.textContent);return {x,y,label:e.getAttribute('aria-label')||e.textContent}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1, modifiers }); win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1, modifiers }); await pause(80); result.operations.push({ action: 'native-click', modifiers, ...point })
    }
    const stableScroll = async () => {
      const samples = []; let stable = 0
      for (let index = 0; index < 60; index++) {
        const value = await read('window.originalTree.scrollTop'); samples.push(value)
        stable = samples.length > 1 && value === samples[samples.length - 2] ? stable + 1 : 0
        if (stable === 5) { result.operations.push({ action: 'settled-file-scroll', samples }); return value }
        await pause(30)
      }
      throw Error('Original file scrolling did not settle: ' + JSON.stringify(samples))
    }
    const page = async label => { await click(tab(label)); await until(`(${tab(label)})?.getAttribute('aria-selected')==='true'`, label) }
    const measure = () => read(`(()=>{
      const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      const frame=${q('.workspace-tool-explorer')},details=${q('[data-mote-details]')},tree=${q('.file-tree')},search=${q('[placeholder="Find loaded files"]')},context=frame.querySelector('.workspace-tool-context--explorer');
      const selected=window.moteCalendarScene.facts();return {viewport:{width:innerWidth,height:innerHeight},section:details.dataset.section,frame:rect(frame),details:rect(details),header:rect(context),tree:rect(tree),handle:rect(frame.querySelector('.workspace-tools-resize-handle')),search:search?.value,scroll:tree?.scrollTop,visibleRows:tree?[...tree.querySelectorAll('[data-tree-path]')].filter(e=>e.getBoundingClientRect().height>0).length:0,
        treeLayout:tree?{offsetTop:tree.querySelector('.file-tree__rows')?.offsetTop,rowsHeight:tree.querySelector('.file-tree__rows')?.style.height,prefix:rect(tree.querySelector('.file-tree__prefix')),scrollHeight:tree.scrollHeight,clientHeight:tree.clientHeight,rows:[...tree.querySelectorAll('.file-tree__virtual-row')].slice(0,4).map(e=>({index:e.dataset.index,transform:e.style.transform,height:e.getBoundingClientRect().height,path:e.querySelector('[data-tree-path]')?.dataset.treePath}))}:null,
        retainedDOM:!window.originalTree||(window.originalTree===tree&&window.originalSearch===search&&window.originalExplorer===frame.querySelector('.file-explorer')),
        overflow:[document.documentElement,details].map(e=>({client:e.clientWidth,scroll:e.scrollWidth})),facts:selected};})()`)
    const noFiles = g => {
      for(const [name,rect] of [['header',g.header],['tree',g.tree],['resize handle',g.handle]])assert.ok(!rect||rect.height===0||rect.width===0,'Content-only regression: visible file '+name)
      assert.ok(Math.abs(g.details.top-g.frame.top)<=1,'Content-only regression: file area left a top gap')
      assert.ok(Math.abs(g.details.height-g.frame.height)<=1,'Content-only regression: file area retained layout space')
      assert.equal(g.retainedDOM,true,'The original file tree must remain mounted')
      for(const item of g.overflow)assert.ok(item.scroll<=item.client+1,'Original surface overflowed')
    }
    const sync = async () => { await read('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))'); win.webContents.invalidate(); await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))') }
    const capture = async name => {await sync();const g=await measure();if(g.section!=='discussion')noFiles(g);await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());result.images.push(name+'.png');result.geometry.push({capture:name,...g});return g}
    await until(`!!${q('[aria-label="Mote pages"]')}&&!!${q('[aria-label="Expand working-notes"]')}`,'Populated original Discussion file tree')
    await click(q('[aria-label="Expand working-notes"]'))
    await until(`!!${q('[data-tree-path$="/note-00.md"]')}`,'Original folder children')
    await click(q('[placeholder="Find loaded files"]')); win.webContents.insertText('note'); await pause(80)
    await click(q('[data-tree-path$="/note-00.md"]'), ['meta'])
    await read(`window.originalTree=${q('.file-tree')};window.originalSearch=${q('[placeholder="Find loaded files"]')};window.originalExplorer=${q('.file-explorer')}`)
    const tree = await read(`(()=>{const r=window.originalTree.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    result.operations.push({action:'before-file-scroll',geometry:await measure()})
    win.webContents.sendInputEvent({type:'mouseWheel',x:Math.round(tree.x),y:Math.round(tree.y),deltaY:-300,deltaX:0,canScroll:true});await until('window.originalTree.scrollTop>0','Native file-tree scroll');await stableScroll()
    const before=await measure();assert.ok(before.visibleRows>3);assert.ok(before.facts.explorer.expandedPaths.some(p=>p.endsWith('/working-notes')));assert.ok(before.facts.explorer.selectedPaths.some(p=>p.endsWith('/note-00.md')));assert.equal(before.search,'note')
    result.originalFiles=before
    for(const [label,name] of [['Profile','profile-without-files-wide'],['Ideas','ideas-without-files-wide'],['Calendar','calendar-without-files-wide']]){
      await page(label);await capture(name)
      await page('Discussion');await stableScroll();const returned=await measure();result.operations.push({action:'returned-file-geometry',from:label,geometry:returned});assert.equal(returned.retainedDOM,true);assert.equal(returned.search,before.search);assert.deepEqual(returned.facts.explorer,before.facts.explorer);assert.equal(returned.scroll,before.scroll,'Return to the exact original file-tree scroll');result.operations.push({action:'retained-original-files',from:label,scroll:returned.scroll,query:returned.search})
    }
    await capture('discussion-retained-files-wide')
    await page('Profile')
    let key,failure,mutant;try{key=await win.webContents.insertCSS('.workspace-tool-explorer--content-only{grid-template-rows:34px minmax(0,1fr)!important}.workspace-tool-explorer--content-only>.workspace-tool-context[hidden]{display:flex!important}.workspace-tool-explorer--content-only [data-panel][aria-hidden="true"]{display:block!important}');await sync();mutant=await measure();try{noFiles(mutant)}catch(error){failure=error}}finally{if(key)await win.webContents.removeInsertedCSS(key)}await sync();noFiles(await measure());assert.ok(failure instanceof assert.AssertionError&&failure.message.includes('Content-only regression'));result.mutations.push({name:'restored-top-file-area',red:failure.message,geometry:mutant,restored:true})
    win.setContentSize(360,760);await pause(80);await capture('profile-without-files-narrow')
    const final=await measure();assert.deepEqual(final.facts.drafts,final.facts.initialDrafts);assert.deepEqual(final.facts.tabIds,before.facts.tabIds);assert.deepEqual(final.facts.selection,before.facts.selection);assert.equal(final.facts.calls.filter(c=>/schedule\.(create|pause|resume|cancel)/.test(c.method)).length,0)
    result.passed=true
  }catch(error){result.error={message:error.message,stack:error.stack}}
  finally{await fs.writeFile(path.join(evidence,'renderer-result.json'),JSON.stringify(result,null,2)+'\n');if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}
})
