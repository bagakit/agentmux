const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), { mkdirSync } = require('node:fs'), { join } = require('node:path')
const assert = require('node:assert/strict'), { createHash } = require('node:crypto')
const directory = process.env.AGENTMUX_RESOURCE_VISUAL_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const receipt = { schema: 'agentmux.browser-resource-settings-native.v1', passed: false, pid: process.pid, frames: [],
  physicalInputQualified: false, independentVisualReview: 'not-performed',
  boundary: 'Actual production SettingsPanel, Browser module, Desktop platform and current CSS in private Electron. Directory/process data are controlled protocol inputs. No Browser lifecycle, actual memory measurement, user App or physical input qualification.' }
let win
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1180, height: 900, show: false, title: 'Browser resources · private Settings review',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await win.loadFile(process.env.AGENTMUX_RESOURCE_VISUAL_HTML)
  const evaluate = code => win.webContents.executeJavaScript(code)
  const until = async (code, label) => { const end = Date.now() + 10000; while (Date.now() < end) { if (await evaluate(code)) return; await wait(40) } throw new Error(label) }
  await until('Boolean(window.resourceSettingsVisual?.ready && document.querySelectorAll("[data-browser-resource]").length===5)', 'The actual Settings directory must mount')
  await evaluate('resourceSettingsVisual.markPrevious()')
  await until('document.querySelector("[data-browser-resource=unconfirmed]").textContent.includes("Previously observed")', 'The original partial read retains its previous row')
  for (const [name, width, height] of [['normal', 1180, 900], ['narrow', 560, 850]]) {
    win.setContentSize(width, height); await wait(300)
    await evaluate('document.querySelector(".browser-resources").scrollIntoView({block:"start"})')
    await wait(150)
    const facts = await evaluate(`(()=>{const section=document.querySelector('.browser-resources'),r=section.getBoundingClientRect(),viewport={width:innerWidth,height:innerHeight};return{viewport,section:r.toJSON(),overflow:document.documentElement.scrollWidth>innerWidth,rows:[...section.querySelectorAll('[data-browser-resource]')].map(row=>{const r=row.getBoundingClientRect(),a=row.querySelector('button').getBoundingClientRect();return{id:row.dataset.browserResource,row:r.toJSON(),action:a.toJSON(),memory:row.querySelector('.browser-resources__memory').textContent}}),actions:resourceSettingsVisual.actions}})()`)
    assert.equal(facts.overflow, false, 'Actual Settings fits its viewport')
    assert.equal(facts.rows.length, 5); assert.deepEqual(facts.actions, [])
    for (const row of facts.rows) assert.ok(row.action.right <= width && row.action.left >= 0 && row.action.width > 0, 'Original row actions fit the actual Settings width')
    const image = await win.webContents.capturePage(), bytes = image.toPNG()
    const file = name + '-renderer.png'
    await fs.writeFile(join(directory, file), bytes)
    receipt.frames.push({ name, pid: process.pid, webContentsId: win.webContents.id, facts, file, pixels: image.getSize(),
      surface: 'complete-renderer-viewport', sha256: createHash('sha256').update(bytes).digest('hex'),
      boundary: 'Original complete pure-Renderer Settings pixels. No crop, composition, OS chrome, physical input or native Browser composition claim.' })
  }
  receipt.passed = true
}).catch(error => { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy()
  receipt.cleanup = { windowDestroyed: !win || win.isDestroyed() }
  await fs.writeFile(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1)
})
