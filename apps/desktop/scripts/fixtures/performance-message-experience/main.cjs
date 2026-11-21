const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const directory = process.env.AGENTMUX_EXPERIENCE_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const receipt = { schema: 'agentmux.performance-message-experience-visual.v1', passed: false, frames: [], actions: [], independentVisualReview: 'pending' }
let win
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 560, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`))
  await win.loadFile(process.env.AGENTMUX_EXPERIENCE_HTML)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const evaluate = code => win.webContents.executeJavaScript(code)
  const until = async (code, label) => { const end = Date.now() + 10000; while (Date.now() < end) { if (await evaluate(code)) return; await wait(35) } throw Error(label) }
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    assert.ok(point, `Visible action: ${selector}`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  }
  const motion = async reduced => { await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] }) }
  const capture = async (name, { allowRunningAnimations = false, scrollBottom = false } = {}) => {
    if (scrollBottom) {
      await evaluate(`(()=>{const body=document.querySelector('.performance-body');if(!body)return false;body.scrollTop=body.scrollHeight;return true})()`)
      await wait(40)
    }
    if (!allowRunningAnimations) await until(`(()=>{const p=document.querySelector('.performance-popover,.composer-mailbox');return p&&[...p.querySelectorAll('*'),p].every(n=>n.getAnimations().every(a=>a.playState!=='running'))})()`, `${name}: visual animations settled`)
    const facts = await evaluate(`(()=>{const p=document.querySelector('.performance-popover,.composer-mailbox');const r=p?.getBoundingClientRect();const body=p?.querySelector('.performance-body');const bodyRect=body?.getBoundingClientRect();const lastAction=p?.querySelector('.performance-next-actions > button:last-child')?.getBoundingClientRect();const observation=p?.querySelector('.performance-sources')?.getBoundingClientRect();return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth,panel:r?.toJSON(),text:p?.textContent,animations:p?[...p.querySelectorAll('*'),p].flatMap(n=>n.getAnimations()).filter(a=>a.playState==='running').map(a=>a.animationName):[],scroll:body&&bodyRect?{top:body.scrollTop,clientHeight:body.clientHeight,scrollHeight:body.scrollHeight,bodyTop:bodyRect.top,bodyBottom:bodyRect.bottom,lastActionBottom:lastAction?.bottom,observationBottom:observation?.bottom}:null}})()`)
    assert.equal(facts.overflow, 0, `${name}: no horizontal overflow`)
    if (facts.panel) { assert.ok(facts.panel.width > 0 && facts.panel.x >= 0 && facts.panel.right <= facts.width + 1, `${name}: panel fits horizontally`); assert.ok(facts.panel.y >= 0 && facts.panel.bottom <= facts.height + 1, `${name}: panel fits vertically`) }
    if (scrollBottom) {
      assert.ok(facts.scroll, `${name}: scrollable Performance body`)
      assert.ok(Math.abs(facts.scroll.top - (facts.scroll.scrollHeight - facts.scroll.clientHeight)) <= 1, `${name}: reached scroll bottom`)
      assert.ok(facts.scroll.lastActionBottom <= facts.scroll.bodyBottom + 1, `${name}: final action fully visible`)
      assert.ok(facts.scroll.observationBottom <= facts.scroll.bodyBottom + 1, `${name}: observation details fully visible`)
    }
    const png = await win.webContents.capturePage()
    await fs.writeFile(join(directory, `${name}.png`), png.toPNG())
    receipt.frames.push({ name, sha256: createHash('sha256').update(png.toPNG()).digest('hex'), facts })
  }
  await until('window.experienceReview?.ready&&document.querySelector("[data-performance-live]")', 'Production Performance mounted')
  await wait(300); await capture('dark-performance-compact')
  await capture('dark-performance-compact-bottom', { scrollBottom: true })
  await evaluate(`document.querySelector('.performance-body').scrollTop=0`)
  await evaluate(`(()=>{const e=document.querySelector('.performance-live-metric .performance-trend');const r=e.getBoundingClientRect();return{x:r.x+r.width*.65,y:r.y+r.height/2}})()`).then(point => win.webContents.sendInputEvent({ type: 'mouseMove', ...point }))
  await wait(180); await capture('dark-performance-trend-hover')
  await click('[aria-label="Expand Performance"]'); await wait(320)
  win.setContentSize(1100, 860); await wait(300); await capture('dark-performance-expanded')
  for (const section of ['resources', 'reclaim', 'diagnostics', 'artifacts']) {
    await click(`[data-performance-section-tab="${section}"]`); await wait(240); await capture(`dark-performance-${section}-expanded`)
  }
  win.setContentSize(560, 900); await click('[aria-label="Compact Performance"]'); await wait(260)
  await click('[data-performance-section-tab="resources"]'); await wait(220); await capture('dark-performance-resources-compact')
  await click('[data-performance-section-tab="overview"]'); await wait(220)
  await evaluate('experienceReview.publishPerformance()'); await wait(55); await capture('dark-performance-sample-mid', { allowRunningAnimations: true })
  await wait(320); await click('[data-performance-observation-toggle]'); await wait(220); await capture('dark-performance-paused')
  await capture('dark-performance-paused-bottom', { scrollBottom: true })
  await evaluate('experienceReview.missingPerformance()'); await wait(240); await capture('dark-performance-unavailable')
  win.setContentSize(390, 820); await evaluate('experienceReview.performance();experienceReview.theme("light")'); await motion(true); await wait(240)
  await evaluate('experienceReview.publishPerformance()'); await wait(80); await capture('light-performance-narrow-reduced')
  await capture('light-performance-narrow-reduced-bottom', { scrollBottom: true })
  assert.equal(receipt.frames.at(-1).facts.animations.length, 0, 'Reduced motion has no running Performance animation')

  win.setContentSize(640, 600); await evaluate('experienceReview.theme("dark");experienceReview.messages()'); await motion(false); await wait(200)
  await until('document.querySelector(".composer__mailbox")', 'Mailbox trigger mounted')
  await click('.composer__mailbox'); await until('document.querySelector(".composer-mailbox")?.matches(":popover-open")', 'Mailbox opened')
  await click('[role="tab"][id$="-agents-tab"]')
  await until('document.querySelector(\'[data-record-key="a2a:agent-inbox"]\')', 'Received Agent message loaded')
  await wait(45); await capture('dark-agent-messages-arrival-mid', { allowRunningAnimations: true })
  await wait(260); await capture('dark-agent-messages-list')
  assert.ok(await evaluate('document.querySelector(".composer-mailbox")?.textContent.includes("The revised hierarchy is much clearer")'))
  await click('[data-record-key="a2a:agent-inbox"]'); await wait(80); await capture('dark-agent-message-detail-mid', { allowRunningAnimations: true })
  await wait(180); await capture('dark-agent-message-detail')
  assert.ok(await evaluate('document.querySelector(".composer-mailbox")?.textContent.includes("keep the selected sample visible")'))
  await click('.composer-mailbox__back button'); await wait(180)
  await click('[role="tab"][id$="-outbox-tab"]'); await until('document.querySelector(\'[data-record-key="a2a:agent-outbox"]\')', 'Sent Agent message loaded')
  await wait(180); await capture('dark-agent-messages-sent')
  await click('[role="tab"][id$="-user-tab"]'); await until('document.querySelector(\'[data-record-key="queue:hierarchy-pass"]\')', 'Queued input loaded')
  await wait(180); await capture('dark-inputs-list')
  await click('[aria-label="Send queued message"]'); assert.ok(await evaluate('experienceReview.actions.includes("send:hierarchy-pass")'))
  await click('[data-record-key="queue:hierarchy-pass"]'); await wait(220); await capture('dark-input-detail')
  assert.ok(await evaluate('document.querySelector(".composer-mailbox")?.textContent.includes("keep this exact input available for review")'))
  await click('[role="tab"][id$="-system-tab"]'); await until('document.querySelector(".composer-notice")', 'Notice list opened')
  await wait(45); await capture('dark-notices-arrival-mid', { allowRunningAnimations: true })
  await wait(260); await capture('dark-notices-list')
  assert.ok(await evaluate('[...document.querySelectorAll(".composer-notice__state")].some(node=>node.textContent==="Result unconfirmed")'))
  await click('.composer-notice__action'); await wait(100)
  assert.ok(await evaluate('experienceReview.actions.includes("check-delivery")'))
  assert.ok(await evaluate('Boolean(document.querySelector(".composer-mailbox__row"))'), 'Direct action keeps the original list readable')
  await click('.composer-notice[data-kind="indeterminate"] .composer-mailbox__row'); await wait(80); await capture('dark-notice-detail-mid', { allowRunningAnimations: true })
  await wait(180); await capture('dark-notice-detail')
  assert.ok(await evaluate('document.querySelector(".service-window__restore")?.textContent.includes("original delivery result")'))
  await click('.composer-mailbox__back button'); await wait(180); await click('.composer-mailbox__automation'); await wait(180); await capture('dark-automation-unconfirmed')
  await click('[aria-label="Back to messages"]'); await wait(150)
  win.setContentSize(390, 600); await evaluate('experienceReview.theme("light")'); await motion(true)
  await click('[role="tab"][id$="-user-tab"]'); await wait(180); await capture('light-inputs-narrow-reduced')
  assert.equal(receipt.frames.at(-1).facts.animations.length, 0, 'Reduced motion has no running Input animation')
  await click('[role="tab"][id$="-system-tab"]'); await wait(180); await capture('light-notices-narrow-reduced')
  assert.equal(receipt.frames.at(-1).facts.animations.length, 0, 'Reduced motion has no running Notice animation')
  receipt.actions = await evaluate('experienceReview.actions')
  receipt.passed = true
}).catch(error => { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy()
  receipt.cleanup = { windowDestroyed: !win || win.isDestroyed() }
  await fs.writeFile(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1)
})
