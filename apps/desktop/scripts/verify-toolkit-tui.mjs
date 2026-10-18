import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['--runtime', '--desktop', '--recovery'].includes(mode), 'Choose a TUI verification boundary')
const evidence = resolve(root, '.local/toolkit-tui', mode.slice(2))
await mkdir(evidence, { recursive: true })
const sources = ['apps/desktop/scripts/verify-toolkit-tui.mjs', 'packages/core/src/toolkit.ts', 'apps/desktop/src/main/toolkit-config.ts',
  'apps/desktop/src/main/toolkit-custom-owner.ts', 'apps/desktop/src/main/toolkit-owner.ts',
  'apps/desktop/src/main/toolkit-run-port.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'apps/desktop/src/main/ipc.ts']
if (mode === '--desktop') sources.push('apps/desktop/src/renderer/src/components/TerminalView.tsx',
  'apps/desktop/src/renderer/src/lib/run-service-projection.ts',
  'apps/desktop/src/renderer/src/components/toolkit/TuiToolkitResult.tsx',
  'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx',
  'apps/desktop/src/renderer/src/components/settings/ToolkitToolEditor.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformancePopover.tsx',
  'apps/desktop/src/renderer/src/styles/toolkit-tui.css', 'apps/desktop/test/toolkit-tui-ui.test.tsx', 'apps/desktop/test/toolkit-tui-ui.config.mts')
else if (mode === '--runtime') sources.push('apps/desktop/test/toolkit-tui-runtime.test.ts', 'apps/desktop/test/toolkit-tui-owner.test.ts',
  'apps/desktop/test/toolkit-tui.config.mts', 'apps/desktop/test/toolkit-tui-config.test.ts', 'packages/core/test/toolkit-custom.test.ts',
  'packages/core/test/toolkit-custom.config.mts')
else sources.push('apps/desktop/test/toolkit-tui-process.test.ts', 'apps/desktop/test/helpers/toolkit-tui-process.ts', 'apps/desktop/test/toolkit-tui-process.config.mts')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(resolve(root, path)))])))
const results = []
async function suite(name, config, files = [], environment = {}, mutation = false) {
  const resultPath = resolve(evidence, name + '.json'), logPath = resolve(evidence, name + '.log')
  let log = ''
  const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    ...files, '--reporter=json', '--outputFile=' + resultPath], { cwd: root, env: { ...process.env,
      AGENTMUX_TOOLKIT_CLI: resolve(root, 'packages/core/dist/agentmux.js'), AGENTMUX_TOOLKIT_EVIDENCE: evidence, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  await writeFile(logPath, log)
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.ok(result.numTotalTests > 0 && result.testResults.length > 0, name + ': nonempty consumer tests required')
  if (mutation) {
    assert.notEqual(code, 0, name + ': mutant survived')
    const failed = result.testResults.flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'failed')
    assert.ok(failed.length > 0 && failed.some(test => test.failureMessages.some(message => /AssertionError|expected|Run kind|raw Attachment|changed since you started editing/iu.test(message))), name + ': product assertion must kill the mutant')
    const receiptPath = environment.AGENTMUX_TUI_MUTATION_RECEIPT ?? environment.AGENTMUX_TUI_UI_RECEIPT
    if (receiptPath) {
      const receipts = (await readFile(receiptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.ok(receipts.some(value => value.original && value.original !== value.consumed || value.mutation && value.sourceSHA256 !== value.loadedSHA256), name + ': changed product source must actually load')
    }
  } else { assert.equal(code, 0, name + ': see ' + relative(root, logPath)); assert.equal(result.success, true) }
  results.push({ name, passed: result.numPassedTests, failed: result.numFailedTests, mutation, result: relative(root, resultPath) })
  process.stdout.write(name + ': ' + (mutation ? 'mutant killed' : 'passed') + '\n')
}
if (mode === '--runtime') {
  await suite('contract', 'packages/core/test/toolkit-custom.config.mts')
  await suite('runtime', 'apps/desktop/test/toolkit-tui.config.mts')
  await suite('raw-ownership', 'apps/desktop/test/toolkit-tui.config.mts', ['apps/desktop/test/toolkit-tui-runtime.test.ts'], {
    AGENTMUX_TUI_MUTATION: 'raw-ownership', AGENTMUX_TUI_MUTATION_RECEIPT: resolve(evidence, 'raw-ownership.jsonl') }, true)
  await suite('repeat-load', 'apps/desktop/test/toolkit-tui.config.mts', ['apps/desktop/test/toolkit-tui-owner.test.ts'], {
    AGENTMUX_TUI_MUTATION: 'repeat-load', AGENTMUX_TUI_MUTATION_RECEIPT: resolve(evidence, 'repeat-load.jsonl') }, true)
  await suite('runner-environment', 'apps/desktop/test/toolkit-tui.config.mts', ['apps/desktop/test/toolkit-tui-owner.test.ts'], {
    AGENTMUX_TUI_MUTATION: 'runner-environment', AGENTMUX_TUI_MUTATION_RECEIPT: resolve(evidence, 'runner-environment.jsonl') }, true)
  await suite('mode-loss', 'packages/core/test/toolkit-custom.config.mts', ['apps/desktop/test/toolkit-tui-config.test.ts'], {
    AGENTMUX_TOOLKIT_CORE_MUTANT: 'tui-default-mode' }, true)
} else if (mode === '--desktop') {
  await suite('ui', 'apps/desktop/test/toolkit-tui-ui.config.mts')
  await suite('service', 'apps/desktop/test/toolkit-tui.config.mts', ['apps/desktop/test/run-service-projection.test.ts'])
  for (const mutation of ['current-mode', 'consume-escape', 'stop-on-close', 'metadata-order']) await suite(mutation,
    'apps/desktop/test/toolkit-tui-ui.config.mts', ['apps/desktop/test/toolkit-tui-ui.test.tsx'], {
      AGENTMUX_TUI_UI_MUTATION: mutation, AGENTMUX_TUI_UI_RECEIPT: resolve(evidence, mutation + '.jsonl') }, true)
  await suite('service-membership', 'apps/desktop/test/toolkit-tui.config.mts', ['apps/desktop/test/run-service-projection.test.ts'], {
    AGENTMUX_TUI_MUTATION: 'service-membership', AGENTMUX_TUI_MUTATION_RECEIPT: resolve(evidence, 'service-membership.jsonl') }, true)
  const review = JSON.parse(await readFile(resolve(root, '.local/toolkit-tui/visual-review.json'), 'utf8'))
  assert.equal(review.status, 'approved'); assert.ok(review.reviewer && review.images.length >= 3)
  for (const [path, digest] of Object.entries(review.sourceHashes)) assert.equal(hash(await readFile(resolve(root, path))), digest, 'Visual source changed: ' + path)
  for (const image of review.images) assert.equal(hash(await readFile(resolve(root, image.path))), image.sha256, 'Reviewed image changed')
} else {
  await suite('process-recovery', 'apps/desktop/test/toolkit-tui-process.config.mts')
  await suite('process-stop-on-dispose', 'apps/desktop/test/toolkit-tui-process.config.mts', [], {
    AGENTMUX_TOOLKIT_RECOVERY_MUTANT: 'stop-on-dispose' }, true)
  await suite('owner-recovery', 'apps/desktop/test/toolkit-tui.config.mts', ['apps/desktop/test/toolkit-tui-owner.test.ts', 'apps/desktop/test/toolkit-tui-runtime.test.ts'])
  await suite('missing-intent', 'apps/desktop/test/toolkit-tui.config.mts', ['apps/desktop/test/toolkit-tui-owner.test.ts'], {
    AGENTMUX_TUI_MUTATION: 'missing-intent', AGENTMUX_TUI_MUTATION_RECEIPT: resolve(evidence, 'missing-intent.jsonl') }, true)
  await suite('dispose-stop', 'apps/desktop/test/toolkit-tui.config.mts', ['apps/desktop/test/toolkit-tui-owner.test.ts'], {
    AGENTMUX_TUI_MUTATION: 'dispose-stop', AGENTMUX_TUI_MUTATION_RECEIPT: resolve(evidence, 'dispose-stop.jsonl') }, true)
}
for (const [path, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, path))), digest, 'Proof source changed: ' + path)
await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ status: 'passed', mode, inputs, results }, null, 2) + '\n')
