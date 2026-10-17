const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, owned, evidence, mode = 'full', pages = ''] = process.argv.slice(2)
app.setPath('userData', path.join(owned, 'user-data'))
app.setPath('sessionData', path.join(owned, 'session-data'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', frames: [], interactions: [],
  boundary: 'Actual App, SettingsPanel, original catalog/editors and production CSS with isolated public Preview data and trusted Electron Renderer input. No user App, live Runtime, durability, external service or installation claim.' }
let win
app.whenReady().then(async () => {
  const bounded = (promise, label) => new Promise((resolve, reject) => {
    const timer=setTimeout(()=>reject(new Error('Private Renderer observation stalled: '+label)),8000)
    promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})
  })
  const read = code => bounded(win.webContents.executeJavaScript(code),code)
  const node = selector => `document.querySelector(${JSON.stringify(selector)})`
  const until = async (code, message = code) => {
    const end = Date.now() + 8000
    while (Date.now() < end) { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 25)) }
    throw new Error('Renderer did not settle: ' + message)
  }
  const settle = async () => {
    await read('document.fonts.ready')
    // A hidden capture target can suspend animation frames between captures.
    // Rendering is verified by the ensuing native geometry read/capture itself.
    await new Promise(resolve=>setTimeout(resolve,40))
  }
  const hit = async (expression, scroll = true) => {
    if (scroll) { await read(`(${expression}).scrollIntoView({behavior:'instant',block:'center',inline:'nearest'})`); await settle() }
    return read(`(() => { const n=${expression}; if(!n?.isConnected||!n.checkVisibility())throw Error('Expected a visible control'); const r=n.getBoundingClientRect(); return {label:n.getAttribute('aria-label')||n.textContent.trim(),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),width:r.width,height:r.height,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}; })()`)
  }
  const click = async expression => {
    const target = await hit(expression)
    assert.ok(target.width > 0 && target.height > 0 && target.hit, 'The actual control has an unobstructed hit')
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:target.x,y:target.y})
    result.interactions.push({kind:'trusted-pointer',label:target.label})
    await settle()
  }
  const key = async keyCode => {
    win.webContents.sendInputEvent({type:'keyDown',keyCode})
    if (keyCode==='Enter') win.webContents.sendInputEvent({type:'char',keyCode:'\r'})
    win.webContents.sendInputEvent({type:'keyUp',keyCode})
    await settle()
  }
  const fill = async (selector, value) => {
    await click(node(selector)); win.webContents.selectAll(); win.webContents.insertText(value)
    await until(`${node(selector)}?.value===${JSON.stringify(value)}`)
  }
  const title = () => read('document.querySelector(".settings-content__header h2")?.textContent')
  const resize = async (width, height) => { win.setContentSize(width,height); await until(`innerWidth===${width}&&innerHeight===${height}`); await settle() }
  const capture = async (name, page, theme, position = 'top') => {
    await settle()
    const checks = await read(`(() => { const pane=document.querySelector('[data-settings-overview]')||document.querySelector('[data-settings-pane]:not([hidden])')||document.querySelector('.settings-search-results'); return {viewport:[innerWidth,innerHeight],horizontalOverflow:document.documentElement.scrollWidth>innerWidth,scroll: pane?{top:pane.scrollTop,height:pane.scrollHeight,viewport:pane.clientHeight}:null}; })()`)
    assert.equal(checks.horizontalOverflow,false,'Settings has no document horizontal overflow')
    const file = name + '.png'
    fs.writeFileSync(path.join(evidence,file),(await bounded(win.webContents.capturePage(undefined,{stayHidden:true}),'capture '+file)).toPNG())
    result.frames.push({file,page,theme,position,checks})
  }
  const theme = async value => { await read(`window.settingsHomeProbe.theme(${JSON.stringify(value)})`); await settle() }
  let catalog
  const nav = async id => {
    const entry = id === 'overview' ? {id,title:'Overview'} : catalog.find(item=>item.id===id)
    assert.ok(entry,'Navigation target comes from the actual catalog')
    if (await read('document.querySelector(".settings-section-picker").checkVisibility()')) {
      await click(node('.settings-section-picker'))
      await until('!!document.querySelector("[role=menuitemradio]")')
      await click(`Array.from(document.querySelectorAll('[role=menuitemradio]')).find(n=>n.textContent.trim()===${JSON.stringify(entry.title)})`)
    } else {
      if (entry.group && await read(`${node(`[data-settings-group-toggle="${entry.group}"]`)}?.getAttribute('aria-expanded')==='false'`))
        await click(node(`[data-settings-group-toggle="${entry.group}"]`))
      await click(node(`nav[aria-label="Settings sections"] [data-settings-target="${id}"]`))
    }
    await until(id === 'overview' ? '!!document.querySelector("[data-settings-overview]")' : `!!document.querySelector('[data-settings-pane="${id}"]:not([hidden])')`)
    assert.equal(await title(),entry.title,'The original navigation reaches its original editor')
  }
  const disclosureGeometry = async () => {
    await nav('agents')
    for (const state of ['collapsed','expanded']) {
      await click(node('[data-settings-group-toggle="preferences"]'))
      await settle()
      const geometry = await read(`(() => {const target=document.querySelector('nav [data-settings-target="agents"]').getBoundingClientRect(),surface=document.querySelector('nav [data-liquid-selection="agents"]').getBoundingClientRect();return {target:target.toJSON(),surface:surface.toJSON()}})()`)
      for (const key of ['x','y','width','height']) assert.ok(Math.abs(geometry.target[key]-geometry.surface[key])<1,'Current selection surface follows disclosure geometry: '+key)
      result.interactions.push({kind:'disclosure-selection-geometry',state,geometry})
      await capture('sidebar-'+state,'agents','dark')
    }
    await nav('overview')
  }
  try {
    win = new BrowserWindow({width:1440,height:940,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
    result.console = []
    win.webContents.on('console-message', details => result.console.push({level:details.level,message:details.message}))
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await until('window.settingsHomeProbe?.ready && !!document.querySelector(".window-status-bar [aria-label=Settings]")')
    catalog = await read('window.settingsHomeProbe.catalog')
    assert.ok(catalog.length > 0,'The actual page inventory is nonempty')
    result.catalog = catalog
    const requested = pages ? pages.split(',') : null
    const available = ['overview', ...catalog.map(entry=>entry.id)]
    const selected = requested ?? available
    assert.ok(selected.length > 0 && selected.every(id=>available.includes(id)), 'Every selected page exists in the actual catalog')
    assert.equal(new Set(selected).size, selected.length, 'No duplicate page selection')
    result.scope = {requested, resolved:available.filter(id=>selected.includes(id))}
    const reviewCatalog = catalog.filter(entry=>selected.includes(entry.id))

    result.original = await read('window.settingsHomeProbe.beginSurface()')
    assert.ok(result.original.tabs>0&&result.original.sessions>0&&result.original.layouts>0)
    await click(node('.window-status-bar [aria-label="Settings"]'))
    await until('!!document.querySelector("[data-settings-overview]")')
    assert.equal(await title(),'Overview','Ordinary App Settings opens Overview')
    assert.equal(await read('document.querySelectorAll("[data-settings-pane]").length'),0,'Home does not mount configuration editors')
    assert.deepEqual(await read('Array.from(document.querySelectorAll("[data-settings-directory] [data-settings-section]")).map(n=>n.dataset.settingsSection)'),catalog.map(item=>item.id))
    if (mode==='navigation') { await disclosureGeometry(); result.passed=true; return }
    for (const [width,height,label] of [[1440,940,'wide'],[900,620,'short'],[500,840,'compact'],[320,700,'narrow']]) {
      await resize(width,height)
      for (const mode of ['dark','light']) {
        await theme(mode)
        await read('document.querySelector("[data-settings-overview]").scrollTop=0')
        await capture(`home-${label}-${mode}`,'overview',mode)
        const first = await hit(node('[data-settings-shortcut]'),false)
        const footer = await read('document.querySelector(".window-status-bar").getBoundingClientRect().toJSON()')
        assert.ok(first.y>0&&first.y<footer.top,'A priority entry is immediately reachable')
        assert.ok((await hit(node('[aria-label="Close settings"]'))).hit,'Close remains reachable')
        assert.ok((await hit(node('[aria-label="Search settings"]'))).hit,'Search remains reachable')
      }
    }
    await read(`window.originalSettingsArt=${node('.settings-overview__art')}.src;${node('.settings-overview__art')}.src='data:image/png;base64,invalid'`)
    await until(`${node('.settings-overview__art')}.hidden===true`)
    assert.deepEqual(await read('Array.from(document.querySelectorAll("[data-settings-directory] [data-settings-section]")).map(n=>n.dataset.settingsSection)'),catalog.map(item=>item.id),'Missing artwork retains every real destination')
    await capture('home-missing-art','overview','light')
    await read(`${node('.settings-overview__art')}.src=window.originalSettingsArt;${node('.settings-overview__art')}.hidden=false`)
    await resize(1440,940); await theme('dark')
    const home = node('[data-settings-overview]')
    const homeHeight = await read(`({height:${home}.scrollHeight,viewport:${home}.clientHeight})`)
    for (let offset=homeHeight.viewport*.85,part=1;offset<homeHeight.height;offset+=homeHeight.viewport*.85,part++) {
      await read(`${home}.scrollTop=${Math.round(offset)}`)
      await capture(`home-directory-${part}`,'overview','dark','continuation')
      if (offset>=homeHeight.height-homeHeight.viewport) break
    }
    await read(`${home}.scrollTop=0`)
    await click(node('[aria-label="Search settings"]'))
    let focusedShortcut
    for (let step=0;step<60;step++) {
      await key('Tab')
      focusedShortcut=await read('document.activeElement?.dataset.settingsShortcut')
      if (focusedShortcut) break
    }
    assert.ok(focusedShortcut,'Keyboard Tab reaches a priority entry')
    await capture('home-keyboard-focus','overview','dark')
    await key('Enter')
    await until(`!!document.querySelector('[data-settings-pane="${focusedShortcut}"]:not([hidden])')`)
    assert.equal(await title(),catalog.find(entry=>entry.id===focusedShortcut).title,'Keyboard Enter opens the original priority destination')
    result.keyboard={shortcut:focusedShortcut,tab:true,enter:true}
    await resize(320,700)
    await nav('appearance')
    await fill('[aria-label="Terminal font size in pixels"]','19')
    await read(`window.originalSettingsFont=${node('[aria-label="Terminal font size in pixels"]')}`)
    await nav('overview'); await nav('appearance')
    assert.equal(await read(`${node('[aria-label="Terminal font size in pixels"]')}===window.originalSettingsFont`),true,'Visited Appearance keeps the original draft input')
    assert.equal(await read(`${node('[aria-label="Terminal font size in pixels"]')}.value`),'19')
    await fill('[aria-label="Search settings"]','font')
    await until('document.querySelector(".settings-content__header h2")?.textContent==="Search results"')
    await capture('search-narrow','search','light')
    await click(node('[data-settings-search-section="appearance"]'))
    await key('Escape')
    assert.equal(await read(`${node('[aria-label="Search settings"]')}.value`),'')
    assert.equal(await read(`${node('[aria-label="Terminal font size in pixels"]')}.value`),'19','Clearing search retains the original draft')
    assert.equal(await read(`document.activeElement===${node('[aria-label="Search settings"]')}`),true)
    assert.equal(await read('window.settingsHomeProbe.saves.length'),0,'Navigation does not save configuration')
    await capture('appearance-narrow-draft','appearance','light')
    await resize(1440,940)
    await theme('dark'); await disclosureGeometry()
    for (const entry of reviewCatalog) {
      await nav(entry.id)
      const pane = node(`[data-settings-pane="${entry.id}"]`)
      await read(`${pane}.scrollTop=0`)
      for (const mode of ['dark','light']) { await theme(mode); await capture(`page-${entry.id}-${mode}`,entry.id,mode) }
      // Read every vertical segment of long pages for independent complete-page review.
      await theme('dark')
      const dimensions = await read(`({height:${pane}.scrollHeight,viewport:${pane}.clientHeight})`)
      for (let offset=dimensions.viewport*.85,part=1;offset<dimensions.height-dimensions.viewport;offset+=dimensions.viewport*.85,part++) {
        await read(`${pane}.scrollTop=${Math.round(offset)}`)
        await capture(`page-${entry.id}-detail-${part}`,entry.id,'dark','continuation')
      }
      if (dimensions.height>dimensions.viewport+24) {
        await read(`${pane}.scrollTop=${pane}.scrollHeight`)
        await capture(`page-${entry.id}-end`,entry.id,'dark','bottom')
      }
      await read(`${pane}.scrollTop=0`)
      const innerReaders = await read(`(() => {let index=0;return [...${pane}.querySelectorAll('*')].filter(n=>n.checkVisibility()&&n.clientHeight>80&&n.scrollHeight>n.clientHeight+24&&['auto','scroll'].includes(getComputedStyle(n).overflowY)).map(n=>{n.dataset.settingsReviewScroll=String(index++);return {id:n.dataset.settingsReviewScroll,height:n.scrollHeight,viewport:n.clientHeight}})})()`)
      for (const reader of innerReaders) {
        const scroll = `${pane}.querySelector('[data-settings-review-scroll="${reader.id}"]')`
        for (let offset=reader.viewport*.85,part=1;offset<reader.height;offset+=reader.viewport*.85,part++) {
          await read(`${scroll}.scrollTop=${Math.round(offset)}`)
          await capture(`page-${entry.id}-inner-${reader.id}-${part}`,entry.id,'dark','inner continuation')
          if (offset>=reader.height-reader.viewport) break
        }
        await read(`${scroll}.scrollTop=0`)
      }
    }
    for (const {id} of reviewCatalog) {
      await resize(500,840); await nav(id); await theme('light'); await capture(`page-${id}-compact`,id,'light')
      if (id==='agents') {
        const row = '[data-settings-pane="agents"] .settings-agent-templates [data-resource-row="codex"]'
        if (await read(`${node(row)}?.checkVisibility()`)) await click(node(row))
        await until('document.querySelector("[data-resource-editor=codex]")?.checkVisibility()')
        await capture('page-agents-compact-detail',id,'light')
        await read('document.querySelector("[data-settings-pane=agents] .settings-agent-templates .settings-resource-editor").scrollTop=100000')
        await capture('page-agents-compact-detail-end',id,'light','inner bottom')
      }
    }
    await resize(1440,940); await nav('overview'); await theme('dark')
    await click(node('[aria-label="Close settings"]'))
    const avatar = 'Array.from(document.querySelectorAll(".agent-avatar[data-executor-id]")).find(n=>n.checkVisibility())'
    const executorId = await read(`${avatar}?.dataset.executorId`)
    assert.ok(executorId,'The original workbench has an exact Executor identity')
    const target = await hit(avatar)
    win.webContents.sendInputEvent({type:'mouseMove',x:target.x,y:target.y})
    await until('!!document.querySelector(".agent-identity-popover header button")')
    await click(node('.agent-identity-popover header button'))
    await until('!!document.querySelector("[data-settings-pane=agents]:not([hidden])")')
    assert.equal(await title(),'Agents','Actual Avatar direct entry bypasses Home')
    assert.equal(await read(`${node(`[data-resource-editor="${executorId}"]`)}?.isConnected`),true,'The original exact Executor editor is reached')
    result.exactTarget = {executorId,caller:'AgentAvatar -> SettingsNavigation -> App -> SettingsPanel -> AgentSettingsPane'}
    await capture('executor-direct-entry','agents','dark')
    await click(node('[aria-label="Close settings"]'))
    const preserved = await read('window.settingsHomeProbe.surface()')
    result.preserved = preserved
    assert.ok(preserved.references.length>0)
    assert.equal(preserved.exact,true,'Settings preserves the original work surface')
    result.events = await read('window.settingsHomeProbe.events')
    assert.ok(result.events.length>0)
    assert.ok(result.events.some(event=>event.type==='click'&&event.trusted),'The actual App receives trusted pointer input')
    assert.ok(result.events.some(event=>event.type==='input'&&event.trusted),'The actual editor receives trusted text input')
    assert.deepEqual(await read('window.settingsHomeProbe.errors'),[])
    result.passed = true
  } catch (error) {
    result.failure = {name:error.name,message:error.message,stack:error.stack}
    if (win&&!win.isDestroyed()) {
      try { fs.writeFileSync(path.join(evidence,'failure.png'),(await bounded(win.webContents.capturePage(undefined,{stayHidden:true}),'failure capture')).toPNG()) } catch {}
      result.diagnostic = await read('({errors:window.settingsHomeProbe?.errors,text:document.querySelector(".settings-page")?.innerText})').catch(String)
      result.events = await read('window.settingsHomeProbe?.events').catch(String)
    }
  } finally {
    fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2))
    win?.destroy(); app.exit(result.passed?0:1)
  }
})
