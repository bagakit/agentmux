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
  const { read, until, settle, click, type } = nativeRendererInput(win, result.interactions, '')
  const panel = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
  const findButton = label => `(()=>{const p=${panel};return [...p.querySelectorAll('button')].find(n=>n.checkVisibility()&&n.textContent.trim()===${JSON.stringify(label)})})()`
  async function load(initialDelay = false, initialUnbound = false) {
   await win.loadFile(html, { query: { phase: 'seed', retained: '1', zoneSelection: '1', ...(initialDelay ? { initialDelay: '1' } : {}), ...(initialUnbound ? { initialUnbound: '1' } : {}), ...(process.argv.includes('--native-groups') ? { nativeGroups: '1' } : {}), ...(process.argv.includes('--direct-threads') ? { directThreads: '1' } : {}) } })
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
  if (process.argv.includes('--direct-threads')) {
   win.webContents.debugger.attach('1.3')
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
   const holdMotion = name => read(`(() => {
     window.directMotion = null;
     const deadline = performance.now() + 6000;
     const sample = () => {
       const dialog = document.querySelector('.mote-direct-panel');
       const motion = dialog?.getAnimations().find(animation => (animation.animationName || animation.id) === ${JSON.stringify(name)});
       if (!motion) { if (performance.now() < deadline) requestAnimationFrame(sample); return; }
       motion.pause();
       motion.currentTime = 72;
       window.directMotion = motion;
     };
     requestAnimationFrame(sample);
   })()`)
   const captureMotion = async (selector, name, filename) => {
     await holdMotion(name)
     const pressed = click(selector)
     try {
       await until('window.directMotion?.currentTime === 72', 'Actual ' + name + ' has an intermediate frame')
       await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
       assert.equal(await read('getComputedStyle(document.querySelector(".mote-direct-panel")).opacity'), '1', 'Private text and surface remain opaque throughout motion')
       await fs.writeFile(path.join(evidence, filename), (await win.webContents.capturePage()).toPNG())
       result.images.push(filename)
     } finally {
       await read('window.directMotion?.play()')
       await pressed
     }
   }
   await until('document.querySelector(".mote-direct-entry")?.innerText.includes("已回复")', 'Main shows observed private progress')
   await capture('desktop-main-private-summary')
   await captureMotion('.mote-direct-entry button', 'mote-direct-enter', 'desktop-private-enter-motion.png')
   await until('!!document.querySelector("[data-direct-message-id=original-private-report]")', 'Original private report visible')
   await capture('desktop-private-detail')
   await click('[data-direct-message-id=another-private-assignment] [data-open-assignment]')
   await until('document.querySelector(".mote-direct-assignment")?.innerText.includes("暂无回报")', 'Forward from the other assignment shows its own empty replies')
   assert.ok(await read('document.querySelector(".mote-direct-assignment").innerText.includes("资料整理 · 等待接收")'))
   assert.equal(await read('!!document.querySelector(".mote-direct-assignment [data-direct-message-id=original-private-report]")'), false)
   await capture('desktop-private-forward-assignment')
   await click('js:[...document.querySelectorAll(".mote-direct-panel button")].find(button=>button.textContent==="返回私聊")')
   await until('document.activeElement?.closest("[data-direct-message-id]")?.dataset.directMessageId === "another-private-assignment"', 'Forward path restores exact source focus')
   await click('[data-direct-message-id=original-private-report] button')
   await until('!!document.querySelector("[data-direct-message-id=original-private-assignment]")', 'Report reads its original assignment outside the current page')
   assert.ok(await read('document.querySelector("[data-direct-message-id=original-private-assignment]").innerText.includes("优先投递")'))
   assert.equal(await read('!!document.querySelector("[data-direct-message-id=another-private-assignment]")'), false)
   await capture('desktop-private-assignment')
   await click('.mote-direct-image button')
   await until('document.querySelector(".mote-direct-image img")?.naturalWidth === 220', 'Original private image renders from its retained bytes')
   await capture('desktop-private-assignment-image')
   await click('js:[...document.querySelectorAll(".mote-direct-panel button")].find(button=>button.textContent==="返回私聊")')
   await until('document.activeElement?.textContent === "查看原作业"', 'Focus returns to the chosen report')
   await click('js:[...document.querySelectorAll(".mote-direct-panel button")].find(button=>button.textContent==="全部私聊")')
   await until('document.querySelector(".mote-direct-panel .mote-direct-row")?.innerText.includes("资料整理")', 'Private counterpart visible')
   await capture('desktop-private-list')
   win.setContentSize(760, 720)
   await read('window.moteDiscussionCapture.theme(true)')
   await click('.mote-direct-panel .mote-direct-row')
   await until('!!document.querySelector("[data-direct-message-id=original-private-report]")', 'Original private report still visible after resizing')
   await capture('desktop-private-detail-narrow')
   await captureMotion('button[aria-label="关闭私聊"]', 'mote-direct-exit', 'desktop-private-exit-motion.png')
   await until('!document.querySelector(".mote-direct-panel")', 'Returns to original Main')
   assert.equal(await read('document.activeElement?.matches(".mote-direct-entry__summary")'), true, 'Focus returns to exact Main summary')
   await click('.mote-direct-entry__assignment')
   await until('document.querySelector(".mote-direct-assignment")?.innerText.includes("资料整理 · 已接收")', 'Main action opens the original assignment with its recipient')
   await click('button[aria-label="关闭私聊"]')
   await until('document.activeElement?.matches(".mote-direct-entry__assignment")', 'Focus returns to the exact Main shortcut')
   result.final = await facts(); assert.deepEqual(result.final.identities, before.identities); assert.deepEqual(result.final.drafts, before.drafts)
   result.passed = true
   return
  }
  if (process.argv.includes('--native-groups')) {
   await until('Boolean(window.moteNativeGroupsCapture)', 'Native group source connected to original panel')
   await require(process.argv.includes('--group-management') ? './group-management.cjs' : './native-groups.cjs')({ win, panel, findButton, read, until, click, type, capture, theme: light => read('window.moteDiscussionCapture.theme(' + light + ')') })
   result.final = await facts(); assert.deepEqual(result.final.identities, before.identities)
   result.groupCalls = await read('window.moteNativeGroupsCapture.calls')
   result.passed = true
   return
  }
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
  await until(panel + '.innerText.includes("设置默认执行器")', 'Unbound Main setup, no guessed Executor')
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
