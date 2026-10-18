import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['--fast', '--public'].includes(mode), 'Choose --fast or --public for the bounded icon proof. Native visual qualification is collected separately.')
const evidence = resolve(root, '.local/toolkit-icons', mode.slice(2))
await mkdir(evidence, { recursive: true })
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
const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(resolve(root, file)))])))
const results = []
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
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.ok(result.numTotalTests > 0 && result.testResults.length > 0, name + ': nonempty tests required')
  const loaded = (await readFile(receipt, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(loaded.length > 0, name + ': actual loaded source proof required')
  if (mutation) {
    assert.notEqual(code, 0, name + ': mutant survived')
    const failed = result.testResults.flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'failed')
    assert.ok(failed.some(test => test.failureMessages.some(message => /AssertionError|expected/iu.test(message))), name + ': behavioral assertion must fail')
    assert.ok(loaded.some(item => item.mutation === mutation && item.sourceSHA256 !== item.consumedSHA256), name + ': actual mutation must load')
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
  results.push({ name, passed: result.numPassedTests, failed: result.numFailedTests, mutation: mutation ?? null })
  process.stdout.write(`${name}: ${mutation ? 'mutant killed' : 'passed'}\n`)
}

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
