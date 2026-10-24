import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const take = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
assert.ok(args.every((arg, index) => ['--receipt', '--prepare-only', '--baseline-only', '--prepared', '--ui-receipt', '--visual-review'].includes(arg) || ['--receipt', '--prepared', '--ui-receipt', '--visual-review'].includes(args[index - 1])), 'Unsupported unified child proof option')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')))
const { build: esbuild, transform } = createRequire(require.resolve('vite/package.json'))('esbuild')
const sha = value => createHash('sha256').update(value).digest('hex')
const base = join(root, '.tmp/unified-browser-children'); await mkdir(base, { recursive: true })
const latestFile = join(base, 'latest.json'), reviewFile = take('--visual-review') ? resolve(take('--visual-review')) : join(base, 'visual-review.json')
const development = args.includes('--baseline-only') || args.includes('--prepare-only')
const out = await mkdtemp(join(base, 'attempt-')), compiled = join(out, 'compiled')
const receiptFile = take('--receipt') ? resolve(take('--receipt')) : join(out, 'receipt.json')
try { await stat(receiptFile); throw new Error('Keep the original receipt; choose another explicit output') } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(dirname(receiptFile), { recursive: true }); await mkdir(compiled)
const fixture = 'apps/desktop/scripts/fixtures/unified-browser-children/main.ts'
const owners = ['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-native-windows.ts', 'apps/desktop/src/main/browser-page-dispatch.ts',
  'apps/desktop/src/main/browser-cdp-session.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/src/store.ts', 'packages/core/src/control-browser-targets.ts', 'packages/core/src/agentmux.ts']
const receipt = { schema: 'agentmux.unified-browser-children.proof.v1', candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  passed: false, behaviorPassed: false, mode: 'native-owner-public-consumers', visualReview: 'separate-UI-proof-required', out, sources: {}, externalInputs: {}, bundles: {}, runs: [], images: [],
  driverSha256: sha(await readFile(import.meta.filename)),
  boundary: 'Actual isolated BVM/native child, original Chromium requests, actual Store/preload/Main consumers over Electron IPC, Core public RPC and freshly compiled CLI. No user Runtime or installed App. This owner proof does not certify full BrowserPane/native shell composition, physical OS input, installation or recovery; those retain separate evidence.' }
const save = () => writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
const bind = async id => {
  const file = id.split('?')[0]
  if (!isAbsolute(file)) return
  const bytes = await readFile(file).catch(error => { if (error.code !== 'EISDIR') throw error })
  if (!bytes) return
  const digest = sha(bytes), internal = file.startsWith(root + '/') && !file.includes('/node_modules/')
  const key = internal ? relative(root, file) : file, target = internal ? receipt.sources : receipt.externalInputs
  assert.ok(!target[key] || target[key] === digest, 'A consumed source cannot drift while building: ' + key)
  target[key] = digest
}
const aliases = []
for (const item of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!item.isDirectory()) continue
  const folder = join(root, 'packages', item.name)
  let pkg
  try { pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
  for (const [key, exported] of Object.entries(pkg.exports ?? {})) {
    const target = typeof exported === 'string' ? exported : exported.browser ?? exported.import
    if (typeof target !== 'string') continue
    const name = pkg.name + (key === '.' ? '' : key.slice(1)), wildcard = name.includes('*')
    let replacement = resolve(folder, target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    if (!wildcard) {
      try { await stat(replacement) } catch {
        replacement = replacement.replace(/\.ts$/u, '.tsx')
        try { await stat(replacement) } catch { continue }
      }
    }
    aliases.push({ name, wildcard, find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$'), replacement: replacement.replace('*', '$1') })
  }
}
aliases.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.name.length - a.name.length)
const expectedCaseNames = [
  'native-command-and-middle-original-request-session-security', 'native-target-blank-noopener',
  'native-sandbox-frame-retains-original-restrictions', 'native-guestless-nested-source-lifecycle-exactly-once',
  'normal-original-opener-session-postmessage', 'aboutblank-original-synchronous-document',
  'guestful-native-child-javascript-disabled', 'native-form-post-and-referrer',
  'same-browser-owner-navigation-history-reload', 'native-navigation-beforeunload-does-not-close-child',
  'original-native-child-beforeunload-stay-and-leave', 'nested-original-policy-and-script-close',
  'same-browser-native-auth-owner-pending-and-navigation-cancel', 'native-private-child-close-preserves-parent-session',
  'private-original-session-and-owner-close', 'actual-child-owner-standard-ref-run',
  'actual-public-rpc-child-discovery-and-run', 'actual-public-cli-child-discovery-source-and-run'
]
const mutations = {
  'omit-native-continuation': { file: 'apps/desktop/src/main/browser-native-windows.ts', from: 'request.navigate(page)', to: '/* proof removes original native continuation */', expected: 'Actual native continuation navigates the original guestless child URL' },
  'undefined-webcontents': { file: 'apps/desktop/src/main/browser-view-manager.ts', from: '...(guest ? { webContents: guest } : {})', to: 'webContents: guest', expected: 'Actual native child construction succeeds without the undefined-WebContents exception' },
  'navigation-veto-becomes-close': { file: 'apps/desktop/src/main/browser-view-manager.ts', from: 'if (entry.nativeChild?.closing && this.owns(entry, view)) void this.confirmNativeChildClose(entry, view)', to: 'if (entry.nativeChild && this.owns(entry, view)) { if (!entry.nativeChild.closing) void this.closeNativeChild(entry).catch(() => {}); void this.confirmNativeChildClose(entry, view) }', expected: 'A navigation beforeunload never becomes a child Close confirmation' },
  'private-child-clears-parent': { file: 'apps/desktop/src/main/browser-view-manager.ts', from: 'if (entry?.nativeChild) return this.closeNativeChild(entry).then(closed => {', to: "if (entry?.nativeChild && entry.storage.mode !== 'private') return this.closeNativeChild(entry).then(closed => {", expected: 'Closing one private child preserves the original parent native page' },
  'omit-child-catalog': { file: 'apps/desktop/src/main/browser-view-manager.ts', from: 'return [...this.entries.values()].map(entry => this.projectTarget(entry))', to: 'return [...this.entries.values()].filter(entry => !entry.source).map(entry => this.projectTarget(entry))', expected: 'Every native child joins the actual Browser target catalog exactly once' },
  'omit-public-source': { file: 'packages/core/src/control-browser-targets.ts', from: '...(row.openedFrom === undefined ? {} : { openedFrom: parseBrowserSource(row.openedFrom) }),', to: '/* proof drops the original child source at the actual public receiving edge */', expected: 'Public RPC preserves the original child source relationship' },
  'omit-cli-page-effect': { file: 'apps/desktop/src/main/browser-page-dispatch.ts', from: '          expression,\n          awaitPromise: true,', to: "          expression: 'undefined',\n          awaitPromise: true,", expected: 'Public CLI dispatch mutates the exact original child' }
}
function applyMutation(code, name) {
  const mutation = mutations[name]
  if (!mutation) return code
  assert.equal(code.split(mutation.from).length, 2, 'One actual production mutation anchor: ' + name)
  return code.replace(mutation.from, mutation.to)
}
async function consumers(variant, directory) {
  const ts = require('typescript')
  const paths = { main: 'apps/desktop/src/main/ipc.ts', preload: 'apps/desktop/src/preload/index.ts', store: 'apps/desktop/src/renderer/src/store.ts' }
  const source = {}, parsed = {}
  for (const [kind, file] of Object.entries(paths)) {
    await bind(join(root, file)); const text = await readFile(join(root, file), 'utf8')
    source[kind] = mutations[variant]?.file === file ? applyMutation(text, variant) : text
    parsed[kind] = ts.createSourceFile(file, source[kind], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  }
  const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const main = [], preload = {}, store = []
  const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)) }
  walk(parsed.main, node => {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return
    const call = node.expression, first = call.arguments[0]
    if (call.expression.getText(parsed.main) === 'handleWithEvent' && first && ts.isStringLiteral(first) && ['browser:listTargets', 'browser:runScript'].includes(first.text)) main.push(node.getText(parsed.main))
  })
  walk(parsed.preload, node => {
    if (ts.isPropertyAssignment(node) && ['listTargets', 'runScript'].includes(node.name.getText(parsed.preload)) && node.initializer.getText(parsed.preload).includes("ipcRenderer.invoke('browser:")) {
      assert.ok(!preload[node.name.getText(parsed.preload)], 'One actual preload mapping per consumer')
      preload[node.name.getText(parsed.preload)] = node.initializer.getText(parsed.preload)
    }
  })
  walk(parsed.store, node => {
    if (!ts.isIfStatement(node) || !ts.isBinaryExpression(node.expression)) return
    const expression = node.expression
    if (expression.left.getText(parsed.store) === 'request.operation' && ts.isStringLiteral(expression.right) && ['browser.targets', 'browser.run'].includes(expression.right.text)) store.push(node.getText(parsed.store))
  })
  assert.equal(main.length, 2, 'Actual production Main registrations are nonempty and unique')
  assert.deepEqual(Object.keys(preload).sort(), ['listTargets', 'runScript'])
  assert.equal(store.length, 2, 'Actual production Store branches are nonempty and unique')
  const actual = { main: compile(main.join('\n')), store: compile(store.join('\n')), sources: Object.fromEntries(Object.values(paths).map(file => [file, sha(source[Object.keys(paths).find(key => paths[key] === file)])])) }
  await writeFile(join(directory, 'consumers.json'), JSON.stringify(actual, null, 2))
  const bridge = compile(`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('unifiedBrowserProof',{${Object.entries(preload).map(([name,value])=>name+':'+value).join(',')}})`)
  await writeFile(join(directory, 'preload.cjs'), bridge)
  return { consumers: sha(JSON.stringify(actual)), preload: sha(bridge) }
}
const sourcePlugin = mutationName => ({ name: 'actual-unified-child-inputs', enforce: 'pre',
  async resolveId(id, importer) {
    if (!importer || id.startsWith('.') || isAbsolute(id) || id.startsWith('\0') || isBuiltin(id) || id === 'electron' || id.startsWith('@agentmux/')) return
    const found = await this.resolve(id, importer, { skipSelf: true })
    if (found && isAbsolute(found.id) && found.id.includes('/node_modules/')) { await bind(found.id); return { id: found.id, external: true } }
  },
  resolveImportMeta(property, { moduleId }) {
    if (!isAbsolute(moduleId)) return
    if (property === 'url') return JSON.stringify(pathToFileURL(moduleId).href)
    if (property === 'filename') return JSON.stringify(moduleId)
    if (property === 'dirname') return JSON.stringify(dirname(moduleId))
  },
  async transform(code, id) {
    if (!id.startsWith(root + '/') || id.includes('/node_modules/')) return
    await bind(id)
    const mutation = mutations[mutationName]
    if (mutation && id.split('?')[0] === join(root, mutation.file)) {
      assert.equal(code.split(mutation.from).length, 2, 'One actual original mutation anchor: ' + mutationName)
      const changed = applyMutation(code, mutationName)
      await transform(changed, { loader: 'ts' })
      ;(receipt.mutations ??= {})[mutationName] = { ...mutation, before: sha(code), after: sha(changed) }
      return { code: changed, map: null }
    }
  }
})
async function collect(folder) {
  const files = {}
  async function walk(directory) { for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, item.name)
    if (item.isDirectory()) await walk(file)
    else files[relative(folder, file)] = sha(await readFile(file))
  } }
  await walk(folder); return files
}
async function currentSources() {
  for (const [file, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(join(root, file))), digest, 'Actual source stays the consumed candidate: ' + file)
  for (const [file, digest] of Object.entries(receipt.externalInputs)) assert.equal(sha(await readFile(file)), digest, 'Actual external input stays the consumed candidate: ' + file)
}
async function fileRef(file) { file = resolve(file); return { file, sha256: sha(await readFile(file)) } }
async function readRef(ref) {
  assert.ok(ref && typeof ref.file === 'string' && /^[a-f0-9]{64}$/u.test(ref.sha256), 'An evidence index contains exact file and SHA-256')
  const bytes = await readFile(ref.file)
  assert.equal(sha(bytes), ref.sha256, 'Original evidence remains byte-identical: ' + ref.file)
  return JSON.parse(bytes)
}
async function sourceMapCurrent(sources) {
  assert.ok(sources && Object.keys(sources).length > 0, 'Evidence binds nonempty current candidate sources')
  for (const [file, digest] of Object.entries(sources)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Evidence consumes the current candidate: ' + file)
}
async function validateNative(actual) {
  assert.equal(actual.schema, receipt.schema)
  assert.equal(actual.nativeBehaviorPassed ?? actual.behaviorPassed, true)
  assert.equal(actual.driverSha256, receipt.driverSha256, 'Reuse only the current canonical proof driver')
  await sourceMapCurrent(actual.sources)
  for (const [file, digest] of Object.entries(actual.externalInputs)) assert.equal(sha(await readFile(file)), digest, 'Native external input remains current: ' + file)
  assert.deepEqual(actual.runs.map(row => row.label), ['baseline', ...Object.keys(mutations), 'restored'], 'Reuse the complete baseline/mutation/restored proof')
  for (const row of actual.runs) {
    assert.equal(row.process.exitConfirmed, true); assert.equal(row.process.timedOut, false); assert.deepEqual(row.remaining, [])
    assert.equal(row.actual.cleanupComplete, true); assert.deepEqual(row.actual.cleanup, [])
    assert.equal(row.actual.runtimeConnections, 0); assert.equal(row.actual.clipboardWrites, 0)
    if (row.label in mutations) {
      assert.equal(row.owningAssertion, 'AssertionRED'); assert.equal(row.process.exitCode, 1)
      assert.equal(row.actual.failure?.name, 'AssertionError'); assert.ok(row.actual.failure.message.includes(mutations[row.label].expected))
    } else {
      assert.equal(row.process.exitCode, 0); assert.equal(row.actual.passed, true)
      assert.deepEqual(row.actual.cases.map(one => one.name), expectedCaseNames)
    }
    assert.equal(sha(await readFile(row.native.file)), row.native.sha256, 'Original native receipt remains bound')
  }
}
async function validateUI(ui, file) {
  assert.equal(ui.schema, 'agentmux.unified-browser-children-ui.v1'); assert.equal(ui.passed, true)
  assert.deepEqual(ui.sourceBefore, ui.sourceAfter); await sourceMapCurrent(ui.sourceBefore)
  assert.deepEqual(ui.renderer.inputs, ui.rendererInputsAfter); await sourceMapCurrent(ui.renderer.inputs)
  assert.deepEqual(ui.phases.map(row => row.phase), ['seed', 'restore'])
  assert.equal(new Set(ui.phases.map(row => row.native.pid)).size, 2, 'UI evidence contains an actual process restart')
  for (const phase of ui.phases) {
    assert.equal(phase.exit.timedOut, false); assert.equal(phase.exit.exitCode, 0); assert.equal(phase.native.passed, true)
  }
  assert.deepEqual(ui.cleanup.remaining, []); assert.equal(ui.cleanup.privateRootRemoved, true)
  assert.ok(ui.images.length > 0, 'Actual UI images are nonempty')
  for (const one of ui.images) assert.equal(sha(await readFile(resolve(dirname(file), one.filename))), one.sha256, 'Original UI screenshot remains byte-identical: ' + one.filename)
}
async function composeUI(latest, nativeRef) {
  let uiRef, ui
  if (take('--ui-receipt')) { uiRef = await fileRef(take('--ui-receipt')); ui = await readRef(uiRef); await validateUI(ui, uiRef.file) }
  else if (latest?.uiReceipt) {
    try { ui = await readRef(latest.uiReceipt); await validateUI(ui, latest.uiReceipt.file); uiRef = latest.uiReceipt }
    catch (error) { receipt.uiReuseRejected = error.message }
  }
  if (!uiRef) {
    const directory = join(out, 'ui'), logs = []
    const processReceipt = await runProbeProcess(process.execPath, [join(root, 'apps/desktop/scripts/verify-unified-browser-children-ui.mjs'), directory], {
      cwd: root, timeoutMs: 180000, onLine: line => logs.push(line)
    })
    await writeFile(join(out, 'ui-driver.log'), logs.join('\n'))
    assert.equal(processReceipt.timedOut, false, 'UI driver does not time out'); assert.equal(processReceipt.exitCode, 0, logs.join('\n'))
    uiRef = await fileRef(join(directory, 'receipt.json')); ui = await readRef(uiRef); await validateUI(ui, uiRef.file)
    receipt.uiProcess = processReceipt
  }
  receipt.ui = { ...uiRef, behaviorPassed: true, captureOnly: ui.captureOnly, aestheticReview: ui.aestheticReview }
  receipt.images = ui.images.map(one => ({ ...one, file: resolve(dirname(uiRef.file), one.filename) }))
  receipt.behaviorPassed = true; receipt.visualReview = 'independent-review-required'
  let visualRef
  try {
    visualRef = take('--visual-review') || !latest?.visualReviewReceipt ? await fileRef(reviewFile) : latest.visualReviewReceipt
    const review = await readRef(visualRef)
    assert.equal(review.schema, 'agentmux.unified-browser-children.visual-review.v1')
    assert.equal(review.origin, 'independent-agent-review'); assert.equal(review.passed, true)
    assert.ok(typeof review.reviewer === 'string' && review.reviewer.length > 0, 'An independent reviewer is identified')
    assert.deepEqual(review.uiReceipt, uiRef); assert.deepEqual(review.source, ui.sourceBefore)
    assert.deepEqual(review.images, ui.images.map(({ filename, sha256 }) => ({ filename, sha256 })), 'Independent review binds every actual UI screenshot')
    receipt.visualReview = { ...visualRef, reviewer: review.reviewer, passed: true }; receipt.passed = true
  } catch (error) {
    receipt.pendingReview = { file: visualRef?.file ?? reviewFile, reason: error.message }; process.exitCode = 1
  }
  await writeFile(latestFile, JSON.stringify({ schema: 'agentmux.unified-browser-children.index.v1', nativeReceipt: nativeRef, uiReceipt: uiRef, visualReviewReceipt: receipt.passed ? visualRef : null }, null, 2) + '\n')
}
try {
  let latest, nativeRef, native
  if (!development) {
    try {
      latest = JSON.parse(await readFile(latestFile, 'utf8'))
      assert.equal(latest.schema, 'agentmux.unified-browser-children.index.v1')
      native = await readRef(latest.nativeReceipt); await validateNative(native); nativeRef = latest.nativeReceipt
    } catch (error) { receipt.nativeReuseRejected = error.message }
  }
  if (nativeRef) {
    for (const key of ['sources', 'externalInputs', 'bundles', 'runs', 'engine', 'mutations']) receipt[key] = native[key]
    receipt.nativeReuse = nativeRef
  } else {
  let prepared
  if (take('--prepared')) {
    const preparedFile = resolve(take('--prepared'))
    prepared = JSON.parse(await readFile(preparedFile, 'utf8'))
    assert.equal(prepared.schema, receipt.schema, 'Reuse only this native proof schema')
    assert.ok(prepared.bundles.source, 'Prepared source assets are present')
    assert.deepEqual(await collect(prepared.bundles.source.directory), prepared.bundles.source.files, 'Retained prepared assets remain byte-identical')
    for (const [file, digest] of Object.entries(prepared.sources)) {
      if (file === fixture) continue // Recompile this bounded test-host change below.
      assert.equal(sha(await readFile(join(root, file))), digest, 'Reuse only the unchanged production candidate: ' + file)
      receipt.sources[file] = digest
    }
    for (const [file, digest] of Object.entries(prepared.externalInputs)) {
      assert.equal(sha(await readFile(file)), digest, 'Reuse only unchanged external inputs: ' + file)
      receipt.externalInputs[file] = digest
    }
    receipt.preparedFrom = { file: preparedFile, sha256: sha(await readFile(preparedFile)), originalDriver: prepared.driverSha256, recompiledFixture: fixture }
  }
  for (const file of [...owners, fixture]) await bind(join(root, file))
  const variants = args.includes('--baseline-only') ? ['source'] : ['source', ...Object.keys(mutations)]
  for (const variant of variants) {
    const directory = join(compiled, variant)
    await mkdir(directory, { recursive: true })
    const consumption = await consumers(variant, directory)
    await build({ configFile: false, root, logLevel: 'error', ssr: { noExternal: true }, resolve: { alias: aliases }, plugins: [sourcePlugin(variant)],
      build: { ssr: true, outDir: join(directory, 'native'), minify: false, rollupOptions: { input: join(root, fixture), external: id => id === 'electron' || isBuiltin(id),
        output: { entryFileNames: 'main.mjs', format: 'es', banner: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" } } } })
    const sourceCLI = prepared?.bundles.source.directory ?? (variant === 'source' ? undefined : join(compiled, 'source'))
    if (sourceCLI && mutations[variant]?.file !== 'packages/core/src/control-browser-targets.ts') {
      await cp(join(sourceCLI, 'cli'), join(directory, 'cli'), { recursive: true })
    } else await build({ configFile: false, root, logLevel: 'error', ssr: { noExternal: true }, resolve: { alias: aliases }, plugins: [sourcePlugin(variant)],
      build: { ssr: true, outDir: join(directory, 'cli'), minify: false, rollupOptions: { input: join(root, 'packages/core/src/agentmux.ts'), external: id => isBuiltin(id),
        output: { entryFileNames: 'agentmux.mjs', format: 'es', banner: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" } } } })
    receipt.bundles[variant] = { directory, consumption, files: await collect(directory) }
  }
  assert.ok(Object.keys(receipt.sources).length > owners.length, 'Actual native and public consumer sources are nonempty')
  await currentSources()
  if (args.includes('--prepare-only')) { receipt.prepared = true; await save(); console.log(JSON.stringify({ prepared: true, receipt: receiptFile })); process.exit(0) }
  const executable = require('electron')
  receipt.engine = { executable, sha256: sha(await readFile(executable)), version: require('electron/package.json').version }
  for (const label of args.includes('--baseline-only') ? ['baseline'] : ['baseline', ...Object.keys(mutations), 'restored']) {
    const directory = join(out, label); await mkdir(directory)
    const privateRoot = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'amx-child-'))
    const assets = receipt.bundles[label in mutations ? label : 'source'].directory
    const bootstrap = join(privateRoot, 'bootstrap.cjs')
    await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(privateRoot)},out=${JSON.stringify(directory)};const stage=value=>fs.writeFileSync(path.join(out,'bootstrap.json'),JSON.stringify({stage:value,pid:process.pid}));stage('bootstrap-entered');for(const key of ['home','appData','userData','sessionData']){const value=path.join(root,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.commandLine.appendSwitch('no-proxy-server');app.whenReady().then(()=>{stage('app-ready');return import(${JSON.stringify(pathToFileURL(join(assets, 'native/main.mjs')).href)})}).catch(e=>{console.error(e);app.exit(1)});`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { HOME: join(privateRoot, 'home'), XDG_CACHE_HOME: join(privateRoot, 'cache'), XDG_CONFIG_HOME: join(privateRoot, 'config'), XDG_DATA_HOME: join(privateRoot, 'data'),
      AGENTMUX_CHILD_HOME: privateRoot, AGENTMUX_CHILD_OUT: directory, AGENTMUX_CHILD_ASSETS: assets, AGENTMUX_CHILD_NODE: process.execPath })
    const row = { label, privateRoot, process: null, actual: null, native: null, remaining: null }
    receipt.runs.push(row); await save()
    const logs = []
    try { row.process = await runProbeProcess(executable, [bootstrap], { cwd: privateRoot, env, timeoutMs: 90000, onLine: line => logs.push(line) }) }
    catch (error) { row.process = error.probe; row.processError = { name: error.name, message: error.message }; throw error }
    finally {
      await writeFile(join(directory, 'process.log'), logs.join('\n'))
      await writeFile(join(directory, 'process.json'), JSON.stringify(row.process, null, 2) + '\n')
      if (row.process?.originalPid) { await stopProbeProcesses(row.process.originalPid, privateRoot); row.remaining = await listProbeProcesses(row.process.originalPid, privateRoot) }
      if (row.process?.exitConfirmed && row.remaining?.length === 0) { await rm(privateRoot, { recursive: true }); row.privateDataCleanup = { removed: true, exitConfirmed: true, remaining: [] } }
      await save()
    }
    assert.equal(row.process.timedOut, false, 'Native proof process timed out; retain its bootstrap/receipt stage and exact process cleanup, not a behavior RED')
    const bytes = await readFile(join(directory, 'native.json')), actual = JSON.parse(bytes)
    row.actual = actual; row.native = { file: join(directory, 'native.json'), sha256: sha(bytes) }; await save()
    assert.equal(row.process.timedOut, false, 'A timeout is not an owning AssertionRED')
    assert.equal(row.process.exitSignal, null); assert.equal(row.process.exitConfirmed, true); assert.deepEqual(row.remaining, [])
    assert.equal(actual.cleanupComplete, true); assert.deepEqual(actual.cleanup, [])
    if (label in mutations) {
      assert.equal(row.process.exitCode, 1); assert.equal(actual.failure?.name, 'AssertionError')
      assert.ok(actual.failure.message.includes(mutations[label].expected), 'Mutation reaches its actual owning assertion: ' + label + ': ' + actual.failure?.message)
      row.owningAssertion = 'AssertionRED'
    } else {
      assert.equal(row.process.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true)
      assert.deepEqual(actual.cases.map(row => row.name), expectedCaseNames, 'Every original native behavior and actual public consumer ran')
      assert.ok(actual.calls.length > 0); assert.ok(actual.originalCallbacks.length > 0)
      const supplied = actual.originalCallbacks.filter(row => row.guestId !== null)
      assert.ok(supplied.length > 0); assert.equal(supplied.every(row => row.exactGuest && row.sameSession), true)
      assert.equal(actual.nativeLinkObservations.length, 5)
      assert.equal(actual.nativeLinkObservations.every(row => row.callback.guestId === null && row.events.length === 1 && row.actualURL === row.target), true)
      assert.deepEqual(actual.uncaughtExceptions ?? [], [])
      assert.equal(actual.runtimeConnections, 0); assert.equal(actual.clipboardWrites, 0)
    }
    await save()
  }
  await currentSources()
  }
  receipt.nativeBehaviorPassed = true
  if (development) receipt.behaviorPassed = true
  else {
    if (!nativeRef) {
      const nativeFile = join(out, 'native-owner.json')
      await writeFile(nativeFile, JSON.stringify({ ...receipt, behaviorPassed: true }, null, 2) + '\n'); nativeRef = await fileRef(nativeFile)
    }
    receipt.nativeEvidence = nativeRef
    // Preserve the completed native proof even if the subsequent UI observation
    // fails; a repeat must not rebuild an unchanged accepted native candidate.
    await writeFile(latestFile, JSON.stringify({ schema: 'agentmux.unified-browser-children.index.v1', nativeReceipt: nativeRef,
      uiReceipt: latest?.uiReceipt ?? null, visualReviewReceipt: latest?.visualReviewReceipt ?? null }, null, 2) + '\n')
    await composeUI(latest, nativeRef)
    await currentSources()
  }
} catch (error) { receipt.passed = false; receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await save() }
console.log(JSON.stringify({ passed: receipt.passed, behaviorPassed: receipt.behaviorPassed, visualReview: receipt.visualReview, receipt: receiptFile }))
