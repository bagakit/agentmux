import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const ts = require('typescript'), electron = require('electron')
const patchPath = 'patches/@xterm__xterm@6.1.0-beta.303.patch'
const patch = await readFile(join(root, patchPath), 'utf8')
const hash = text => createHash('sha256').update(text).digest('hex')
const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
assert.ok(lock.includes("'@xterm/xterm@6.1.0-beta.303': " + hash(patch)))
for (const match of lock.matchAll(/\(patch_hash=([a-f0-9]{64})\)/g)) assert.equal(match[1], hash(patch))
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-write-scheduler-'))
const evidence = join(root, '.tmp/terminal-write-scheduler', String(globalThis.crypto.randomUUID()))
await mkdir(evidence, { recursive: true })
const result = { schema: 'agentmux.terminal-write-scheduler-proof.v1', passed: false, patchSha256: hash(patch), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), mutations: [], userRunTouched: false }
try {
  const cached = dirname(require.resolve('@xterm/xterm/package.json')), pristine = join(privateRoot, 'pristine'), candidate = join(privateRoot, 'candidate')
  await cp(cached, pristine, { recursive: true })
  const revisions = execFileSync('git', ['log', '-5', '--format=%H', '--', patchPath], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  const patches = [patch, ...revisions.map(rev => execFileSync('git', ['show', rev + ':' + patchPath], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))]
  let reversed = false
  for (const [i, value] of patches.entries()) {
    const file = join(privateRoot, `reverse-${i}.patch`); await writeFile(file, value)
    try { execFileSync('patch', ['-p1', '--batch', '--reverse', '--dry-run', '--input', file], { cwd: pristine, stdio: 'pipe' }) } catch { continue }
    execFileSync('patch', ['-p1', '--batch', '--reverse', '--input', file], { cwd: pristine, stdio: 'pipe' }); reversed = true; break
  }
  assert.ok(reversed, 'cached package matches a declared repository patch')
  await cp(pristine, candidate, { recursive: true })
  execFileSync('patch', ['-p1', '--batch', '--input', join(root, patchPath)], { cwd: candidate, stdio: 'pipe' })
  const owner = 'src/common/input/WriteBuffer.ts', source = await readFile(join(candidate, owner), 'utf8')
  const program = ts.createProgram([join(candidate, owner)], { strict: true, skipLibCheck: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true })
  const diagnostics = ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
  assert.deepEqual(diagnostics, [], 'changed dependency source typechecks with its real imports')
  const a = source.indexOf('class WriteTaskTimer '), b = source.indexOf('\nconst enum Constants', a)
  assert.ok(a >= 0 && b > a)
  const compiledClass = ts.transpileModule(source.slice(a, b), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.trim().replace(/^class WriteTaskTimer/, 'class').replace(/;$/, '')
  const ctor = `this._innerWriteTimer=this._register(new(${compiledClass})())`
  result.entries = {}
  for (const entry of ['xterm.js', 'xterm.mjs']) {
    const code = await readFile(join(candidate, 'lib', entry), 'utf8')
    assert.equal(code.split(ctor).length, 2, entry + ': exact source-derived scheduler is consumed once')
    assert.equal(code.split('this._innerWriteTimer.cancelAndSet(()=>this._innerWrite(e,t))').length, 2)
    result.entries[entry] = hash(code)
  }
  // Other existing dependency patch surfaces must remain identical to the cached baseline.
  const previousPatch = patches.find(value => value !== patch && !value.includes('class WriteTaskTimer'))
  assert.ok(previousPatch, 'pre-scheduler patch remains available for preservation proof')
  const previous = join(privateRoot, 'previous'), previousFile = join(privateRoot, 'previous.patch')
  await cp(pristine, previous, { recursive: true }); await writeFile(previousFile, previousPatch)
  execFileSync('patch', ['-p1', '--batch', '--input', previousFile], { cwd: previous, stdio: 'pipe' })
  const existingFiles = [...previousPatch.matchAll(/^diff --git a\/(.+) b\//gm)].map(match => match[1])
  assert.ok(existingFiles.length > 0)
  for (const file of existingFiles.filter(file => !file.startsWith('lib/'))) assert.equal(await readFile(join(candidate, file), 'utf8'), await readFile(join(previous, file), 'utf8'), 'existing patch preserved: ' + file)
  for (const [entry, oldCtor] of [['xterm.js', 'this._innerWriteTimer=this._register(new s.TimeoutTimer)'], ['xterm.mjs', 'this._innerWriteTimer=this._register(new Ie)']]) {
    const reverted = (await readFile(join(candidate, 'lib', entry), 'utf8')).replace(ctor, oldCtor).replace('this._innerWriteTimer.cancelAndSet(()=>this._innerWrite(e,t))', 'this._innerWriteTimer.cancelAndSet(()=>this._innerWrite(e,t),0)')
    assert.equal(reverted, await readFile(join(previous, 'lib', entry), 'utf8'), 'compiled changes restricted to the parser scheduler: ' + entry)
  }
  const consumers = [
    ['apps/desktop/src/renderer/src/components/TerminalView.tsx', /terminal\.write\(data, resolve\)/],
    ['src/common/CoreTerminal.ts', /new WriteBuffer\(/]
  ]
  result.callers = []
  for (const [file, pattern] of consumers) {
    const value = await readFile(join(file.startsWith('apps/') ? root : candidate, file), 'utf8')
    assert.match(value, pattern); result.callers.push(file)
  }
  assert.ok(result.callers.length > 0)

  function sourceProof(text = source) {
    const queue = [], channels = [], cache = new Map(); let now = 100, maxPending = 0
    class FakeChannel {
      constructor() {
        this.port1 = { closed: false, onmessage: null, close() { this.closed = true } }
        this.port2 = { closed: false, close() { this.closed = true }, postMessage: data => { queue.push(() => { if (!this.port1.closed) this.port1.onmessage?.({ data }) }); maxPending = Math.max(maxPending, queue.length) } }
        channels.push(this)
      }
    }
    function load(file) {
      if (cache.has(file)) return cache.get(file).exports
      const mod = { exports: {} }; cache.set(file, mod)
      const input = file === join(candidate, owner) ? text : readFileSync(file, 'utf8')
      const js = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText
      const sandbox = { MessageChannel: FakeChannel, performance: { now: () => now }, queueMicrotask, console, setTimeout: () => { throw new assert.AssertionError({ message: 'parser uses a throttled timeout' }) }, clearTimeout() {} }
      const fn = vm.runInNewContext('(function(exports,require,module){' + js + '\n})', sandbox)
      fn(mod.exports, spec => load(resolve(dirname(file), spec + '.ts')), mod); return mod.exports
    }
    const { WriteBuffer } = load(join(candidate, owner)), drain = () => { let count = 0; while (queue.length) { assert.ok(count++ < 100, 'bounded pending work'); queue.shift()() } }
    const writes = [], callbacks = [], buffer = new WriteBuffer(data => { writes.push(data); now += 7 })
    for (const i of ['a', 'b', 'c', 'd']) buffer.write(i, () => callbacks.push(i))
    assert.equal(writes.length, 0, 'initial write yields a macrotask')
    queue.shift()(); assert.equal(writes.length, 2, '12ms slice yields before processing remaining chunks')
    assert.equal(queue.length, 1); drain(); assert.deepEqual(writes, ['a', 'b', 'c', 'd']); assert.deepEqual(callbacks, writes)
    const scheduler = buffer._innerWriteTimer, runs = []
    for (let i = 0; i < 1000; i++) scheduler.cancelAndSet(() => runs.push(i))
    assert.equal(queue.length, 1, 'superseding storm keeps one posted wake-up')
    queue.shift()(); assert.equal(runs.length, 0, 'stale message cannot consume replacement continuation')
    assert.equal(queue.length, 1); drain(); assert.deepEqual(runs, [999])
    buffer.handleUserInput(); buffer.write('input', () => callbacks.push('input')); assert.equal(writes.at(-1), 'input', 'original user-input fast path')
    scheduler.cancelAndSet(() => runs.push('disposed')); buffer.dispose(); drain(); assert.deepEqual(runs, [999])
    assert.ok(channels.length > 0); assert.ok(channels.every(channel => channel.port1.closed && channel.port2.closed), 'both ports released')
    const idle = new WriteBuffer(() => {}); assert.equal(queue.length, 0, 'idle terminals post no tasks'); idle.dispose()
    return { WriteBuffer, queue, drain, channels, advance: ms => { now += ms }, maxPending }
  }
  const unit = sourceProof()
  const calls = [], resumed = new unit.WriteBuffer((data, value) => { calls.push([data, value]); if (calls.length === 1) return Promise.resolve(false) })
  const completed = []; resumed.write('async', () => completed.push('async')); unit.queue.shift()(); unit.advance(20)
  await Promise.resolve(); await Promise.resolve(); assert.equal(unit.queue.length, 1, 'expired async slice resumes in a new task'); unit.drain()
  assert.deepEqual(calls, [['async', true], ['async', false]]); assert.deepEqual(completed, ['async']); resumed.dispose()
  const quickCalls = [], quick = new unit.WriteBuffer((data, value) => { quickCalls.push([data, value]); unit.advance(7); if (quickCalls.length === 1) return Promise.resolve(false) })
  quick.write('quick'); quick.write('tail'); unit.queue.shift()(); await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(quickCalls, [['quick', true], ['quick', false]], 'short async continuation retains original slice startTime')
  assert.equal(unit.queue.length, 1); unit.drain(); assert.deepEqual(quickCalls.at(-1), ['tail', true]); quick.dispose()
  result.source = { scheduler: hash(source.slice(a, b)), maxPending: unit.maxPending, idleTasks: 0, asyncFalseContinuation: true }
  for (const [name, from, to] of [
    ['callback-order', 'const cb = this._callbacks[this._bufferOffset];', 'const cb = this._callbacks[this._callbacks.length - 1 - this._bufferOffset];'],
    ['dispose-port', 'this._channel.port2.close();', 'void this._channel.port2;'],
    ['no-yield', 'if (performance.now() - startTime >= Constants.WRITE_TIMEOUT_MS) {\n        break;', 'if (false) {\n        break;'],
    ['wake-storm', 'if (!this._posted) this._post();', 'this._post();']
  ]) {
    assert.equal(source.split(from).length, 2, 'nonempty mutation anchor: ' + name)
    assert.throws(() => sourceProof(source.replace(from, to)), { name: 'AssertionError' }, name + ': production mutant must fail a behavioral assertion')
    result.mutations.push({ name, assertionRed: true })
  }
  function native(label, cases, shouldPass = true) {
    const output = join(evidence, label + '.json'), config = join(privateRoot, label + '.json')
    writeFileSync(config, JSON.stringify({ userData: join(privateRoot, label + '-userdata'), output, cases }))
    let code = 0
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    try { execFileSync(electron, [join(root, 'apps/desktop/scripts/fixtures/terminal-write-scheduler/main.cjs'), config], { cwd: privateRoot, env, timeout: 30000, stdio: 'pipe' }) } catch (error) { code = error.status; assert.equal(typeof code, 'number', 'native process completed with a known exit') }
    const receipt = JSON.parse(readFileSync(output, 'utf8'))
    if (shouldPass) { assert.equal(code, 0, JSON.stringify(receipt.error)); assert.equal(receipt.passed, true) }
    else { assert.notEqual(code, 0); assert.equal(receipt.error?.name, 'AssertionError'); assert.match(receipt.error.message, /hidden parser callback avoids timer clamp/) }
    return receipt
  }
  const baseline = { label: 'original-timeout', directory: previous, entry: 'xterm.js' }
  result.native = native('native', [baseline, ...['xterm.js', 'xterm.mjs'].map(entry => ({ label: 'candidate-' + entry, directory: candidate, entry, expectFast: true, burst: true })), { label: 'page-visible', directory: candidate, entry: 'xterm.mjs', expectFast: true, burst: true, visible: true }])
  assert.ok(Math.max(...result.native.cases[0].data.waits.slice(6)) >= 500, 'native baseline reproduces hidden timer clamp')
  native('timeout-mutant', [{ ...baseline, expectFast: true }], false)
  result.mutations.push({ name: 'compiled-timeout-regression', assertionRed: true })
  result.passed = true
} finally {
  await rm(privateRoot, { recursive: true, force: true })
  result.privateRootRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, evidence, mutations: result.mutations.length }))
}
