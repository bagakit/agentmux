import { fixtureTime as _hygiene_fixtureTime } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(resolve(root, 'package.json'))
const ts = require('typescript'), mutant = process.argv[2]
const coreExports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const observation = 'apps/desktop/src/renderer/src/lib/terminal-interaction-observation.ts'
const view = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const codecs = 'packages/core/src/metrics.ts', projection = 'apps/desktop/src/main/resource-usage-control.ts'
const source = path => {
  path = relative(root, resolve(root, path))
  let value = readFileSync(resolve(root, path), 'utf8'), before = value
  if (path === observation && mutant === 'synthetic') value = value.replace('!event.isTrusted || ', '')
  if (path === observation && mutant === 'clock') value = value.replace(/const delayMs = .*? : null/, 'const delayMs = 0')
  if (path === observation && mutant === 'disposed') value = value.replace('if (disposed || settled) return', 'if (settled) return')
  if (path === observation && mutant === 'failure') value = value.replace("requests[failed ? 'failed' : 'completed']++", "requests.completed++")
  if (path === view && mutant === 'caller') value = value.replace('interaction.observeWriteRequest(request, startedAt)', 'void request')
  if (path === view && mutant === 'host') value = value.replace('host: terminalRoot,', 'host: unrelatedRoot,')
  if (path === view && mutant === 'protocol') value = value.replace("if (source === 'user') interaction.observeWriteRequest", 'interaction.observeWriteRequest')
  if (path === codecs && mutant === 'codec') value = value.replace(', interaction: terminalInteractionParser', '')
  if (path === projection && mutant === 'projection') value = value.replace('performance: result.performance', 'performance: { ...result.performance, terminals: [] }')
  if (value !== before) console.log('MUTATION_APPLIED=' + mutant)
  return value
}
const transpile = (text, path = 'fixture.ts') => ts.transpileModule(text, { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const cache = new Map()
function load(path) {
  path = resolve(root, path)
  if (cache.has(path)) return cache.get(path).exports
  const module = { exports: {} }; cache.set(path, module)
  const localRequire = name => name.startsWith('@agentmux/core/') ? load('packages/core/' + coreExports['./' + name.slice('@agentmux/core/'.length)].import.replace('./dist/', 'src/').replace(/\.js$/, '.ts'))
    : name.startsWith('.') ? load(resolve(dirname(path), name.replace(/\.js$/, '.ts') + (/\.[cm]?[jt]s$/.test(name) ? '' : '.ts'))) : require(name)
  new Function('require', 'module', 'exports', transpile(source(path), path))(localRequire, module, module.exports)
  return module.exports
}
class Host {
  listeners = new Map()
  addEventListener(kind, callback, options) { assert.deepEqual(options, { capture: true, passive: true }); this.listeners.set(kind, callback) }
  removeEventListener(kind, callback) { assert.equal(this.listeners.get(kind), callback); this.listeners.delete(kind) }
  event(type, timeStamp, isTrusted = true) {
    const event = { type, timeStamp, isTrusted }
    for (const key of ['key', 'code', 'data', 'target', 'deltaY']) Object.defineProperty(event, key, { get() { assert.fail('Input payload/target was read') } })
    this.listeners.get(type)?.(event)
  }
}
const { createTerminalInteractionObservation } = load(observation)
let time = 2000
const context = { visible: true, liveReady: true, acceptsInput: true, readOnly: false, buffer: 'alternate', mouseTrackingMode: 'any' }
const host = new Host(), slow = []
const recorder = createTerminalInteractionObservation({ host, readContext: () => context, now: () => time, wall: () => _hygiene_fixtureTime(-67225600000) + time, slow: (...args) => slow.push(args) })
assert.equal(recorder.snapshot().lastEvent, null)
host.event('keydown', 1800, false); assert.equal(recorder.snapshot().keydown.count, 0)
host.event('keydown', 1750); assert.equal(recorder.snapshot().keydown.delay.maxMs, 250)
for (const stamp of [NaN, Infinity, 0, 2001, _hygiene_fixtureTime(-67225600000)]) host.event('wheel', stamp)
assert.equal(recorder.snapshot().wheel.unknownDelayCount, 5)
assert.equal(recorder.snapshot().wheel.delay.count, 0)
assert.equal(recorder.snapshot().lastEvent.delayMs, null)
host.event('wheel', 1500); assert.equal(recorder.snapshot().wheel.delay.maxMs, 500)
const detached = recorder.snapshot(); detached.keydown.delay.maxMs = 99999; detached.lastEvent.mouseTrackingMode = 'changed'
assert.equal(recorder.snapshot().keydown.delay.maxMs, 250); assert.equal(recorder.snapshot().lastEvent.mouseTrackingMode, 'any')
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const ok = defer(), failed = defer()
recorder.observeWriteRequest(ok.promise, time); recorder.observeWriteRequest(failed.promise, time)
assert.equal(recorder.snapshot().writeRequests.pending, 2)
time += 650; ok.resolve(); failed.reject(new Error('fixture rejected')); await flush()
assert.equal(recorder.snapshot().writeRequests.completed, 1); assert.equal(recorder.snapshot().writeRequests.failed, 1)
assert.equal(recorder.snapshot().writeRequests.pending, 0); assert.equal(recorder.snapshot().writeRequests.wall.maxMs, 650)
const pending = defer(); recorder.observeWriteRequest(pending.promise, time)
const beforeDispose = recorder.snapshot(); recorder.dispose(); recorder.dispose(); pending.resolve(); await flush()
assert.deepEqual(recorder.snapshot(), beforeDispose); assert.equal(host.listeners.size, 0)

// Execute the actual component constructor, input subscription and write caller ASTs.
const viewSource = source(view), ast = ts.createSourceFile(view, viewSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function declaration(name) {
  const found = []
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found.push(node); ts.forEachChild(node, visit) }
  visit(ast); assert.equal(found.length, 1, `Actual production declaration ${name}`)
  return 'const ' + found[0].getText(ast) + ';'
}
assert.match(declaration('resourceOwners'), /listeners: 11\b/, 'Resource counts include the two passive interaction listeners')
const revealPath = 'apps/desktop/src/renderer/src/lib/terminal-reveal.ts'
const revealAst = ts.createSourceFile(revealPath, source(revealPath), ts.ScriptTarget.Latest, true)
const revealFunctions = revealAst.statements.filter(node => ts.isFunctionDeclaration(node) && ['terminalInputSender', 'terminalAcceptsInput'].includes(node.name?.text))
assert.equal(revealFunctions.length, 2, 'Actual input gate/sender declarations')
const revealExports = {}
new Function('exports', transpile(revealFunctions.map(node => node.getText(revealAst)).join('\n')))(revealExports)
const { terminalInputSender, terminalAcceptsInput } = revealExports
const { subscribeTerminalInput } = load('packages/client-ui/src/terminal/input.ts')
const { createRendererPerformance } = load('apps/desktop/src/renderer/src/lib/renderer-performance.ts')
const perf = createRendererPerformance(() => time, () => _hygiene_fixtureTime(-67225600000) + time)
const terminalRoot = new Host(), unrelatedRoot = new Host(), handlers = {}, writes = [], errors = []
const control = { kind: 'agent', hostId: 'local', agentSessionId: 's1', run: { runId: 'r1' } }
const terminal = { cols: 80, rows: 24, modes: { mouseTrackingMode: 'any' }, buffer: { active: { type: 'alternate' }, normal: { length: 24 }, alternate: { length: 24 } } }
for (const name of ['onUserInput', 'onData', 'onBinary']) terminal[name] = callback => { handlers[name] = callback; return { dispose: () => { delete handlers[name] } } }
const readOnlyRef = { current: false }, acceptsInputRef = { current: true }
const deps = { createTerminalInteractionObservation: options => createTerminalInteractionObservation({ ...options, now: () => time, wall: () => _hygiene_fixtureTime(-67225600000) + time }),
  terminalInputSender, terminalAcceptsInput, subscribeTerminalInput, terminalRoot, unrelatedRoot, terminal,
  visibleRef: { current: true }, visibleSinceRef: { current: _hygiene_fixtureTime(-67225599000) }, revealed: true, readyForLiveOutput: true, readySinceAt: _hygiene_fixtureTime(-67225599000),
  readOnlyRef, acceptsInputRef, canControlRunRef: { current: true }, rendererPerformance: perf,
  session: { id: 's1', control }, linkOriginRef: { current: { regionId: 'region1' } }, replayingContinuation: false,
  linkPreviewWrites: 0, liveOutputQueue: { length: 0, byteLength: 0 }, pending: [], pendingBytes: 0,
  pasteInput: { consume: () => false }, reportError: error => errors.push(error),
  api: { sessions: { write: (target, data, source) => { const pending = defer(); writes.push({ target, data, source, ...pending }); return pending.promise } } } }
deps.rendererPerformance = { ...perf, registerTerminal: read => { assert.doesNotThrow(read); return perf.registerTerminal(read) } }
const body = ['acceptsCurrentInput', 'interaction', 'releasePerformance', 'sendInput', 'input'].map(declaration).join('\n')
const mounted = new Function(...Object.keys(deps), transpile(body) + '\nreturn {interaction, input, sendInput};')(...Object.values(deps))
terminalRoot.event('wheel', time - 350); terminalRoot.event('keydown', time - 100)
assert.equal(perf.snapshot().terminals[0].interaction.wheel.count, 1)
handlers.onUserInput(); handlers.onData('fixture text')
handlers.onBinary(String.fromCharCode(0x80, 0xff))
assert.equal(writes.length, 2); assert.equal(writes[0].target, control); assert.equal(writes[0].source, 'user')
assert.deepEqual([...writes[1].data], [0x80, 0xff]); assert.equal(writes[1].source, 'user')
acceptsInputRef.current = false; handlers.onData('blocked'); assert.equal(writes.length, 2); acceptsInputRef.current = true
readOnlyRef.current = true; handlers.onData('readonly'); assert.equal(writes.length, 2); readOnlyRef.current = false
mounted.sendInput('protocol reply', 'terminal-protocol')
assert.equal(writes.length, 3); assert.equal(writes[2].source, 'terminal-protocol'); writes[2].resolve(); await flush()
assert.equal(perf.snapshot().terminals[0].interaction.writeRequests.started, 2, 'Protocol replies do not count as user input requests')
time += 1234; writes[0].resolve(); const error = new Error('original failure'); writes[1].reject(error); await flush()
assert.deepEqual(errors, [error])
const snapshot = perf.snapshot(), observed = snapshot.terminals[0]
assert.equal(observed.sessionId, 's1'); assert.equal(observed.runId, 'r1'); assert.equal(observed.regionId, 'region1')
assert.equal(observed.interaction.writeRequests.started, 2); assert.equal(observed.interaction.writeRequests.completed, 1)
assert.equal(observed.interaction.writeRequests.failed, 1); assert.equal(observed.interaction.writeRequests.wall.maxMs, 1234)
assert.ok(snapshot.slowEvents.some(event => event.kind === 'terminal-interaction' && event.detail === 'write-request'))
assert.match(viewSource, /disposed = true\s+interaction\.dispose\(\)/)
mounted.input.dispose(); mounted.interaction.dispose()
const { parseRendererPerformanceSnapshot, parseMetricsRendererResult } = load(codecs)
assert.doesNotThrow(() => parseRendererPerformanceSnapshot(snapshot))
for (const mutate of [x => { delete x.terminals[0].interaction }, x => { x.terminals[0].interaction.wheel.delay.count = -1 },
  x => { x.terminals[0].interaction.lastEvent.delayMs = Infinity }, x => { x.terminals[0].interaction.key = 'forbidden' }]) {
  const invalid = structuredClone(snapshot); mutate(invalid); assert.throws(() => parseRendererPerformanceSnapshot(invalid))
}
const projectionSource = source(projection), projectionAst = ts.createSourceFile(projection, projectionSource, ts.ScriptTarget.Latest, true)
const project = projectionAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'observeRendererResources')
assert.ok(project, 'Actual Main projection exists')
const exports = {}
new Function('exports', 'parseMetricsRendererResult', 'randomUUID', 'AgentMuxError', transpile(project.getText(projectionAst)))(exports, parseMetricsRendererResult, () => 'fixture', Error)
const window = { windowId: 1, webContentsId: 1, generation: 1 }, counts = { monacoEditors: null, monacoModels: null, documents: 1, runtimeSubscriptions: 1, terminalViews: 1, terminalAddons: 3, terminalListeners: 9 }
const projected = await exports.observeRendererResources({ execute: async () => ({ operation: 'metrics.renderer', window, observedAt: 1, counts, performance: snapshot }) }, () => window, new AbortController().signal)
assert.equal(projected.data.performance.terminals.length, 1, 'Main forwards the observed terminal')
assert.deepEqual(projected.data.performance.terminals[0].interaction, observed.interaction)
const cleanHost = new Host(), bounded = createTerminalInteractionObservation({ host: cleanHost, readContext: () => context, now: () => time, wall: () => time, slow: () => {} })
for (let i = 0; i < 100000; i++) cleanHost.event('wheel', time - 1)
assert.equal(bounded.snapshot().wheel.count, 100000); assert.ok(JSON.stringify(bounded.snapshot()).length < 1000); bounded.dispose()
const callers = [ [view, 'interaction.snapshot()'], [view, 'interaction.observeWriteRequest(request, startedAt)'],
  [projection, 'parseMetricsRendererResult(await bridge.execute'], ['packages/core/src/public-rpc-client.ts', 'parseMetricsObservation(p.observation)'],
  ['packages/core/src/agentmux.ts', 'const result = await client.call(method, invocation.params'] ].map(([path, anchor]) => {
  const count = source(path).split(anchor).length - 1; assert.ok(count > 0, `Nonempty production caller ${path}`); return { path, anchor, count }
})
if (!mutant) {
  const mutants = ['synthetic', 'clock', 'disposed', 'failure', 'caller', 'host', 'protocol', 'codec', 'projection']
  for (const name of mutants) {
    const result = spawnSync(process.execPath, [import.meta.filename, name], { cwd: root, encoding: 'utf8', timeout: 30000 })
    const output = result.stdout + result.stderr
    assert.ok(result.status !== 0 && !result.error && output.includes('MUTATION_APPLIED=' + name) && output.includes('AssertionError'), `Mutant ${name} must fail assertions: ${output.slice(-2000)}`)
    console.log(name + ': killed')
  }
  const evidence = resolve(root, '.local/state/terminal-interaction-observation'); mkdirSync(evidence, { recursive: true })
  writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({ passed: true, mutants, callers, executedComponentDeclarations: view, host: 'controlled passive event host; not a React/native E2E', publicProjection: projection }, null, 2) + '\n')
  console.log('terminal interaction production regression: passed')
}
