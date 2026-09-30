import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { Window } from 'happy-dom'

const file = resolve(import.meta.dirname, 'paperdoll-main.cjs'), source = await readFile(file, 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const styles = await Promise.all(['base', 'overlays', 'space-object-appearance'].map(async name => {
  const path = resolve(import.meta.dirname, '../../../src/renderer/src/styles', name + '.css'), bytes = await readFile(path)
  return { path, sha256: hash(bytes), text: bytes.toString('utf8') }
}))
const evidence = resolve(import.meta.dirname, '../../../../../.tmp/mote-paperdoll-save-paint', String(Date.now()))
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.mote-paperdoll-save-paint-source.v1', source: { path: file, sha256: hash(source) }, styles: styles.map(({ text, ...row }) => row),
  actualCompileCapture: false, userAppOrRunTouched: false, boundary: 'Original Node read/assertion block executes against actual happy-dom DOM/CSSOM and current styles. Geometry and Canvas color decoding are controlled boundaries; this does not claim native pixels, viewport reachability or visual approval.', cases: [], mutations: [] }
async function acceptance(text, fault) {
  const start = text.indexOf('      assert.equal(editor.save.primary, true)'), end = text.indexOf('      return current', start)
  assert.ok(start >= 0 && end > start && text.slice(start, end).includes('const paint = editor.paint = await read'), 'Original nonempty actual paint observation/assertion block exists')
  const window = new Window(), document = window.document
  const theme = document.createElement('style')
  theme.textContent = ':root { --green-bg: rgba(80,160,120,0.2); --green-text: rgb(160,220,180); --text-2: rgb(140,145,150); --bg: rgb(20,20,20); }'
  document.head.append(theme)
  for (const source of styles) { const style = document.createElement('style'); style.textContent = source.text; document.head.append(style); assert.ok(style.sheet.cssRules.length > 0) }
  document.body.innerHTML = '<div class="space-icon-picker dialog-surface" role="dialog"><footer><button class="small-button">Cancel</button><button class="primary-button space-icon-picker__save">Save avatar</button></footer></div>'
  const save = document.querySelector('.space-icon-picker__save'), cancel = document.querySelector('footer button')
  assert.ok(save && cancel)
  for (const control of [save, cancel]) control.getBoundingClientRect = () => ({ width: control === save && fault === 'zero-area' ? 0 : 80, height: 28 })
  if (fault === 'transparent-save') { save.style.background = 'transparent'; cancel.style.background = 'rgb(40,40,40)' }
  if (fault === 'identical-actions') { cancel.style.background = 'var(--green-bg)'; cancel.style.color = 'var(--green-text)' }
  if (fault === 'empty-primary-rules' || fault === 'empty-paint-declaration') {
    save.style.background = 'var(--green-bg)'; save.style.color = 'var(--green-text)'
    const sheet = [...document.styleSheets].find(sheet => [...sheet.cssRules].some(rule => rule.selectorText === '.dialog-surface footer .primary-button'))
    assert.ok(sheet); const index = [...sheet.cssRules].findIndex(rule => rule.selectorText === '.dialog-surface footer .primary-button'); assert.ok(index >= 0)
    if (fault === 'empty-primary-rules') sheet.deleteRule(index)
    else sheet.cssRules[index].style.removeProperty('background')
  }
  // This finite Canvas boundary only decodes these controlled theme colors; actual Electron uses its native Canvas.
  const pixels = { 'rgba(80, 160, 120, 0.2)': [80, 160, 120, 51], 'rgba(0, 0, 0, 0)': [0, 0, 0, 0], transparent: [0, 0, 0, 0], 'rgb(40, 40, 40)': [40, 40, 40, 255] }
  const observed = [], context = { fillStyle: '', clearRect() {}, fillRect() {}, getImageData() { assert.ok(pixels[this.fillStyle], 'Controlled Canvas color is in the explicit boundary'); observed.push(this.fillStyle); return { data: new Uint8ClampedArray(pixels[this.fillStyle]) } } }
  window.HTMLCanvasElement.prototype.getContext = () => context
  const editor = { save: { primary: true, background: 'none' }, cancel: { primary: false } }, expressions = []
  try {
    await runInNewContext('(async () => {\n' + text.slice(start, end) + '\n})()', { assert, editor, read: async expression => { expressions.push(expression); return runInNewContext(expression, { document, getComputedStyle: window.getComputedStyle.bind(window) }) } })
    assert.equal(expressions.length, 1); assert.equal(observed.length, 2)
    assert.equal(editor.paint.save.backgroundPixel.length, 4)
    assert.equal(editor.save.background, 'none', 'The r3 compiled-entry matte image fact is valid without a gradient')
    return JSON.parse(JSON.stringify(editor.paint))
  } finally { await window.happyDOM.close() }
}
async function qualification(text) {
  const positive = await acceptance(text), negatives = []
  assert.equal(positive.primaryRules.length, 1)
  for (const fault of ['transparent-save', 'identical-actions', 'empty-primary-rules', 'empty-paint-declaration', 'zero-area']) {
    let red
    try { await acceptance(text, fault) } catch (error) { red = error }
    assert.equal(red?.name, 'AssertionError', 'Actual paint qualification rejects ' + fault)
    negatives.push({ fault, name: red.name, message: red.message })
  }
  assert.equal(negatives.length, 5)
  return { positive, negatives }
}
test('original matte Dialog Save has actual distinct nontransparent paint, positive geometry and a nonempty loaded rule', async () => {
  receipt.cases.push(await qualification(source))
})
test('removing alpha, distinction or nonempty-rule Source guards makes the original paint qualification red', async () => {
  const variants = [
    ['transparent paint admitted', "      assert.ok(paint.save.backgroundPixel[3] > 0, 'Save has actual nontransparent primary paint')\n"],
    ['identical action paint admitted', "      assert.notEqual(paint.save.background, paint.cancel.background, 'Save and Cancel have distinct actual backgrounds')\n      assert.notEqual(paint.save.color, paint.cancel.color, 'Save and Cancel have distinct actual text colors')\n"],
    ['empty loaded rules admitted', "      assert.equal(paint.primaryRules.length, 1, 'Exactly one loaded original Dialog primary rule is observed')\n"]
  ]
  assert.equal(variants.length, 3)
  for (const [name, anchor] of variants) {
    assert.ok(source.includes(anchor)); const changed = source.replace(anchor, ''); assert.notEqual(changed, source)
    let red
    try { await qualification(changed) } catch (error) { red = error }
    assert.equal(red?.name, 'AssertionError', 'Real guard deletion causes semantic qualification RED: ' + name)
    await qualification(source)
    receipt.mutations.push({ name, mutated: hash(changed), red: { name: red.name, message: red.message }, restoredGreen: true })
    await writeFile(join(evidence, name.replaceAll(' ', '-') + '.source.cjs'), changed)
  }
  assert.equal(hash(await readFile(file)), hash(source)); receipt.passed = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json'), cases: receipt.cases.length, mutations: receipt.mutations.length }))
})
