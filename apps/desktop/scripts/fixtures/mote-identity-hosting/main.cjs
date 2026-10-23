const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron'), { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], interactions: [], boundary: 'Original MoteConnectionPanel and production CSS; synthetic display DTOs only. No native send, deployed Host or installed GUI proof.' }; let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1040, height: 960, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } }); await win.loadFile(html)
  const { read, until, settle, press, click } = nativeRendererInput(win, result.interactions, '')
  await until('window.moteIdentityHostingProof?.ready && document.querySelector("[aria-label=\\"Mote chat bot\\"]")')
  await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
  win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
  await click('js:Array.from(document.querySelectorAll("summary")).find(node => node.textContent === "Identity options")')
  await click('js:Array.from(document.querySelectorAll("summary")).find(node => node.textContent === "Retained save requests")')
  await until('document.body.textContent.includes("Original bot hosting owner unconfirmed")')
  const capture = async name => { await settle(); fs.writeFileSync(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG()); result.frames.push(name + '.png') }
  await until('document.body.textContent.includes("Public notes and useful findings for our shared work.")')
  await capture('mote-identity-owner-unconfirmed-wide'); win.setContentSize(390, 960); await until('innerWidth===390'); await capture('mote-identity-owner-unconfirmed-narrow')
  result.facts = await read('({errors:window.moteIdentityHostingProof.errors,overflow:document.documentElement.scrollWidth>innerWidth,text:document.body.textContent})'); assert.deepEqual(result.facts.errors, []); assert.equal(result.facts.overflow, false); result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) { result.diagnostics = await win.webContents.executeJavaScript('({proof:window.moteIdentityHostingProof,body:document.body.textContent})').catch(() => null); fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) } }
finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) } })
