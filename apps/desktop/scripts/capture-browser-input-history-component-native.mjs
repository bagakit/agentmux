import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { gzipSync } from 'node:zlib'

const repo = resolve(new URL('../../../', import.meta.url).pathname)
const require = createRequire(join(repo, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const electron = require('electron'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: node apps/desktop/scripts/capture-browser-input-history-component-native.mjs [new-evidence-directory [durable-write-disabled|ime-submit-guards-disabled]]\nPrivate shared-component behavior producer only; full T026 Native acceptance remains pending.\n')
  process.exit(0)
}
assert.ok(args.length <= 2 && args.every(value => value && !value.startsWith('--')), 'Only an evidence directory and an explicit known Source mutant are accepted')
assert.ok(!args[1] || ['durable-write-disabled', 'ime-submit-guards-disabled'].includes(args[1]), 'An explicit known Native Source mutant is required')
const out = resolve(process.argv[2] ?? `docs/reviews/evidence/browser-input-history-component-native-2026-10-04/attempt-${Date.now()}`)
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-history-native-')))
const compiledRoot = join(scratch, 'compiled')
await mkdir(out, { recursive: true }); await mkdir(compiledRoot)
const receipt = { schema: 'agentmux.browser-input-history-component-native.v1', author: '/root/browser_input_history_main', passed: false, behaviorPassed: false,
  taskComplete: false, scope: 'actual-shared-component-private-bridge-store-native-overlay', phases: [],
  notTested: ['Native mounting of BrowserPane two forms, Launcher and GlobalSurvey callers', 'Production registerIpc four history handlers', 'OS Native IME trusted commit (CDP start/Enter boundary only)', 'Complete Desktop Tab/Region/healthyRun restart', 'Original page visibility in the composed window requires independent original-image review'],
  source: { candidate: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim() }, inputs: [], drift: [] },
  compiled: [], systemClipboard: [], userAppRuntimeControl: [], privateRoot: scratch, temporaryLimit: 30 * 1024 * 1024, evidenceLimit: 8 * 1024 * 1024 }
const packageCore = JSON.parse(await readFile(join(repo, 'packages/core/package.json'), 'utf8'))
const aliases = Object.fromEntries(Object.entries(packageCore.exports).filter(([, target]) => typeof target.import === 'string').map(([key, target]) => [key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2), join(repo, 'packages/core/src', target.import.replace('./dist/', '').replace(/\.js$/, '.ts'))]))
const common = { bundle: true, metafile: true, absWorkingDir: repo, logLevel: 'silent', alias: aliases, minify: true }
const mutant = process.argv[3], modifiedInputs = new Map()
if (mutant) {
  const sourcePath = mutant === 'durable-write-disabled' ? 'apps/desktop/src/main/browser-input-history.ts' : 'apps/desktop/src/renderer/src/components/BrowserAddressInput.tsx'
  const original = await readFile(join(repo, sourcePath), 'utf8')
  const blocks = mutant === 'durable-write-disabled' ? [['await durableWriteFile(this.path(scope), document)', 'void document']] : [
    ['if (props.disabled || submitDisabled || composing.current) return', 'if (props.disabled || submitDisabled) return'],
    ["if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return }", '/* Actual composition submission block removed by private Source mutant. */']
  ]
  let changed = original
  for (const [from, to] of blocks) { assert.equal(changed.split(from).length - 1, 1, 'Source mutation anchor is present exactly once'); changed = changed.replace(from, to) }
  modifiedInputs.set(sourcePath, { bytes: Buffer.from(changed), originalSha256: hash(Buffer.from(original)) })
  receipt.sourceMutation = { id: mutant, sourcePath, blocks, originalSha256: hash(Buffer.from(original)), compiledSourceSha256: hash(Buffer.from(changed)) }
  common.plugins = [{ name: 'owned-actual-source-mutation', setup(builder) {
    builder.onLoad({ filter: /(?:browser-input-history\.ts|BrowserAddressInput\.tsx)$/ }, async args => {
      const row = modifiedInputs.get(relative(repo, args.path))
      return row ? { contents: row.bytes.toString(), loader: args.path.endsWith('tsx') ? 'tsx' : 'ts', resolveDir: dirname(args.path) } : undefined
    })
  } }]
}
let server
async function bytesIn(directory) { let bytes = 0; for (const row of await readdir(directory, { withFileTypes: true })) { const p = join(directory, row.name); if (row.isFile()) bytes += (await stat(p)).size; else if (row.isDirectory()) bytes += await bytesIn(p) } return bytes }
async function original(path, prefix) {
  const bytes = await readFile(path), file = prefix ?? relative(out, path)
  return { path: file, bytes: bytes.length, sha256: hash(bytes) }
}
async function execute(phase) {
  const env = { ...process.env, AGENTMUX_HISTORY_PRIVATE_ROOT: scratch, AGENTMUX_HISTORY_NATIVE_OUT: out, AGENTMUX_HISTORY_NATIVE_PHASE: phase,
    AGENTMUX_HISTORY_COMPILED_ROOT: compiledRoot, AGENTMUX_HISTORY_PAGE_URL: `http://127.0.0.1:${server.address().port}/page`,
    NODE_PATH: [join(repo, 'apps/desktop/node_modules'), join(repo, 'packages/core/node_modules'), join(repo, 'node_modules')].join(':') }
  delete env.ELECTRON_RUN_AS_NODE
  const startedAt = Date.now(), child = spawn(electron, [join(compiledRoot, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 90000)
  const result = await new Promise(resolve => { child.on('error', error => resolve({ error: error.message })); child.on('exit', (exit, signal) => resolve({ exit, signal })) })
  clearTimeout(timer)
  await writeFile(join(out, phase + '-stdout.log'), stdout); await writeFile(join(out, phase + '-stderr.log'), stderr)
  const phaseResult = { phase, startedAt, returnedAt: Date.now(), process: { pid: child.pid, ...result, timedOut }, temporaryBytes: await bytesIn(scratch) }
  try {
    const raw = JSON.parse(await readFile(join(out, phase + '-receipt.json'), 'utf8'))
    return { ...phaseResult, original: await original(join(out, phase + '-receipt.json')), actual: { pid: raw.pid, passed: raw.passed, behaviorPassed: raw.behaviorPassed, scope: raw.scope, phaseCompleted: raw.phaseCompleted } }
  } catch (error) { return { ...phaseResult, missingActualOriginal: error.message } }
}
try {
  const builds = [
    await build({ ...common, platform: 'node', format: 'esm', banner: { js: "import { createRequire as __historyCreateRequire } from 'node:module'; const require=__historyCreateRequire(import.meta.url);" }, alias: aliases, external: ['electron', 'node-pty', '@ctxmux/core', 'ctxmux'], entryPoints: ['apps/desktop/scripts/fixtures/browser-input-history-native/main.ts'], outfile: join(compiledRoot, 'main.mjs') }),
    await build({ ...common, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: join(compiledRoot, 'preload.cjs') }),
    await build({ ...common, platform: 'browser', format: 'iife', define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' }, entryPoints: ['apps/desktop/scripts/fixtures/browser-input-history-native/renderer.tsx'], outfile: join(compiledRoot, 'renderer.js') })
  ]
  await writeFile(join(compiledRoot, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Private Browser input history Native probe</title><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>')
  await mkdir(join(out, 'source-inputs'))
  const inputs = new Set()
  for (let i = 0; i < builds.length; i++) {
    const metadata = builds[i].metafile
    await writeFile(join(out, ['main', 'preload', 'renderer'][i] + '-metafile.json'), JSON.stringify(metadata))
    // Bind actual emitted input bytes; parser-only unused reexports are not loaded Native Source.
    for (const artifact of Object.values(metadata.outputs)) for (const [path, binding] of Object.entries(artifact.inputs)) if (binding.bytesInOutput > 0) inputs.add(path)
  }
  for (const path of inputs) {
    const bytes = modifiedInputs.get(path)?.bytes ?? await readFile(resolve(repo, path)), leaf = hash(Buffer.from(path)) + '.gz'
    await writeFile(join(out, 'source-inputs', leaf), gzipSync(bytes))
    receipt.source.inputs.push({ sourcePath: path, sha256: hash(bytes), bytes: bytes.length, snapshot: 'source-inputs/' + leaf, compression: 'gzip',
      ...(modifiedInputs.has(path) ? { expectedLiveOriginalSha256: modifiedInputs.get(path).originalSha256 } : {}) })
  }
  for (const name of ['main.mjs', 'preload.cjs', 'renderer.js', 'renderer.css', 'index.html']) {
    const bytes = await readFile(join(compiledRoot, name)); await mkdir(join(out, 'compiled'), { recursive: true }); await writeFile(join(out, 'compiled', name + '.gz'), gzipSync(bytes))
    receipt.compiled.push({ name, bytes: bytes.length, sha256: hash(bytes), snapshot: 'compiled/' + name + '.gz', compression: 'gzip' })
  }
  assert.ok(receipt.source.inputs.length > 0 && receipt.compiled.length === 5)
  server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><style>body{margin:0;background:#171e1d;color:#d8ebe5;font:16px system-ui;padding:18px}main{font-size:12px;color:#8bb7a8}button{position:fixed;bottom:0;left:0;width:100%;height:36px;background:#253b35;color:#b5e0cc;border:0}</style><h3>Original Browser page</h3><main>This original WebContentsView stays visible.<br>History covers only its own compact list.<br>The uncovered bottom button counts real native clicks.</main><button>Original page input · <span id="count">0</span></button><script>window.fixtureClicks=0;window.fixtureEvents=[];document.addEventListener("click",e=>{window.fixtureClicks++;window.fixtureEvents.push({type:e.type,trusted:e.isTrusted,at:Date.now()});document.querySelector("#count").textContent=window.fixtureClicks})</script>') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  for (const phase of ['first', 'second']) {
    const result = await execute(phase); receipt.phases.push(result)
    assert.ok(result.temporaryBytes < receipt.temporaryLimit, 'Owned temporary bytes below limit')
    if (result.process.exit !== 0 || !result.actual?.behaviorPassed) throw new Error('Actual private behavior failed: ' + phase)
  }
  assert.notEqual(receipt.phases[0].actual.pid, receipt.phases[1].actual.pid)
  const first = JSON.parse(await readFile(join(out, 'first-receipt.json'))), second = JSON.parse(await readFile(join(out, 'second-receipt.json')))
  assert.deepEqual(second.durable.recovered, first.durable.saved)
  assert.deepEqual(second.durable.afterDeletion.entries, [])
  receipt.behaviorPassed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  server?.close()
  for (const row of receipt.source.inputs) if (hash(await readFile(resolve(repo, row.sourcePath))) !== (row.expectedLiveOriginalSha256 ?? row.sha256)) receipt.source.drift.push(row.sourcePath)
  if (receipt.source.drift.length) receipt.behaviorPassed = false
  await rm(scratch, { recursive: true }); receipt.ownedTemporaryRemoved = true
  const otherBytes = await bytesIn(out)
  receipt.evidenceBytes = otherBytes
  for (let i = 0; i < 12; i++) {
    const total = otherBytes + Buffer.byteLength(JSON.stringify(receipt))
    if (total > receipt.evidenceLimit) { receipt.behaviorPassed = false; receipt.evidenceOverBudget = true }
    if (receipt.evidenceBytes === total) break
    receipt.evidenceBytes = total
  }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt))
  assert.equal(receipt.evidenceBytes, await bytesIn(out), 'Final actual evidence budget includes the original receipt')
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, behaviorPassed: receipt.behaviorPassed, taskComplete: false, scope: receipt.scope, evidenceBytes: receipt.evidenceBytes, sourceInputs: receipt.source.inputs.length, sourceDrift: receipt.source.drift, receipt: join(out, 'receipt.json'), failure: receipt.failure?.message }) + '\n')
process.exitCode = receipt.behaviorPassed ? 0 : 1
