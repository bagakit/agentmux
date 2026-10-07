const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
let win
const receipt = { passed: false, frames: [], phases: [], boundary: 'Actual App/Workbench/SessionPane/Activity and shared UI; public DTO preview. No user Session/Run, physical PTY, native Writer, restart or installation.' }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1280, height: 820, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const read = source => win.webContents.executeJavaScript(source)
  const settle = async () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const until = async (label, source) => { const end = Date.now() + 12000; do { if (await read(source)) return; await pause(30) } while (Date.now() < end); throw new Error('Scene did not settle: ' + label) }
  const shot = async file => { await settle(); const facts = await read('window.metricsProof.facts()'); assert.deepEqual(Object.values(facts.calls), [0, 0, 0, 0]); assert.ok(facts.drafts.includes('保留的未发送草稿')); assert.equal(facts.runId, 'run-codex');
    await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); receipt.frames.push({ file, facts }) }
  const click = async expression => { const point = await read(`(()=>{const node=${expression}; if(!node?.checkVisibility())throw Error('Missing visible control');node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,width:r.width,height:r.height,hit:node.contains(document.elementFromPoint(x,y))}})()`);
    assert.ok(point.hit && point.width > 0 && point.height > 0); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }); await settle() }
  await win.loadFile(html); win.showInactive(); win.webContents.debugger.attach('1.3'); await until('original native summary', 'window.metricsProof?.ready()')
  await shot('normal-dark-collapsed.png')
  const report = `Array.from(document.querySelectorAll('.wf-head')).find(node=>node.textContent.includes('输出 127 tokens')&&node.checkVisibility())`
  await click(report); await until('metrics expanded', `${report}.getAttribute('aria-expanded')==='true'`)
  await shot('normal-dark-expanded.png'); await click(report)
  await read('window.metricsProof.theme("light")'); await settle(); await shot('normal-light-collapsed.png')
  await read('window.metricsProof.split()'); win.setContentSize(820, 820); await until('two real visible Regions', 'window.metricsProof.facts().regions.length===2'); await shot('narrow-light-split.png')
  await read('window.metricsProof.theme("dark")'); await settle(); await shot('narrow-dark-split.png')
  await read('window.metricsProof.response()'); await until('response scope and diagnostic', 'document.body.textContent.includes("输出 0 tokens")&&document.body.textContent.includes("原记录与 Agent 仍可使用")'); await shot('narrow-dark-response-unknown.png')
  await read('window.metricsProof.responseActivities()'); await until('two response records', 'document.querySelectorAll("[data-native-record-ids]").length>0&&Array.from(document.querySelectorAll("[data-native-record-ids]")).some(node=>node.dataset.nativeRecordIds.includes("response-b"))')
  const responseCard = `Array.from(document.querySelectorAll('[data-native-record-ids]')).find(node=>node.dataset.nativeRecordIds.includes('response-b')&&node.checkVisibility())`
  await click(`${responseCard}.querySelector('.wf-head')`)
  const responseStep = `${responseCard}.querySelector('[data-native-record-id="response-b"] [data-observation-step-id]')`
  await click(responseStep); await until('read response body', `${responseStep}.getAttribute('aria-expanded')==='true'`)
  const before = await read('window.metricsProof.retainResponse()'); assert.equal(before.sameRange, true)
  await read('window.metricsProof.clipResponse()'); await settle(); await settle()
  const after = await read('window.metricsProof.retentionFacts()'); for (const key of ['sameRecord', 'sameBody', 'bodyConnected', 'sameRange']) assert.equal(after[key], true, key); assert.equal(after.expanded, 'true'); assert.equal(after.selection, before.expected)
  const protectedWindow = await read(`Array.from(document.querySelectorAll('[data-native-record-id="response-a"]')).some(node=>node.checkVisibility())`)
  receipt.phases.push({ phase: 'response-window-invalidation', before, after, protectedWindow,
    boundary: 'The actual Activity reader may retain its selected window. Direct shared-sequence multi-response-to-one clipping is separately covered by the behavioral test and actual-source mutation.' }); await shot('narrow-dark-response-retained.png')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
} finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(receipt, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(receipt.passed ? 0 : 1) } })
