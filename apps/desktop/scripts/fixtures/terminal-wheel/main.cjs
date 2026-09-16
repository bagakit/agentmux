const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const [html, privateRoot] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { schema: 'agentmux.actual-terminal-wheel.v1', pid: process.pid,
  nativeBoundary: 'synthetic bridge and three-row-per-wheel program', runtimeCreated: false,
  userRunTouched: false, physicalDeviceTested: false, cases: [], passed: false }
let win
const info = () => win.webContents.executeJavaScript('info()')
async function mount(c) {
  let before = await win.webContents.executeJavaScript(`mount(${JSON.stringify(c.mode)},${!!c.readOnly},${!!c.pending},${!!c.applicationCursor})`)
  await delay(120)
  let stable = 0
  for (let i = 0; i < 30; i++) {
    const current = await info()
    stable = current.cols === before.cols && current.rows === before.rows && current.baseY === before.baseY ? stable + 1 : 0
    before = current
    if (stable === 3) break
    await delay(25)
  }
  assert.equal(stable, 3, 'Real public grid must settle before wheel')
  assert.equal(before.terminalCount, 1)
  assert.ok(before.point && before.cellHeight > 0 && before.length > 0)
  if (c.mode === 'normal') {
    assert.ok(before.length > 500)
    await win.webContents.executeJavaScript('terminals.at(-1).scrollToLine(300)')
    await delay(25); before = await info()
    assert.equal(before.viewportY, 300)
  } else assert.equal(before.type, 'alternate')
  return before
}
async function wheel(c, before) {
  for (let i = 0; i < (c.events ?? 1); i++) {
    if (c.unit) {
      await win.webContents.executeJavaScript(`(() => {
        const p=info().point;document.elementFromPoint(p.x,p.y).dispatchEvent(new WheelEvent('wheel', {
          bubbles:true,cancelable:true,clientX:p.x,clientY:p.y,deltaY:${-c.delta},deltaMode:${c.unit},ctrlKey:${!!c.ctrl},shiftKey:${!!c.shift}
        }))
      })()`)
    } else {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.floor(before.point.x), y: Math.floor(before.point.y),
        deltaX: c.horizontal ? 50 : 0, deltaY: c.delta, wheelTicksY: c.zeroLegacy ? 0 : c.delta / 40,
        hasPreciseScrollingDeltas: !!c.precise, canScroll: true,
        modifiers: c.ctrl ? ['control'] : c.shift ? ['shift'] : [] })
    }
    await delay(20)
  }
  await delay(100)
}
function verify(c, before, after) {
  assert.equal(after.cols, before.cols); assert.equal(after.rows, before.rows); assert.equal(after.baseY, before.baseY)
  assert.deepEqual(after.errors, [])
  assert.equal(after.wheels.length, c.events ?? 1, 'The actual DOM must receive each bounded event')
  assert.ok(after.wheels.every(e => e.isTrusted === !c.unit))
  if (c.zeroLegacy) { assert.notEqual(after.wheels[0].deltaY, 0); assert.equal(after.wheels[0].wheelDeltaY, 0) }
  if (c.mode === 'normal') {
    assert.equal(after.writes.length, 0)
    assert.ok(c.delta > 0 ? after.viewportY < before.viewportY : after.viewportY > before.viewportY,
      'Nonempty existing normal buffer must scroll in the actual direction')
    return
  }
  const gated = c.readOnly || c.pending || c.shift || c.delta === 0
  let expected = 0
  if (!gated) {
    const distance = Math.abs(c.delta) * (c.events ?? 1) * before.scrollSensitivity * (c.ctrl ? before.fastScrollSensitivity : 1)
    expected = Math.trunc(c.unit === 1 ? distance : c.unit === 2 ? distance * before.rows :
      distance / before.cellHeight * (Math.abs(c.delta) < 50 ? 0.3 : 1))
  }
  assert.ok(Number.isInteger(expected) && (gated || expected > 0))
  assert.equal(after.program.reports, expected, 'Computed integer wheel distance must reach the actual bridge')
  assert.equal(after.writes.length, expected, 'No report may be silently duplicated or discarded')
  assert.equal(after.program.top, 500 + (c.delta > 0 ? -3 : 3) * expected)
  assert.ok(after.firstLine.includes(`private-TUI-row-${after.program.top}`), 'Actual live output must repaint the TUI')
  if (!expected) return
  if (c.mode === 'alternate-mouse') {
    const encoded = after.writes.map(write => /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(write.text))
    assert.ok(encoded.length > 0 && encoded.every(Boolean))
    const code = (c.delta > 0 ? 64 : 65) + (c.ctrl ? 16 : 0)
    assert.ok(encoded.every(match => Number(match[1]) === code))
    assert.deepEqual([...new Set(encoded.map(match => `${match[2]}:${match[3]}`))], [`${encoded[0][2]}:${encoded[0][3]}`],
      'Each fresh report must retain its original coordinates')
  } else if (c.mode === 'alternate-binary') {
    assert.ok(after.writes.every(write => write.binary && write.length === 6))
    assert.ok(after.writes[0].bytes[4] >= 128, 'Legacy coordinates must exercise actual Latin-1 bytes')
    assert.ok(after.writes.every(write => write.bytes[3] === 96 && write.bytes[4] === after.writes[0].bytes[4] && write.bytes[5] === after.writes[0].bytes[5]))
  } else assert.ok(after.writes.every(write => write.text === `\x1b${c.applicationCursor ? 'O' : '['}${c.delta > 0 ? 'A' : 'B'}`))
}
const cases = [
  { name:'normal-up', mode:'normal', delta:350 },
  { name:'normal-down', mode:'normal', delta:-350 },
  { name:'normal-standard-with-zero-legacy-readonly', mode:'normal', delta:350, zeroLegacy:true, precise:true, readOnly:true },
  { name:'sgr-up', mode:'alternate-mouse', delta:350 },
  { name:'sgr-down', mode:'alternate-mouse', delta:-350 },
  { name:'sgr-precise-fraction', mode:'alternate-mouse', delta:20, precise:true, events:10 },
  { name:'sgr-line-integer', mode:'alternate-mouse', delta:1, unit:1 },
  { name:'sgr-page-integer', mode:'alternate-mouse', delta:1, unit:2 },
  { name:'sgr-ctrl-modifier', mode:'alternate-mouse', delta:1, unit:1, ctrl:true },
  { name:'sgr-shift-local', mode:'alternate-mouse', delta:350, shift:true },
  { name:'alternate-normal-keys', mode:'alternate-keys', delta:350 },
  { name:'alternate-application-keys', mode:'alternate-keys', delta:-350, applicationCursor:true },
  { name:'legacy-binary-coordinates', mode:'alternate-binary', delta:350 },
  { name:'sgr-readonly', mode:'alternate-mouse', delta:350, readOnly:true },
  { name:'sgr-permission-pending', mode:'alternate-mouse', delta:350, pending:true },
  { name:'sgr-horizontal-zero', mode:'alternate-mouse', delta:0, horizontal:true }
]
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({width:1560,height:580,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true}})
    await win.loadFile(html); win.showInactive()
    for (let i = 0; i < 100 && !await win.webContents.executeJavaScript('window.ready===true'); i++) await delay(30)
    assert.equal(await win.webContents.executeJavaScript('window.ready===true'), true)
    for (const distribution of ['esm','umd']) {
      await win.webContents.executeJavaScript(`setDistribution(${JSON.stringify(distribution)})`)
      for (const c of cases) {
        const before = await mount(c); await wheel(c, before); const after = await info()
        result.cases.push({distribution,...c,before,after})
        verify(c,before,after)
      }
    }
    assert.equal(result.cases.length, 32)
    result.passed = true
  } catch (error) { result.failure = error.stack }
  finally {
    if (win && !win.isDestroyed()) win.destroy()
    fs.writeFileSync(path.join(privateRoot,'browser.json'), JSON.stringify(result,null,2))
    app.exit(result.passed ? 0 : 1)
  }
})
