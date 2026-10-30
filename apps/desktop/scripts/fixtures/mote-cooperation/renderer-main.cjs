const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
app.setPath('sessionData', path.join(privateRoot, 'sessionData'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', images: [], operations: [], interactions: [], errors: [] }
let win
app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1180, height: 850, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await win.loadFile(html, { query: { phase: 'seed', retained: '1', zoneSelection: '1' } })
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    const panel = 'document.querySelector("[data-pmo-teams-topic-floating]:popover-open")'
    const cooperation = `(${panel}?.querySelector('[data-mote-cooperation]') ?? [...document.querySelectorAll('[data-mote-cooperation]')].find(n=>n.checkVisibility()))`
    const facts = () => read('window.moteCooperationCapture.facts()')
    await until('window.moteCooperationCapture?.ready && !!' + cooperation, 'Production App Mote cooperation entry')
    await read('window.__connectionsTrustedEvents=window.moteCooperationCapture.facts().trustedEvents')
    win.showInactive(); win.focus(); win.webContents.focus()
    await until('document.hasFocus()')
    await until(cooperation + '.textContent.includes("Main Agent")', 'Original main Agent qualification')
    const initial = result.initial = await facts()
    assert.equal(initial.runs.length >= 4, true, 'Nonempty original and unrelated Session identities')
    assert.equal(initial.drafts['mote-primary'], '还有一个问题先留在这里，暂不发送。')
    assert.deepEqual(initial.writes, [])
    async function capture(name) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 })
      await new Promise(resolve => setTimeout(resolve, 220))
      await settle()
      const current = await facts()
      assert.deepEqual(current.identities, initial.identities, 'Navigation must preserve every original Region/Session binding')
      assert.deepEqual(current.drafts, initial.drafts, 'Every original unsent draft survives navigation')
      assert.deepEqual(current.writes, [], 'Reading, expanding and navigating never dispatch input or lifecycle controls')
      for (const run of current.runs) assert.deepEqual(run, initial.runs.find(original => original.id === run.id), 'No original Session or Run is replaced')
      const dom = await read(`(()=>{const n=${cooperation},r=n?.getBoundingClientRect();return{body:document.body.innerText,viewport:{width:innerWidth,height:innerHeight},cooperation:r?.toJSON(),text:n?.innerText,team:[...n?.querySelectorAll('[data-mote-member]')??[]].map(m=>({sessionId:m.dataset.moteMember,hostId:m.dataset.memberHost,text:m.innerText})),request:[...document.querySelectorAll('[data-request-id]')].filter(n=>n.checkVisibility()).map(n=>n.dataset.requestId),inputs:[...document.querySelectorAll('textarea')].filter(n=>n.checkVisibility()).map(n=>({label:n.getAttribute('aria-label'),value:n.value}))}})()`)
      assert.ok(dom.cooperation?.width > 0 && dom.cooperation?.height > 0, 'The real cooperation surface is visible in the full frame')
      const file = name + '.png'
      const png = (await win.webContents.capturePage()).toPNG()
      assert.ok(png.length > 10000, 'Nonempty full Renderer image')
      await fs.writeFile(path.join(evidence, file), png)
      result.images.push(file); result.operations.push({ name, facts: current, dom })
    }
    await until('!!document.querySelector(".conversation-mote-notice")', 'Owner-qualified readable notice reaches the real conversation')
    assert.equal(await read('document.querySelector(".conversation-mote-notice").closest("[data-conversation-item-ref]").getAttribute("data-conversation-item-ref").includes("host-original")'), true, 'Original record provenance is not rewritten into the local route')
    assert.equal((await facts()).reads.filter(read => read.operation === 'mote-observation').length, 0, 'Collapsed notice causes zero detail IO')
    assert.equal(await read(panel + '.querySelector(".conversation-mote-notice__member").textContent'), '实现与校验', 'Readable return identifies the exact member, independently of Mote team branding')
    await capture('01-main-conversation-wide-dark')
    await click('js:' + panel + '.querySelector(".conversation-mote-notice__original > summary")')
    await until('document.querySelector(".conversation-mote-notice blockquote")?.textContent.includes("按已确认的范围继续")', 'Exact original observation is read on demand')
    assert.equal((await facts()).reads.filter(read => read.operation === 'mote-observation').length, 1)
    assert.equal((await facts()).reads.find(read => read.operation === 'mote-observation').target.hostId, 'local', 'Inspection uses the original execution route, not source provenance')
    await read("document.querySelector('[data-pmo-teams-topic-floating]:popover-open .conversation-mote-notice').scrollIntoView({block:'start'})")
    await capture('01b-original-decision-readable-wide-dark')
    await click('js:' + panel + '.querySelector(".conversation-mote-notice__records > summary")')
    await until('document.querySelector(".conversation-mote-notice__records")?.open', 'Full original result references remain available')
    await read("document.querySelector('[data-pmo-teams-topic-floating]:popover-open .conversation-mote-notice__records').scrollIntoView({block:'start'})")
    if (process.argv.includes('--notice-only')) {
      const viewport = await read(`(()=>{let n=document.querySelector('[data-pmo-teams-topic-floating]:popover-open .conversation-mote-notice__records');while(n&&!(n.scrollHeight>n.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(n).overflowY)))n=n.parentElement;if(!n)throw Error('Original reading viewport unavailable');const r=n.getBoundingClientRect();window.noticeToolViewport=n;window.noticeToolWheels=[];n.addEventListener('wheel',event=>window.noticeToolWheels.push({trusted:event.isTrusted,deltaY:event.deltaY}));return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: viewport.x, y: viewport.y, deltaX: 0, deltaY: -80 })
      await until(`(()=>{const tools=document.querySelector('[data-pmo-teams-topic-floating]:popover-open .conversation-mote-notice__records .conversation-detail-actions'),r=tools.getBoundingClientRect(),v=window.noticeToolViewport.getBoundingClientRect();return r.top>=v.top&&r.bottom<=v.bottom&&window.noticeToolWheels.some(e=>e.trusted)})()`, 'Original tool row is visible after a genuine reading scroll')
      result.interactions.push({ kind: 'native-reading-wheel', events: await read('window.noticeToolWheels') })
    }
    await capture('01c-complete-result-references-wide-dark')
    if (process.argv.includes('--notice-only')) {
      result.noticeTools = await read(`(()=>{const n=document.querySelector('[data-pmo-teams-topic-floating]:popover-open .conversation-mote-notice__records'),v=window.noticeToolViewport.getBoundingClientRect();return {viewport:v.toJSON(),tools:[...n.querySelectorAll('button')].map(b=>({text:b.textContent,rect:b.getBoundingClientRect().toJSON()})),originalReferences:n.querySelector('pre').textContent}})()`)
      result.final = await facts(); result.passed = true; return
    }
    await read("document.querySelector('[data-pmo-teams-topic-floating]:popover-open .conversation-mote-notice__original > summary').scrollIntoView({block:'center'})")
    await click('js:' + panel + '.querySelector(".conversation-mote-notice__original > summary")')
    await click('js:' + cooperation + '.querySelector("[aria-label=\\"Team work\\"]")')
    await until(cooperation + '.querySelectorAll("[data-mote-member]").length===2', 'Only this Mote’s two original members')
    const members = await read(cooperation + '.querySelector("[data-mote-team]").innerText')
    assert.equal(members.includes('另一位搭档的研究'), false)
    assert.equal(await read(cooperation + '.querySelector("[data-needs-you=\\"true\\"]")!==null'), true)
    await capture('02-team-expanded-wide-dark')
    await click('js:' + cooperation + '.querySelector("[data-mote-member=\\"mote-neighbor\\"] button")')
    await until(panel + '?.dataset.moteTargetSession==="mote-neighbor"', 'Exact original member Session selected')
    await until('!!document.querySelector("[data-request-id=\\"original-experiment-choice\\"]")', 'Original typed request is mounted')
    await capture('03-member-original-request-wide-dark')
    await click('js:' + cooperation + '.querySelector("[aria-label=\\"Return to main Agent\\"]")')
    await until(panel + '?.dataset.moteTargetSession==="mote-primary"', 'Return to the same original main Session')
    await capture('04-returned-main-wide-dark')
    await click('js:' + panel + '.querySelector("[aria-label=\\"Open in Space\\"]")')
    await until('!' + panel + ' && !![...document.querySelectorAll(".mote-space-frame [data-mote-cooperation]")].find(n=>n.checkVisibility())', 'Same Mote in its actual full Space')
    await capture('05-original-space-main-wide-dark')
    await click('js:' + cooperation + '.querySelector("[aria-label=\\"Team work\\"]")')
    await until(cooperation + '.querySelector("[data-mote-team]")!==null')
    await capture('06-original-space-team-wide-dark')
    await read('window.moteCooperationCapture.unknown()')
    await until(cooperation + '.textContent.includes("Status not confirmed") || ' + cooperation + '.textContent.includes("暂未确认")', 'Unconfirmed observation is explicit')
    await capture('07-unknown-original-team-retained')
    await read('window.moteCooperationCapture.restore();window.moteCooperationCapture.longNames()')
    win.setContentSize(640, 850)
    await until('innerWidth===640')
    await capture('08-long-name-space-narrow-dark')
    await read('window.moteCooperationCapture.reopen();window.moteCooperationCapture.theme(true)')
    await until('!!' + panel + ' && !!' + cooperation + ' && document.documentElement.dataset.appearance==="light"')
    await capture('09-long-name-main-narrow-light')
    await click('js:' + cooperation + '.querySelector("[aria-label=\\"Team work\\"]")')
    await until(cooperation + '.querySelector("[data-mote-team]")!==null')
    await capture('10-long-name-team-narrow-light')
    result.final = await facts()
    assert.ok(result.interactions.length >= 8 && result.interactions.every(item => item.events.some(event => event.trusted)), 'Actual trusted mouse operations are recorded')
    assert.deepEqual(result.final.writes, [])
    result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack, cause: error.cause?.message }
    if (win && !win.isDestroyed()) {
      result.failureState = await win.webContents.executeJavaScript('({body:document.body.textContent,setup:window.closedTabSetup,facts:window.moteCooperationCapture?.facts()})').catch(error => ({ error: error.message }))
      await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    if (win && !win.isDestroyed()) {
      try { await win.webContents.executeJavaScript('window.closedTabProof?.dispose()') } catch (error) { result.cleanupError = error.message; result.passed = false }
    }
    await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
