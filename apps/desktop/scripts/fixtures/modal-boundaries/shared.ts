import assert from 'node:assert/strict'
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { proof, output, delay, wait, screenshot } from './common'

void proof(async receipt => {
  const window = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { backgroundThrottling: false } })
  await window.loadFile(join(output, 'renderer/index.html')); window.showInactive()
  window.webContents.debugger.attach('1.3'); await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const read = (script: string) => window.webContents.executeJavaScript(script)
  await wait(() => read('!!window.modalProof'), 'Actual shared Renderer must load')
  const key = async (key: string, virtual: number) => { for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: virtual, ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}) }); await delay(100) }
  for (const kind of ['empty', 'busy', 'confirmation']) {
    const initial = await read(`modalProof.render(${JSON.stringify(kind)})`), outside = await read('modalProof.outsideFocus()')
    receipt.cases.push({ kind, initial, outside })
    assert.equal(initial.inside, true, 'shared focus fallback must be inside the actual modal boundary: ' + kind)
    assert.equal(outside.inside, true, 'shared focus trap retains the original modal: ' + kind)
    if (kind === 'confirmation') assert.equal(initial.active, 'BUTTON', 'Actual destructive confirmation initially focuses Cancel')
  }
  const initial = await read('modalProof.render("controls")'), removed = await read('modalProof.removeLast()'), outside = await read('modalProof.outsideFocus()')
  receipt.cases.push({ kind: 'remove-last', initial, removed, outside })
  assert.equal(removed.inside && outside.inside, true, 'shared focus fallback survives removal of the last focusable control')
  await read('modalProof.render("attachment")'); await read('modalProof.focusAttachment()'); await key('Tab', 9)
  const tab = await read('modalProof.state()'); assert.equal(tab.inside, true, 'shared attached control remains in the original Tab boundary')
  await key('Escape', 27); const escaped = await read('modalProof.state()'); receipt.cases.push({ kind: 'attachment-tab-escape', tab, escaped })
  assert.deepEqual(escaped.changes, [false], 'shared Escape dismisses the original modal exactly once')
  for (const marker of ['composing', 'legacy']) {
    await read('modalProof.render("hostfolder")'); await read('modalProof.setFolder()')
    const escaped = await read(`modalProof.ime("Escape",${JSON.stringify(marker)})`), entered = await read(`modalProof.ime("Enter",${JSON.stringify(marker)})`)
    receipt.cases.push({ kind: 'hostfolder-ime', marker, escaped, entered })
    assert.deepEqual(escaped.changes, [], 'shared IME Escape retains the original HostFolder request')
    assert.equal(escaped.defaultPrevented, true, 'shared IME Escape is consumed by the original input environment')
    assert.equal(entered.defaultPrevented, true, 'shared IME Enter cannot submit the original HostFolder form')
    assert.deepEqual(entered.additions, [], 'shared IME Enter never performs the original add-folder side effect')
    await key('Enter', 13); const ordinary = await read('modalProof.state()'); receipt.cases.push({ kind: 'hostfolder-ordinary-enter', marker, ordinary })
    assert.equal(ordinary.additions.length, 1, 'A real ordinary Chromium Enter performs the original form action exactly once')
  }
  await read('modalProof.render("controls")'); await read('modalProof.focusEditor()')
  for (const destination of [true, false]) {
    const moved = await read(`modalProof.move(${destination})`); receipt.cases.push({ kind: 'retained-document-move', destination, moved })
    assert.equal(moved.sameInput, true, 'shared document move retains the exact original input DOM')
    assert.equal(moved.draft, 'Original preserved selection', 'shared document move retains the unsent original draft')
    assert.deepEqual(moved.selection, [3, 11], 'shared document move retains the original text selection')
  }
  await read('modalProof.render("confirmation")'); receipt.screenshots.push(await screenshot(window, 'shared-confirmation'))
})
