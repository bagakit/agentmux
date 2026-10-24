#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'package.json'))
const product = 'apps/desktop/scripts/package-runtime-upgrade.mjs'
const test = 'apps/desktop/test/package-ui-observation-rpc.test.ts'
const config = 'apps/desktop/test/package-ui-observation-budget.config.mts'
const copied = [product, 'apps/desktop/src/shared/client-observation.ts',
  'apps/desktop/src/shared/desktop-focus-observation.ts', 'packages/core/src/socket-liveness.ts']
const sdk = ['packages/core/dist/index.js', 'packages/core/dist/public-rpc-client.js',
  'packages/core/dist/public-rpc-wire.js', 'packages/core/dist/rpc-native-codec.js']
const inputs = [...copied, test, config, 'apps/desktop/scripts/verify-ui-observation-budget.mjs', ...sdk]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const source = Object.fromEntries([...original].map(([path, bytes]) => [path, hash(bytes)]))
const evidence = join(root, '.local/state/ui-observation-budget', randomUUID())
await mkdir(evidence, { recursive: true })
const copy = await realpath(await mkdtemp(join(tmpdir(), 'amx-ui-observation-budget-'))), target = join(copy, product)
const receipt = { schema: 'agentmux.ui-observation-budget.v1', passed: false, source, cases: [],
  boundary: 'Actual default observeUiClient child → fixture App SDK entry delayed 10.25s → actual public Unix app.inspect/parse/dispose. Existing RPC-error/invalid-required-fact cases remain actual child consumers. No strict in-flight 30s deadline is added or claimed.',
  userAppOrRunTouched: false, buildOrInstallPerformed: false, sharedTreeMutations: 0 }
async function run(label, pattern) {
  const loaded = join(evidence, label + '-loaded.jsonl'), report = join(evidence, label + '.json')
  await writeFile(loaded, '')
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config', config,
      '--reporter=json', '--outputFile=' + report], { cwd: root, env: { ...process.env,
      AGENTMUX_UI_OBSERVATION_SOURCE: target, AGENTMUX_UI_BUDGET_LOAD_LOG: loaded,
      ...(pattern ? { AGENTMUX_UI_BUDGET_TEST_PATTERN: pattern } : {}),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(join(copy, 'observe-load.mjs')).href}` },
      stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal, output }))
  })
  await writeFile(join(evidence, label + '.log'), result.output)
  const parsed = JSON.parse(await readFile(report, 'utf8'))
  const assertions = parsed.testResults.flatMap(suite => suite.assertionResults).filter(test => !['pending', 'skipped', 'todo'].includes(test.status))
  assert.equal(assertions.length, pattern ? 1 : 10, 'Exact nonempty actual consumer inventory')
  const loads = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const readers = loads.filter(row => row.path === product)
  assert.equal(readers.length, assertions.length, 'Every actual child loaded the selected inspector')
  const effectiveSHA256 = hash(await readFile(target))
  assert.ok(readers.every(row => row.sha256 === effectiveSHA256))
  const sdkLoads = loads.filter(row => sdk.includes(row.path))
  assert.ok(sdkLoads.length > 0, 'The actual child consumed its public SDK')
  for (const row of sdkLoads) assert.equal(row.sha256, source[row.path], 'Exact actual SDK bytes: ' + row.path)
  const failures = assertions.filter(test => test.status === 'failed')
  const entry = { label, code: result.code, signal: result.signal, assertions: assertions.length, passed: assertions.length - failures.length,
    failed: failures.length, effectiveProductSHA256: effectiveSHA256, loaded: loads,
    reportSHA256: hash(await readFile(report)), failures: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) }
  receipt.cases.push(entry)
  return entry
}
console.log('ui-observation-budget-evidence=' + evidence)
try {
  for (const path of copied) { await mkdir(dirname(join(copy, path)), { recursive: true }); await cp(join(root, path), join(copy, path)) }
  await cp(join(root, 'package.json'), join(copy, 'package.json'))
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  await symlink(join(root, 'apps/desktop/node_modules'), join(copy, 'apps/desktop/node_modules'))
  await writeFile(join(copy, 'observe-load.mjs'), `
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const target = pathToFileURL(process.env.AGENTMUX_UI_OBSERVATION_SOURCE).href;
const inputs = new Map(${JSON.stringify(sdk.map(path => [pathToFileURL(join(root, path)).href, path]))});
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (process.argv[2] === '--inspect-ui' && (url === target || inputs.has(url)))
    appendFileSync(process.env.AGENTMUX_UI_BUDGET_LOAD_LOG, JSON.stringify({ pid: process.pid,
      path: url === target ? ${JSON.stringify(product)} : inputs.get(url),
      sha256: createHash('sha256').update(loaded.source).digest('hex') }) + '\\n');
  return loaded;
} });
`)
  const baseline = await run('candidate')
  assert.equal(baseline.code, 0); assert.equal(baseline.signal, null); assert.equal(baseline.failed, 0)
  if (process.argv.includes('--mutations')) {
    const text = original.get(product).toString(), before = "maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }\n  })\n  return parseDesktopClientObservation(JSON.parse(stdout))"
    assert.equal(text.split(before).length - 1, 1, 'The exact UI wrapper is the sole mutation target')
    await writeFile(target, text.replace(before, 'timeout: 10_000, ' + before))
    try {
      const red = await run('ten-second-child-limit', 'ui-reader-budget')
      assert.equal(red.code, 1); assert.equal(red.signal, null); assert.equal(red.failed, 1)
      assert.ok(red.failures.every(test => test.messages.some(message => message.includes('The original UI reader must survive') && message.includes('SIGTERM'))),
        'The old child kill must cause its actual behavior assertion, not a harness timeout')
    } finally { await writeFile(target, original.get(product)) }
    const restored = await run('restored', 'ui-reader-budget')
    assert.equal(restored.code, 0); assert.equal(restored.signal, null); assert.equal(restored.failed, 0)
  }
  for (const [path, digest] of Object.entries(source)) assert.equal(hash(await readFile(join(root, path))), digest, 'Source stable: ' + path)
  receipt.sourceStable = true; receipt.passed = true
} finally {
  await rm(copy, { recursive: true, force: true })
  receipt.privateCopyRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json') }))
