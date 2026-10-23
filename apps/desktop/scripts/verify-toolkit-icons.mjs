import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyCustomizationCapture } from './fixtures/toolkit-tui/verify-customization-capture.mjs'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(mode === undefined || ['--fast', '--public'].includes(mode), 'Use --fast or --public to collect bounded evidence, or no argument to verify the joined candidate.')
const evidence = resolve(root, '.local/toolkit-icons', mode?.slice(2) ?? 'qualification')
if (mode) await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = [
  'apps/desktop/src/shared/toolkit-preferences.ts',
  'apps/desktop/src/renderer/src/components/toolkit/ToolkitIcon.tsx',
  'apps/desktop/src/renderer/src/components/toolkit/ToolkitIconPicker.tsx',
  'apps/desktop/src/renderer/src/components/toolkit/toolkit-icon-picker.css',
  'apps/desktop/src/renderer/src/components/settings/ToolkitToolEditor.tsx',
  'apps/desktop/src/renderer/src/styles/settings-toolkit.css',
  'packages/client-ui/src/theme/icon-catalog.ts', 'packages/client-ui/src/theme/icon-glyphs.ts',
  'apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/toolkit-package.ts',
  'apps/desktop/scripts/verify-toolkit-icons.mjs',
  ...(mode === '--fast' ? ['apps/desktop/test/toolkit-icons.config.mts', 'apps/desktop/test/toolkit-icons.test.tsx',
    'apps/desktop/test/toolkit-icons-config.test.ts', 'apps/desktop/test/toolkit-custom-identity.test.tsx',
    'apps/desktop/test/toolkit-editor-icon-meaning.test.tsx'] : ['apps/desktop/test/toolkit-icons-main.config.mts',
    'apps/desktop/test/toolkit-icons-main.test.ts', 'apps/desktop/test/toolkit-main.fixture.ts', 'packages/core/dist/agentmux.js'])
]
const inputs = mode ? Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(resolve(root, file)))]))) : {}
const results = []
const mutationAssertions = {
  admission: 'accepts all choices in inline persistence and package capture without changing their stored values',
  semantic: 'uses the same retained semantic sprite for picker and tool output under glyph and path overrides',
  search: 'filters by meaning and stable identifiers without replacing the selected draft, and returns focus on Escape'
}
function verifyMutation(result, loaded, mutation, code) {
  assert.ok(Number.isInteger(code) && code !== 0, mutation + ': mutant must exit unsuccessfully')
  assert.equal(result.success, false)
  const expected = mutationAssertions[mutation]
  assert.ok(expected, 'Known mutation assertion')
  const failed = result.testResults.flatMap(file => file.assertionResults ?? [])
    .find(test => test.fullName === expected && test.status === 'failed')
  assert.ok(failed?.failureMessages.some(message => /AssertionError|expected/iu.test(message)), mutation + ': expected behavioral assertion must fail')
  assert.ok(loaded.some(item => item.mutation === mutation && item.sourceSHA256 !== item.consumedSHA256), mutation + ': actual mutation must load')
}
async function suite(name, files = [], mutation) {
  const directory = resolve(evidence, name)
  await mkdir(directory, { recursive: true })
  const receipt = resolve(directory, 'loaded.jsonl')
  await writeFile(receipt, '')
  const resultPath = resolve(directory, 'tests.json')
  const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    mode === '--fast' ? 'apps/desktop/test/toolkit-icons.config.mts' : 'apps/desktop/test/toolkit-icons-main.config.mts',
    ...files, '--maxWorkers=1', '--reporter=json', '--outputFile=' + resultPath], {
    cwd: root, env: { ...process.env, AGENTMUX_TOOLKIT_ICONS_MUTATION: mutation ?? '',
      AGENTMUX_TOOLKIT_ICONS_RECEIPT: receipt, AGENTMUX_TOOLKIT_EVIDENCE: directory,
      AGENTMUX_TOOLKIT_CLI: resolve(root, 'packages/core/dist/agentmux.js') }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  await writeFile(resolve(directory, 'output.log'), log)
  const artifacts = Object.fromEntries(await Promise.all([
    ['tests', 'tests.json'], ['loaded', 'loaded.jsonl'], ['log', 'output.log']
  ].map(async ([key, file]) => [key, { file, sha256: hash(await readFile(resolve(directory, file))) }])))
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.ok(result.numTotalTests > 0 && result.testResults.length > 0, name + ': nonempty tests required')
  const loaded = (await readFile(receipt, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(loaded.length > 0, name + ': actual loaded source proof required')
  if (mutation) {
    verifyMutation(result, loaded, mutation, code)
  } else {
    assert.equal(code, 0, name + ': see evidence output.log')
    assert.equal(result.success, true)
  }
  for (const item of loaded) {
    const file = item.file ?? item.path, sourceSHA256 = item.fileSHA256
    assert.equal(hash(await readFile(resolve(root, file))), sourceSHA256, 'Loaded source changed: ' + file)
    if (inputs[file]) assert.equal(inputs[file], sourceSHA256, 'Input changed during verification: ' + file)
    inputs[file] = sourceSHA256
  }
  results.push({ name, code, total: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests,
    mutation: mutation ?? null, ...artifacts })
  process.stdout.write(`${name}: ${mutation ? 'mutant killed' : 'passed'}\n`)
}

if (mode) {
  await suite('baseline')
  if (mode === '--fast') {
    for (const mutation of ['admission', 'semantic', 'search']) await suite(mutation,
      [mutation === 'admission' ? 'apps/desktop/test/toolkit-icons-config.test.ts' : 'apps/desktop/test/toolkit-icons.test.tsx'], mutation)
  }
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Proof source changed: ' + file)
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ status: 'passed', mode,
    scope: mode === '--fast' ? 'Actual Renderer consumers, shared sprite, Main config and package paths; no Native visual qualification.'
      : 'Registered Main, real public CLI and private Runtime; no Native window or visual qualification.',
    inputs, results }, null, 2) + '\n')
} else {
  await verifyCustomizationCapture(root, '.local/toolkit-customization/icons-review.json', [
    'icon-sizes-dark.png', 'icons-dark.png', 'icons-search.png',
    'icons-light.png', 'icons-light-narrow.png', 'icon-sizes-light.png'
  ])
  for (const proofMode of ['fast', 'public']) {
    const directory = resolve(root, '.local/toolkit-icons', proofMode)
    const proof = JSON.parse(await readFile(resolve(directory, 'receipt.json')))
    assert.equal(proof.status, 'passed'); assert.equal(proof.mode, '--' + proofMode)
    const names = proofMode === 'fast' ? ['baseline', 'admission', 'semantic', 'search'] : ['baseline']
    assert.deepEqual(proof.results.map(result => result.name), names)
    assert.ok(Object.keys(proof.inputs).length > 0, 'Original nonempty icon proof inputs')
    for (const [file, digest] of Object.entries(proof.inputs)) {
      assert.equal(hash(await readFile(resolve(root, file))), digest, 'Icon proof candidate changed: ' + file)
    }
    for (const result of proof.results) {
      const artifacts = Object.fromEntries(await Promise.all([
        ['tests', 'tests.json'], ['loaded', 'loaded.jsonl'], ['log', 'output.log']
      ].map(async ([key, file]) => {
        assert.equal(result[key]?.file, file, 'Original artifact name: ' + key)
        const bytes = await readFile(resolve(directory, result.name, file))
        assert.equal(hash(bytes), result[key].sha256, 'Original artifact changed: ' + result.name + '/' + file)
        return [key, bytes]
      })))
      const raw = JSON.parse(artifacts.tests)
      const loaded = artifacts.loaded.toString().trim().split('\n').filter(Boolean).map(JSON.parse)
      assert.ok(raw.numTotalTests > 0 && loaded.length > 0, 'Original nonempty tests and loaded consumers')
      assert.equal(raw.numTotalTests, result.total); assert.equal(raw.numPassedTests, result.passed); assert.equal(raw.numFailedTests, result.failed)
      for (const input of loaded) assert.equal(input.fileSHA256, proof.inputs[input.file], 'Loaded proof identity: ' + input.file)
      if (result.name === 'baseline') {
        assert.equal(result.code, 0); assert.equal(result.mutation, null)
        assert.equal(raw.success, true); assert.equal(result.failed, 0)
      } else {
        assert.equal(result.mutation, result.name)
        verifyMutation(raw, loaded, result.name, result.code)
      }
    }
  }
  process.stdout.write('Toolkit icon qualification passed.\n')
}
