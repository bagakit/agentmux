const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(evidence, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], actions: [], errors: [] }
app.whenReady().then(async () => {
  let window
  try {
    Menu.setApplicationMenu(null)
    window = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await window.loadFile(html, { query: { workspacePath: path.join(evidence, 'workspace', 'scratch'), contextProof: '1' } })
    const read = script => window.webContents.executeJavaScript(script)
    const wait = async script => { for (let i = 0; i < 100; i++) { if (await read(script)) return; await pause(30) } throw Error('Timed out: ' + script) }
    await wait('!!window.moteQuick')
    const click = async selector => {
      const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Original control missing');const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(!hit||!n.contains(hit))throw Error('Original control covered: '+${JSON.stringify(selector)});return {x,y}})()`)
      for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
      result.actions.push({ action: 'trusted-click', selector, point }); await pause(120)
    }
    const facts = () => read(`(()=>{const p=document.querySelector('[data-pmo-teams-topic-floating]'),s=p.querySelector('.mote-context-status'),i=p.querySelector('[contenteditable=true]'),d=s?.querySelector('[popover=hint]');const r=p.getBoundingClientRect();return {source:moteQuick.facts(),status:s?.textContent,summary:s?.querySelector('.service-disclosure__trigger')?.textContent,detailsOpen:!!d?.matches(':popover-open'),input:i?{text:i.textContent,inert:!!i.closest('[inert]'),bounds:JSON.parse(JSON.stringify(i.getBoundingClientRect()))}:null,panel:{x:r.x,y:r.y,width:r.width,height:r.height},bodyBanners:[...p.querySelectorAll('.workbench-restore-notice.mote-context-notice')].map(n=>n.textContent)}})()`)
    const capture = async name => {
      await pause(100); const observed = await facts()
      assert.ok(observed.panel.width > 100 && observed.panel.height > 100)
      assert.equal(observed.bodyBanners.length, 0, 'Preparation/location is not a stacked body banner')
      await fs.writeFile(path.join(evidence, name + '.png'), (await window.webContents.capturePage()).toPNG())
      result.images.push(name + '.png'); result.actions.push({ action: 'capture', name, observed })
    }
    for (const narrow of [false, true]) {
      const suffix = narrow ? 'narrow' : 'wide'
      window.setContentSize(narrow ? 520 : 1000, 800)
      await read(`(async()=>{await moteQuick.contextScenario('normal');moteQuick.theme(${narrow});moteQuick.floatSize(${narrow ? 480 : 720},520)})()`)
      await wait("!!document.querySelector('[data-pmo-teams-topic-floating]:popover-open [contenteditable=true]')")
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.action==='prepare'&&o.state==='confirmed')")
      assert.equal((await facts()).summary, undefined)
      await capture('context-normal-' + suffix)
      await read("moteQuick.contextScenario('prepare-failure')")
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.failure?.step==='ensure-mote')")
      assert.equal((await facts()).input.inert, false)
      await capture('context-preparation-' + suffix)
      await click('.mote-context-status .service-disclosure__trigger')
      await wait("!!document.querySelector('.mote-context-status [popover=hint]:popover-open')")
      await capture('context-preparation-details-' + suffix)
      const original = (await facts()).source
      await read('moteQuick.contextPending()'); await click('.mote-context-status [data-mote-context-retry]')
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.state==='pending'&&o.failure?.step==='ensure-mote')")
      assert.equal((await facts()).input.inert, false)
      await capture('context-retry-pending-' + suffix)
      await read('moteQuick.contextConfirm()')
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.state==='confirmed'&&o.failure===null)")
      const confirmed = (await facts()).source
      for (const name of ['tabs', 'layouts', 'sessions', 'drafts']) assert.deepEqual(confirmed[name], original[name], name + ' must survive the real Retry control')
      await read("moteQuick.contextScenario('read-failure')")
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.failure?.step==='read-discussion')")
      assert.equal((await facts()).input.inert, false)
      assert.equal((await facts()).source.calls.filter(call => call.operation === 'error').length, 0, 'The original discussion failure has one visible owner')
      await capture('context-read-failure-' + suffix)
      await click('.mote-context-status .service-disclosure__trigger')
      await wait("!!document.querySelector('.mote-context-status [popover=hint]:popover-open')")
      await capture('context-read-failure-details-' + suffix)
      await read("moteQuick.contextScenario('parent-available')")
      await wait("moteQuick.facts().projection.issueKind==='parent-available'")
      assert.equal((await facts()).input.inert, false)
      await capture('context-original-parent-' + suffix)
      await read("moteQuick.contextScenario('location-choice')")
      await wait("moteQuick.facts().projection.issueKind==='choice'")
      await capture('context-location-choice-' + suffix)
      await click('.mote-context-status .service-disclosure__trigger')
      await wait("!!document.querySelector('.mote-context-status [popover=hint]:popover-open')")
      await capture('context-location-details-' + suffix)
      await click('.mote-context-status__locations button')
      await wait("moteQuick.facts().projection.issue===null&&!!document.querySelector('[data-pmo-teams-topic-floating] [contenteditable=true]')")
      await capture('context-location-selected-' + suffix)
      assert.equal((await facts()).source.floating.targetTabId, 'original-discussion')
    }
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) { result.error = { message: error.message, stack: error.stack } }
  finally {
    await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    window?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
