const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, mode = 'matrix'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const titles = ['Appearance', 'Notifications', 'Browser', 'General', 'Agents', 'Prompts', 'Workspaces', 'Hosts']
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', mode, frames: [], actions: [],
  boundary: 'Actual App/Settings/CSS/public Preview, trusted Electron Renderer input. No Runtime, durable restart, file manager or installation.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 960, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    win.webContents.focus()
    win.webContents.on('console-message', (_event, ...details) => console.error('renderer-console', ...details))
    const read = async expression => {
      try { return await win.webContents.executeJavaScript(expression) }
      catch(error) { throw new Error(`Renderer expression failed: ${expression}\n${error.message}`, {cause:error}) }
    }
    const node = selector => `document.querySelector(${JSON.stringify(selector)})`
    const until = async expression => {
      const end = Date.now() + 6000
      do { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
      throw new Error(`Structure proof did not settle: ${expression}`)
    }
    const settle = async () => {
      await read('document.fonts.ready')
      await read('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const hit = expression => read(`(() => {const n=${expression};if(!n?.isConnected||!n.checkVisibility())throw Error('Missing visible connected control');const r=n.getBoundingClientRect();return{label:n.getAttribute('aria-label')||n.textContent.trim(),rect:r.toJSON(),viewport:{width:innerWidth,height:innerHeight},x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hits:[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>n.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)))};})()`)
    const assertHit = geometry => { assert.ok(geometry.width > 0 && geometry.height > 0); assert.deepEqual(geometry.hits, [true,true,true,true,true], `Control has five actual CSS hits: ${JSON.stringify(geometry)}`) }
    const click = async (expression, label) => {
      const geometry = await hit(expression); assertHit(geometry)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y })
      result.actions.push({ label, geometry }); return geometry
    }
    const key = (keyCode, modifiers) => { win.webContents.sendInputEvent({ type:'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type:'keyUp', keyCode, modifiers }) }
    const capture = async file => { await settle(); fs.writeFileSync(path.join(evidence,file), (await win.webContents.capturePage()).toPNG()) }
    const footerHits = async () => {
      const controls = `Array.from(document.querySelectorAll('.window-status-bar button')).filter(n=>n.checkVisibility()&&n.getBoundingClientRect().width>0)`
      const count = await read(`${controls}.length`); assert.ok(count>=5)
      const found = []
      for(let i=0;i<count;i++) {const geometry=await hit(`${controls}[${i}]`);assertHit(geometry);found.push(geometry)}
      return found
    }
    const sampleCounts = async () => {
      const sample = await read('window.structureProbe.counts()');await settle()
      assert.deepEqual(sample.counts,[{status:'working',count:12},{status:'error',count:12}])
      sample.actual = await read(`Array.from(document.querySelectorAll('.window-status-bar [data-focus-count]')).map(n=>({kind:n.dataset.focusCount,text:n.textContent.trim()}))`)
      assert.deepEqual(sample.actual,[{kind:'working',text:'12'},{kind:'attention',text:'12'}], 'Two-digit count facts are consumed by the actual status controls')
      sample.footerHits = await footerHits(); sample.file='320-dark-footer-two-digit-counts.png';await capture(sample.file)
      await read('window.structureProbe.restoreCounts()');await settle();return sample
    }
    const nav = async title => {
      if (await read(`${node('.settings-section-picker')}.checkVisibility()`)) {
        await click(node('.settings-section-picker'), 'Open section picker')
        await until('!!document.querySelector(".settings-section-menu[role=menu]")'); await settle()
        const actual = await read(`Array.from(document.querySelectorAll('.settings-section-menu [role=menuitemradio]')).map(n=>n.textContent.trim())`)
        assert.deepEqual(actual, titles, 'Eight actual compact navigation entries are nonempty and complete')
        const index = actual.indexOf(title); assert.ok(index >= 0)
        key('Home'); await until(`document.activeElement===document.querySelectorAll('.settings-section-menu [role=menuitemradio]')[0]`)
        for (let i=1;i<=index;i++) { key('Down'); await until(`document.activeElement===document.querySelectorAll('.settings-section-menu [role=menuitemradio]')[${i}]`) }
        key('Return'); await until('!document.querySelector(".settings-section-menu[role=menu]")')
      } else {
        const buttons = await read(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).map(n=>n.textContent.trim())`)
        assert.deepEqual(buttons, titles, 'Eight actual sidebar navigation entries are nonempty and complete')
        await click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find(n=>n.textContent.trim()===${JSON.stringify(title)})`, title)
      }
      await until(`document.querySelector('.settings-content__header h2')?.textContent===${JSON.stringify(title)}`); await settle()
    }
    const surface = async () => {
      const actual = await read('window.structureProbe.surface()')
      assert.equal(actual.references.length, 8)
      for (const reference of actual.references) assert.equal(reference.same,true,`Original ${reference.key} reference changed`)
      assert.equal(actual.exact, true, 'Original workbench facts remain exact')
      return actual
    }
    await until('window.structureProbe?.ready && !!document.querySelector(".window-status-bar [aria-label=Settings]")')
    // Preview starts with two real Sessions but no opened Tab. Select an existing
    // Session through the actual Project Activity menu before taking the baseline.
    const initial = await read('window.structureProbe.beginSurface()')
    if (initial.tabs === 0) {
      await click(`Array.from(document.querySelectorAll('.project-activity')).find(n=>n.checkVisibility())`, 'Open existing activity')
      await until(`!!document.querySelector('.project-activity-group__summary')`); await settle()
      await click(node('.project-activity-group__summary'), 'Select existing Session')
      await until(`window.structureProbe.beginSurface().tabs>0`); await settle()
    }
    result.original = await read('window.structureProbe.beginSurface()')
    assert.ok(result.original.tabs > 0 && result.original.sessions > 0 && result.original.layouts > 0, 'Original public Preview workbench is nonempty')
    await click(node('.window-status-bar [aria-label=Settings]'), 'Ordinary Settings')
    await until('!!document.querySelector(".settings-page")'); await settle()
    assert.equal(await read(`document.querySelector('.settings-content__header h2').textContent`), 'Appearance', 'Actual ordinary Settings entry opens Appearance')
    assert.deepEqual(await read(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] p')).map(n=>n.textContent)`), ['Preferences','Resources'], 'Complete preference/resource groups are nonempty')
    if (mode === 'footer') {
      win.setContentSize(320,900);await until('innerWidth===320')
      await read('window.structureProbe.theme("dark")');await until('document.documentElement.dataset.appearance==="dark"');await settle()
      result.footer = await footerHits()
      result.countSample = await sampleCounts()
      await click(node('[aria-label="Close settings"]'),'Close footer sample');await until('!document.querySelector(".settings-page")')
      result.closedSurface = await surface();result.passed=true;return
    }
    await nav('General')
    const toggle = node('[data-settings-pane=general] input[type=checkbox]')
    const save = node('[data-settings-pane=general] [data-settings-save-bar] button')
    const beforeConfig = await read('window.structureProbe.config()')
    const draft = beforeConfig.copyPathsAsAbsolute !== true
    await read(`window.originalGeneralToggle=${toggle}`)
    await click(toggle, 'Copied paths toggle')
    await until(`${toggle}.checked===${draft}`)
    assert.equal(await read(`${save}.disabled`), false)
    await nav('Appearance'); await nav('General')
    assert.equal(await read(`${toggle}===window.originalGeneralToggle`), true, 'Visited General preserves the original mounted draft control')
    assert.equal(await read(`${toggle}.checked`), draft, 'Visited General retains the unsaved copied paths draft')
    assert.equal(await read(`${save}.disabled`), false)
    assert.ok(await read(`${node('[data-settings-pane=general] [data-settings-save-bar]')}.textContent.includes('Unsaved changes')`))
    await click(save, 'Save copied paths'); await settle()
    const calls = await read('window.structureProbe.saves')
    assert.equal(calls.length, 1, 'General save reaches the original public config owner exactly once')
    assert.deepEqual(calls[0].next, { ...beforeConfig, copyPathsAsAbsolute: draft })
    assert.deepEqual(calls[0].expected, { ...beforeConfig, copyPathsAsAbsolute: beforeConfig.copyPathsAsAbsolute === true })
    const savedConfig = await read('window.structureProbe.config()')
    assert.deepEqual(savedConfig, { ...beforeConfig, copyPathsAsAbsolute: draft })
    await until(`${save}.disabled`)
    result.generalSave = { calls, savedConfig, originalMountedControl: true, dirtySurvivedNavigation: true }
    await nav('Appearance')
    const font = node('[aria-label="Terminal font size in pixels"]')
    await read(`window.originalFont=${font}`)
    await click(font, 'Font size')
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyDown', key:'a', code:'KeyA', modifiers:4, windowsVirtualKeyCode:65, commands:['selectAll'] })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyUp', key:'a', code:'KeyA', modifiers:4, windowsVirtualKeyCode:65 })
    key('Backspace')
    await until(`${font}.value===''`)
    const fontSteps = []
    for (const digit of ['1','8']) {
      await win.webContents.insertText(digit); await settle()
      const value = await read(`${font}.value`)
      fontSteps.push(value); assert.equal(value, fontSteps.length===1?'1':'18')
      assert.equal(await read(`document.activeElement===${font}`),true)
    }
    await nav('General'); await nav('Appearance')
    assert.equal(await read(`${font}===window.originalFont && ${font}.value==='18'`), true, 'Visited Appearance retains its raw font draft and control')
    const appearanceSave = node('[data-settings-pane=appearance] [data-settings-save-bar] button')
    assert.equal(await read(`${appearanceSave}.disabled`),false)
    await click(appearanceSave, 'Save appearance'); await until(`${appearanceSave}.disabled`)
    result.font = { steps: fontSteps, originalMountedControl: true, saved: true }
    await nav('General')
    const diagnostic = node('[data-settings-pane=general] .settings-diagnostics button')
    await read(`${diagnostic}.scrollIntoView({block:'nearest'})`); await settle()
    const priorCalls = await read('window.structureProbe.saves.length')
    await click(diagnostic, 'Show crash log'); await until('window.structureProbe.diagnostics.length===1'); await settle()
    assert.equal(await read('window.structureProbe.saves.length'), priorCalls, 'Diagnostics is separate from configuration saving')
    result.diagnostics = await read('window.structureProbe.diagnostics')
    assert.equal(result.diagnostics[0].outcome,'check-failed')
    assert.equal(result.diagnostics[0].cause.code,'CONTROL_UNAVAILABLE', 'Actual Preview reports its Desktop-host boundary honestly')
    if (mode === 'matrix') for (const width of [1480,420,320]) {
      win.setContentSize(width, width===1480?960:900); await until(`innerWidth===${width}`)
      for (const theme of ['dark','light']) {
        await read(`window.structureProbe.theme(${JSON.stringify(theme)})`)
        await until(`document.documentElement.dataset.appearance===${JSON.stringify(theme)}`)
        for (const title of titles) {
          await nav(title)
          await read(`document.querySelector('[data-settings-pane]:not([hidden])').scrollTop=0`); await settle()
          const actual = await read(`(() => {
            const pane=document.querySelector('[data-settings-pane]:not([hidden])'),header=document.querySelector('.settings-content__header');
            const rect=n=>n.getBoundingClientRect().toJSON(),text=n=>{const range=document.createRange();range.selectNodeContents(n);return{text:n.textContent.trim(),lines:Array.from(range.getClientRects()).filter(r=>r.width>0&&r.height>0).map(r=>r.toJSON())}};
            const bar=pane.querySelector('[data-settings-save-bar]');
            return {id:pane.dataset.settingsPane,pane:rect(pane),header:rect(header),title:text(header.querySelector('h2')),description:text(header.querySelector('p')),
              overflow:pane.scrollWidth-pane.clientWidth,bodyText:pane.innerText,save:bar?{rect:rect(bar),text:bar.textContent,button:rect(bar.querySelector('button'))}:null,
              longText:Array.from(pane.querySelectorAll('p,dd,label small,.settings-footnote,.settings-notice')).filter(n=>n.checkVisibility()&&n.textContent.trim()).map(text),
              status:rect(document.querySelector('.window-status-bar')),page:rect(document.querySelector('.settings-page')),
              workspaceInert:document.querySelector('.app-shell__workspace').inert,footerInert:!!document.querySelector('.window-status-bar').closest('[inert]')};})()`)
          assert.equal(actual.id,title.toLowerCase()); assert.equal(actual.title.text,title)
          assert.ok(actual.bodyText.length > 0 && actual.description.text.length > 0)
          for (const text of [actual.title,actual.description]) {
            assert.ok(text.lines.length > 0, 'Header has complete nonempty text Range')
            for (const line of text.lines) assert.ok(line.x>=actual.header.x-1&&line.right<=actual.header.right+1&&line.y>=actual.header.y-1&&line.bottom<=actual.header.bottom+1, 'Complete header text stays within the actual header')
          }
          for (const text of actual.longText) { assert.ok(text.lines.length > 0); for (const line of text.lines) assert.ok(line.x>=actual.pane.x-1&&line.right<=actual.pane.right+1, 'Long pane text is not horizontally clipped') }
          assert.ok(actual.overflow <= 1); assert.equal(actual.status.height,32); assert.ok(actual.page.bottom<=actual.status.y+1)
          assert.equal(actual.workspaceInert,true); assert.equal(actual.footerInert,false)
          if (actual.save) { assert.ok(actual.save.rect.y>=actual.pane.y-1&&actual.save.rect.bottom<=actual.status.y+1, 'Original Save bar remains reachable'); assert.ok(actual.save.button.width>0) }
          const footer = await footerHits()
          const file=`${width}-${theme}-${title.toLowerCase()}.png`
          await capture(file); result.frames.push({width,theme,title,file,actual,footerHits:footer})
          if (title==='General') {
            await read(`${diagnostic}.scrollIntoView({block:'nearest'})`); await settle()
            const geometry=await hit(diagnostic); assertHit(geometry)
            const privacy=await read(`${node('[data-settings-pane=general] .settings-diagnostics > span')}.firstChild.textContent.trim()`)
            assert.equal(privacy,'Crashes are recorded to a local file and never uploaded.')
            const diagnosticFile=`${width}-${theme}-general-diagnostics.png`
            await capture(diagnosticFile); result.frames.at(-1).diagnostic={geometry,privacy,file:diagnosticFile}
          }
        }
      }
    }
    if (mode === 'matrix') {
      win.setContentSize(320,900); await until('innerWidth===320')
      await read('window.structureProbe.theme("dark")'); await until('document.documentElement.dataset.appearance==="dark"')
      result.countSample = await sampleCounts()
    }
    assert.equal(result.frames.length,mode==='matrix'?48:0)
    await click(node('[aria-label="Close settings"]'), 'Close settings'); await until('!document.querySelector(".settings-page")')
    result.closedSurface = await surface()
    if (mode !== 'owning') {
    win.setContentSize(1480,960); await settle()
    await click(node('.window-status-bar [aria-label=Settings]'), 'Reopen ordinary Settings')
    await until('!!document.querySelector(".settings-page")'); await settle()
    assert.equal(await read(`document.querySelector('.settings-content__header h2').textContent`),'Appearance','Reopened actual ordinary entry remains Appearance')
    await nav('Workspaces')
    await click(node('[aria-label="Close settings"]'),'Close resource settings'); await until('!document.querySelector(".settings-page")')
    result.resourceSurface = await surface()
    } else result.resourceReturn = 'not-qualified-in-partial-owning-mode'
    result.events = await read('window.structureProbe.events')
    assert.ok(result.events.length>0)
    const derived = []
    for(const [index,event] of result.events.entries()) {
      if(event.trusted) continue
      const origin=result.events[index-1]
      assert.equal(event.type,'click','Only the original Radix keyboard selection may derive a click')
      assert.equal(event.role,'menuitemradio')
      assert.ok(origin?.trusted && origin.type==='keydown' && origin.key==='Enter' && origin.receiver===event.receiver && origin.role===event.role && origin.label===event.label,
        'A derived Radix item click is paired with the immediately preceding trusted Enter on the exact radio target')
      derived.push({index,origin,event})
    }
    result.radixKeyboardDerivedClicks=derived
    if(mode==='matrix') {
      assert.equal(derived.length,32,'Four compact-menu passes select eight exact radio targets through trusted Enter')
      const menuKeys=result.events.filter(event=>event.type==='keydown'&&event.role==='menuitemradio')
      assert.ok(menuKeys.length>0);for(const event of menuKeys)assert.equal(event.trusted,true)
    }
    result.runtime = await read('({userAgent:navigator.userAgent})')
    result.passed=true
  } catch(error) {
    result.failure={name:error.name,message:error.message,stack:error.stack}
    if(win) { result.failure.ui=await win.webContents.executeJavaScript(`({title:document.querySelector('h2')?.textContent,active:document.activeElement?.outerHTML,events:window.structureProbe?.events})`).catch(()=>null);fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG()) }
  } finally { fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1) }
})
