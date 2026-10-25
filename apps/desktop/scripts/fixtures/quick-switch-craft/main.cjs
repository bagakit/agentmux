const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto')
const [html, temporary, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user-data')); app.setPath('sessionData', path.join(temporary, 'session-data'))
const result = { passed: false, frames: [], checks: [], userRunTouched: false }
let win
const call = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(fn) { const until = Date.now() + 10000; while (Date.now() < until) { if (await call(fn)) return; await delay(30) } assert.fail('Actual quick-switch condition absent: ' + fn.toString()) }
async function paint() { await call(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await delay(180) }
async function key(key, code, vk) { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}) }); await paint() }
async function clickMode(label) {
  const point = await call(label => { const e = [...document.querySelectorAll('.quick-switch__modes button')].find(button => button.textContent === label); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }, label)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await paint()
}
async function query(value) {
  await call(value => { const field = document.querySelector('.quick-switch [role="combobox"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); field.focus() }, value)
  await paint()
}
async function open(theme, width, height) {
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await call(theme => quickCraft.show(theme), theme)
  await wait(() => !!document.querySelector('.quick-switch [role="combobox"]')); await paint()
  if (await call(() => !!document.querySelector('[aria-label="Find project files"]'))) await clickMode('Sessions & tabs')
  assert.equal(await call(() => document.activeElement === document.querySelector('.quick-switch [role="combobox"]')), true, 'Opening the switcher focuses its actual query')
}
async function close() {
  await key('Escape', 'Escape', 27); await wait(() => !document.querySelector('.quick-switch'))
  assert.equal(await call(() => document.activeElement?.getAttribute('aria-label')), 'Original unsaved draft', 'Cancel restores the retained source')
  assert.equal(await call(() => document.querySelector('[aria-label="Original unsaved draft"]').value), 'Keep the original draft and selection.')
}
async function frame(name) {
  await call(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))); await paint()
  const geometry = await call(() => { const e = document.querySelector('.quick-switch'), r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, scroll: e.scrollWidth, client: e.clientWidth } })
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width + 1 && geometry.top >= 0 && geometry.bottom <= geometry.height + 1, 'Dialog fits the actual viewport')
  assert.equal(geometry.scroll, geometry.client, 'Dialog has no horizontal overflow')
  const file = name + '.png', bytes = (await win.webContents.capturePage()).toPNG(); await fs.writeFile(path.join(evidence, file), bytes)
  result.frames.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), geometry })
}
app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true }); win = new BrowserWindow({ show: false, width: 1080, height: 760, webPreferences: { backgroundThrottling: false, sandbox: false } })
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await wait(() => !!window.quickCraft)
    await open('dark', 1080, 760)
    const glyphs = await call(() => [...document.querySelectorAll('.quick-switch__row')].map(row => [row.querySelector('.quick-switch__row-title').textContent, row.querySelector('[data-semantic-icon]').getAttribute('data-semantic-icon')]))
    assert.deepEqual(new Set(glyphs.map(row => row[1])), new Set(['object.browser', 'file.code', 'git.compare', 'object.launcher']), 'Actual typed index reaches the correct glyphs')
    const firstOption = await call(() => document.querySelector('.quick-switch__row[data-active="true"]').id)
    await key('ArrowDown', 'ArrowDown', 40)
    assert.notEqual(await call(() => document.querySelector('.quick-switch__row[data-active="true"]').id), firstOption, 'ArrowDown moves the current row from the query')
    assert.equal(await call(() => { const input = document.querySelector('[role="combobox"]'), active = document.querySelector('.quick-switch__row[data-active="true"]'); return input.getAttribute('aria-activedescendant') === active.id }), true)
    await frame('sessions-wide-dark-active'); await close()
    await open('light', 380, 620); await frame('sessions-narrow-light'); await close()
    await open('dark', 1080, 760); await clickMode('Project files'); await wait(() => document.querySelectorAll('.quick-file-picker [role="option"]').length === 3)
    const activeFile = await call(() => document.querySelector('.quick-file-picker [role="combobox"]').getAttribute('aria-activedescendant'))
    await key('ArrowDown', 'ArrowDown', 40)
    assert.equal(await call(previous => { const input = document.querySelector('.quick-file-picker [role="combobox"]'), row = document.querySelector('.quick-file-picker [data-active="true"]'); return input === document.activeElement && input.getAttribute('aria-activedescendant') === row.id && row.id !== previous }, activeFile), true, 'Files expose their actual keyboard-active row')
    await frame('files-wide-dark'); await close()
    await open('light', 380, 620)
    await call(() => [...document.querySelectorAll('.quick-switch__modes button')].find(button => button.textContent === 'Project files').focus())
    assert.equal(await call(() => document.activeElement.textContent), 'Project files', 'The mode button receives real keyboard focus')
    await key('Enter', 'Enter', 13); await wait(() => document.querySelectorAll('.quick-file-picker [role="option"]').length === 3)
    await query('QuickSwitcher'); await frame('files-narrow-light-match')
    await query('No matching project file')
    assert.equal(await call(() => { const empty = document.querySelector('.quick-file-picker .quick-switch__empty'), input = document.querySelector('.quick-file-picker [role="combobox"]'); return empty.getAttribute('role') === 'status' && !empty.closest('[role="listbox"]') && !input.hasAttribute('aria-activedescendant') }), true, 'File empty copy is an honest status outside the option list')
    await frame('files-narrow-light-empty'); await close()
    await open('light', 380, 620); await query('No matching workface'); await frame('sessions-narrow-light-empty'); await close()
    await open('dark', 1080, 760); await query(''); await call(() => quickCraft.empty()); await paint();
    assert.equal(await call(() => document.querySelector('.quick-switch__empty').textContent), 'No open sessions or tabs yet.')
    await frame('sessions-wide-dark-no-workfaces')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    assert.equal(await call(() => getComputedStyle(document.querySelector('.quick-switch')).animationName), 'none', 'Reduced motion remains static')
    result.checks.push({ typedGlyphs: glyphs, activeDescendant: true, retainedDraftAndFocus: true, reducedMotion: true, privatePreviewOnly: true }); result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally { await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
