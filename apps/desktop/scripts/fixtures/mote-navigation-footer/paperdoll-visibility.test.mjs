import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const file = resolve(import.meta.dirname, 'paperdoll-main.cjs'), source = await readFile(file, 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = resolve(import.meta.dirname, '../../../../../.tmp/mote-paperdoll-visibility', String(Date.now()))
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.mote-paperdoll-visibility-source.v1', source: { path: file, sha256: hash(source) }, actualCompileCapture: false, userAppOrRunTouched: false,
  boundary: 'Actual private Node flow executes against a controlled Window/CDP Page Visibility policy model. This verifies conditions/restoration and nonempty observations, not Electron native visibility or product animations.', cases: [], mutations: [] }
async function acceptance(text, priorBackgroundThrottling = false) {
  const helperStart = text.indexOf('    let focusEmulationEnabled'), helperEnd = text.indexOf('    const node =', helperStart)
  const start = text.indexOf('      const visibilitySample ='), end = text.indexOf('      win.setContentSize(420, 820)', start)
  assert.ok(helperStart >= 0 && helperEnd > helperStart && start >= 0 && end > start, 'Two original nonempty flow blocks exist')
  const state = { visible: true, backgroundThrottling: priorBackgroundThrottling, focus: false }, calls = [], checks = [], result = {}
  const original = { tabs: { 'original-tab': { sessionId: 'original-agent' } }, drafts: { 'original-agent': 'Original unsent text' }, runs: { 'original-agent': 'healthy-original-run' } }
  const hidden = () => !state.visible && state.backgroundThrottling && !state.focus
  const facts = async () => ({ protected: structuredClone(original), ui: { entry: { motion: { motion: hidden() ? 'off' : 'on', expression: 'idle', animations: hidden() ? [] : [{ name: 'native-idle', state: 'running' }] } } } })
  const read = async expression => runInNewContext(expression, { document: { hidden: hidden(), visibilityState: hidden() ? 'hidden' : 'visible' } })
  const win = { isVisible: () => state.visible, hide: () => { calls.push('hide'); state.visible = false }, showInactive: () => { calls.push('show'); state.visible = true }, webContents: {
    getBackgroundThrottling: () => state.backgroundThrottling, setBackgroundThrottling: value => { calls.push(['background', value]); state.backgroundThrottling = value }
  } }
  await runInNewContext('(async () => {\n' + text.slice(helperStart, helperEnd) + '\n' + text.slice(start, end) + '\n})()', {
    win, result, assert, read, facts, reduced: await facts(), offscreen: await facts(),
    input: async (method, options) => { assert.equal(method, 'Emulation.setFocusEmulationEnabled'); calls.push(['focus', options.enabled]); state.focus = options.enabled },
    until: async expression => {
      const fact = await facts()
      assert.equal(runInNewContext(expression, { document: { hidden: hidden() }, window: { motePaperdollProof: { facts: () => fact } } }), true, 'Real observation predicate must admit hiding under the controlled policy boundary')
    },
    animate: async expression => { const fact = await facts(); assert.equal(fact.ui.entry.motion.expression, expression); assert.equal(fact.ui.entry.motion.motion, 'on'); assert.equal(fact.ui.entry.motion.animations.length, 1) },
    protectedSame: (before, after) => { assert.equal(Object.keys(before.protected.tabs).length, 1); assert.equal(Object.keys(before.protected.drafts).length, 1); assert.deepEqual(after.protected, before.protected) },
    check: (name, data) => checks.push({ name, data })
  })
  assert.equal(checks.length, 1); assert.ok(calls.length >= 6)
  assert.equal(result.visibility.before.windowVisible, true); assert.equal(result.visibility.hidden.windowVisible, false)
  assert.equal(result.visibility.hidden.page.hidden, true); assert.equal(result.visibility.hidden.facts.ui.entry.motion.animations.length, 0)
  assert.equal(result.visibility.after.backgroundThrottling, priorBackgroundThrottling); assert.equal(result.visibility.after.focusEmulationEnabled, true)
  assert.equal(result.visibility.after.windowVisible, true); assert.equal(result.visibility.after.page.hidden, false)
  assert.equal(state.backgroundThrottling, priorBackgroundThrottling); assert.equal(state.focus, true)
  return { priorBackgroundThrottling, calls, observations: JSON.parse(JSON.stringify(result.visibility)) }
}
test('actual hidden flow has nonempty before/hidden/after observations and restores each original policy', async () => {
  receipt.cases.push(await acceptance(source, false), await acceptance(source, true))
})
test('wrong throttling, missing focus release and wrong restoration make original flow acceptance red', async () => {
  const variants = [
    ['visibility forced visible', 'win.webContents.setBackgroundThrottling(true); await setFocusEmulation(false)', 'win.webContents.setBackgroundThrottling(false); await setFocusEmulation(false)'],
    ['focus emulation not released', 'win.webContents.setBackgroundThrottling(true); await setFocusEmulation(false)', 'win.webContents.setBackgroundThrottling(true); await setFocusEmulation(true)'],
    ['prior throttling not restored', 'win.webContents.setBackgroundThrottling(visibility.before.backgroundThrottling)', 'win.webContents.setBackgroundThrottling(true)']
  ]
  assert.equal(variants.length, 3)
  for (const [name, anchor, replacement] of variants) {
    assert.ok(source.includes(anchor)); const changed = source.replace(anchor, replacement); assert.notEqual(changed, source)
    let red
    try { await acceptance(changed) } catch (error) { red = error }
    assert.equal(red?.name, 'AssertionError', 'A semantic flow assertion must fail: ' + name)
    await acceptance(source)
    receipt.mutations.push({ name, mutated: hash(changed), red: { name: red.name, message: red.message }, restoredGreen: true })
    await writeFile(join(evidence, name.replaceAll(' ', '-') + '.source.cjs'), changed)
  }
  assert.equal(hash(await readFile(file)), hash(source)); receipt.passed = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json'), cases: receipt.cases.length, mutations: receipt.mutations.length }))
})
