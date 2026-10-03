const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')
const [html, privateRoot, evidence, section] = process.argv.slice(2)
assert.ok(section === 'hosts' || section === 'devices')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.setName('Owned Connections Preview')
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]))
const result = { completed: false, section, frames: [], interactions: [],
  boundary: 'Actual SettingsPanel/modules/Panes, original Preview config-edit/save and Store checks, full production CSS in an owned Renderer. Controlled 24 Hosts and exact original DeviceList; device invitation is controlled UI intent, never completed OS authorization; native Electron Renderer input and selection command. No registered Main durability, real SSH, physical compositor qualification, Runtime/Run, user App or installation claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const read = code => win.webContents.executeJavaScript(code)
    const until = async (code, label = code) => {
      const end = Date.now() + 6000
      do { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
      throw new Error('Renderer setup did not settle: ' + label)
    }
    const settle = () => read('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
    const press = async key => {
      const before = await read('window.__connectionsTrustedEvents.length')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
      if (key === 'Enter' || key === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : ' ' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
      await settle()
      const expected = key === 'Down' ? 'ArrowDown' : key === 'Space' ? ' ' : key
      const events = await read(`window.__connectionsTrustedEvents.slice(${before})`)
      assert.ok(events.some(event => event.type === 'keydown' && event.key === expected && event.trusted), 'Actual native key reaches the Renderer with its exact DOM key')
      if (key === 'Enter') assert.ok(events.some(event => event.type === 'click' && event.trusted), 'Complete native Enter sequence activates the original button')
      result.interactions.push({ kind: 'native-renderer-key', electronKey: key, expectedDOMKey: expected, events })
    }
    const pane = '[data-settings-pane="hosts"]'
    const target = 'host-01'
    const nameSelector = pane + ' [data-host-name]'
    const factsOf = selector => `(() => { const node=${selector.startsWith('js:') ? selector.slice(3) : `document.querySelector(${JSON.stringify(selector)})`}; if(!node)return null; const r=node.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const hit=document.elementFromPoint(x,y); return {connected:node.isConnected,visible:node.checkVisibility(),bounds:r.toJSON(),value:node.value,disabled:node.disabled,focused:document.activeElement===node,pseudoFocus:node.matches(':focus'),documentHasFocus:document.hasFocus(),cssHit:!!hit&&(hit===node||node.contains(hit)),x,y}; })()`
    async function click(selector) {
      await read(`(${selector.startsWith('js:') ? selector.slice(3) : `document.querySelector(${JSON.stringify(selector)})`})?.scrollIntoView({block:'nearest',inline:'nearest'})`)
      await settle()
      const facts = await read(factsOf(selector))
      assert.ok(facts && facts.connected && facts.visible && facts.bounds.width > 0 && facts.bounds.height > 0, 'Actual connected visible target: ' + selector)
      assert.equal(facts.cssHit, true, 'Actual CSS hit is the exact target: ' + selector)
      assert.notEqual(facts.disabled, true, 'Target is operable: ' + selector)
      const before = await read('window.__connectionsTrustedEvents.length')
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(facts.x), y: Math.round(facts.y) })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(facts.x), y: Math.round(facts.y) })
      await settle()
      const events = await read(`window.__connectionsTrustedEvents.slice(${before})`)
      assert.ok(events.some(event => event.type === 'click' && event.trusted), 'Actual native click creates a trusted Renderer event')
      result.interactions.push({ kind: 'native-renderer-click', selector, facts, events })
    }
    async function type(selector, value) {
      await click(selector)
      await until(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`, 'Exact input focus')
      win.webContents.selectAll()
      await until(`(() => {const n=document.querySelector(${JSON.stringify(selector)});return n.selectionStart===0&&n.selectionEnd===n.value.length})()`, 'Native Edit selectAll prepares the entire actual value')
      const beforeInsert = await read('window.__connectionsTrustedEvents.length')
      await win.webContents.insertText(value)
      await until(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`, 'Actual input value after native insertText')
      const events = await read(`window.__connectionsTrustedEvents.slice(${beforeInsert})`)
      assert.ok(events.some(event => event.type === 'input' && event.trusted), 'Actual native text entry creates a trusted input event')
      result.interactions.push({ kind: 'native-edit-selectAll-and-insertText', selector, value, events })
    }
    async function typeField(label, value) {
      const index = await read(`(() => {const nodes=[...document.querySelectorAll(${JSON.stringify(pane + ' [data-resource-editor] input,' + pane + ' [data-resource-editor] textarea')})];const input=[...document.querySelectorAll(${JSON.stringify(pane + ' [data-resource-editor] label')})].find(n=>n.querySelector('span')?.textContent?.startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea');return nodes.indexOf(input)})()`)
      assert.ok(index >= 0, 'Actual editor field exists: ' + label)
      const selector = `${pane} [data-resource-editor] :is(input,textarea)`
      await read(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].scrollIntoView({block:'nearest'})`)
      await settle()
      const position = await read(`(() => {const n=document.querySelectorAll(${JSON.stringify(selector)})[${index}],r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,visible:n.checkVisibility(),hit:n.contains(document.elementFromPoint(x,y)),connected:n.isConnected}})()`)
      assert.ok(position.connected && position.visible && position.hit, 'Actual exact field hit: ' + label)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(position.x), y: Math.round(position.y) })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(position.x), y: Math.round(position.y) })
      await until(`document.activeElement===document.querySelectorAll(${JSON.stringify(selector)})[${index}]`)
      win.webContents.selectAll(); await until(`(() => {const n=document.querySelectorAll(${JSON.stringify(selector)})[${index}];return n.selectionStart===0&&n.selectionEnd===n.value.length})()`)
      const beforeInsert = await read('window.__connectionsTrustedEvents.length')
      await win.webContents.insertText(value)
      await until(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].value===${JSON.stringify(value)}`)
      const events = await read(`window.__connectionsTrustedEvents.slice(${beforeInsert})`)
      assert.ok(events.some(event => event.type === 'input' && event.trusted), 'Actual native field entry creates a trusted input event')
      result.interactions.push({ kind: 'native-edit-selectAll-and-insertText', field: label, value, position, events })
    }

    const branch = id => `${pane} [data-host-disclosure="${id}"]`
    const leaf = (id, page = 'connection') => `${branch(id)} [data-host-panel="${page}"]`
    const summary = id => `${branch(id)} > summary`
    const business = () => read('window.connectionsProof.calls.map(call=>call.kind)')
    async function openBranch(id) {
      if (!await read(`document.querySelector(${JSON.stringify(branch(id))})?.open`)) await click(summary(id))
      await until(`document.querySelector(${JSON.stringify(branch(id))})?.open`)
    }
    async function back() {
      await click(`${pane} .settings-resource-back`)
      const facts = await read(`(() => {const n=document.activeElement;return {connected:n?.isConnected,visible:n?.checkVisibility(),id:n?.closest('[data-host-disclosure]')?.dataset.hostDisclosure,panel:n?.dataset.hostPanel,focused:n?.matches(':focus'),documentHasFocus:document.hasFocus()}})()`)
      assert.equal(facts.connected, true); assert.equal(facts.visible, true); assert.equal(facts.focused, true); assert.equal(facts.documentHasFocus, true)
      assert.equal(facts.id, await read(`document.querySelector(${JSON.stringify(pane + ' [data-resource-editor]')}).dataset.resourceEditor`), 'Back returns to the accurate connected original Host submenu')
      result.interactions.push({ kind: 'native-renderer-exact-host-back', facts })
    }
    async function choose(id, page = 'connection') {
      const narrow = await read('innerWidth<720')
      if (narrow && await read(`document.querySelector(${JSON.stringify(pane + ' .settings-resource-workbench')})?.dataset.resourceView==='editor'`)) await back()
      await openBranch(id); await click(leaf(id, page))
      await until(`document.querySelector(${JSON.stringify(pane + ' [data-resource-editor]')})?.dataset.resourceEditor===${JSON.stringify(id)}&&document.querySelector(${JSON.stringify(pane + ' [data-resource-editor]')}).dataset.hostView===${JSON.stringify(page)}`)
      const focused = page === 'connection' && id !== 'local' ? nameSelector : pane + ' [data-resource-editor]'
      const facts = await read(factsOf(focused))
      assert.ok(facts.connected && facts.visible && facts.focused && facts.pseudoFocus && facts.documentHasFocus, 'Host leaf focuses its exact connected visible destination')
      result.interactions.push({ kind: 'native-renderer-exact-host-leaf', id, page, facts })
    }
    async function sectionRoute(id) {
      const sidebar = `[data-settings-target="${id}"]`
      if (await read(`document.querySelector(${JSON.stringify(sidebar)})?.checkVisibility()`)) await click(sidebar)
      else {
        await click('[aria-label="Settings section"]')
        const title = { hosts: 'Remote environments', devices: 'Phones & devices', overview: 'Overview' }[id]
        await until('document.querySelector(".settings-section-menu")')
        const titles = await read('[...document.querySelectorAll(".settings-section-menu__item")].map(n=>n.textContent.trim())')
        const actualTitle = id === 'hosts' ? titles.find(text => text === title || text === 'Hosts' || text === 'Environments') : title
        assert.ok(titles.includes(actualTitle), 'Actual compiled module is present in narrow menu: ' + id)
        await click(`js:[...document.querySelectorAll('.settings-section-menu__item')].find(n=>n.textContent.trim()===${JSON.stringify(actualTitle)})`)
      }
      await until(`document.querySelector('.settings-page')?.dataset.settingsPage===${JSON.stringify(id)}`)
      result.interactions.push({ kind: 'native-renderer-original-section-route', id })
    }
    await until('window.connectionsProof?.ready && document.querySelector(".settings-page")')
    await read(`window.__connectionsTrustedEvents=[]; for(const type of ['click','keydown','keypress','keyup','input'])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key,code:event.code,keyCode:event.keyCode,target:event.target.closest?.('[data-host-disclosure]')?.dataset.hostDisclosure??event.target.tagName}),true)`)
    for (const width of [320, 640, 1480]) for (const theme of ['light', 'dark']) {
      await read('window.connectionsProof.reset()')
      await read('window.connectionsProof.reopen("hosts")')
      await until(`document.querySelector(${JSON.stringify(branch(target))})`)
      await read(`window.connectionsProof.theme(${JSON.stringify(theme)})`)
      win.setContentSize(width, 980)
      await until(`innerWidth===${width} && document.documentElement.dataset.appearance===${JSON.stringify(theme)}`)
      win.showInactive(); win.focus(); win.webContents.focus()
      await until('document.hasFocus()', 'Owned Renderer native focus before input')
      await settle()
      if (width === 320 && theme === 'light') {
        const before = await business()
        await click(summary(target))
        assert.equal(await read(`document.querySelector(${JSON.stringify(branch(target))}).open`), true)
        await press('Enter')
        assert.equal(await read(`document.querySelector(${JSON.stringify(branch(target))}).open`), false, 'Native summary Enter toggles without selecting')
        await press('Space')
        assert.equal(await read(`document.querySelector(${JSON.stringify(branch(target))}).open`), true, 'Native summary Space toggles without selecting')
        assert.equal(await read(`document.querySelector(${JSON.stringify(pane + ' [data-resource-editor]')}).dataset.resourceEditor`), 'local')
        assert.deepEqual(await business(), before, 'Native disclosure activation does not save, Test, read devices or authorize')
        await press('Tab')
        const nativeTab = await read(factsOf(leaf(target)))
        assert.ok(nativeTab.focused && nativeTab.pseudoFocus && nativeTab.visible && nativeTab.connected && nativeTab.documentHasFocus)
        await press('Enter')
        await until(`document.activeElement===document.querySelector(${JSON.stringify(nameSelector)})`)
        result.interactions.push({ kind: 'native-summary-and-leaf-keyboard', callsBefore: before, callsAfter: await business(), nativeTab })
        if (section === 'hosts') {
          await click(`${pane} .settings-pane-toolbar > .small-button`)
          const created = await read(`document.querySelector(${JSON.stringify(pane + ' [data-resource-editor]')}).dataset.resourceEditor`)
          const focus = await read(factsOf(nameSelector))
          assert.ok(focus.connected && focus.visible && focus.focused && focus.pseudoFocus && focus.documentHasFocus)
          assert.notEqual(created, target)
          await click(`${pane} [data-resource-editor] .icon-button--danger`)
          await until('document.querySelector("[role=dialog]")')
          assert.ok((await read('document.querySelector("[role=dialog]").textContent')).includes('0 linked workspace registrations'))
          await click('[data-confirm-label="Remove Host"]')
          await until('!document.querySelector("[role=dialog]")')
          const returnTarget = await read(factsOf(leaf('local')))
          assert.ok(returnTarget.connected && returnTarget.visible && returnTarget.focused && returnTarget.pseudoFocus && returnTarget.documentHasFocus, 'Native removal returns focus to the legal visible original Local leaf')
          assert.equal(await read(`document.querySelectorAll(${JSON.stringify(pane + ' [data-host-disclosure]')}).length`), 24)
          result.interactions.push({ kind: 'native-renderer-create-and-remove-legal-leaf', created, focus, returnTarget })
          await choose(target)
        }
      } else await choose(target)
      if (section === 'hosts') {
        await type(nameSelector, 'Development workspace')
        await typeField('Host or SSH alias', 'development-alias')
        await click(`${pane} .host-edit-disclosure > summary`)
        await until(`document.querySelector(${JSON.stringify(pane + ' .host-edit-disclosure')}).open`)
        await typeField('User', 'authored-user')
        const user = `${pane} .host-edit-disclosure input`
        await read(`window.__connectionsAuthoredInput=document.querySelector(${JSON.stringify(user)})`)
        for (const char of ['x', 'y', 'z']) {
          await win.webContents.insertText(char)
          const facts = await read(`({same:document.querySelector(${JSON.stringify(user)})===window.__connectionsAuthoredInput,connected:window.__connectionsAuthoredInput.isConnected,visible:window.__connectionsAuthoredInput.checkVisibility(),focused:document.activeElement===window.__connectionsAuthoredInput,open:document.querySelector(${JSON.stringify(pane + ' .host-edit-disclosure')}).open})`)
          assert.deepEqual(facts, { same: true, connected: true, visible: true, focused: true, open: true })
          result.interactions.push({ kind: 'native-insertText-character', char, facts })
        }
        const draft = await read(`({name:document.querySelector(${JSON.stringify(nameSelector)}).value,hostname:document.querySelector(${JSON.stringify(pane + ' .host-edit-grid--basic label:nth-child(2) input')}).value,user:document.querySelector(${JSON.stringify(user)}).value})`)
        const beforePanels = await business()
        await choose(target, 'projects')
        const projectsA = await read(`document.querySelector(${JSON.stringify(pane + ' .settings-host-projects')}).textContent`)
        assert.ok(projectsA.includes('Application on A') && projectsA.includes('Library on A') && !projectsA.includes('Application on B'))
        assert.equal(await read(`document.querySelectorAll(${JSON.stringify(pane + ' .host-connection-fields')}).length`), 0)
        await choose('host-02', 'projects')
        const projectsB = await read(`document.querySelector(${JSON.stringify(pane + ' .settings-host-projects')}).textContent`)
        assert.ok(projectsB.includes('Application on B') && !projectsB.includes('Application on A'))
        await choose(target)
        assert.deepEqual(await read(`({name:document.querySelector(${JSON.stringify(nameSelector)}).value,hostname:document.querySelector(${JSON.stringify(pane + ' .host-edit-grid--basic label:nth-child(2) input')}).value,user:document.querySelector(${JSON.stringify(user)}).value})`), draft, 'Exact authored Host survives same-ID projects and B/A')
        assert.equal(await read(`document.querySelector(${JSON.stringify(pane + ' .host-edit-disclosure')}).open`), true)
        assert.deepEqual(await business(), beforePanels, 'Submenus do not Test, save, read authorization or mutate')
        await click(`${pane} [data-resource-editor] header .small-button`)
        await until(`document.querySelector(${JSON.stringify(pane + ' .host-check-detail')})?.textContent.includes('Original diagnostic')`)
        if (width === 320 && theme === 'light') {
          await read(`window.__connectionsOriginalPane=document.querySelector(${JSON.stringify(pane)});window.__connectionsOriginalName=document.querySelector(${JSON.stringify(nameSelector)})`)
          await sectionRoute('devices')
          await until('window.connectionsProof.calls.some(c=>c.kind==="device.ls")')
          await sectionRoute('hosts')
          const continuity = await read(`({pane:document.querySelector(${JSON.stringify(pane)})===window.__connectionsOriginalPane,name:document.querySelector(${JSON.stringify(nameSelector)})===window.__connectionsOriginalName,value:window.__connectionsOriginalName.value,open:document.querySelector(${JSON.stringify(pane + ' .host-edit-disclosure')}).open})`)
          assert.deepEqual(continuity, { pane: true, name: true, value: draft.name, open: true }, 'Visited original Host Pane and input stay mounted across devices')
          const reads = (await business()).filter(kind => kind === 'device.ls').length
          await typeField('Host or SSH alias', 'development-alias-final')
          assert.equal((await business()).filter(kind => kind === 'device.ls').length, reads, 'Hidden device page does not read due to Host edits')
          result.interactions.push({ kind: 'visited-host-device-continuity', continuity, deviceReads: reads })
        }
        await click(`${pane} [data-settings-save-bar] button`)
        await until(`document.querySelector(${JSON.stringify(pane + ' [data-settings-save-bar] button')}).disabled`)
        const saved = await read('window.connectionsProof.current()'), host = saved.hosts.find(host => host.id === target)
        assert.equal(host.label, draft.name); assert.equal(host.user, draft.user); assert.equal(host.runtimeId, 'controlled-bound-runtime')
        assert.equal(host.hostname, width === 320 && theme === 'light' ? 'development-alias-final' : draft.hostname)
        if (width === 320 && theme === 'dark' || width === 640 && theme === 'dark') await choose(target, 'projects')
        else if (width === 320 && theme === 'light') await back()
      } else {
        await type(nameSelector, 'Retained Host draft')
        await read(`window.__connectionsOriginalPane=document.querySelector(${JSON.stringify(pane)});window.__connectionsOriginalName=document.querySelector(${JSON.stringify(nameSelector)})`)
        await sectionRoute('devices')
        const devices = '[data-settings-pane="devices"]'
        await until(`document.querySelector(${JSON.stringify(devices)})?.textContent.includes('Personal phone')`)
        assert.equal((await business()).filter(kind => kind === 'device.ls').length, 1)
        assert.equal((await business()).filter(kind => kind !== 'device.ls').length, 0)
        assert.equal(await read('document.querySelectorAll(".settings-devices-pane").length'), 1, 'Only one original Device module exists')
        if (width === 320 && theme === 'light') {
          const inviteSelector = '[aria-label="短时设备邀请"]'
          await click(`js:[...document.querySelectorAll('${devices} button')].find(n=>n.textContent.includes('生成短时邀请'))`)
          await until(`document.querySelector(${JSON.stringify(inviteSelector)})`)
          assert.equal((await business()).filter(kind => kind === 'device.link').length, 1)
          await sectionRoute('hosts')
          const continuity = await read(`({pane:document.querySelector(${JSON.stringify(pane)})===window.__connectionsOriginalPane,name:document.querySelector(${JSON.stringify(nameSelector)})===window.__connectionsOriginalName,value:window.__connectionsOriginalName.value})`)
          assert.deepEqual(continuity, { pane: true, name: true, value: 'Retained Host draft' })
          assert.equal(await read(`!!document.querySelector(${JSON.stringify(inviteSelector)})`), false)
          const reads = (await business()).filter(kind => kind === 'device.ls').length
          await typeField('Host or SSH alias', 'hidden-draft-update')
          assert.equal((await business()).filter(kind => kind === 'device.ls').length, reads)
          await sectionRoute('devices')
          await until(`window.connectionsProof.calls.filter(c=>c.kind==='device.ls').length===${reads + 1}`)
          assert.equal(await read(`!!document.querySelector(${JSON.stringify(inviteSelector)})`), false, 'Short invitation clears on leaving; return does not auto-generate')
          assert.equal((await business()).filter(kind => kind === 'device.link').length, 1)
          result.interactions.push({ kind: 'native-renderer-device-active-and-invitation-lifetime', continuity, readsBeforeReturn: reads, readsAfterReturn: reads + 1, invitation: 'controlled UI intent only; no OS approval qualification' })
        }
        assert.equal((await business()).filter(kind => /approve|reject|revoke/.test(kind)).length, 0, 'No automatic device authorization mutation')
      }
      const visiblePane = `[data-settings-pane="${section}"]`
      await read(`document.querySelector(${JSON.stringify(visiblePane)}).scrollTop=0;document.querySelector(${JSON.stringify(pane + ' .settings-resource-editor')})?.scrollTo(0,0)`)
      await settle()
      const facts = await read(`(() => {
        const pane=document.querySelector(${JSON.stringify(visiblePane)}),rect=n=>n.getBoundingClientRect().toJSON(),visible=n=>n.isConnected&&n.checkVisibility(),controls=[...pane.querySelectorAll('button,input,select,textarea,summary')].filter(visible);
        const close=document.querySelector('[aria-label="Close settings"]');
        return {theme:document.documentElement.dataset.appearance,colorScheme:getComputedStyle(document.documentElement).colorScheme,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},documentHasFocus:document.hasFocus(),settingsAncestor:!!pane.closest('.settings-page'),
          pane:{bounds:rect(pane),clientWidth:pane.clientWidth,scrollWidth:pane.scrollWidth},
          hosts:pane.querySelectorAll('[data-host-disclosure]').length,editors:[...pane.querySelectorAll('[data-resource-editor]')].map(n=>({id:n.dataset.resourceEditor,panel:n.dataset.hostView,visible:visible(n)})),fields:pane.querySelectorAll('.host-connection-fields input').length,
          library:pane.querySelector('.settings-host-library')?{visible:visible(pane.querySelector('.settings-host-library')),bounds:rect(pane.querySelector('.settings-host-library'))}:null,
          originalDevice:pane.querySelectorAll('.settings-devices-pane').length,clippedControls:controls.filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&(r.left<-.5||r.right>innerWidth+.5)}).map(n=>({tag:n.tagName,text:n.textContent?.slice(0,60),bounds:rect(n)})),
          close:{connected:close.isConnected,visible:visible(close),bounds:rect(close)},calls:window.connectionsProof.calls.slice(),errors:window.connectionsProof.errors.slice()};
      })()`)
      assert.equal(facts.theme, theme); assert.equal(facts.colorScheme, theme); assert.equal(facts.settingsAncestor, true); assert.equal(facts.close.visible, true)
      assert.deepEqual(facts.errors, []); assert.deepEqual(facts.clippedControls, [], 'Original complete Connections controls have no horizontal viewport clipping')
      if (section === 'hosts') { assert.equal(facts.hosts, 24); assert.equal(facts.editors.length, 1); assert.equal(facts.editors[0].id, target); assert.ok(facts.fields === 0 || facts.fields === 8) }
      else { assert.equal(facts.originalDevice, 1); assert.equal(facts.fields, 0) }
      const image = `${section}-${width}-${theme}.png`, png = (await win.webContents.capturePage()).toPNG()
      fs.writeFileSync(path.join(evidence, image), png)
      result.frames.push({ section, width, theme, image, requestedContentSize: { width, height: 980 }, actualContentSize: win.getContentSize(),
        pngPixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, facts })
      if (section === 'hosts' && width === 1480 && theme === 'dark') {
        await type(`${pane} [aria-label="Filter hosts"]`, target)
        assert.equal(await read(`document.querySelectorAll(${JSON.stringify(pane + ' [data-host-disclosure]')}).length`), 1)
        await click(`${pane} [data-resource-editor] .icon-button--danger`)
        await until('document.querySelector("[role=dialog]")')
        assert.ok((await read('document.querySelector("[role=dialog]").textContent')).includes('2 linked workspace registrations'))
        await click('[data-confirm-label="Remove Host"]'); await until('!document.querySelector("[role=dialog]")')
        const filteredReturn = await read(factsOf(leaf('local')))
        assert.ok(filteredReturn.connected && filteredReturn.visible && filteredReturn.focused && filteredReturn.pseudoFocus && filteredReturn.documentHasFocus, 'Exact filtered deletion returns native focus to the original visible Local leaf')
        assert.equal(await read(`document.querySelector(${JSON.stringify(pane + ' [aria-label="Filter hosts"]')}).value`), '')
        const afterFiltered = await read('window.connectionsProof.current()')
        assert.equal(afterFiltered.hosts.some(host => host.id === target), false)
        assert.equal(afterFiltered.workspaces.some(workspace => workspace.hostId === target), false)
        result.interactions.push({ kind: 'native-renderer-filtered-host-deletion', input: target, filteredReturn })
        await read('window.connectionsProof.seedFinalEditable()')
        await until(`document.querySelectorAll(${JSON.stringify(pane + ' [data-host-disclosure]')}).length===2`)
        await choose('host-02')
        await click(`${pane} [data-resource-editor] .icon-button--danger`)
        await until('document.querySelector("[role=dialog]")')
        assert.ok((await read('document.querySelector("[role=dialog]").textContent')).includes('1 linked workspace registrations'))
        await click('[data-confirm-label="Remove Host"]'); await until('!document.querySelector("[role=dialog]")')
        const lastReturn = await read(factsOf(leaf('local')))
        assert.ok(lastReturn.connected && lastReturn.visible && lastReturn.focused && lastReturn.pseudoFocus && lastReturn.documentHasFocus, 'Deleting the last editable SSH object returns native focus to the legal original Local leaf')
        assert.deepEqual((await read('window.connectionsProof.current()')).hosts.map(host => host.id), ['local'])
        result.interactions.push({ kind: 'native-renderer-last-editable-host-deletion', input: 'host-02', lastReturn, boundary: 'Valid controlled Local plus one SSH configuration; Local remains nondeletable. No Main or Runtime mutation.' })
      }
      await click('[aria-label="Close settings"]'); await until('!document.querySelector(".settings-page")')
      assert.equal(await read('document.querySelectorAll("[data-resource-editor],.settings-devices-pane").length'), 0, 'Original production Close only unmounts owned SettingsPanel')
    }
    assert.equal(result.frames.length, 6); assert.equal(await read('window.connectionsProof.closeCount'), 6)
    result.completed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      result.failureObserved = await win.webContents.executeJavaScript('({errors:window.connectionsProof?.errors,calls:window.connectionsProof?.calls,text:document.body.innerText.slice(0,3000),active:document.activeElement?.outerHTML,appearance:document.documentElement.dataset.appearance})').catch(() => null)
      fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    win?.destroy(); app.exit(result.completed ? 0 : 1)
  }
})
