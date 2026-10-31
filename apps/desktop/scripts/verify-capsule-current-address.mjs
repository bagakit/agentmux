import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const owner = 'apps/desktop/src/main/browser-view-manager.ts'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const suites = [
  { name: 'owner', file: 'apps/desktop/test/capsule-browser.test.ts', pattern: 'keeps exact current Capsule URI navigation' },
  { name: 'reader', file: 'apps/desktop/test/capsule-address-consumer.test.tsx' },
  { name: 'ipc', file: 'apps/desktop/test/bookmark-owner-ipc.test.ts', pattern: 'forwards the exact current Capsule address' }
]
const mutations = [
  { id: 'foreign-capsule-accepted', file: owner, suite: suites[0],
    from: 'target.capsuleId !== storage.capsule.record.capsuleId', to: 'false' },
  { id: 'external-document-accepted', file: owner, suite: suites[0],
    from: 'if (new URL(entry.view.webContents.getURL()).origin !== storage.capsuleOrigin)', to: 'if (false)' },
  { id: 'exact-browser-context-lost', file: pane, suite: suites[1],
    from: 'if (target === tab.objectLink) {', to: 'if (false) {',
    pattern: 'shows the original object address without requiring a handshake' }
]
const files = [owner, pane, 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/main/capsule-presentation.ts', 'apps/desktop/src/main/browser-cold-descriptor.ts',
  'apps/desktop/src/shared/browser-object-link.ts', 'packages/core/guides/modules/browser.md',
  'packages/core/src/agentmux-cli-module-skills.ts', 'packages/core/src/generated/agentmux-guides.ts',
  'apps/desktop/scripts/verify-capsule-current-address.mjs', ...suites.map(suite => suite.file)]
await mkdir(join(root, '.tmp/capsule-current-address-proof'), { recursive: true })
const output = await mkdtemp(join(root, '.tmp/capsule-current-address-proof/run-'))
const receipt = { schema: 'agentmux.capsule-current-address-proof.v1', passed: false, output,
  boundary: 'Original Node Capsule HTTP, BrowserViewManager and global Capsule presentation owner through controlled native ports; production BrowserPane and exact preload-to-registered-Main-IPC dispatch. Native pixels and real process restart belong to the integration proof.',
  inputs: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))]))),
  baseline: [], mutations: [], consumers: [] }
const publish = () => writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await publish()

async function run(suite, mutant) {
  const name = mutant?.id ?? suite.name
  const config = join(output, name + '.config.mts'), report = join(output, name + '.tests.json'), capture = join(output, name + '.capture.json')
  if (mutant) assert.equal((await readFile(join(root, mutant.file), 'utf8')).split(mutant.from).length - 1, 1, 'One actual source anchor: ' + name)
  await writeFile(config, `import base from ${JSON.stringify(join(root, 'apps/desktop/test/capsule-settings.config.mts'))}
import {readFileSync,writeFileSync} from 'node:fs';import {relative} from 'node:path';import {createHash} from 'node:crypto'
const files=${JSON.stringify(files)},mutant=${JSON.stringify(mutant ?? null)},capture={consumed:0,loaded:{}}
const hash=value=>createHash('sha256').update(value).digest('hex')
export default {...base,cacheDir:${JSON.stringify(join(output, 'cache-' + name))},plugins:[...(base.plugins??[]),
{name:'capsule-current-original-source',enforce:'pre',transform(input,id){const file=relative(${JSON.stringify(root)},id.split('?')[0]);if(!files.includes(file))return
let code=input;if(mutant?.file===file){if(code.split(mutant.from).length!==2)throw Error('Actual mutant source changed');code=code.replace(mutant.from,mutant.to);capture.consumed++}
capture.loaded[file]={source:hash(readFileSync(id.split('?')[0])),loaded:hash(code)};writeFileSync(${JSON.stringify(capture)},JSON.stringify(capture));return{code,map:null}}}],
test:{...base.test,include:[${JSON.stringify(suite.file)}],maxWorkers:1,passWithNoTests:false}}
`)
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile.json=' + report]
  const pattern = mutant?.pattern ?? suite.pattern
  if (pattern) args.push('-t', pattern)
  const result = await new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', part => { log += part }); child.stderr.on('data', part => { log += part })
    child.once('error', fail); child.once('close', code => done({ code, log }))
  })
  await writeFile(join(output, name + '.log'), result.log)
  let data
  try { data = JSON.parse(await readFile(report, 'utf8')) }
  catch { throw new Error(name + ': setup/collection is not a semantic proof. ' + result.log.slice(-5000)) }
  const assertions = data.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(data.testResults.length, 1); assert.ok(assertions.length > 0)
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, result.log.slice(-5000))
  const captured = JSON.parse(await readFile(capture, 'utf8'))
  if (mutant) {
    assert.equal(captured.consumed, 1, 'The exact production mutant must be loaded once')
    assert.equal(result.code, 1, result.log.slice(-5000))
    assert.ok(assertions.some(assertion => assertion.status === 'failed' && assertion.fullName.includes(pattern) &&
      assertion.failureMessages.some(message => message.includes('AssertionError'))), 'The designated original behavior must be RED: ' + name + '\n' + result.log.slice(-5000))
  } else {
    assert.equal(result.code, 0, result.log.slice(-5000)); assert.equal(data.numFailedTests, 0); assert.ok(data.numPassedTests > 0)
  }
  return { name, suite: suite.file, exitCode: result.code, passed: data.numPassedTests, failed: data.numFailedTests,
    reportSha256: hash(await readFile(report)), consumed: captured.consumed, loaded: captured.loaded }
}
try {
  const callers = execFileSync('rg', ['-n', 'browser:navigate', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  assert.ok(callers.some(line => line.startsWith('apps/desktop/src/main/ipc.ts:')))
  assert.ok(callers.some(line => line.startsWith('apps/desktop/src/preload/index.ts:')))
  receipt.consumers = callers
  for (const suite of suites) receipt.baseline.push(await run(suite))
  for (const mutant of mutations) receipt.mutations.push(await run(mutant.suite, mutant))
  for (const file of files) assert.equal(hash(await readFile(join(root, file))), receipt.inputs[file], 'The current candidate changed: ' + file)
  receipt.passed = true
} finally { await publish() }
for (const name of [...suites.map(suite => suite.name), ...mutations.map(mutant => mutant.id)]) await rm(join(output, 'cache-' + name), { recursive: true, force: true })
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(output, 'receipt.json'), tests: receipt.baseline.reduce((sum, suite) => sum + suite.passed, 0), mutants: receipt.mutations.length }))
