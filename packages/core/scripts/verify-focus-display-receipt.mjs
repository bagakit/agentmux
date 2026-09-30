import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp', `focus-display-receipt-${Date.now()}`)
const owner = 'packages/core/src/desktop-focus-parser.ts'
const paths = [owner, 'packages/core/test/control-focus-display.test.ts',
  'packages/core/test/vitest.focus-display.config.mts', 'packages/core/test/focus-display-demand-freshness.ts',
  'packages/core/test/tsconfig.focus-display.json', 'packages/core/scripts/verify-focus-display-receipt.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const snapshot = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.focus-display-receipt-qualification.v1', passed: false,
  sourceBefore: await snapshot(), commands: [], loaded: [], cleanup: [], sharedSourceMutations: 0,
  boundary: 'Public Core source ControlServer/requester/parser over private Unix sockets; only actual Demand dist is consumed and checked by the unchanged freshness predicate. No Core build/dist mutation, Desktop paint, Native, Runtime or user installation qualification.' }
await mkdir(evidence, { recursive: true })
const run = async (label, args, extra = {}) => {
  const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  await writeFile(join(evidence, label + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  const command = { label, args, exit: result.status, signal: result.signal, error: result.error?.message ?? null }
  receipt.commands.push(command)
  assert.equal(result.signal, null, label + ' must finish normally')
  assert.equal(result.error, undefined, label + ' must not time out or fail to start')
  return command
}
const jsonLines = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const test = async (label, mutation = '') => {
  const loaded = join(evidence, label + '.loaded.jsonl'), cleanup = join(evidence, label + '.cleanup.jsonl'), output = join(evidence, label + '.json')
  const command = await run(label, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/vitest.focus-display.config.mts',
    '--reporter=json', '--outputFile=' + output], { AGENTMUX_FOCUS_DISPLAY_MUTATION: mutation,
    AGENTMUX_FOCUS_DISPLAY_LOADED: loaded, AGENTMUX_FOCUS_DISPLAY_CLEANUP: cleanup })
  const result = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(result.numTotalTests, 11, 'The exact owning fixture must be collected, never empty')
  const source = await jsonLines(loaded)
  assert.ok(source.length > 0, 'Actual loaded Core source graph must be nonempty')
  const parser = source.filter(item => item.path === owner)
  assert.equal(parser.length, 1, 'The public transport must consume the exact parser')
  assert.equal(parser[0].sourceSHA256, receipt.sourceBefore[owner])
  assert.equal(parser[0].transformed, Boolean(mutation))
  for (const item of source) assert.equal(hash(await readFile(join(root, item.path))), item.sourceSHA256, 'Actual consumer source remained unchanged: ' + item.path)
  const cleaned = await jsonLines(cleanup)
  assert.equal(cleaned.length, 11, 'Every real private server must be cleaned up')
  for (const item of cleaned) { assert.equal(item.stopped, true); assert.equal(existsSync(item.root), false); assert.equal(existsSync(item.socket), false) }
  receipt.cleanup.push({ label, privateServers: cleaned.length, allRemoved: true })
  const failures = result.testResults.flatMap(file => file.assertionResults).filter(item => item.status === 'failed')
  receipt.loaded.push({ label, coreFiles: source.length, parser: parser[0], tests: result.numTotalTests,
    passed: result.numPassedTests, failed: result.numFailedTests, assertionRED: failures.filter(item => item.failureMessages.some(message => message.includes('AssertionError'))).length })
  return { command, result, failures }
}
try {
  const baseline = await test('baseline-green'); assert.equal(baseline.command.exit, 0); assert.equal(baseline.result.numPassedTests, 11)
  const red = await test('direct-request-key-red', 'direct-request-key')
  assert.equal(red.command.exit, 1); assert.equal(red.result.numFailedTests, 2)
  assert.equal(receipt.loaded.at(-1).assertionRED, 2, 'The actual old-key regression must produce semantic assertions')
  const green = await test('same-source-restored-green'); assert.equal(green.command.exit, 0); assert.equal(green.result.numPassedTests, 11)
  assert.equal((await run('production-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'packages/core/tsconfig.build.json',
    '--tsBuildInfoFile', join(evidence, 'production-types.tsbuildinfo')])).exit, 0)
  assert.equal((await run('owning-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'packages/core/test/tsconfig.focus-display.json'])).exit, 0)
  const host = await readFile(join(root, 'packages/core/src/control-host.ts'), 'utf8')
  const callers = host.split('\n').flatMap((text, i) => text.includes('return parseDesktopFocusSuccessReceipt(') ? [{ path: 'packages/core/src/control-host.ts', line: i + 1, text: text.trim() }] : [])
  assert.ok(callers.length > 0, 'Product parser callers outside its definition must be nonempty')
  receipt.callers = callers
  receipt.sourceAfter = await snapshot(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, tests: 11, assertionRED: 2, receipt: join(evidence, 'receipt.json') }))
