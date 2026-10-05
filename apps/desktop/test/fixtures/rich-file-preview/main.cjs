const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const [moduleFile, rendererFile, requestFile, userData, sceneFile, sceneDevUrl] = process.argv.slice(2)
app.setPath('userData', userData)
app.on('window-all-closed', () => {})
const bridges = []
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    void window.webContents.executeJavaScript('({agentmux:typeof window.agentmux,require:typeof require})').then(value => bridges.push(value)).catch(() => {})
  })
})
app.whenReady().then(async () => {
  const { FileDiagramRenderer } = await import(pathToFileURL(moduleFile).href)
  const renderer = new FileDiagramRenderer({ rendererFile })
  const results = []
  for (const request of JSON.parse(readFileSync(requestFile, 'utf8'))) {
    console.error('Rendering', request.id)
    const start = performance.now()
    const result = await renderer.render(request)
    console.error('Rendered', request.id, performance.now() - start, result.error ?? '')
    results.push({ ...result, elapsedMs: performance.now() - start, remainingWindows: BrowserWindow.getAllWindows().length })
  }
  const pending = renderer.render({ id: 'cancelled', kind: 'plantuml', content: '@startuml\nAlice -> Bob\n@enduml', theme: 'light' })
  renderer.cancel('cancelled')
  const cancelled = await pending
  renderer.dispose()
  async function runScene(location, development) {
    const window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: `rich-scene-fixture-${development}` } })
    const fontRequests = []
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.includes('.woff')) fontRequests.push(details.url)
      callback({ cancel: !/^(file|data|blob):/.test(details.url) && !(development && new URL(details.url).origin === new URL(location).origin) })
    })
    if (development) await window.loadURL(location)
    else await window.loadFile(location)
    const scene = await window.webContents.executeJavaScript('window.__sceneBenchmark()', true)
    scene.fonts.requests = fontRequests
    window.destroy()
    return scene
  }
  const scene = sceneFile && await runScene(sceneFile, false)
  const sceneDev = sceneDevUrl && await runScene(sceneDevUrl, true)
  process.stdout.write(`AMX_RICH_RESULTS=${JSON.stringify({ results, cancelled, bridges, scene, sceneDev, remainingWindows: BrowserWindow.getAllWindows().length })}\n`)
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
