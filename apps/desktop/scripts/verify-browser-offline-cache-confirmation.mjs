import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild'), electron = require('electron')
const evidence = join(root, '.bagakit/feature-tracker/resource-confirmation-and-paste-readability')
const diagnostic = process.argv.includes('--native-diagnostic')
await mkdir(evidence, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const helper = 'apps/desktop/src/main/browser-profile-storage-confirmation.ts', ipc = 'apps/desktop/src/main/ipc.ts'
const inputs = [helper, ipc, 'apps/desktop/src/main/browser-profile-storage.ts', 'apps/desktop/test/browser-offline-cache-confirmation.test.ts', 'apps/desktop/test/browser-offline-cache-confirmation.config.mts', 'apps/desktop/scripts/fixtures/browser-offline-cache-confirmation/main.ts']
const receipt = { passed: false, sources: Object.fromEntries(await Promise.all(inputs.map(async file => [file, sha(await readFile(join(root, file)))]))), tests: [], native: null, cleanup: [], aestheticReview: 'not-performed' }
const save = () => writeFile(join(evidence, diagnostic ? 'confirmation-diagnostic.json' : 'confirmation-verification.json'), JSON.stringify(receipt, null, 2) + '\n')
const temporary = await mkdtemp('/tmp/amux-cache-confirmation-')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
try {
  for (const mutant of diagnostic ? [] : ['baseline', 'profile', 'revision', 'cancel-default', 'native-response', 'question', 'restored']) {
    const resultFile = join(temporary, mutant + '.json')
    const result = await runProbeProcess(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/browser-offline-cache-confirmation.config.mts', '--reporter=default', '--reporter=json', '--outputFile.json=' + resultFile], {
      cwd: root, env: { ...env, ...(mutant === 'baseline' || mutant === 'restored' ? {} : { AGENTMUX_CONFIRMATION_MUTANT: mutant }) }, timeoutMs: 45_000
    })
    await stopProbeProcesses(result.originalPid, temporary)
    assert.deepEqual(await listProbeProcesses(result.originalPid, temporary), [])
    const tests = JSON.parse(await readFile(resultFile, 'utf8'))
    assert.equal(tests.numTotalTests, 5); assert.equal(tests.numPendingTests, 0); assert.equal(tests.numRuntimeErrorTestSuites ?? 0, 0)
    for (const suite of tests.testResults) assert.equal(suite.message, '', 'Setup/collection failures cannot qualify a mutation')
    if (mutant === 'baseline' || mutant === 'restored') { assert.equal(result.exitCode, 0); assert.equal(tests.numFailedTests, 0) }
    else {
      assert.notEqual(result.exitCode, 0)
      const failed = tests.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
      assert.ok(failed.some(test => test.failureMessages.some(message => /AssertionError/u.test(message))), 'A source mutation must reach a real behavioral assertion')
    }
    receipt.tests.push({ mutant, result, total: tests.numTotalTests, failed: tests.numFailedTests }); await save()
    console.log(`Confirmation ${mutant}: ${result.exitCode}`)
  }
  const bundle = join(temporary, 'main.mjs')
  await build({ entryPoints: [join(root, 'apps/desktop/scripts/fixtures/browser-offline-cache-confirmation/main.ts')], outfile: bundle, platform: 'node', target: 'node24', format: 'esm', bundle: true, external: ['electron'] })
  await symlink(join(root, 'apps/desktop/node_modules'), join(temporary, 'node_modules'))
  const home = join(temporary, 'home'); await mkdir(home)
  const bootstrap = join(temporary, 'main.cjs')
  await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const key of ['appData','userData','sessionData']){const p=path.join(${JSON.stringify(home)},key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(bundle).href)})).catch(e=>{console.error(e);app.exit(1)});`)
  await rm(join(evidence, 'confirmation-native.json'), { force: true })
  const logs = [], result = await runProbeProcess(electron, [bootstrap], { cwd: home, timeoutMs: 90_000,
    env: { ...env, AGENTMUX_CONFIRMATION_ROOT: root, AGENTMUX_CONFIRMATION_EVIDENCE: evidence }, onLine: line => { logs.push(line); console.log(line) } })
  await stopProbeProcesses(result.originalPid, temporary)
  const remaining = await listProbeProcesses(result.originalPid, temporary)
  const native = JSON.parse(await readFile(join(evidence, 'confirmation-native.json'), 'utf8'))
  receipt.native = { result, remaining, actual: native, bundleSha256: sha(await readFile(bundle)), electronSha256: sha(await readFile(electron)), nativeHelperSha256: sha(await readFile(join(root, 'packages/native-desktop/macos/.build/debug/agentmux-native-macos'))), log: logs.join('\n') }
  await save()
  assert.equal(result.exitCode, 0, native.error ?? logs.join('\n')); assert.equal(native.passed, true); assert.equal(native.captures.length, 2); assert.deepEqual(remaining, [])
  for (const file of inputs) assert.equal(sha(await readFile(join(root, file))), receipt.sources[file], 'Bound source changed during the proof: ' + file)
  receipt.passed = true
} finally {
  await rm(temporary, { recursive: true, force: true })
  receipt.cleanup.push({ path: temporary, removed: true })
  await rm(join(evidence, 'confirmation-cache'), { recursive: true, force: true })
  await save()
}
console.log('Confirmation proof passed; complete native PNGs await independent visual review.')
