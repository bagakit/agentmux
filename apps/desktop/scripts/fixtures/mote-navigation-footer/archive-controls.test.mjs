import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import ts from 'typescript'

const repository = resolve(import.meta.dirname, '../../../../..')
const paths = ['apps/desktop/scripts/fixtures/mote-navigation-footer/archive-main.cjs',
  'apps/desktop/src/renderer/src/components/WindowUtilityBar.tsx', 'apps/desktop/src/renderer/src/App.tsx']
const [probe, owner, caller] = await Promise.all(paths.map(path => readFile(join(repository, path), 'utf8')))
const inputs = Object.fromEntries(paths.map((path, index) => [path, createHash('sha256').update([probe, owner, caller][index]).digest('hex')]))

test('compact actions proof distinguishes the owning declaration, computed flex child and actual crowded identity', async () => {
  const anchor = '          assert.equal(proof.compactActionsMutation.declaration', start = probe.indexOf(anchor)
  const end = probe.indexOf('\n        } finally {', start)
  assert.ok(start >= 0 && end > start, 'The actual compact mutation assertion block must be nonempty')
  assert.equal(probe.split(anchor).length, 2, 'There is exactly one actual compact mutation assertion block')
  const block = probe.slice(start, end)
  assert.match(block, /proof\.compactActionsMutation\.mutated\.fits/)
  const baseline = { declaration: 'inline-flex', actions: [
    { display: 'flex', width: 20, height: 24, hit: true }, { display: 'flex', width: 20, height: 24, hit: true }
  ], mutated: { fits: false } }
  assert.equal(baseline.actions.length, 2, 'The controlled assertion input contains both original actions')
  const consume = value => runInNewContext('(async () => {\n' + block + '\n})()', {
    assert, proof: { compactActionsMutation: value }, labelGeometry: async () => value.mutated
  })
  await consume(structuredClone(baseline))
  const rejected = []
  for (const [name, corrupt] of [
    ['owning rule unchanged', value => { value.declaration = 'none' }],
    ['computed child still hidden', value => { value.actions[0].display = 'none' }],
    ['computed inline display mistaken for flex child', value => { value.actions[0].display = 'inline-flex' }],
    ['original control has no area', value => { value.actions[1].width = 0 }],
    ['original control is not hit reachable', value => { value.actions[1].hit = false }],
    ['mutation does not crowd original identity', value => { value.mutated.fits = true }]
  ]) {
    const value = structuredClone(baseline); corrupt(value)
    await assert.rejects(() => consume(value), { name: 'AssertionError' }, name); rejected.push(name)
  }
  assert.equal(rejected.length, 6, 'Every semantic counterexample was consumed')
  await consume(structuredClone(baseline))
  const evidence = resolve(repository, '.tmp/mote-archive-controls', String(Date.now()))
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.mote-archive-compact-proof-source.v1', passed: true, inputs,
    sourceBlock: { start, end, sha256: createHash('sha256').update(block).digest('hex') }, actions: baseline.actions.length,
    rejected, restoredGreen: true, actualCompileCapture: false, userAppOrRunTouched: false }, null, 2))
  console.log(relative(repository, join(evidence, 'receipt.json')))
})

test('archive uses the single real Settings button from the mounted WindowUtilityBar owner', async () => {
  const start = probe.indexOf('    const panel = '), end = probe.indexOf('\n', start)
  assert.ok(start >= 0 && end > start, 'The actual control declaration must be nonempty')
  const block = probe.slice(start, end)
  assert.equal(probe.split('    const panel = ').length, 2, 'There is exactly one original control declaration')
  const selector = text => runInNewContext(text + '\nsettings')
  const tree = ts.createSourceFile(paths[1], owner, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const attribute = (opening, name) => opening.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(tree) === name)
  const buttons = []
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === 'button' && attribute(node, 'aria-label')?.initializer?.text === 'Settings') buttons.push(node)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.equal(buttons.length, 1, 'The actual utility owner must contain exactly one Settings button')
  const button = buttons[0], container = button.parent.parent
  assert.ok(ts.isJsxElement(container), 'The original Settings button has its actual JSX container')
  assert.equal(container.openingElement.tagName.getText(tree), 'div')
  assert.match(attribute(button, 'onClick').initializer.expression.getText(tree), /settings\.open\('overview'\)/)
  const callerTree = ts.createSourceFile(paths[2], caller, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const calls = []
  function visitCaller(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(callerTree) === 'WindowUtilityBar') calls.push(node)
    ts.forEachChild(node, visitCaller)
  }
  visitCaller(callerTree)
  assert.equal(calls.length, 1, 'The real App must mount this exact utility owner')
  const window = new Window()
  try {
    function element(opening) {
      const node = window.document.createElement(opening.tagName.getText(tree))
      for (const prop of opening.attributes.properties) if (ts.isJsxAttribute(prop) && prop.initializer && ts.isStringLiteral(prop.initializer))
        node.setAttribute(prop.name.getText(tree) === 'className' ? 'class' : prop.name.getText(tree), prop.initializer.text)
      return node
    }
    const toolbar = element(container.openingElement), control = element(button)
    toolbar.append(control); window.document.body.append(toolbar)
    const matches = value => {
      const found = [...window.document.querySelectorAll(value)]
      assert.equal(found.length, 1, 'The archive selector must find the single original Settings control')
      assert.equal(found[0], control, 'The archive probe uses its original public utility button')
    }
    matches(selector(block))
    const old = block.replace(selector(block), '.surface-navigation__settings[aria-label="Settings"]')
    assert.notEqual(old, block, 'The actual consumed declaration is changed for the stale-selector counterexample')
    assert.throws(() => matches(selector(old)), { name: 'AssertionError', message: /must find the single original Settings control/ })
    matches(selector(block))
    const evidence = resolve(repository, '.tmp/mote-archive-controls', String(Date.now()))
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.mote-archive-control-source.v1', passed: true, inputs,
      selector: selector(block), originalSettingsButtons: buttons.length, actualAppCallers: calls.length,
      counterexample: { name: 'stale original Settings selector', assertionRed: true, restoredGreen: true },
      actualCompileCapture: false, userAppOrRunTouched: false }, null, 2))
    console.log(relative(repository, join(evidence, 'receipt.json')))
  } finally { await window.happyDOM.close() }
})
