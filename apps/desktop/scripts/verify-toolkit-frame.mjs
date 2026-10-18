import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/toolkit-frame')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = async (file) => JSON.parse(await readFile(file, 'utf8'))
assert.equal(
  process.argv.length,
  2,
  'Consume the current Toolkit frame qualification',
)

async function checkFiles(base, files) {
  assert.ok(Object.keys(files).length > 0, 'Evidence inputs cannot be empty')
  for (const [file, hash] of Object.entries(files)) {
    assert.ok(
      !isAbsolute(file) &&
        !relative(base, resolve(base, file)).startsWith('..'),
      'Bounded evidence file',
    )
    assert.match(hash, /^[a-f0-9]{64}$/u)
    assert.equal(
      sha(await readFile(resolve(base, file))),
      hash,
      'Exact evidence bytes: ' + file,
    )
  }
}

const captures = {}
for (const name of ['baseline', 'height', 'wrap', 'action']) {
  const directory = resolve(evidence, name)
  const capture = await json(resolve(directory, 'receipt.json'))
  assert.equal(capture.completed, true, name + ': actual capture completed')
  assert.deepEqual(capture.drift, [])
  assert.deepEqual(capture.remainingPrivateProcesses, [])
  assert.equal(capture.privateRootRemoved, true)
  assert.equal(capture.process.timedOut, false)
  assert.equal(capture.process.interruption, null)
  await checkFiles(root, capture.inputs)
  await checkFiles(resolve(directory, 'compiled'), capture.compiled)
  assert.equal(
    capture.sourceIdentity,
    sha(
      JSON.stringify(
        Object.entries(capture.inputs).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
  )
  assert.ok(
    capture.loadedCSS.length > 0,
    'The actual product cascade was loaded',
  )
  for (const css of capture.loadedCSS) {
    assert.match(css.source, /^[a-f0-9]{64}$/u)
    assert.equal(css.source, capture.inputs[css.path])
  }
  if (name === 'baseline') {
    assert.equal(capture.mutation, null)
    assert.equal(capture.process.exitCode, 0)
    assert.equal(capture.scene.completed, true)
    assert.deepEqual(capture.scene.errors, [])
    assert.ok(
      capture.scene.geometry.length >= 5,
      'Real consumers supplied nonempty geometry',
    )
    for (const measurement of capture.scene.geometry) {
      assert.ok(measurement.bar.height > 0 && measurement.footers.length > 0)
      for (const footer of measurement.footers)
        assert.ok(footer.box.height <= measurement.bar.height + 0.1)
    }
    assert.equal(capture.frames.length, 8)
    assert.ok(
      capture.scene.inputs.some(
        (event) => event.type === 'click' && event.trusted,
      ),
    )
    assert.ok(
      capture.scene.inputs.some(
        (event) => event.type === 'keydown' && event.trusted,
      ),
    )
  } else {
    assert.equal(capture.mutation, name)
    assert.equal(capture.process.exitCode, 1)
    assert.equal(
      capture.scene.failure.name,
      'AssertionError',
      'Mutants must fail an assertion, not setup',
    )
    assert.equal(
      capture.scene.assertion,
      name === 'action' ? 'original-action' : 'footer-height',
    )
    assert.equal(capture.specificAssertionRED, true)
    assert.match(
      capture.scene.failure.message,
      name === 'action'
        ? /Original menu primary calls the original toolkit API once/u
        : /Footer actual total height cannot exceed same-window Status Bar/u,
      'The loaded mutant must fail its specific behavioral oracle',
    )
    if (name === 'action') {
      assert.notEqual(
        capture.actionMutation.source,
        capture.actionMutation.loaded,
      )
    } else
      assert.ok(
        capture.loadedCSS.some(
          (css) => css.changed > 0 && css.before !== css.loaded,
        ),
      )
  }
  captures[name] = capture
}

const componentInputs = await json(resolve(evidence, 'components-inputs.json'))
await checkFiles(root, componentInputs)
const componentOwners = [
  'toolkit/ToolkitActions',
  'toolkit/UserToolkitResult',
  'toolkit/TuiToolkitResult',
  'performance/PerformanceOverview',
  'performance/PerformancePopover',
].map((file) => 'apps/desktop/src/renderer/src/components/' + file + '.tsx')
for (const file of [
  '.local/toolkit-frame/components.json',
  '.local/toolkit-frame/components-loaded.json',
  'apps/desktop/test/toolkit-frame.config.mts',
  'apps/desktop/test/helpers/toolkit-menu.ts',
  ...componentOwners,
]) {
  assert.match(
    componentInputs[file] ?? '',
    /^[a-f0-9]{64}$/u,
    'Bound component run input: ' + file,
  )
}
const loaded = await json(resolve(evidence, 'components-loaded.json'))
assert.ok(loaded.length > 0, 'Actual component transform inputs are nonempty')
for (const owner of componentOwners) {
  const transforms = loaded.filter((input) => input.path === owner)
  assert.ok(
    transforms.length > 0,
    'Actual component owner was loaded: ' + owner,
  )
  for (const input of transforms) {
    assert.equal(input.diskSHA256, componentInputs[owner])
    assert.equal(input.loadedSHA256, input.diskSHA256)
  }
}
const components = await json(resolve(evidence, 'components.json'))
assert.equal(components.success, true)
assert.equal(components.numFailedTests, 0)
assert.ok(components.numPassedTests >= 15)
for (const file of [
  'toolkit-frame.test.tsx',
  'toolkit-tui-ui.test.tsx',
  'performance-themed-controls.test.tsx',
]) {
  const suite = components.testResults.find((suite) =>
    suite.name.endsWith('/' + file),
  )
  assert.ok(
    suite?.assertionResults.length > 0,
    'Actual component suite: ' + file,
  )
  assert.ok(suite.assertionResults.every((test) => test.status === 'passed'))
  assert.ok(
    Object.keys(componentInputs).some((input) => input.endsWith('/' + file)),
  )
}

const performance = await json(resolve(evidence, 'performance-current.json'))
assert.equal(performance.success, true)
assert.equal(performance.numPassedTests, 7)
assert.equal(performance.numFailedTests, 0)
const appSuite = performance.testResults.find((suite) =>
  suite.name.endsWith('/performance-panel-interaction.test.tsx'),
)
assert.equal(appSuite?.assertionResults.length, 7)
assert.ok(appSuite.assertionResults.every((test) => test.status === 'passed'))
const performanceRoot = resolve(evidence, 'performance-current')
const appInputs = (
  await readFile(resolve(performanceRoot, 'loaded-source.jsonl'), 'utf8')
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
assert.ok(
  appInputs.length > 0,
  'The real App performance consumers were loaded',
)
for (const input of appInputs) {
  assert.equal(input.mutant, 'baseline')
  assert.equal(
    sha(await readFile(resolve(root, input.path))),
    input.originalSHA256,
    'Exact App consumer input: ' + input.path,
  )
  if (input.consumedSHA256 !== input.inputSHA256) {
    assert.equal(
      sha(await readFile(resolve(performanceRoot, 'consumed', input.path))),
      input.consumedSHA256,
    )
  }
}
for (const suffix of [
  '/App.tsx',
  '/performance/PerformancePanel.tsx',
  '/performance/PerformanceOverview.tsx',
  '/lib/toolkit-agent-card-facts.ts',
]) {
  assert.ok(
    appInputs.some(
      (input) =>
        input.path.endsWith(suffix) &&
        input.consumedSHA256 !== input.inputSHA256,
    ),
    'Nonempty actual App measurement: ' + suffix,
  )
}

// Real Native consumers qualify layout and callbacks; these are the existing
// application edges that make those components part of the shipping product.
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const ts = require('typescript')
const renderer = 'apps/desktop/src/renderer/src/'
const edges = [
  ['App.tsx', 'ToolkitStatusBar', 'components/toolkit/ToolkitStatusBar.tsx'],
  [
    'components/toolkit/ToolkitStatusBar.tsx',
    'UserToolkitResult',
    'components/toolkit/UserToolkitResult.tsx',
  ],
  [
    'components/toolkit/ToolkitStatusBar.tsx',
    'PerformancePanel',
    'components/performance/PerformancePanel.tsx',
  ],
  [
    'components/performance/PerformancePanel.tsx',
    'PerformanceOverview',
    'components/performance/PerformanceOverview.tsx',
  ],
  [
    'components/toolkit/ToolkitStatusBar.tsx',
    'MobileConnectionToolkit',
    'components/toolkit/MobileConnectionToolkit.tsx',
  ],
  [
    'components/toolkit/MobileConnectionToolkit.tsx',
    'MobileConnectionResult',
    'components/toolkit/MobileConnectionResult.tsx',
  ],
  [
    'components/toolkit/UserToolkitResult.tsx',
    'TuiToolkitResult',
    'components/toolkit/TuiToolkitResult.tsx',
  ],
  ...[
    'toolkit/UserToolkitResult',
    'toolkit/TuiToolkitResult',
    'performance/PerformanceOverview',
  ].map((file) => [
    'components/' + file + '.tsx',
    'ToolkitActions',
    'components/toolkit/ToolkitActions.tsx',
  ]),
]
const consumerInputs = {}
for (const [caller, name, target] of edges) {
  const file = resolve(root, renderer + caller),
    bytes = await readFile(file)
  consumerInputs[renderer + caller] = sha(bytes)
  const source = ts.createSourceFile(
    file,
    bytes.toString(),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const declarations = source.statements.filter(ts.isImportDeclaration)
  assert.ok(
    declarations.some(
      (node) =>
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(
          (binding) => binding.name.text === name,
        ) &&
        resolve(dirname(file), node.moduleSpecifier.text + '.tsx') ===
          resolve(root, renderer + target),
    ),
    'Original imported product owner: ' + name,
  )
  let consumers = 0
  function visit(node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === name
    )
      consumers++
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(
    consumers > 0,
    'Nonempty original product JSX consumer: ' + caller + ' -> ' + name,
  )
}

const baseline = captures.baseline
for (const capture of Object.values(captures)) {
  assert.equal(capture.sourceIdentity, baseline.sourceIdentity)
}
for (const file of [
  'components/toolkit/ToolkitActions.tsx',
  'components/toolkit/UserToolkitResult.tsx',
  'components/toolkit/TuiToolkitResult.tsx',
  'components/toolkit/MobileConnectionResult.tsx',
  'components/performance/PerformanceOverview.tsx',
  'components/performance/PerformancePopover.tsx',
  'components/WindowUtilityBar.tsx',
  ...[
    'performance-toolkit',
    'toolkit-tui',
    'toolkit-custom',
    'mobile-connection',
    'tokens',
    'agent',
  ].map((name) => 'styles/' + name + '.css'),
]) {
  assert.match(
    baseline.inputs[renderer + file] ?? '',
    /^[a-f0-9]{64}$/u,
    'Actual owning input: ' + file,
  )
}
for (const kind of ['visual', 'code']) {
  const review = await json(resolve(evidence, kind + '-review-final.json'))
  assert.equal(review.sourceIdentity, baseline.sourceIdentity)
  assert.equal(review.verdict, 'pass')
  assert.deepEqual(review.mustFix, [])
  assert.equal(
    sha(await readFile(resolve(root, review.report.file))),
    review.report.sha256,
  )
  if (kind === 'visual') {
    assert.equal(review.images.length, baseline.frames.length)
    assert.equal(
      new Set(review.images.map((image) => image.file)).size,
      baseline.frames.length,
    )
    for (const frame of baseline.frames) {
      const viewed = review.images.find((image) => image.file === frame.path)
      assert.equal(
        viewed?.personallyViewedOriginal,
        true,
        'Independently viewed final image: ' + frame.path,
      )
      const png = await readFile(resolve(evidence, 'baseline', frame.path))
      assert.equal(sha(png), frame.sha256)
      assert.equal(viewed.sha256, frame.sha256)
      assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0)
    }
  }
}
const result = {
  completed: true,
  sourceIdentity: baseline.sourceIdentity,
  passedTests: components.numPassedTests,
  appConsumerTests: performance.numPassedTests,
  mutants: ['height', 'wrap', 'action'],
  frames: baseline.frames.length,
  productEdges: edges,
  consumerInputs,
  boundary: baseline.boundary,
}
await writeFile(
  resolve(evidence, 'verification.json'),
  JSON.stringify(result, null, 2) + '\n',
)
console.log(
  JSON.stringify({
    completed: true,
    passedTests: result.passedTests,
    mutants: result.mutants,
    frames: result.frames,
  }),
)
