const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, variant = 'baseline'] = process.argv.slice(2)
for (const key of ['userData', 'sessionData']) { const dir = path.join(privateRoot, key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir) }
const result = { passed: false, images: [], checks: [] }; let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ show: false, width: 1280, height: 980, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  result.console = []; win.webContents.on("console-message", (...args) => { const message = args[1]?.message ?? args[2]; if (typeof message === "string") result.console.push(message.slice(0, 1400)) })
  const read = source => win.webContents.executeJavaScript(source)
  const until = async source => { const end = Date.now() + 12000; while (!await read(source)) { assert.ok(Date.now() < end, source); await new Promise(resolve => setTimeout(resolve, 25)) } }
  const click = async selector => {
    await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
    const point = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point })
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  const open = async section => { await read(`buttonsScene.open(${JSON.stringify(section)})`); await until(`document.querySelector('.settings-page').dataset.settingsPage===${JSON.stringify(section)}`) }
  const style = selector => read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(n),r=n.getBoundingClientRect();return{height:r.height,width:r.width,font:s.fontSize,gap:s.gap,background:s.backgroundImage,shadow:s.boxShadow,outline:s.outlineStyle,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,disabled:n.disabled,classes:n.className}})()`)
  const scale = async (selector, label) => { const s = await style(selector); assert.ok(Math.abs(s.height - 28) < 0.1, label + ' height: ' + s.height); assert.equal(s.font, '12px', label + ' type'); assert.equal(s.gap, '6px', label + ' gap') }
  const capture = async name => {
    if (variant !== 'baseline') return
    await read('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
    await new Promise(resolve => setTimeout(resolve, 180)); await win.webContents.invalidate()
    fs.writeFileSync(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG()); result.images.push(name + '.png')
  }
  await win.loadFile(html); await until('window.buttonsScene?.ready && document.querySelector("#profile-display-name")'); win.show(); win.focus(); win.webContents.focus()
  const footer = '[data-settings-pane="profile"] [data-settings-save-bar] .primary-button'
  await scale('.settings-profile__image-actions .small-button', 'Photo action'); await scale(footer, 'Save action')
  assert.equal((await style(footer)).disabled, true); assert.equal((await style(footer)).background, 'none', 'Disabled primary is neutral')
  await capture('profile-dark-clean')
  await click('#profile-display-name'); win.webContents.selectAll(); await win.webContents.insertText('New display name')
  await until(`document.querySelector(${JSON.stringify(footer)}).disabled===false`)
  await open('appearance'); await open('profile'); assert.equal(await read('document.querySelector("#profile-display-name").value'), 'New display name', 'Visited settings keep original draft')
  await click(footer); await until(`document.querySelector(${JSON.stringify(footer)}).getAttribute('aria-busy')==='true'`); await scale(footer, 'Pending save')
  await capture('profile-dark-saving'); await read('buttonsScene.finishSave(true)'); await until('!!document.querySelector(".settings-profile [role=alert]")')
  assert.equal(await read('document.querySelector("#profile-display-name").value'), 'New display name', 'Save failure retains draft')
  await read('buttonsScene.theme("light")'); win.setContentSize(620, 900); await capture('profile-light-retry-compact')
  await click(footer); await until(`document.querySelector(${JSON.stringify(footer)}).getAttribute('aria-busy')==='true'`); await read('buttonsScene.finishSave(false)')
  await until('document.querySelector(".settings-profile .settings-save-feedback").textContent.includes("Changes saved")'); result.checks.push('Original profile draft, navigation, save pending, failure and retry')
  await open('mobile'); await until('!!document.querySelector("[data-device-record]")')
  await scale('[data-device-action="scan"]', 'Phone primary'); await scale('[data-device-action="copy"]', 'Phone secondary')
  await click('[data-device-records] > summary'); await click('[data-device-record] > summary')
  const copy = '[data-device-record] button[title="Copy key fingerprint"]'
  assert.equal((await style(copy)).height, 28, 'Fingerprint copy uses shared icon scale'); await click(copy)
  assert.equal(await read('buttonsScene.calls.filter(x=>x.method==="clipboard").at(-1).text'), 'preview-key-fingerprint')
  await read('buttonsScene.theme("dark")'); await capture('mobile-dark-compact'); win.setContentSize(332, 900); await capture('mobile-dark-phone-width')
  await read('document.querySelector(".settings-search input").focus()')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
  await until('document.activeElement===document.querySelector("[data-device-record] .danger-button")')
  // Electron's injected Tab changes focus without establishing Chromium's human input modality.
  // Inspect the real focus-visible CSS state explicitly; this is not proof of native input modality.
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('DOM.enable'); await win.webContents.debugger.sendCommand('CSS.enable')
  const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument')
  const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-device-record] .danger-button' })
  await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus-visible'] })
  result.checks.push('Actual Shift-Tab target and Chromium focus-visible CSS state; injected input modality is not qualified')
  assert.equal((await style('[data-device-record] .danger-button')).outlineWidth, '2px', 'Keyboard action focus remains visible'); assert.equal((await style('[data-device-record] .danger-button')).outlineOffset, '2px', 'Settings action focus spacing'); await capture('mobile-dark-focus'); await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }); win.webContents.debugger.detach()
  await click('[data-device-record] .danger-button'); await until('!document.querySelector("[data-device-record]")'); assert.equal(await read('buttonsScene.calls.find(x=>x.method==="device.revoke").input.deviceId'), 'preview-phone'); result.checks.push('Real device record copy and exact-device revoke handlers')
  await open('appearance'); await click('.settings-theme-choice input[value="custom.action-study"]')
  await read('Array.from(document.querySelectorAll(".theme-library-actions button")).find(x=>x.textContent==="Remove custom theme").click()')
  await until('!!document.querySelector(".theme-library__review .danger-button")')
  await scale('.theme-library__review .small-button', 'Keep theme'); await scale('.theme-library__review .danger-button', 'Remove theme')
  await read('document.querySelector(".theme-library__review").scrollIntoView({block:"center"})'); await capture('appearance-dark-confirm-compact'); win.setContentSize(1280, 980); await read('buttonsScene.theme("light")'); await capture('appearance-light-confirm-wide')
  await click('.theme-library__review .small-button'); assert.equal(await read('!!document.querySelector(".theme-library__review")'), false); result.checks.push('Original theme removal cancellation stays secondary and intact')
  await open('toolkit'); await until('!!document.querySelector(".toolkit-editor__footer .primary-button")'); await scale('.toolkit-editor__footer .primary-button', 'Toolkit save'); await read('document.querySelector(".toolkit-editor__footer").scrollIntoView({block:"center"})'); await capture('toolkit-light-footer');
  await open('discord'); await until('!!document.querySelector(".connector-service-control__refresh")'); await scale('.connector-service-control__refresh', 'Connector refresh'); await scale('.connector-identities-heading__actions .primary-button', 'Connector create'); await scale('.connector-identities-heading__actions .small-button', 'Connector portal'); await scale('.connector-saved-identities > header .small-button', 'Bot list refresh'); await capture('discord-light-refresh');
  await open('hosts'); await until('document.querySelector("[data-upgrade-action]")?.classList.contains("primary-button")')
  await scale('[data-upgrade-action]', 'Host upgrade'); await read('buttonsScene.holdCheck()'); await click('[data-upgrade-action]'); await until('document.querySelector(".host-upgrade").textContent.includes("Checking upgrade")'); assert.equal(await read('document.querySelector("[data-upgrade-action]").classList.contains("primary-button")'), true, 'Pending precheck keeps primary role'); await scale('[data-upgrade-action]', 'Pending precheck'); await read('buttonsScene.finishCheck()'); await until('buttonsScene.calls.some(x=>x.method==="hosts.upgrade")')
  assert.equal(await read('document.querySelector("[data-upgrade-action]").classList.contains("primary-button")'), true, 'Pending upgrade keeps primary role'); await scale('[data-upgrade-action]', 'Pending upgrade')
  await read('document.querySelector(".host-upgrade").scrollIntoView({block:"center"})'); await capture('hosts-light-pending'); await read('buttonsScene.finishUpgrade()'); await until('document.querySelector(".host-upgrade").textContent.includes("Upgrade complete")')
  result.calls = await read('buttonsScene.calls'); assert.equal(result.calls.filter(x=>x.method==='config.save').length, 2); assert.equal(result.calls.filter(x=>x.method==='hosts.upgrade').length, 1); result.checks.push('Original checked host upgrade handler, no repeated deployment')
  assert.equal(await read('document.documentElement.scrollWidth>innerWidth'), false, 'Settings has no horizontal page overflow'); result.passed = true
} catch (error) { if (win && !win.isDestroyed()) result.focus = await win.webContents.executeJavaScript('({page:document.querySelector(".settings-content")?.innerText,active:document.activeElement?.tagName,visible:Array.from(document.querySelectorAll(":focus-visible")).map(x=>x.outerHTML)})').catch(()=>null); result.error = { name: error.name, message: error.message, stack: error.stack } } finally {
  if (win && !win.isDestroyed()) win.destroy(); fs.writeFileSync(path.join(evidence, 'renderer.json'), JSON.stringify(result, null, 2)); app.exit(result.passed ? 0 : 1)
} })
