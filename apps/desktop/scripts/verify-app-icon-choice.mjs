import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { APP_ICON_IDS } from '../../../packages/client-ui/src/lib/app-icon-catalog.ts'

const root = resolve(import.meta.dirname, '../../..')
const installedRoot = dirname(resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()))
const evidence = join(root, '.tmp/app-icon-choice', randomUUID())
await mkdir(evidence, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = {}
for (const file of ['packages/client-ui/src/lib/app-icon-catalog.ts', 'packages/client-ui/src/lib/app-icon-url.ts',
  'packages/client-ui/src/components/BrandIcon.tsx', 'apps/desktop/src/renderer/src/components/BrandIcon.tsx',
  'apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPane.tsx', 'apps/desktop/src/main/app-brand-icon.ts',
  'apps/desktop/src/main/index.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/config-store.ts',
  'apps/desktop/src/main/settings/modules/appearance.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx']) {
  inputs[file] = sha(await readFile(join(root, file)))
}
for (const id of APP_ICON_IDS) {
  const source = await readFile(join(root, 'packages/client-ui/brand/app-icons', id + '.png'))
  const shared = await readFile(join(root, 'packages/client-ui/src/assets/app-icons', id + '.png'))
  assert.ok(source.length > 0 && shared.length > 0)
  assert.equal(sha(shared), sha(await readFile(join(root, 'apps/desktop/resources/app-icons', id + '.png'))), 'Native and browser bitmap share the original build projection')
  if (id === 'classic') assert.equal(sha(source), '98761cbedb68ca1462f2931e84069bb7c875ddd8ff0f224b2131305a23c3e8cc', 'Preserve the original icon bytes')
  inputs['brand:' + id] = sha(source)
}
const runs = []
async function run(name, mutant) {
  const report = join(evidence, name + '.json'), mutationLog = join(evidence, name + '-source.txt')
  const selected = mutant === 'brand' || mutant === 'save' ? ['apps/desktop/test/app-icon-choice.test.tsx']
    : mutant === 'schema' ? ['apps/desktop/test/app-icon-settings-control.test.ts']
      : mutant ? ['apps/desktop/test/app-brand-icon.test.ts'] : []
  const args = [join(installedRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.app-icon.config.mts',
    ...selected, '--reporter=json', '--outputFile', report]
  let output = ''
  const code = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
      AGENTMUX_TEST_OBJECT_CLI: join(installedRoot, 'packages/core/bin/amux'),
      ...(mutant ? { AGENTMUX_APP_ICON_MUTANT: mutant, AGENTMUX_APP_ICON_MUTATION_LOG: mutationLog } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', reject); child.once('close', accept)
  })
  await writeFile(join(evidence, name + '.log'), output)
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.ok(result.numTotalTests > 0, 'The actual consumer test set is nonempty')
  assert.ok(result.testResults.every(suite => suite.assertionResults.length > 0), 'Every selected suite collected real assertions; collection failures never count as evidence')
  if (mutant) {
    assert.notEqual(code, 0, 'The broken production owner must fail')
    assert.ok(result.numFailedTests > 0, 'Mutation is killed by a real consumer assertion')
    assert.ok((await readFile(mutationLog, 'utf8')).trim(), 'The changed owner was actually loaded')
  } else { assert.equal(code, 0, output); assert.equal(result.numFailedTests, 0) }
  runs.push({ name, code, tests: result.numTotalTests, failed: result.numFailedTests })
  console.log(name + ': ' + (mutant ? 'assertion RED' : 'PASS'))
}
await run('baseline')
for (const mutant of ['brand', 'save', 'schema', 'native', 'native-issue']) await run(mutant, mutant)
await run('restored')
for (const [file, hash] of Object.entries(inputs)) {
  if (file.startsWith('brand:')) continue
  assert.equal(sha(await readFile(join(root, file))), hash, 'Production input remained unchanged during verification')
}
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ passed: true, evidence, inputs, runs,
  boundary: 'Production Settings/BrandIcon/ConfigOwner/native projection/public service and compiled CLI; native ports isolated in unit tests. Product capture, real process restart and independent visual review have separate receipts.' }, null, 2))
console.log(JSON.stringify({ passed: true, evidence }))
