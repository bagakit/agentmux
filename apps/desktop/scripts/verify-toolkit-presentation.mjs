import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { verifyCustomizationCapture } from './fixtures/toolkit-tui/verify-customization-capture.mjs'
const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(root, '.local/toolkit-customization/presentation')
const sha = value => createHash('sha256').update(value).digest('hex')
await mkdir(evidence, { recursive: true })
const config = 'apps/desktop/test/toolkit-presentation.config.mts'
const cases = [
  ['baseline', []],
  ['double-preference-commit', ['apps/desktop/test/toolkit-presentation-persistence.test.ts']],
  ['forget-presentation', ['apps/desktop/test/toolkit-presentation-persistence.test.ts']],
  ['ignore-tool-palette', ['apps/desktop/test/toolkit-presentation-ui.test.tsx']],
  ['forget-size', ['apps/desktop/test/toolkit-tui-popover.test.tsx']],
  ['forget-default-shell-ui', ['apps/desktop/test/toolkit-presentation-ui.test.tsx']]
]
if (process.argv.includes('--fast')) {
  const results = []
  for (const [name, files] of cases) {
    const output = resolve(evidence, name + '.json'), loaded = resolve(evidence, name + '-loaded.jsonl')
    await writeFile(loaded, '')
    const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, ...files, '--reporter=default', '--reporter=json', '--outputFile=' + output],
      { cwd: root, env: { ...process.env, AGENTMUX_TOOLKIT_PRESENTATION_MUTATION: name === 'baseline' ? '' : name, AGENTMUX_TOOLKIT_PRESENTATION_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
    await writeFile(resolve(evidence, name + '.log'), log)
    const result = JSON.parse(await readFile(output)), inputs = (await readFile(loaded, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(result.numTotalTests > 0 && inputs.length > 0, 'Nonempty real consumers and loaded inputs')
    if (name === 'baseline') { assert.equal(code, 0, 'Baseline tests: inspect the original log'); assert.equal(result.success, true) }
    else {
      assert.notEqual(code, 0, name + ': mutant survived')
      assert.ok(result.testResults.flatMap(suite => suite.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(text => /AssertionError|expected/u.test(text))), 'Product assertions kill the actual mutant')
      assert.ok(inputs.some(input => input.mutation === name && input.original !== input.consumed), 'Actual owner mutation was loaded')
    }
    results.push({ name, code, total: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests,
      result: { file: relative(root, output), sha256: sha(await readFile(output)) }, loaded: { file: relative(root, loaded), sha256: sha(await readFile(loaded)) } })
    process.stdout.write(name + ': ' + (name === 'baseline' ? 'passed' : 'mutant killed') + '\n')
  }
  await writeFile(resolve(evidence, 'fast.json'), JSON.stringify({ results }, null, 2) + '\n')
} else {
  const fast = JSON.parse(await readFile(resolve(evidence, 'fast.json')))
  assert.equal(fast.results.length, cases.length)
  for (const result of fast.results) {
    const loaded = await readFile(resolve(root, result.loaded.file))
    assert.equal(sha(loaded), result.loaded.sha256); assert.equal(sha(await readFile(resolve(root, result.result.file))), result.result.sha256)
    const inputs = loaded.toString().trim().split('\n').map(JSON.parse)
    const raw = JSON.parse(await readFile(resolve(root, result.result.file)))
    assert.ok(raw.numTotalTests > 0)
    if (result.name === 'baseline') { assert.equal(result.code, 0); assert.equal(raw.success, true) }
    else {
      const oracle = {
        'double-preference-commit': 'requests only one platform commit',
        'forget-presentation': 'writes each tool preference',
        'ignore-tool-palette': 'applies a tool palette',
        'forget-size': 'remembers only a completed gesture',
        'forget-default-shell-ui': 'saves a blank TUI command'
      }[result.name]
      assert.ok(oracle); assert.notEqual(result.code, 0)
      assert.ok(raw.testResults.flatMap(suite => suite.assertionResults).some(test => test.fullName.includes(oracle) && test.status === 'failed' && test.failureMessages.some(message => /AssertionError|expected/u.test(message))))
      assert.ok(inputs.some(input => input.mutation === result.name && input.original !== input.consumed))
    }
    for (const input of inputs) assert.equal(sha(await readFile(resolve(root, input.path))), input.disk, 'Candidate changed since the consumer test: ' + input.path)
  }
  await verifyCustomizationCapture(root, '.local/toolkit-customization/presentation-review.json', [
    'palette-settings-dark.png', 'terminal-nord.png', 'terminal-resized-reopened.png', 'terminal-narrow.png',
    'terminal-global-light.png', 'terminal-workspace-light.png', 'terminal-restored.png', 'palette-save-service-window.png'
  ])
  process.stdout.write('Toolkit presentation qualification passed.\n')
}
