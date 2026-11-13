const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [html, privateRoot, evidence] = process.argv.slice(2)
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(privateRoot, key), { recursive: true }); app.setPath(key, join(privateRoot, key)) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1240, height: 920, show: false, webPreferences: { contextIsolation: true } })
  win.webContents.debugger.attach('1.3')
  const evaluate = async expression => {
    const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const frames = []
  for (const theme of ['light', 'dark']) for (const width of [1240, 620]) {
    win.setContentSize(width, 920)
    await win.loadFile(html)
    for (let count = 0; !(await evaluate('window.goalHostProbe?.ready()')); count++) { if (count > 100) throw new Error('Original Host settings did not mount'); await wait(50) }
    await wait(200)
    await evaluate(`goalHostProbe.appearance(${JSON.stringify(theme)});goalHostProbe.open()`); await wait(180)
    await evaluate('goalHostProbe.scroll()'); await wait(60)
    for (const state of ['pending', 'fingerprints', 'approved']) {
      if (state === 'fingerprints') await evaluate('goalHostProbe.expand();goalHostProbe.scroll()')
      if (state === 'approved') await evaluate('goalHostProbe.allow(0).then(()=>goalHostProbe.allow(1))')
      await wait(80)
      const facts = await evaluate('goalHostProbe.facts()')
      if (facts.errors.length || facts.overflow || !facts.visible || facts.appearance !== theme || facts.directions.length !== 2) throw new Error(JSON.stringify(facts))
      if (state === 'approved' && !facts.directions.every(text => text.includes('Messages from this source are trusted'))) throw new Error('Both explicit approvals must be observed before capture')
      const file = `${theme}-${width}-${state}.png`
      writeFileSync(join(evidence, file), (await win.webContents.capturePage()).toPNG())
      frames.push({ file, theme, width, height: 920, state, facts })
    }
  }
  writeFileSync(join(evidence, 'render.json'), JSON.stringify({ passed: true, frames }, null, 2)); app.quit()
}).catch(error => { writeFileSync(join(evidence, 'render.json'), JSON.stringify({ passed: false, error: error.stack })); app.exit(1) })
