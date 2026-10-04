const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, images: [], operations: [], pid: process.pid }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1180, height: 760, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, _level, message) => console.log('Renderer:', message))
    await win.loadFile(html)
    const read = script => win.webContents.executeJavaScript(script)
    for (let i = 0; i < 100 && !(await read('!!window.directoryScene')); i++) await pause(30)
    const click = async selector => {
      const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing original control: '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      assert.ok(point.x>0 && point.y>0, 'The original control must have a visible target');result.operations.push({ click: selector, point })
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) }); await pause(50)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
      await pause(150)
    }
    await pause(600)
    const original = await read('directoryScene.facts()')
    for (const view of ['collaborators', 'list']) for (const narrow of [false, true]) for (const light of [false, true]) {
      win.setContentSize(narrow ? 720 : 1180, 760)
      await read(`directoryScene.view(${JSON.stringify(view)});directoryScene.theme(${light})`); await pause(250)
      const facts = await read(`(()=>{const roster=document.querySelector('[data-mote-directory-view]');const names=[...roster.querySelectorAll('[data-space-nav]')].map(n=>n.getAttribute('data-space-nav'));return {view:roster.dataset.moteDirectoryView,names,appearance:document.documentElement.dataset.appearance,portrait:roster.querySelector('.space-object-icon')?.getBoundingClientRect().width,archive:document.querySelector('[aria-label="Show archived Motes in Space"]').textContent,overflow:document.body.scrollWidth>innerWidth,...directoryScene.facts()}})()`)
      assert.equal(facts.view,view); assert.equal(facts.names.length,5); assert.equal(facts.archive,'1'); assert.equal(facts.overflow,false)
      if (view === 'collaborators') assert.ok(facts.portrait>=32 && facts.portrait<54, 'Readable compact round portraits')
      assert.deepEqual(facts.drafts,original.drafts); assert.deepEqual(facts.selection,original.selection); assert.deepEqual(facts.forbidden,[])
      const file=`directory-${view}-${narrow?'narrow':'wide'}-${light?'light':'dark'}.png`
      await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());result.images.push(file);result.operations.push({file,...facts})
    }
    await read('directoryScene.view("collaborators");directoryScene.theme(false)'); win.setContentSize(1180,760); await pause(150)
    await click('[aria-label="Show archived Motes in Space"]')
    assert.equal(await read('document.querySelectorAll("[data-mote-directory-view] [data-space-nav]").length'),6)
    await click('[aria-label="More actions for Research and systems design"]')
    assert.ok(await read('document.querySelector("[role=menu]")?.textContent.includes("Rename Mote")'))
    const stableMenu = await read(`(async()=>{const menu=document.querySelector('[role=menu]');if(!menu)throw Error('Original menu missing');await Promise.all(menu.getAnimations().map(animation=>animation.finished));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const style=getComputedStyle(menu);return {opacity:style.opacity,backgroundColor:style.backgroundColor,animationName:style.animationName,animations:menu.getAnimations().map(animation=>({playState:animation.playState,currentTime:animation.currentTime}))}})()`)
    assert.equal(stableMenu.opacity,'1'); result.operations.push({stableMenu})
    const menuFile='directory-original-actions.png'
    await fs.writeFile(path.join(evidence,menuFile),(await win.webContents.capturePage()).toPNG());result.images.push(menuFile)
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESC'});await pause(150)
    await read('directoryScene.settings(true)');await pause(200)
    await click('[value="list"]');await click('.settings-pane-actions button')
    assert.equal(await read('document.querySelector("[data-mote-directory-view]").dataset.moteDirectoryView'),'list')
    for (const light of [false,true]) {
      await read(`directoryScene.theme(${light})`);await pause(150)
      const file=`directory-settings-${light?'light':'dark'}.png`
      await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());result.images.push(file)
    }
    await read('directoryScene.settings(false);directoryScene.theme(false)');await pause(150)
    const anchor=await read('(()=>{const r=document.querySelector("[data-pmo-teams-topic-launcher] button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(anchor.x),y:Math.round(anchor.y)});await pause(400)
    if (!(await read('!!document.querySelector("[data-pmo-teams-topic-floating][data-state=open]")'))) await click('[data-pmo-teams-topic-launcher] button')
    const floating=await read('(()=>{const panel=document.querySelector("[data-pmo-teams-topic-floating][data-state=open]");return {open:!!panel,archive:panel?.querySelector("[aria-label=\\"Show archived Motes\\"]")?.textContent,...directoryScene.facts()}})()')
    assert.equal(floating.open,true);assert.equal(floating.archive,'1');assert.deepEqual(floating.forbidden,[])
    const floatingFile='directory-floating-archive.png'
    await fs.writeFile(path.join(evidence,floatingFile),(await win.webContents.capturePage()).toPNG());result.images.push(floatingFile);result.operations.push({file:floatingFile,...floating})
    await read('directoryScene.coldReadIssue()');await pause(250)
    assert.equal(await read('!!document.querySelector("[data-pmo-teams-topic-floating][data-state=open]")'),false)
    for (const view of ['collaborators', 'list']) {
      await read(`directoryScene.view(${JSON.stringify(view)})`);await pause(150)
      assert.ok(await read(`!!document.querySelector('[data-space-nav="topic:launcher:analyst"]')`))
      assert.ok(await read('document.querySelector(".workspace-sidebar")?.textContent.includes("collaborator details could not be read") || document.body.textContent.includes("collaborator details could not be read")'))
      const file = `directory-cold-read-${view}.png`
      await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());result.images.push(file)
    }
    result.originalInteractions={method:'Chromium sendInputEvent',archiveReveal:true,originalObjectMenu:true,settingsRadioAndSave:true}
    result.passed=true
  } catch (error) { result.error={message:error.message,stack:error.stack}; if(win) await fs.writeFile(path.join(evidence,'failed-renderer.png'),(await win.webContents.capturePage()).toPNG()) }
  finally { await fs.writeFile(path.join(evidence,'renderer-result.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1) }
})
