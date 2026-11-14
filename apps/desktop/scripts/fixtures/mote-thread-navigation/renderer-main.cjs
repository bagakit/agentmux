const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData')); app.setPath('sessionData', path.join(privateRoot, 'sessionData'))
const result = { passed: false, captureOnly: true, images: [], operations: [], interactions: [], errors: [] }
const restoring = process.argv.includes('--restore')
let win
app.whenReady().then(async () => {
 try {
  Menu.setApplicationMenu(null)
  win = new BrowserWindow({ width: 1180, height: 850, useContentSize: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
  const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
  const panel = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
  const button = label => `(()=>{const p=${panel};return [...p.querySelectorAll('button')].find(n=>n.checkVisibility()&&(n.getAttribute('aria-label')===${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)}))})()`
  await win.loadFile(html, { query: { phase: restoring ? 'restore' : 'seed', retained: '1', zoneSelection: '1' } })
  await until('window.moteNavigationCapture?.ready && !!' + panel)
  await read('window.__connectionsTrustedEvents=window.moteNavigationCapture.facts().trustedEvents')
  app.focus({ steal: true }); win.show(); win.focus(); win.webContents.focus(); await until('document.hasFocus()'); await settle()
  const facts = () => read('window.moteNavigationCapture.facts()')
  async function capture(name, target = panel) {
   await settle(); const current = await facts(); assert.deepEqual(current.writes, [])
   const dom = await read(`(()=>{const p=${target};return {text:p.innerText,rect:p.getBoundingClientRect().toJSON(),navigation:[...p.querySelectorAll('[role=tab]')].filter(n=>n.checkVisibility()).map(n=>({text:n.textContent,selected:n.getAttribute('aria-selected'),rect:n.getBoundingClientRect().toJSON()}))}})()`)
   assert.ok(dom.rect.width > 0)
   const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
   result.images.push(file); result.operations.push({ name, facts: current, dom })
  }
  await until(panel + '.innerText.includes("把协作体验补完整")')
  const before = await facts(); result.initial = before
  if (restoring) {
    assert.equal(before.bootstrap.initialization.seedApplied, false)
    assert.ok(before.bootstrap.initialization.afterOrdinaryInitialize.tabIds.includes('mote-primary-tab'))
    assert.equal(before.drafts['mote-primary'], 'Restart retains this original draft')
    await capture('12-real-process-restart-original-workface'); result.passed = true; return
  }
  await until(panel + '.querySelector("[data-mote-active-work]")')
  await read(`window.navigationEditor=${panel}.querySelector('[contenteditable=true]')`)
  await capture('01-main-top-navigation-dark')
  await click('js:' + button('工作中的成员')); await until('document.querySelector(".mote-active-work__popover")')
  await capture('02-work-quick-jump-open')
  await click('js:document.querySelector("[data-mote-work-jump=original-work-event]")')
  await until(panel + '.querySelector("[data-mote-work-thread=original-work-event]")')
  await capture('03-original-thread-jump')
  await click('js:' + button('成员')); await capture('04-members-top-navigation')
  await click('js:' + button('私聊')); await capture('05-private-zero')
  await click('js:' + button('主对话'))
  assert.equal(await read(panel + '.querySelector("[contenteditable=true]")===window.navigationEditor'), true)
  await read('window.moteNavigationCapture.longNames(); window.moteNavigationCapture.working()'); win.setContentSize(760, 720); await capture('06-long-name-narrow-dark')
  await read('window.moteNavigationCapture.theme(true)'); await capture('07-long-name-narrow-light')
  win.setContentSize(760, 480); await click('js:' + button('工作中的成员')); await capture('08-short-work-popover')
  await click('js:document.querySelector("[aria-label=\\"关闭工作快跳\\"]")')
  await win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  win.setContentSize(960, 720); await capture('09-reduced-motion-intermediate')
  await read('window.moteNavigationCapture.longHeader()'); win.setContentSize(620, 720)
  await until(panel + '.querySelector(".mote-conversation-identity__name")?.innerText.includes("长期合作伙伴")')
  await capture('09b-real-header-long-name')
  await read('window.moteNavigationCapture.restore(); window.moteNavigationCapture.working()'); win.setContentSize(960, 720); await settle()
  await click('js:' + button('Open Mote in Space'))
  await until('document.querySelector("[data-mote-space] .mote-space-frame__header")?.checkVisibility()')
  const close = button('Close'); if (await read('!!' + panel) && await read('!!' + close)) await click('js:' + close)
  await capture('10-space-top-navigation', 'document.querySelector("[data-mote-space]")')
  result.final = await facts(); assert.deepEqual(result.final.identities, before.identities); assert.deepEqual(result.final.drafts, before.drafts)
  win.setContentSize(760, 720); await capture('11-space-narrow-light-final', 'document.querySelector("[data-mote-space]")')
  await click('js:[...document.querySelectorAll("[contenteditable=true]")].find(n=>n.checkVisibility()&&n.textContent.includes("还有一个问题"))')
  win.webContents.selectAll(); await win.webContents.insertText('Restart retains this original draft')
  await until('JSON.stringify(localStorage.getItem("agentmux-workbench-v1")).includes("Restart retains this original draft")', 'Production durable draft writer')
  result.passed = true
 } catch (error) { result.failure = { message: error.message, stack: error.stack }; if(win) { result.dom = await win.webContents.executeJavaScript('document.body.innerText').catch(()=>null); await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()).catch(()=>{}) } }
 finally { await fs.writeFile(path.join(evidence, restoring ? 'renderer-restart-result.json' : 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.quit() }
})
