const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')
const { nativeRendererInput } = require('./native-input.cjs')
const [html, privateRoot, evidence, section] = process.argv.slice(2)
assert.equal(section, 'hosts')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(privateRoot, name); fs.mkdirSync(directory, { recursive: true }); app.setPath(name, directory)
}
app.setName('Owned Network Preview')
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] }]))
const result = { completed: false, section, frames: [], supplementalFrames: [], interactions: [],
  boundary: 'Actual SettingsPanel/HostSettingsPane/HostTopology network consumers and full production CSS with explicit controlled network DTOs; trusted native Renderer input. No real SSH, live network metrics, user App, installation or physical compositor qualification.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    result.console = []
    win.webContents.on('console-message', (_event, ...details) => result.console.push(details.map(value => typeof value === 'object' ? { message: value.message, level: value.level, sourceId: value.sourceId, lineNumber: value.lineNumber } : value)))
    await win.loadFile(html)
    const pane = '[data-settings-pane="hosts"]', host = 'host-01', network = `${pane} [data-host-network="${host}"]`
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, pane)
    await until('window.connectionsProof?.ready&&document.querySelector(".settings-page")')
    await read("window.__connectionsTrustedEvents=[];for(const type of ['click','keydown','keypress','keyup','input'])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key,target:event.target.tagName}),true)")
    async function shot(width, theme, scenario) {
      await settle()
      const image = `network-${width}-${theme}${scenario ? '-' + scenario : ''}.png`, png = (await win.webContents.capturePage()).toPNG()
      fs.writeFileSync(path.join(evidence, image), png)
      const frame = { width, theme, section, scenario, image, pngPixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } }
      ;(scenario ? result.supplementalFrames : result.frames).push(frame)
    }
    for (const width of [1480, 640, 320]) for (const theme of ['light', 'dark']) {
      win.setContentSize(width, 980)
      await read('window.connectionsProof.reset()')
      await read("window.connectionsProof.networkScenario('healthy')")
      await read("window.connectionsProof.reopen('hosts')")
      await read(`window.connectionsProof.theme(${JSON.stringify(theme)})`)
      await until(`innerWidth===${width}`)
      win.showInactive(); win.focus(); win.webContents.focus()
      const list = `${pane} [aria-label="List"]`
      if (await read(`document.querySelector(${JSON.stringify(list)})?.checkVisibility()`)) await click(list)
      await click(`${pane} [data-host-disclosure="${host}"] > summary`)
      await click(`${pane} [data-host-disclosure="${host}"] [data-host-panel="overview"]`)
      await until(`document.querySelector(${JSON.stringify(network)})`)
      assert.equal(await read("window.connectionsProof.calls.filter(call=>call.kind==='controlled-network-read').length"), 0, 'Opening never probes automatically')
      let fleetTransform
      if (width === 1480) {
        await click(`${pane} [aria-label="Topology"]`)
        await settle()
        fleetTransform = await read("document.querySelector('[data-host-topology] .react-flow__viewport').style.transform")
        await click(`${pane} [aria-label="Selected link"]`)
        await until("document.querySelector('[data-network-map] [data-network-map-step=unknown]')")
        assert.equal(await read("window.connectionsProof.calls.filter(call=>call.kind==='controlled-network-read').length"),0,'Scope never probes')
        await shot(width,theme,'link-unread')
        await click('[data-network-map] [aria-label="Read selected link"]')
      } else await click(`${network} [aria-label="Read network details"]`)
      await until(`document.querySelector(${JSON.stringify(network + ' [data-network-request]')})?.textContent.includes('34 ms')`)
      const calls = await read("window.connectionsProof.calls.filter(call=>call.kind==='controlled-network-read')")
      assert.equal(calls.length, 1); assert.equal(calls[0].input.host.id, host)
      if (width === 1480) {
        await until("document.querySelectorAll('[data-network-map-step=jump]').length===2")
        assert.deepEqual(await read("[...document.querySelectorAll('[data-network-map-step=jump] strong')].map(n=>n.textContent)"),['entry.internal','2001:db8::7'])
        await shot(width,theme,'link-path')
        await click('[data-interface-rack=observer] .host-network__addresses > summary')
        assert.ok(await read("document.querySelector('[data-interface-rack=observer]').textContent.includes('fe80::3/64')"))
        await shot(width,theme,'source-interfaces')
        if (theme === 'light') {
          const start=await read("(()=>{const r=document.querySelector('.network-map__canvas').getBoundingClientRect();return{x:Math.round(r.left+30),y:Math.round(r.top+30)}})()")
          const beforePan=await read("document.querySelector('.network-map__canvas .react-flow__viewport').style.transform")
          await shot(width,theme,'link-pan-before')
          win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...start})
          win.webContents.sendInputEvent({type:'mouseMove',x:start.x+30,y:start.y+15,movementX:30,movementY:15})
          await settle();await shot(width,theme,'link-pan-mid')
          win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:start.x+30,y:start.y+15})
          await settle();await shot(width,theme,'link-pan-after')
          const afterPan=await read("document.querySelector('.network-map__canvas .react-flow__viewport').style.transform")
          assert.notEqual(afterPan,beforePan,'Actual configuration-path pan changes its own viewport')
          result.interactions.push({kind:'native-configuration-path-pan',before:beforePan,after:afterPan})
        }
        await click(`${pane} [aria-label="Fleet map"]`)
        await until("document.querySelector('[data-host-topology] [data-host-node]')")
        await settle()
        const restored=await read("document.querySelector('[data-host-topology] .react-flow__viewport').style.transform")
        assert.equal(restored,fleetTransform,'Fleet viewport survives selected path')
        assert.equal(await read("window.connectionsProof.calls.filter(call=>call.kind==='controlled-network-read').length"),1,'Scope changes never probe')
        result.interactions.push({kind:'native-link-scope-restores-fleet',width,theme,before:fleetTransform,after:restored})
      }
      await read(`document.querySelector(${JSON.stringify(network)}).scrollIntoView({block:'start'})`)
      await shot(width, theme)
      if (theme === 'light') {
        await click(`${network} .host-network__addresses > summary`)
        await read(`document.querySelector(${JSON.stringify(network + ' .host-network__addresses')}).scrollIntoView({block:'start'})`)
        assert.ok(await read(`document.querySelector(${JSON.stringify(network)})?.textContent.includes('2001:db8:1234:5678:abcd:ef01:2345:6789/64')`))
        await shot(width, theme, 'addresses')
      }
      if (width === 1480 && theme === 'dark') {
        await read("window.connectionsProof.theme('dark','retro-future')")
        await until("document.documentElement.dataset.theme==='retro-future'")
        await read(`document.querySelector(${JSON.stringify(network)}).scrollIntoView({block:'start'})`)
        await shot(width, theme, 'retro')
        await click(`${pane} [aria-label="Selected link"]`)
        await shot(width,theme,'link-retro')
        await click(`${pane} [aria-label="Fleet map"]`)
        await read("window.connectionsProof.networkScenario('partial')")
        await click(`${network} [aria-label="Read network details"]`)
        await until(`document.querySelector(${JSON.stringify(network)})?.textContent.includes('Some network sources could not be read')`)
        assert.ok(await read(`document.querySelector(${JSON.stringify(network + ' [data-network-request]')}).textContent.includes('Last confirmed')`))
        await shot(width, theme, 'partial')
        await click(`${pane} [aria-label="Selected link"]`)
        await shot(width,theme,'link-partial')
        for(const phase of ['opaque','direct']) {
          await read(`window.connectionsProof.networkScenario(${JSON.stringify(phase)})`)
          await click('[data-network-map] [aria-label="Read selected link"]')
          await until(phase==='opaque'?"document.querySelector('[data-network-map-step=proxy]')":"!document.querySelector('[data-network-map-step=proxy]')&&!document.querySelector('[data-network-map-step=jump]')")
          await shot(width,theme,'link-'+phase)
        }
      }
    }
    assert.equal(result.frames.length, 6); assert.equal(result.supplementalFrames.length, 18)
    result.completed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) result.failureObserved = await win.webContents.executeJavaScript('({errors:window.connectionsProof?.errors,keys:Object.keys(window.connectionsProof??{}),text:document.body.innerText.slice(0,3000)})').catch(() => null)
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.completed ? 0 : 1) }
})
