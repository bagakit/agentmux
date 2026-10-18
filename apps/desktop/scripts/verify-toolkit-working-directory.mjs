import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['--runtime', '--desktop'].includes(mode), 'Choose the working directory verification boundary')
const evidence = resolve(root, '.local/toolkit-working-directory', mode.slice(2))
await mkdir(evidence, { recursive: true })
const sources = ['packages/core/src/toolkit-working-directory.ts', 'packages/core/src/toolkit.ts',
  'packages/core/src/toolkit-cli.ts', 'packages/core/src/agentmux-cli-commands.ts',
  'apps/desktop/src/main/toolkit-config.ts', 'apps/desktop/src/main/config-store.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/ipc-sender-trust.ts',
  'apps/desktop/src/main/toolkit-ipc.ts', 'apps/desktop/src/shared/toolkit-configuration-result.ts',
  'apps/desktop/src/renderer/src/lib/toolkit-configuration-api.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/scripts/verify-toolkit-working-directory.mjs']
if (mode === '--desktop') sources.push('apps/desktop/src/renderer/src/components/settings/ToolkitWorkingDirectoryField.tsx',
  'apps/desktop/src/renderer/src/components/settings/ToolkitSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/ToolkitToolEditor.tsx',
  'apps/desktop/src/renderer/src/components/settings/ToolkitPackageEditor.tsx',
  'apps/desktop/src/renderer/src/components/settings/use-toolkit-drafts.ts',
  'apps/desktop/src/renderer/src/components/settings/toolkit-working-directory.css',
  'apps/desktop/test/toolkit-working-directory-ui.config.mts', 'apps/desktop/test/toolkit-working-directory-ui.test.tsx')
else sources.push('packages/core/test/toolkit-working-directory.test.ts', 'apps/desktop/test/toolkit-working-directory.test.ts',
  'apps/desktop/test/toolkit-working-directory-main.test.ts', 'apps/desktop/test/toolkit-working-directory.config.mts',
  'apps/desktop/test/toolkit-main.fixture.ts')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(resolve(root, file)))])))
const results = []
async function suite(name, config, files = [], environment = {}, mutation = false) {
  const resultPath = resolve(evidence, name + '.json'), receipt = resolve(evidence, name + '.jsonl')
  if (mutation) await writeFile(receipt, '')
  let log = ''
  const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    ...files, '--reporter=json', '--outputFile=' + resultPath], { cwd: root, env: { ...process.env,
      AGENTMUX_TOOLKIT_CLI: resolve(root, 'packages/core/dist/agentmux.js'), AGENTMUX_TOOLKIT_EVIDENCE: evidence,
      AGENTMUX_WORKING_DIRECTORY_RECEIPT: receipt, AGENTMUX_TOOLKIT_DIRECTORY_UI_RECEIPT: receipt, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  await writeFile(resolve(evidence, name + '.log'), log)
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.ok(result.numTotalTests > 0 && result.testResults.length > 0, name + ': nonempty consumer tests required')
  if (mutation) {
    assert.notEqual(code, 0, name + ': mutant survived')
    const failed = result.testResults.flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'failed')
    assert.ok(failed.some(test => test.failureMessages.some(message => /AssertionError|expected/iu.test(message))), name + ': a product assertion must fail')
    const changes = (await readFile(receipt, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(changes.some(change => change.sourceSHA256 !== (change.consumedSHA256 ?? change.loadedSHA256)), name + ': changed Source must actually load')
  } else { assert.equal(code, 0, name + ': see its evidence log'); assert.equal(result.success, true) }
  results.push({ name, passed: result.numPassedTests, failed: result.numFailedTests, mutation })
  process.stdout.write(name + ': ' + (mutation ? 'mutant killed' : 'passed') + '\n')
}
if (mode === '--runtime') {
  await suite('baseline', 'apps/desktop/test/toolkit-working-directory.config.mts')
  for (const mutation of ['home-expansion', 'host-wiring', 'error-detail']) await suite(mutation,
    'apps/desktop/test/toolkit-working-directory.config.mts', ['packages/core/test/toolkit-working-directory.test.ts',
      'apps/desktop/test/toolkit-working-directory.test.ts'], { AGENTMUX_WORKING_DIRECTORY_MUTATION: mutation }, true)
} else {
  const runtime = JSON.parse(await readFile(resolve(root, '.local/toolkit-working-directory/runtime/receipt.json'), 'utf8'))
  assert.equal(runtime.status, 'passed')
  for (const [file, digest] of Object.entries(runtime.inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Runtime input changed: ' + file)
  await suite('baseline', 'apps/desktop/test/toolkit-working-directory-ui.config.mts')
  for (const mutation of ['late-picker', 'unknown-home-blocks', 'empty-default', 'host-field-lost']) await suite(mutation,
    'apps/desktop/test/toolkit-working-directory-ui.config.mts', ['apps/desktop/test/toolkit-working-directory-ui.test.tsx'],
    { AGENTMUX_TOOLKIT_DIRECTORY_UI_MUTATION: mutation }, true)
  const review = JSON.parse(await readFile(resolve(root, '.local/toolkit-working-directory/visual-review.json'), 'utf8'))
  assert.equal(review.status, 'approved'); assert.ok(review.reviewer && review.images.length >= 3)
  for (const [file, digest] of Object.entries(review.sourceHashes)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Reviewed source changed: ' + file)
  for (const frame of review.images) assert.equal(hash(await readFile(resolve(root, frame.path))), frame.sha256, 'Reviewed image changed')
}
for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Proof source changed: ' + file)
await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ status: 'passed', mode, inputs, results }, null, 2) + '\n')
