const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', frames: [], scopes: [], navigation: [],
  boundary: 'Actual SettingsPanel/Agents/product CSS and trusted input with the original Preview API; no native CLI, Runtime, Run, restart or installation claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); win.webContents.focus()
    const read = expression => win.webContents.executeJavaScript(expression)
    const node = selector => `document.querySelector(${JSON.stringify(selector)})`
    const until = async expression => {
      const end = Date.now() + 4000
      do { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
      throw new Error(`Agents toolbar did not settle: ${expression}`)
    }
    const settle = async () => {
      await read('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const key = (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
    const chooseByTyping = label => {
      const character=label[0];assert.ok(character)
      win.webContents.sendInputEvent({type:'keyDown',keyCode:character})
      win.webContents.sendInputEvent({type:'char',keyCode:character})
      win.webContents.sendInputEvent({type:'keyUp',keyCode:character})
    }
    const hit = expression => read(`(() => {const n=${expression};if(!n?.isConnected||!n.checkVisibility())throw Error('Missing visible connected control');
      const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,
      hits:[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>n.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)))};})()`)
    const assertHit = geometry => assert.ok(geometry.width>0 && geometry.height>0 && geometry.hits.length===5 && geometry.hits.every(Boolean), 'Five actual CSS control hits')
    const click = async expression => {
      const geometry = await hit(expression); result.lastHit={expression,...geometry}; assertHit(geometry)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y }); return geometry
    }
    const replace = async (expression, value) => {
      await click(expression); win.webContents.selectAll(); key('Backspace'); await until(`${expression}.value===""`); win.webContents.insertText(value)
      await until(`${expression}.value===${JSON.stringify(value)}`)
    }
    const filter = node('[aria-label="Filter executors"]'), host = node('.settings-detection-tools select'), refresh = node('[aria-label="Refresh saved executor availability"]')
    await until('window.__agentsToolbar?.ready && window.__settingsSearchRefinement?.ready')
    result.preservedBefore = await read('window.__agentsToolbar.preserved()')
    await click(node('[aria-label="Search settings"]')); win.webContents.insertText('executor')
    await until('document.querySelector(".settings-content__header h2")?.textContent==="Agents"'); await settle()
    const original = await read('Array.from(document.querySelectorAll(".agent-settings-card")).map(n=>n.id)'); assert.ok(original.length>0)
    await click(node('.agent-settings-card summary')); await settle()
    const name = node('.agent-settings-card [data-executor-name]')
    await replace(name, 'Toolbar retained draft')
    const launch = node('.agent-settings-card .settings-launch-config summary')
    await read(`${launch}.scrollIntoView({block:'center'})`); await settle(); await click(launch); await settle()
    const command = node('.agent-settings-card .settings-launch-config__fields > label input')
    const oldCommand = await read(`${command}.value`), draftCommand = `${oldCommand}-draft`
    await read(`${command}.scrollIntoView({block:'center'})`); await settle(); await replace(command, draftCommand)
    await read(`window.__toolbarNodes={card:document.querySelector('.agent-settings-card'),name:${name},command:${command},filter:${filter}}`)
    const assertDraft = async () => {
      const actual = await read(`({sameCard:window.__toolbarNodes.card===document.querySelector('.agent-settings-card'),sameName:window.__toolbarNodes.name===${name},sameCommand:window.__toolbarNodes.command===${command},sameFilter:window.__toolbarNodes.filter===${filter},open:window.__toolbarNodes.card.open,launchOpen:window.__toolbarNodes.command.closest('details').open,name:window.__toolbarNodes.name.value,command:window.__toolbarNodes.command.value})`)
      assert.deepEqual(actual, { sameCard: true, sameName: true, sameCommand: true, sameFilter: true, open: true, launchOpen: true, name: 'Toolbar retained draft', command: draftCommand }); return actual
    }
    await read("document.querySelector('[data-settings-pane=agents]').scrollTop=0"); await settle()
    for (const labelMode of ['short', 'long']) {
      await read(`window.__agentsToolbar.hostLabel(${JSON.stringify(labelMode)})`); await settle(); await assertDraft()
      for (const width of [320, 420, 640, 1480]) {
        win.setContentSize(width, 900); await until(`innerWidth===${width}`); await settle(); await assertDraft()
        await read("document.querySelector('[data-settings-pane=agents]').scrollTop=0"); await settle()
        for (const mode of ['empty', 'query']) {
          const filterHit = await click(filter)
          key('Tab', ['shift']); await until(`document.activeElement===${node('[aria-label="Close settings"]')}`)
          key('Tab'); await until(`document.activeElement===${filter}`)
          win.webContents.selectAll(); key('Backspace'); await until(`${filter}.value===""`)
          if (mode==='query') { win.webContents.insertText('readable-filter-query'); await until(`${filter}.value==="readable-filter-query"`) }
          await settle()
          const actual = await read(`(() => {const pane=document.querySelector('[data-settings-pane="agents"]'),tool=pane.querySelector('.settings-executor-tools'),search=tool.querySelector('.settings-resource-search'),input=search.querySelector('input'),group=tool.querySelector('.settings-detection-tools'),select=group.querySelector('select'),button=group.querySelector('button'),rect=n=>n.getBoundingClientRect().toJSON();
            return {pane:{connected:pane.isConnected,visible:pane.checkVisibility(),hidden:pane.hidden,inert:pane.inert,rect:rect(pane)},toolbar:rect(tool),search:rect(search),input:{rect:rect(input),value:input.value,focused:document.activeElement===input,scrollLeft:input.scrollLeft,scrollWidth:input.scrollWidth,clientWidth:input.clientWidth},
              detection:rect(group),host:{rect:rect(select),value:select.value,options:Array.from(select.options).map(n=>({value:n.value,label:n.textContent}))},refresh:{rect:rect(button),disabled:button.disabled,label:button.getAttribute('aria-label')},
              style:{wrap:getComputedStyle(tool).flexWrap,basis:getComputedStyle(search).flexBasis},cards:Array.from(pane.querySelectorAll('.agent-settings-card')).map(n=>({id:n.id,hidden:n.hidden})),empty:pane.querySelector('.settings-resource-empty')?.textContent,
              save:{text:pane.querySelector('.settings-pane-actions').textContent,disabled:pane.querySelector('.settings-pane-actions button').disabled},status:rect(document.querySelector('.window-status-bar')),page:rect(document.querySelector('.settings-page'))};})()`)
          const image = `${labelMode}-${width}-${mode}.png`; await settle(); fs.writeFileSync(path.join(evidence,image),(await win.webContents.capturePage()).toPNG())
          result.frames.push({ labelMode, width, mode, actual, filterHit, image })
          assert.equal(actual.pane.connected,true); assert.equal(actual.pane.visible,true); assert.equal(actual.pane.hidden,false); assert.equal(actual.pane.inert,false)
          assert.equal(actual.input.focused,true); assert.equal(actual.input.value,mode==='empty'?'':'readable-filter-query'); assert.deepEqual(actual.cards.map(card=>card.id),original)
          assert.equal(actual.save.disabled,false); assert.ok(actual.save.text.includes('Unsaved changes')); assert.equal(actual.status.height,32); assert.ok(actual.page.bottom<=actual.status.y+1)
          assert.ok(actual.host.options.length>0); assert.equal(actual.refresh.label,'Refresh saved executor availability')
          for(const rect of [actual.search,actual.input.rect,actual.detection,actual.host.rect,actual.refresh.rect]) assert.ok(rect.width>0 && rect.height>0 && rect.x>=actual.toolbar.x-1 && rect.right<=actual.toolbar.right+1 && rect.y>=actual.toolbar.y-1 && rect.bottom<=actual.toolbar.bottom+1,'Original tools stay inside their real nonzero container')
          if(labelMode==='long' && width!==1480) assert.ok(actual.detection.y>=actual.search.bottom,'Long Host keeps the entire search on its own row at narrow content widths')
          if(width===1480) assert.ok(actual.detection.y<actual.search.bottom,'Wide content keeps both original tool groups on one row')
          if(mode==='query') { assert.equal(actual.input.scrollLeft,0,'Entered short query is fully readable'); assert.ok(actual.input.scrollWidth<=actual.input.clientWidth+1,'Entered short query fits the actual visible input'); assert.ok(actual.empty.includes('readable-filter-query')); assert.ok(actual.cards.length>0 && actual.cards.every(card=>card.hidden)) }
          else assert.ok(actual.cards.length>0 && actual.cards.every(card=>!card.hidden))
          const frame=result.frames.at(-1); frame.draft=await assertDraft(); frame.hostHit=await hit(host); frame.refreshHit=await hit(refresh); frame.saveHit=await hit(node('[data-settings-pane="agents"] .settings-pane-actions button')); frame.closeHit=await hit(node('[aria-label="Close settings"]'))
          for(const geometry of [frame.hostHit,frame.refreshHit,frame.saveHit,frame.closeHit])assertHit(geometry)
          const footerCount=await read('document.querySelectorAll(".window-status-bar button").length'); assert.ok(footerCount>0); frame.footerHits=[]
          for(let index=0;index<footerCount;index++){const geometry=await hit(`document.querySelectorAll('.window-status-bar button')[${index}]`);assertHit(geometry);frame.footerHits.push(geometry)}
        }
        // Select through native keyboard traversal, then observe the original Store's Preview API calls.
        const labels=await read(`Array.from(${host}.options).map(n=>n.textContent)`),options=await read(`Array.from(${host}.options).map(n=>n.value)`);assert.ok(options.length>=2);assert.equal(await read(`${host}.value`),options[0]);assert.notEqual(labels[0][0].toLowerCase(),labels[1][0].toLowerCase())
        key('Tab');await until(`document.activeElement===${host}`)
        const start=await read('window.__agentsToolbar.checks.length');chooseByTyping(labels[1]);await until(`${host}.value===${JSON.stringify(options[1])}`)
        await until(`window.__agentsToolbar.checks.length===${start+original.length} && !${refresh}.disabled`)
        const selected=await read('window.__agentsToolbar.checks.slice('+start+')');assert.deepEqual(selected.map(check=>check.executorId),original.map(id=>id.replace('executor-settings-','')));assert.ok(selected.length>0 && selected.every(check=>check.hostId===options[1] && check.input.host.id===options[1]))
        const before=await read('({checks:window.__agentsToolbar.checks.length,saves:window.__agentsToolbar.saves.length,saved:window.__agentsToolbar.saved()})')
        const refreshHit=await click(refresh);await until(`window.__agentsToolbar.checks.length===${before.checks+original.length} && !${refresh}.disabled`)
        const after=await read(`({checks:window.__agentsToolbar.checks.slice(${before.checks}),saves:window.__agentsToolbar.saves.length,saved:window.__agentsToolbar.saved()})`)
        assert.equal(after.saves,before.saves);assert.deepEqual(after.saved,before.saved);assert.equal(after.checks.length,original.length);assert.ok(after.checks.length>0 && after.checks.every(check=>check.hostId===options[1] && check.input.host.id===options[1]));assert.ok(after.checks.every(check=>check.input.command===before.saved.executors[check.executorId].command));await assertDraft()
        result.scopes.push({labelMode,width,selected,refreshed:after.checks,refreshHit,configUnchanged:true,draftNotChecked:true})
        await click(filter);key('Tab');await until(`document.activeElement===${host}`)
        const returning=await read('window.__agentsToolbar.checks.length');chooseByTyping(labels[0]);await until(`${host}.value===${JSON.stringify(options[0])} && window.__agentsToolbar.checks.length===${returning+original.length} && !${refresh}.disabled`)
      }
    }
    await replace(filter,'');await settle();await assertDraft()
    const beforeSave=await read('({saved:window.__agentsToolbar.saved(),count:window.__agentsToolbar.saves.length})')
    const saveHit=await click(node('[data-settings-pane="agents"] .settings-pane-actions button'))
    await until('document.querySelector("[data-settings-pane=agents] .settings-pane-actions").textContent.includes("Changes saved")')
    const save=await read(`window.__agentsToolbar.saves[${beforeSave.count}]`),saved=await read('window.__agentsToolbar.saved()')
    const firstId=original[0].replace('executor-settings-',''),expectedNext={...beforeSave.saved.executors,[firstId]:{...beforeSave.saved.executors[firstId],label:'Toolbar retained draft',command:draftCommand}}
    assert.deepEqual(save.expected.executors,beforeSave.saved.executors);assert.deepEqual(save.next.executors,expectedNext);assert.deepEqual(saved.executors,expectedNext)
    result.save={saveHit,expected:save.expected.executors,next:save.next.executors,published:saved.executors}
    const close=await click(node('[aria-label="Close settings"]'));await until('!document.querySelector(".settings-page")')
    const reopen=await click(node('.window-status-bar [aria-label="Settings"]'));await until('document.querySelector(".settings-page")');await settle();result.navigation.push({close,reopen})
    result.preservedAfter=await read('window.__agentsToolbar.preserved()');assert.deepEqual(result.preservedAfter,result.preservedBefore)
    result.events=await read('window.__agentsToolbar.events');const inputs=result.events.filter(event=>event.type==='input'&&event.label==='Filter executors'&&event.value==='readable-filter-query')
    assert.equal(inputs.length,8);assert.ok(inputs.every(event=>event.trusted))
    const hostChanges=result.events.filter(event=>event.type==='change'&&event.label==='Check on');assert.equal(hostChanges.length,16);assert.ok(hostChanges.every(event=>event.trusted))
    const refreshClicks=result.events.filter(event=>event.type==='click'&&event.label==='Refresh saved executor availability');assert.equal(refreshClicks.length,8);assert.ok(refreshClicks.every(event=>event.trusted))
    for(const label of ['Close settings','Settings']){const clicks=result.events.filter(event=>event.type==='click'&&event.label?.trim()===label);assert.equal(clicks.length,1);assert.ok(clicks[0].trusted)}
    assert.equal(result.frames.length,16);assert.equal(result.scopes.length,8);result.passed=true
  } catch(error) {result.failure={name:error.name,message:error.message,stack:error.stack};if(win){result.failureObserved=await win.webContents.executeJavaScript('({events:window.__agentsToolbar?.events,active:{tag:document.activeElement?.tagName,value:document.activeElement?.value,label:document.activeElement?.getAttribute("aria-label")},fields:Array.from(document.querySelectorAll(".agent-settings-card input")).map(n=>({value:n.value,visible:n.checkVisibility(),connected:n.isConnected}))})');fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}}
  finally {fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)}
})
