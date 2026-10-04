const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, scenes: [], screenshots: [], nativeTitleBoundary: 'Actual native pointer hover plus DOM title and accessible name verified; capturePage excludes operating-system tooltip surfaces.' }
let win
const read = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(expression) {
  for (let i = 0; i < 100; i++) { if (await read(expression)) return; await delay(30) }
  throw new Error('Timed out: ' + expression)
}
async function mouse(expression, click = false) {
  const p = await read(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, buttons: 0 })
  if (click) for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 })
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 420, height: 600, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
    win.webContents.debugger.attach('1.3')
    await win.loadFile(html)
    await wait('document.querySelectorAll(".branch-row__state").length===8')
    for (const appearance of ['dark', 'light']) for (const width of [420, 260]) {
      win.setContentSize(width, 600)
      await read(`document.documentElement.dataset.appearance=${JSON.stringify(appearance)}`)
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 1, y: 599, buttons: 0 })
      await delay(160)
      const actual = await read(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,right:r.right,width:r.width,height:r.height}};return [...document.querySelectorAll('.branch-row')].map(row=>{const status=row.querySelector('.branch-row__state'),style=getComputedStyle(status);return{name:row.querySelector('strong').textContent,title:status.title,aria:status.getAttribute('aria-label'),role:status.getAttribute('role'),text:status.textContent,icon:status.querySelector('svg').getAttribute('class'),color:style.color,background:style.backgroundColor,border:style.borderWidth,status:rect(status),identity:rect(row.querySelector('.selector-row__identity')),meta:rect(row.querySelector('.selector-row__meta')),row:rect(row),selected:row.classList.contains('branch-row--selected')}})})()`)
      assert.equal(actual.length, 8)
      assert.deepEqual(actual.map(row => row.title), ['Current branch', ...Array(5).fill('Worktree'), 'Branch without worktree', 'Branch without worktree'])
      assert.equal(new Set(actual.map(row => row.icon)).size, 3)
      for (const row of actual) {
        assert.equal(row.title, row.aria); assert.equal(row.role, 'img'); assert.equal(row.text, '')
        assert.ok(row.status.width <= 16 && row.status.width > 0)
        assert.equal(row.background, 'rgba(0, 0, 0, 0)'); assert.equal(row.border, '0px')
        assert.ok(row.identity.width > 0 && row.identity.right <= row.meta.x + 0.5, 'Name/path and meta never overlap')
        assert.ok(row.status.right <= width && row.row.right <= width)
      }
      assert.ok(actual[0].selected); assert.notEqual(actual[0].color, actual[1].color)
      assert.equal(await read('document.querySelectorAll(".selector-presence .agent-avatar").length'), 2)
      assert.equal(await read('document.querySelector(".branch-row__sync").textContent'), '↑2')
      const screenshot = `${appearance}-${width}.png`
      await fs.writeFile(path.join(evidence, screenshot), (await win.webContents.capturePage()).toPNG())
      result.screenshots.push(screenshot); result.scenes.push({ appearance, width, rows: actual })
    }
    result.hovers = []
    for (const index of [0, 1, 6]) {
      const target = `document.querySelectorAll('.branch-row__state')[${index}]`
      await mouse(target); await delay(80); await mouse(target); await delay(120)
      const hover = await read(`(()=>{const e=${target};return{hovered:e.matches(':hover'),title:e.title,aria:e.getAttribute('aria-label')}})()`)
      assert.ok(hover.hovered); assert.equal(hover.title, hover.aria); result.hovers.push(hover)
    }
    await read(`document.querySelector('.branch-row__pin').focus()`); await delay(160)
    assert.ok(await read(`Number(getComputedStyle(document.querySelector('.branch-row__pin')).opacity)>0`))
    await mouse(`document.querySelector('.branch-row__pin')`, true)
    assert.equal(await read(`branchStyle.calls.filter(call=>call[0]==='pin').length`), 1)
    assert.equal(await read(`branchStyle.calls.filter(call=>call[0]==='open').length`), 0)
    await mouse(`document.querySelectorAll('.branch-row__open')[1]`, true)
    await wait('branchStyle.calls.some(call=>call[0]==="open")')
    assert.deepEqual(await read('branchStyle.calls.filter(call=>call[0]==="open").map(call=>call[1])'), ['agentmux/continuous-progress-review'])
    await mouse(`document.querySelectorAll('.branch-row__open')[6]`, true)
    await wait('Boolean(document.querySelector(".branch-create-dialog"))')
    assert.equal(await read('document.querySelectorAll(".branch-create-dialog").length'), 1)
    result.originalActions = { worktreeOpen: true, unboundCreate: true, pinFocusAndClick: true }
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack }; console.error(error) }
  finally { await fs.writeFile(path.join(evidence, 'electron.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
