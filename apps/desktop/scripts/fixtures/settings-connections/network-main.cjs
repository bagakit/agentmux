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
      await click(`${network} [aria-label="Read network details"]`)
      await until(`document.querySelector(${JSON.stringify(network + ' [data-network-request]')})?.textContent.includes('34 ms')`)
      const calls = await read("window.connectionsProof.calls.filter(call=>call.kind==='controlled-network-read')")
      assert.equal(calls.length, 1); assert.equal(calls[0].input.host.id, host)
      if (width === 1480) await click(`${pane} [aria-label="Topology"]`)
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
        await read("window.connectionsProof.networkScenario('partial')")
        await click(`${network} [aria-label="Read network details"]`)
        await until(`document.querySelector(${JSON.stringify(network)})?.textContent.includes('Some network sources could not be read')`)
        assert.ok(await read(`document.querySelector(${JSON.stringify(network + ' [data-network-request]')}).textContent.includes('Last confirmed')`))
        await shot(width, theme, 'partial')
      }
    }
    assert.equal(result.frames.length, 6); assert.equal(result.supplementalFrames.length, 5)
    result.completed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) result.failureObserved = await win.webContents.executeJavaScript('({errors:window.connectionsProof?.errors,keys:Object.keys(window.connectionsProof??{}),text:document.body.innerText.slice(0,3000)})').catch(() => null)
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.completed ? 0 : 1) }
})
