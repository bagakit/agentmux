const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')
const { nativeRendererInput } = require('./native-input.cjs')
const [html, privateRoot, evidence, section] = process.argv.slice(2)
assert.equal(section, 'hosts')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.setName('Owned Connections Preview')
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]))
const result = { completed: false, section, frames: [], interactions: [],
  boundary: 'Actual SettingsPanel/modules/Panes, original Preview config-edit/save and Store checks, full production CSS in an owned Renderer. Controlled 24 Hosts and exact original DeviceList; remote observations are explicitly controlled protocol facts; native Electron Renderer input and selection command. No registered Main durability, real SSH, physical compositor qualification, Runtime/Run, user App or installation claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    result.console = []
    win.webContents.on('console-message', (_event, ...details) => result.console.push(details.map(value => typeof value === 'object' ? { message: value.message, level: value.level, sourceId: value.sourceId, lineNumber: value.lineNumber } : value)))
    await win.loadFile(html)
    const pane = '[data-settings-pane="hosts"]', target = 'host-01', nameSelector = pane + ' [data-host-name]'
    const { read, until, settle, click, type, typeField, factsOf, press } = nativeRendererInput(win, result.interactions, pane)
    const branch = id => `${pane} [data-host-disclosure="${id}"]`
    const leaf = (id, page = 'connection') => `${branch(id)} [data-host-panel="${page}"]`
    async function mode(label) {
      const selector = `${pane} [aria-label="${label}"]`
      if (await read(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`)) await click(selector)
    }
    async function choose(id, panel = 'connection') {
      if (await read(`innerWidth<=900&&document.querySelector(${JSON.stringify(pane + ' [data-resource-view]')})?.dataset.resourceView==='editor'`)) {
        await click(`${pane} .settings-resource-back`)
      }
      await mode('List')
      const selector = branch(id)
      if (!await read(`document.querySelector(${JSON.stringify(selector)})?.open`)) await click(`${selector} > summary`)
      await click(leaf(id, panel))
      await until(`document.querySelector(${JSON.stringify(pane + ' [data-resource-editor]')})?.dataset.resourceEditor===${JSON.stringify(id)}&&document.querySelector(${JSON.stringify(pane + ' [data-resource-editor]')}).dataset.hostView===${JSON.stringify(panel)}`)
    }
    async function route(section) {
      await read(`window.connectionsProof.select(${JSON.stringify(section)})`)
      await until(`document.querySelector('.settings-page')?.dataset.settingsPage===${JSON.stringify(section)}`)
    }
    const business = () => read('window.connectionsProof.calls.map(call=>call.kind)')
    await until('window.connectionsProof?.ready&&document.querySelector(".settings-page")')
    await read(`window.__connectionsTrustedEvents=[]; for(const type of ['click','keydown','keypress','keyup','input'])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key,target:event.target.closest?.('[data-host-node]')?.dataset.hostNode??event.target.tagName}),true)`)
    for (const width of [1480, 640, 320]) for (const theme of ['light', 'dark']) {
      win.setContentSize(width, 980)
      await read('window.connectionsProof.reset();')
      await read('window.connectionsProof.seedRemote()')
      await read('window.connectionsProof.reopen("hosts")')
      await read(`window.connectionsProof.theme(${JSON.stringify(theme)})`)
      await until(`innerWidth===${width}&&document.documentElement.dataset.appearance===${JSON.stringify(theme)}`)
      win.showInactive(); win.focus(); win.webContents.focus()
      await until('document.hasFocus()')
      await settle()
      if (width>900) {
        await mode('Topology')
        await until(`document.querySelector(${JSON.stringify(pane+' [data-host-node="host-02"]')})`)
        assert.equal(await read(`document.querySelectorAll(${JSON.stringify(pane+' [data-host-node]')}).length`),7)
        assert.equal(await read(`document.querySelectorAll(${JSON.stringify(pane+' [data-host-disclosure]')}).length`),0)
        const saveCalls = await business()
        await click(`${pane} [data-host-node="host-02"]`)
        await until(`document.querySelector(${JSON.stringify(pane+' [data-resource-editor]')})?.dataset.resourceEditor==='host-02'`)
        assert.equal(await read(`document.querySelector(${JSON.stringify(pane+' [data-resource-editor]')}).dataset.hostView`),'overview')
        assert.equal(await read(`!!document.querySelector(${JSON.stringify(nameSelector)})`),false)
        const focus = await read('document.activeElement?.closest("[data-host-node]")?.dataset.hostNode')
        assert.equal(focus,'host-02','Actual graph selection retains native keyboard focus at the selected node')
        assert.deepEqual((await business()).filter(value=>/save|host-check/.test(value)),saveCalls.filter(value=>/save|host-check/.test(value)))
        result.interactions.push({kind:'native-topology-exact-host-selection',id:'host-02',focus})
      } else assert.equal(await read(`document.querySelectorAll(${JSON.stringify(pane+' [data-host-node]')}).length`),0,'Narrow view releases the actual graph')
      if (width<=900) await choose('host-02','overview')
      await click(`${pane} [data-host-session="host-b-agent"]`)
      await until('!document.querySelector(".settings-page")')
      assert.equal(await read('window.connectionsProof.selection()?.regionId'),'region-host-b-agent','Original Session action navigates to the exact existing cross-Host projection')
      assert.ok(await read('window.connectionsProof.calls.some(call=>call.kind==="original-select-session"&&call.input.id==="host-b-agent")'))
      result.interactions.push({kind:'native-remote-original-session-navigation',id:'host-b-agent'})
      await read('window.connectionsProof.reopen("hosts")');await until('document.querySelector(".settings-page")')
      if (width===1480&&theme==='light') {
        await choose(target,'overview')
        await click(`${pane} [data-host-session="host-a-terminal"]`)
        await until('!document.querySelector(".settings-page")')
        assert.equal(await read('window.connectionsProof.selection()?.regionId'),'region-host-a-terminal')
        result.interactions.push({kind:'native-remote-original-terminal-navigation',id:'host-a-terminal'})
        await read('window.connectionsProof.reopen("hosts")');await until('document.querySelector(".settings-page")')
      }
      await choose(target)
      if(width===320&&theme==='light') {
        await click(`${pane} .settings-resource-back`)
        await press('Enter')
        await until(`document.activeElement===document.querySelector(${JSON.stringify(nameSelector)})`)
      }
      await type(nameSelector,'Authored Remote workspace')
      await typeField('Host or SSH alias','development-alias')
      await click(`${pane} .host-edit-disclosure > summary`)
      await until(`document.querySelector(${JSON.stringify(pane+' .host-edit-disclosure')}).open`)
      await typeField('User','authored-user')
      const original = await read(`({name:document.querySelector(${JSON.stringify(nameSelector)}).value,hostname:document.querySelector(${JSON.stringify(pane+' .host-edit-grid--basic label:nth-child(2) input')}).value})`)
      await choose('host-02','projects')
      const projects = await read(`document.querySelector(${JSON.stringify(pane+' [data-host-projects="host-02"]')}).textContent`)
      assert.ok(projects.includes('Application on B')&&!projects.includes('Application on A'),'Same-name/same-path resources retain exact Host ownership')
      if (width>900) {
        await mode('Topology')
        await click(`${pane} [data-host-node="host-01"]`)
        await until(`document.querySelector(${JSON.stringify(pane+' [data-resource-editor]')})?.dataset.resourceEditor==='host-01'`)
      }
      await choose(target)
      const retained = await read(`({name:document.querySelector(${JSON.stringify(nameSelector)}).value,hostname:document.querySelector(${JSON.stringify(pane+' .host-edit-grid--basic label:nth-child(2) input')}).value})`)
      assert.deepEqual(retained,original,'Topology/List/Host changes preserve authored input')
      assert.equal(await read(`document.querySelector(${JSON.stringify(pane+' .host-edit-disclosure')}).open`),true)
      await click(`js:[...document.querySelectorAll('${pane} [data-resource-editor] button')].find(node=>node.textContent.trim()==='Test')`)
      await until(`document.querySelector(${JSON.stringify(pane+' .host-check-detail')})?.textContent.includes('Original diagnostic')`)
      const check = await read('window.connectionsProof.calls.find(call=>call.kind==="controlled-host-check").input')
      assert.equal(check.id,target);assert.equal(check.hostname,'development-alias');assert.equal(check.user,'authored-user')
      if (width===320&&theme==='light') {
        await read(`window.__retainedName=document.querySelector(${JSON.stringify(nameSelector)})`)
        await route('devices');await until('window.connectionsProof.calls.some(call=>call.kind==="device.ls")')
        await route('hosts')
        assert.equal(await read(`document.querySelector(${JSON.stringify(nameSelector)})===window.__retainedName`),true)
        assert.equal(await read('window.__retainedName.value'),original.name)
      }
      await click(`${pane} [data-settings-save-bar] button`)
      await until(`document.querySelector(${JSON.stringify(pane+' [data-settings-save-bar] button')}).disabled`)
      const saved=await read('window.connectionsProof.current()'),host=saved.hosts.find(host=>host.id===target)
      assert.equal(host.label,original.name);assert.equal(host.hostname,original.hostname)
      result.interactions.push({kind:'native-remote-draft-test-save',width,theme,captured:check,saved:host})
      if (width>900) {
        await mode('Topology');await click(`${pane} [data-host-node="host-01"]`)
      } else if (width===640&&theme==='light'||width===320&&theme==='light') {
        await click(`${pane} .settings-resource-back`)
      }
      await settle()
      const facts=await read(`(()=>{const p=document.querySelector(${JSON.stringify(pane)}),close=document.querySelector('[aria-label="Close settings"]'),visible=n=>n.isConnected&&n.checkVisibility(),controls=[...p.querySelectorAll('button,input,select,summary')].filter(n=>visible(n)&&!n.closest('.react-flow'));return{theme:document.documentElement.dataset.appearance,viewport:{width:innerWidth,height:innerHeight},hosts:p.querySelectorAll('[data-host-node]').length,branches:p.querySelectorAll('[data-host-disclosure]').length,editors:[...p.querySelectorAll('[data-resource-editor]')].map(n=>({id:n.dataset.resourceEditor,panel:n.dataset.hostView,visible:visible(n)})),closeVisible:visible(close),clipped:controls.filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&(r.left<-.5||r.right>innerWidth+.5)}).map(n=>({text:n.textContent?.slice(0,80),rect:n.getBoundingClientRect().toJSON()})),errors:window.connectionsProof.errors.slice()}})()`)
      assert.equal(facts.theme,theme);assert.equal(facts.closeVisible,true);assert.deepEqual(facts.errors,[])
      assert.deepEqual(facts.clipped,[],'All ordinary controls fit the actual viewport')
      assert.ok(facts.editors.length<=1,'Only the exact selected Host owns editable fields')
      assert.equal(width>900?facts.branches:facts.hosts,0,'Graph and equivalent list never mount together')
      const image=`hosts-${width}-${theme}.png`,png=(await win.webContents.capturePage()).toPNG()
      fs.writeFileSync(path.join(evidence,image),png)
      result.frames.push({section,width,theme,image,pngPixels:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)},facts})
      await click('[aria-label="Close settings"]');await until('!document.querySelector(".settings-page")')
    }
    assert.equal(result.frames.length,6)
    result.completed=true
  } catch(error) {
    result.failure={name:error.name,message:error.message,stack:error.stack}
    if(win&&!win.isDestroyed()) {
      result.failureObserved=await win.webContents.executeJavaScript('({errors:window.connectionsProof?.errors,calls:window.connectionsProof?.calls,text:document.body.innerText.slice(0,5000),active:document.activeElement?.outerHTML})').catch(()=>null)
      fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())
    }
  } finally {
    fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2))
    win?.destroy();app.exit(result.completed?0:1)
  }
})
