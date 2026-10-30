const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData')); app.setPath('sessionData', path.join(privateRoot, 'sessionData'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', images: [], operations: [], interactions: [], errors: [] }
let win
app.whenReady().then(async () => {
 try {
  Menu.setApplicationMenu(null)
  win = new BrowserWindow({ width: 1180, height: 850, useContentSize: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
  const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
  const panel = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
  const findButton = label => `(()=>{const p=${panel};return [...p.querySelectorAll('button')].find(n=>n.checkVisibility()&&n.textContent.trim()===${JSON.stringify(label)})})()`
  async function load(initialDelay = false, initialUnbound = false) {
   await win.loadFile(html, { query: { phase: 'seed', retained: '1', zoneSelection: '1', ...(initialDelay ? { initialDelay: '1' } : {}), ...(initialUnbound ? { initialUnbound: '1' } : {}) } })
   await until('window.moteDiscussionCapture?.ready && !!' + panel, 'Complete original App Mote entry')
   await read('window.__connectionsTrustedEvents=window.moteDiscussionCapture.facts().trustedEvents'); app.focus({ steal: true }); win.show(); win.focus(); win.webContents.focus(); if (!initialDelay) await until('document.hasFocus()'); await settle()
  }
  const facts = () => read('window.moteDiscussionCapture.facts()')
  async function capture(name, selector = panel) {
   await settle(); const current = await facts()
   assert.deepEqual(current.writes, [], 'No input, Start or Stop through actual Session ports')
   const dom = await read(`(()=>{const n=${selector};return{layout:[...n.querySelectorAll('.mote-workface__original,.workspace-workbench,.pane-group,.pane-content,.agent-body,.activity-feed')].slice(0,24).map(n=>({class:n.className,hidden:n.hidden,rect:n.getBoundingClientRect().toJSON(),display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility})),viewport:{width:innerWidth,height:innerHeight},body:n?.innerText,rect:n?.getBoundingClientRect().toJSON(),navigation:[...document.querySelectorAll('.mote-space-frame__header,.mote-workface__navigation')].filter(n=>n.checkVisibility()).map(n=>({text:n.innerText,rect:n.getBoundingClientRect().toJSON()})),visibleTabbars:[...n.querySelectorAll('.pane-tabbar')].filter(n=>n.checkVisibility()).length,loading:[...n.querySelectorAll('[role=status]')].filter(n=>n.checkVisibility()).map(n=>n.innerText)}})()`)
   assert.ok(dom.rect?.width > 0, 'Nonempty complete product surface')
   const file = name + '.png'; await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
   result.images.push(file); result.operations.push({ name, facts: current, dom })
  }
  await load(); await until(panel + '.innerText.includes("把协作体验补完整")', 'Original Main native messages')
  const before = await facts(); result.initial = before
  if (process.argv.includes('--notice-only')) {
   await read('window.moteDiscussionCapture.unavailable()'); await click('js:' + findButton('Threads')); await click('js:' + findButton('Discussion'))
   await until(panel + '.innerText.includes("原主角色暂未确认")', 'One local unknown role notice retains history')
   await capture('07-main-unconfirmed-history-retained')
   await load(true)
   await until(panel + '.querySelector(".activity-feed__empty-reading.full-page-loading--loading")?.checkVisibility()', 'Initial exited Main reading phase')
   await capture('09-exited-main-initial-loading')
   result.final = await facts(); assert.deepEqual(result.final.identities, before.identities); assert.deepEqual(result.final.drafts, before.drafts)
   result.passed = true
   return
  }
  await capture('01-discussion-wide-dark')
  await require('./thread-discovery.cjs')({ win, result, panel, findButton, read, until, click, capture, settle })
  await click('js:' + findButton('Threads'))
  await until(panel + '.querySelector(".mote-threads-panel:not([hidden]) [data-mote-member]")', 'Independent original Threads list')
  await capture('02-threads-list-wide-dark')
  await click('js:' + panel + '.querySelector(".mote-work-event__summary")')
  await until(panel + '.innerText.includes("主对话和 Threads 已分开")', 'Original dispatch reply')
  await capture('03-thread-expanded-wide-dark')
  await click('js:' + panel + '.querySelector("[data-mote-member=\\"mote-neighbor\\"] button")')
  await until(panel + '.querySelector(".mote-workface__thread-navigation")', 'Specific worker conversation')
  await capture('04-worker-conversation-wide-dark')
  await click('js:' + findButton('Discussion')); await until(panel + '.innerText.includes("把协作体验补完整")', 'Return to original Main')
  await read('window.moteDiscussionCapture.longNames()'); win.setContentSize(760, 720); await settle()
  await capture('05-discussion-long-name-narrow-dark')
  await read('window.moteDiscussionCapture.theme(true)'); await capture('06-discussion-long-name-narrow-light')
  win.setContentSize(1180, 850); await read('window.moteDiscussionCapture.restore()'); await settle()
  await read('window.moteDiscussionCapture.unavailable()'); await click('js:' + findButton('Threads')); await click('js:' + findButton('Discussion'))
  await until(panel + '.innerText.includes("原主角色暂未确认")', 'Unknown refresh service, original body preserved')
  await capture('07-main-unconfirmed-history-retained')
  await load(false, true)
  await until(panel + '.innerText.includes("Configure default Executor")', 'Unbound Main setup, no guessed Executor')
  await capture('08-unbound-main-configure')
  await load(true)
  await until(panel + '.querySelector(".activity-feed__empty-reading.full-page-loading--loading")?.checkVisibility()', 'Initial exited Main reading phase')
  await capture('09-exited-main-initial-loading')
  await read('window.moteDiscussionCapture.release()'); await until(panel + '.innerText.includes("把协作体验补完整")', 'Exited Main history is independently readable')
  await capture('10-exited-main-history-readable')
  await click('js:' + panel + '.querySelector("[aria-label=\\"Open Mote in Space\\"]")')
  await until('document.querySelector("[data-mote-space] .mote-space-frame__header")?.checkVisibility()', 'Complete Space original thin frame')
  // The explicit rail action owns the full Space. Close the floating shell through its actual button.
  const close = await read(`(()=>{const p=${panel};return p ? [...p.querySelectorAll('button')].filter(n=>n.checkVisibility()).map(n=>({label:n.getAttribute('aria-label'),title:n.title,text:n.textContent.trim()})) : []})()`)
  result.closeButtons = close
  const closeSelector = `(()=>{const p=${panel};return p && [...p.querySelectorAll('button')].find(n=>n.checkVisibility()&&(/close/i.test(n.getAttribute('aria-label')||'')||/close/i.test(n.title||'')))})()`
  if (await read('!!' + closeSelector)) await click('js:' + closeSelector)
  await capture('11-space-thin-navigation', 'document.querySelector("[data-mote-space]")')
  result.final = await facts(); assert.deepEqual(result.final.identities, before.identities); assert.deepEqual(result.final.drafts, before.drafts)
  result.passed = true
 } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win) { result.dom = await win.webContents.executeJavaScript('document.body.innerText').catch(()=>null); await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()).catch(()=>{}) } }
 finally { await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.quit() }
})
