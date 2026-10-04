import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const ts = require('typescript'), electron = require('electron')
const owner = 'packages/client-ui/src/terminal/replay.ts', source = readFileSync(join(root, owner), 'utf8')
const liveSource = readFileSync(join(root, 'packages/client-ui/src/terminal/live-output.ts'), 'utf8')
const evidence = join(root, '.local/state/terminal-work-yield')
mkdirSync(evidence, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'amux-terminal-yield-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const result = { passed: false, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256: hash(source), liveSourceSha256: hash(liveSource), mutants: [], callers: [], userRunTouched: false }
const syntax = ts.createSourceFile(owner, source, ts.ScriptTarget.Latest, true)
const helper = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'yieldTerminalWork')
assert.ok(helper, 'nonempty actual exported continuation owner')
const original = 'export function yieldTerminalWork(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)) }'
const baseline = source.slice(0, helper.getStart(syntax)) + original + source.slice(helper.end)
function bundle(text) {
  const compile = input => ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  return 'globalThis.Replay=(()=>{const live={exports:{}};(function(exports,module){' + compile(liveSource) +
    '})(live.exports,live);const replay={exports:{}};(function(exports,module,require){' + compile(text) +
    '})(replay.exports,replay,spec=>{if(spec!=="./live-output.js")throw new Error("Unbundled production import: "+spec);return live.exports});return replay.exports})();void 0'
}
async function behavior(text) {
  const queue = [], channels = []
  class Channel {
    constructor() {
      this.port1 = { closed: false, onmessage: null, close() { this.closed = true } }
      this.port2 = { closed: false, close() { this.closed = true }, postMessage: () => queue.push(() => this.port1.onmessage?.()) }
      channels.push(this)
    }
  }
  const context = vm.createContext({ MessageChannel: Channel, Uint8Array, setTimeout() { assert.fail('continuation must not wait for a timer') } })
  vm.runInContext(bundle(text), context)
  let settled = false
  const pending = context.Replay.yieldTerminalWork().then(() => { settled = true })
  void pending.catch(() => {}) // A rejected production mutant is observed below, never left unhandled.
  await Promise.resolve()
  assert.equal(settled, false, 'a microtask cannot replace a host task yield')
  assert.equal(queue.length, 1, 'one task is posted for one pending continuation')
  queue.shift()()
  await pending
  assert.ok(channels.every(channel => channel.port1.closed && channel.port2.closed), 'both ports close before continuation settles')
  const beforeEmpty = channels.length
  assert.equal(await context.Replay.hydrateTerminalReplay([], async () => assert.fail('empty replay must not write')), null)
  assert.equal(channels.length, beforeEmpty, 'empty replay posts no work')
  const bytes = new Uint8Array(128 * 1024 * 2 + 17).fill(120), writes = [], atYield = []
  let done = false
  const restored = context.Replay.hydrateTerminalReplay([{ dataBytes: bytes, endByte: bytes.length }], async data => writes.push(data))
    .then(cursor => { done = true; return cursor })
  for (let i = 0; !done && i < 40; i++) {
    await Promise.resolve()
    if (queue.length) { atYield.push(writes.length); queue.shift()() }
  }
  assert.equal(done, true, 'bounded replay completes')
  assert.equal(await restored, bytes.length)
  assert.deepEqual(writes.map(data => data.length), [128 * 1024, 128 * 1024, 17])
  assert.deepEqual(Buffer.concat(writes), Buffer.from(bytes))
  assert.deepEqual(atYield, [1, 2, 3], 'default replay retains each existing task boundary')
  const checkpoint = context.Replay.restoreTerminalCheckpoint(new Uint8Array([27, 91, 50, 74]), async data => writes.push(data))
  for (let i = 0; i < 8; i++) { await Promise.resolve(); if (queue.length) queue.shift()() }
  await checkpoint
  assert.deepEqual(Array.from(writes.at(-1)), [27, 91, 50, 74])
  assert.equal(queue.length, 0)
  assert.ok(channels.every(channel => channel.port1.closed && channel.port2.closed))
}
try {
  await behavior(source)
  const changes = [
    ['timeout-regression', baseline],
    ['microtask-regression', source.slice(0, helper.getStart(syntax)) + 'export function yieldTerminalWork(): Promise<void> { return Promise.resolve() }' + source.slice(helper.end)],
    ['port-leak', source.replace('channel.port2.close()', 'void channel.port2')]
  ]
  assert.equal(source.split('channel.port2.close()').length, 2, 'nonempty unique lifecycle mutant anchor')
  for (const [name, mutant] of changes) {
    await assert.rejects(() => behavior(mutant), { name: 'AssertionError' }, name + ': only behavioral assertion RED counts')
    result.mutants.push({ name, assertionRed: true })
  }
  result.callers = [
    ['apps/desktop/src/renderer/src/components/TerminalView.tsx', 'await yieldTerminalWork()', 2],
    [owner, 'yieldWork: () => Promise<void> = yieldTerminalWork', 3],
    ['packages/client-ui/package.json', '"./terminal/*"', 1]
  ].map(([path, anchor, count]) => {
    const actual = readFileSync(join(root, path), 'utf8').split(anchor).length - 1
    assert.equal(actual, count, 'nonempty production consumer: ' + path)
    return { path, anchor, count: actual }
  })
  assert.ok(result.callers.length > 0)
  const config = join(scratch, 'config.json'), output = join(evidence, 'native.json')
  const xtermEntry = require.resolve('@xterm/xterm')
  result.xtermEntrySha256 = hash(readFileSync(xtermEntry))
  result.fixtureSha256 = hash(readFileSync(join(root, 'apps/desktop/scripts/fixtures/terminal-work-yield/main.cjs')))
  writeFileSync(config, JSON.stringify({ userData: join(scratch, 'userdata'), output, xtermEntry,
    cases: [{ label: 'outer-timeout-baseline', bundle: bundle(baseline), expectFast: false }, { label: 'outer-task-candidate', bundle: bundle(source), expectFast: true }] }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const native = spawnSync(electron, [join(root, 'apps/desktop/scripts/fixtures/terminal-work-yield/main.cjs'), config], { cwd: scratch, env, timeout: 30000, encoding: 'utf8' })
  result.native = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(native.error, undefined, 'native fixture completed')
  assert.equal(native.signal, null)
  assert.equal(native.status, 0, JSON.stringify(result.native.error))
  assert.equal(result.native.passed, true)
  result.limitation = 'Helper-only timer delay is proven; default replay into patched xterm may already be fast. Neither is an attribution of the original user stall.'
  result.bundleSha256 = hash(bundle(source))
  // The geometry wiring suite has a baseline-stale source-string assertion and does not own
  // this helper. Keep this gate on the shared replay behavior; record adjacent failures separately.
  const regressionReport = join(evidence, 'regression.json')
  rmSync(regressionReport, { force: true })
  const tests = spawnSync('pnpm', ['exec', 'vitest', 'run', 'apps/desktop/test/terminal-replay.test.ts', '--reporter=json', '--outputFile=' + regressionReport],
    { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(join(evidence, 'regression.log'), (tests.stdout ?? '') + (tests.stderr ?? ''))
  assert.equal(tests.error, undefined)
  assert.equal(tests.signal, null)
  assert.equal(tests.status, 0, 'existing ordered replay/recovery regressions pass')
  const regression = JSON.parse(readFileSync(regressionReport, 'utf8'))
  assert.ok(regression.numTotalTests > 0, 'focused regression actually executes assertions')
  assert.equal(regression.numPassedTests, regression.numTotalTests)
  assert.equal(regression.numFailedTests, 0)
  result.regression = { passed: regression.numPassedTests, failed: regression.numFailedTests }
  result.passed = true
} finally {
  rmSync(scratch, { recursive: true, force: true })
  result.privateRootRemoved = true
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ passed: result.passed, evidence, mutants: result.mutants.length }))
}
