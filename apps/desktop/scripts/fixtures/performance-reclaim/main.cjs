const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), { mkdirSync } = require('node:fs'), { join } = require('node:path')
const assert = require('node:assert/strict'), { createHash } = require('node:crypto')
const directory = process.env.AGENTMUX_RECLAIM_VISUAL_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const receipt = { schema: 'agentmux.performance-reclaim-visual.v1', passed: false, pid: process.pid, frames: [],
  physicalInputQualified: false, independentVisualReview: 'pending',
  boundary: 'Original PerformanceOverview, shared Browser UI, Desktop platform and CSS in isolated hidden Electron. Only resource/cache protocol inputs and container position are controlled. No native cleanup, original App, OS focus, platform delivery or actual memory benefit claim.' }
let win
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1040, height: 820, show: false, title: 'Performance reclaim · private review',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, _level, message) => console.error(message))
  await win.loadFile(process.env.AGENTMUX_RECLAIM_VISUAL_HTML)
  const evaluate = code => win.webContents.executeJavaScript(code)
  const until = async (code, label) => { const end = Date.now() + 10000; while (Date.now() < end) { if (await evaluate(code)) return; await wait(40) } throw Error(label) }
  const click = async selector => { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Actual action unavailable');e.click()})()`); await wait(80) }
  const capture = async name => {
    await wait(160)
    const facts = await evaluate(`(()=>{const p=document.querySelector('.performance-popover'),b=document.querySelector('.performance-body');return{viewport:{width:innerWidth,height:innerHeight},panel:p.getBoundingClientRect().toJSON(),body:{width:b.clientWidth,scrollWidth:b.scrollWidth,scrollTop:b.scrollTop,scrollHeight:b.scrollHeight,height:b.clientHeight},appearance:document.documentElement.dataset.appearance,expanded:p.dataset.performanceExpanded,selected:[...document.querySelectorAll('[data-browser-resource][data-selected]')].map(e=>e.dataset.browserResource),cacheResult:document.querySelector('[data-cache-result]')?.getAttribute('data-cache-result'),receipts:[...document.querySelectorAll('[data-result]')].map(e=>e.getAttribute('data-result')),...reclaimVisual.facts()}})()`)
    assert.ok(facts.panel.left >= 0 && facts.panel.right <= facts.viewport.width && facts.panel.bottom <= facts.viewport.height, 'Whole original panel fits viewport')
    assert.ok(facts.body.scrollWidth <= facts.body.width + 1, 'Original body has no horizontal clipping')
    const image = await win.webContents.capturePage(), bytes = image.toPNG(), file = name + '.png'
    await fs.writeFile(join(directory, file), bytes)
    receipt.frames.push({ name, file, facts, pixels: image.getSize(), sha256: createHash('sha256').update(bytes).digest('hex'), surface: 'complete-renderer-viewport' })
  }
  await until('Boolean(window.reclaimVisual?.ready)', 'Original Performance must mount')
  assert.equal(await evaluate('reclaimVisual.facts().directoryReaders'), 0)
  await click('[data-performance-section-tab="reclaim"]')
  await until('document.querySelectorAll("[data-browser-resource]").length===6', 'Original Browser directory must mount')
  await evaluate('reclaimVisual.markPrevious()')
  await until('document.querySelector("[data-browser-resource=unconfirmed]").textContent.includes("Previously observed")', 'Partial directory must preserve its prior row')
  assert.equal(await evaluate('reclaimVisual.facts().directoryReaders'), 1)
  await click('[data-clean-cache]')
  await until('document.querySelector("[data-cache-result=completed]")', 'Original cache action must render its typed receipt')
  await capture('dark-compact-cache')
  await click('[aria-label="Expand Performance"]')
  await capture('dark-expanded-cache')
  await click('[data-browser-resource="documentation"] input[type=checkbox]')
  await click('[data-browser-resource="research"] input[type=checkbox]')
  await evaluate('document.querySelector(".browser-resources__selection").scrollIntoView({block:"start"})')
  await capture('dark-expanded-selection')
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent==='Release selected (2)');if(!b||b.disabled)throw Error('Actual batch action unavailable');b.click()})()`)
  await until('document.querySelectorAll(".browser-resources__result").length===2', 'Both original batch receipts must be visible')
  await capture('dark-expanded-browser-receipts')
  await evaluate('reclaimVisual.unknownCache();document.querySelector(".performance-body").scrollTop=0')
  await click('[data-clean-cache]')
  await until('document.querySelector("[data-cache-result=unknown]")', 'Unknown cache result must stay unknown')
  await capture('dark-expanded-unknown')
  await evaluate('reclaimVisual.theme("light")')
  await capture('light-expanded-unknown')
  win.setContentSize(420, 780); await wait(200)
  await click('[aria-label="Compact Performance"]')
  await capture('light-narrow-unknown')
  await evaluate('document.querySelector(".browser-resources__selection").scrollIntoView({block:"start"})')
  await capture('light-narrow-browser-receipts')
  await evaluate('reclaimVisual.theme("dark")')
  await capture('dark-narrow-browser-receipts')
  await evaluate('document.querySelector(".performance-body").scrollTop=1e6')
  await capture('dark-narrow-footer')
  await click('[data-performance-section-tab="overview"]')
  await until('reclaimVisual.facts().directoryReaders===0', 'Hiding Reclaim must release its directory reader')
  receipt.actions = await evaluate('reclaimVisual.actions')
  assert.deepEqual(receipt.actions.filter(a => a.kind === 'browser-release').map(a => a.id), ['documentation', 'research'])
  assert.equal(receipt.actions.filter(a => a.kind === 'cache-reclaim').length, 2, 'No retry of unknown effects')
  receipt.passed = true
}).catch(error => { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy()
  receipt.cleanup = { windowDestroyed: !win || win.isDestroyed() }
  await fs.writeFile(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1)
})
