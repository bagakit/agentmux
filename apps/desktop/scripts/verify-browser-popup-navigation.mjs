import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const take = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
assert.ok(args.every((arg, index) => ['--receipt', '--prepare-only', '--baseline-only', '--capture-handoff', '--capture-app'].includes(arg) || ['--receipt', '--capture-app'].includes(args[index - 1])), 'Unsupported popup proof option')
const captureHandoff = args.includes('--capture-handoff')
assert.ok(!captureHandoff || !args.includes('--baseline-only'), 'Capture-only handoff is a separate bounded observation')
assert.ok(!args.includes('--capture-app') || captureHandoff && take('--capture-app') && !take('--capture-app').startsWith('--'), 'A private capture executable is only accepted for capture-only observation')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')))
const { build: esbuild, transform } = createRequire(require.resolve('vite/package.json'))('esbuild')
const sha = value => createHash('sha256').update(value).digest('hex')
const base = join(root, '.tmp/browser-popup-navigation'); await mkdir(base, { recursive: true })
const out = await mkdtemp(join(base, 'attempt-')), compiled = join(out, 'compiled')
const receiptFile = take('--receipt') ? resolve(take('--receipt')) : join(out, 'receipt.json')
try { await stat(receiptFile); throw new Error('Keep the original receipt; choose another explicit output') } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(dirname(receiptFile), { recursive: true }); await mkdir(compiled)
const fixture = 'apps/desktop/scripts/fixtures/browser-popup-navigation/main.ts'
const owners = ['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-popup-windows.ts',
  'apps/desktop/src/preload/browser-popup.ts', 'apps/desktop/src/shared/browser-popup-navigation.ts',
  'apps/desktop/src/renderer/browser-popup.html', 'apps/desktop/src/renderer/src/browser-popup/entry.tsx',
  'apps/desktop/src/renderer/src/browser-popup/popup.css']
const receipt = { schema: 'agentmux.browser-popup-navigation.proof.v1', candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  passed: false, behaviorPassed: false, mode: captureHandoff ? 'capture-handoff' : 'behavior', visualReview: 'required', out, sources: {}, externalInputs: {}, bundles: {}, runs: [], images: [],
  driverSha256: sha(await readFile(import.meta.filename)),
  boundary: 'Actual isolated BVM/native child/dedicated preload/navigation Renderer. No Runtime or user App. Full native window PNGs are kept as actual captures, never synthetic composites; independent review decides visible composition and aesthetics. This command does not certify OS input/default handler, installation or full-App recovery.' }
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
const mutations = {
  'omit-navigation': { file: 'apps/desktop/src/main/browser-popup-windows.ts',
    from: 'await this.load(popup, url)', to: '/* Private proof drops the actual original-page navigation dispatch. */' },
  'omit-native-continuation': { file: 'apps/desktop/src/main/browser-popup-windows.ts',
    from: 'request.navigate(page)', to: '/* Private proof drops the original Chromium continuation. */' },
  'undefined-webcontents': { file: 'apps/desktop/src/main/browser-popup-windows.ts',
    from: '...(guest ? { webContents: guest } : {})', to: 'webContents: guest' }
}
const sourcePlugin = mutationName => ({ name: 'actual-popup-inputs', enforce: 'pre',
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
      const changed = code.replace(mutation.from, mutation.to)
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
try {
  for (const file of [...owners, fixture]) await bind(join(root, file))
  const ts = require('typescript'), fixtureText = await readFile(join(root, fixture), 'utf8')
  const tree = ts.createSourceFile(fixture, fixtureText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const embedded = []
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'executeJavaScript') {
      const value = node.arguments[0]
      if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) embedded.push(value.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(embedded.length > 0, 'Static native consumer script syntax preflight is nonempty')
  for (const code of embedded) await transform(code, { loader: 'js' })
  if (process.platform === 'darwin') {
    const source = join(root, 'apps/desktop/scripts/fixtures/browser-contextual-composer/native-window.swift'), binary = join(compiled, 'native-window')
    await bind(source)
    try {
      execFileSync('/usr/bin/xcrun', ['swiftc', source, '-o', binary], { timeout: 30000, stdio: 'pipe' })
      receipt.bundles.nativeObserver = { file: binary, sha256: sha(await readFile(binary)), source: relative(root, source) }
    } catch (error) {
      receipt.nativeObserverUnavailable = { reason: 'Exact native observer build was unavailable; behavior proof remains independent', message: String(error) }
    }
  }
  const preload = join(compiled, 'browser-popup.cjs')
  const preloadBuild = await esbuild({ entryPoints: [join(root, 'apps/desktop/src/preload/browser-popup.ts')], outfile: preload,
    bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['electron'], metafile: true, logLevel: 'error',
    plugins: [{ name: 'actual-popup-preload', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\// }, args => { for (const alias of aliases) if (alias.find.test(args.path)) return { path: args.path.replace(alias.find, alias.replacement) } })
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
        await bind(path); return { contents: await readFile(path, 'utf8'), loader: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'js' }
      })
    } }] })
  assert.ok(Object.values(preloadBuild.metafile.outputs).every(output => output.imports.every(input => input.path === 'electron')), 'Dedicated sandbox preload external imports are only Electron')
  receipt.bundles.preload = { file: preload, sha256: sha(await readFile(preload)) }
  await build({ configFile: false, root: join(root, 'apps/desktop/src/renderer'), base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: aliases, dedupe: ['react', 'react-dom'] },
    plugins: [{ ...sourcePlugin(false), resolveId: undefined, resolveImportMeta: undefined }],
    css: { postcss: { plugins: [{ postcssPlugin: 'actual-popup-css', async OnceExit(_sheet, { result }) {
      for (const message of result.messages) if (message.type === 'dependency' && typeof message.file === 'string') await bind(message.file)
    } }] } },
    build: { minify: false, outDir: join(compiled, 'renderer'), rollupOptions: { input: join(root, 'apps/desktop/src/renderer/browser-popup.html') } } })
  receipt.bundles.renderer = { directory: join(compiled, 'renderer'), files: await collect(join(compiled, 'renderer')) }
  const variants = args.includes('--baseline-only') || captureHandoff ? ['source'] : ['source', ...Object.keys(mutations)]
  for (const variant of variants) {
    const directory = join(compiled, variant)
    await build({ configFile: false, root, logLevel: 'error', ssr: { noExternal: true }, resolve: { alias: aliases }, plugins: [sourcePlugin(variant)],
      build: { ssr: true, outDir: directory, minify: false, rollupOptions: { input: join(root, fixture), external: id => id === 'electron' || isBuiltin(id),
        output: { entryFileNames: 'main.mjs', format: 'es', banner: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" } } } })
    const file = join(directory, 'main.mjs'); receipt.bundles[variant] = { file, sha256: sha(await readFile(file)) }
  }
  assert.ok(Object.keys(receipt.sources).length > owners.length, 'Actual Main/Renderer/preload sources are nonempty')
  await currentSources(); await writeFile(join(out, 'prepared.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (args.includes('--prepare-only')) { receipt.prepared = true; await save(); console.log(JSON.stringify({ prepared: true, receipt: receiptFile })); process.exit(0) }
  const executable = take('--capture-app') ? resolve(take('--capture-app')) : require('electron')
  assert.equal((await stat(executable)).isFile(), true, '--capture-app names the private native executable, not its App directory')
  receipt.engine = { executable, sha256: sha(await readFile(executable)), version: require('electron/package.json').version,
    captureOverride: Boolean(take('--capture-app')), versionSource: 'Installed stock Electron package; private App clone provenance belongs to its producer' }
  for (const label of captureHandoff ? ['capture-handoff'] : args.includes('--baseline-only') ? ['baseline'] : ['baseline', 'omit-native-continuation', 'undefined-webcontents', 'omit-navigation', 'restored']) {
    const directory = join(out, label); await mkdir(directory)
    const privateRoot = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'amx-popup-'))
    const main = receipt.bundles[label in mutations ? label : 'source'].file
    const bootstrap = join(privateRoot, 'bootstrap.cjs')
    await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(privateRoot)};for(const key of ['home','appData','userData','sessionData']){const value=path.join(root,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.commandLine.appendSwitch('no-proxy-server');app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(main).href)})).catch(e=>{console.error(e);app.exit(1)});`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { HOME: join(privateRoot, 'home'), XDG_CACHE_HOME: join(privateRoot, 'cache'), XDG_CONFIG_HOME: join(privateRoot, 'config'), XDG_DATA_HOME: join(privateRoot, 'data'),
      AGENTMUX_POPUP_HOME: privateRoot, AGENTMUX_POPUP_OUT: directory, AGENTMUX_POPUP_ASSETS: compiled, AGENTMUX_POPUP_IMAGES: label === 'baseline' ? '1' : '0', ...(captureHandoff ? { AGENTMUX_POPUP_CAPTURE_HANDOFF: '1' } : {}), ...(receipt.bundles.nativeObserver ? { AGENTMUX_POPUP_NATIVE_OBSERVER: receipt.bundles.nativeObserver.file } : {}) })
    const row = { label, privateRoot, process: null, actual: null, native: null, remaining: null }
    receipt.runs.push(row); await save()
    const logs = []
    try { row.process = await runProbeProcess(executable, [bootstrap], { cwd: privateRoot, env, timeoutMs: captureHandoff ? 370000 : 60000, onLine: line => logs.push(line) }) }
    catch (error) { row.process = error.probe; row.processError = { name: error.name, message: error.message }; throw error }
    finally {
      await writeFile(join(directory, 'process.log'), logs.join('\n'))
      await writeFile(join(directory, 'process.json'), JSON.stringify(row.process, null, 2) + '\n'); await save()
      if (row.process?.originalPid) { await stopProbeProcesses(row.process.originalPid, privateRoot); row.remaining = await listProbeProcesses(row.process.originalPid, privateRoot) }
      if (row.process?.exitConfirmed && row.remaining?.length === 0) {
        let noOpenFiles = false
        try {
          const open = execFileSync('lsof', ['+D', privateRoot], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' })
          row.privateDataCleanup = { removed: false, reason: 'Open files remain in the exact private root', open }
        } catch (error) {
          if (error.status === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) noOpenFiles = true
          else row.privateDataCleanup = { removed: false, reason: 'Open-file observation is unavailable', error: String(error) }
        }
        if (noOpenFiles) {
          await rm(privateRoot, { recursive: true }); row.privateDataRemoved = true
          row.privateDataCleanup = { removed: true, exitConfirmed: true, remaining: [], openFiles: [] }
        }
      }
      await save()
    }
    const bytes = await readFile(join(directory, 'native.json')), actual = JSON.parse(bytes)
    row.actual = actual; row.native = { file: join(directory, 'native.json'), sha256: sha(bytes) }; await save()
    assert.equal(row.process.timedOut, false, 'A native timeout is not owning AssertionRED')
    assert.equal(row.process.exitSignal, null); assert.equal(row.process.exitConfirmed, true); assert.deepEqual(row.remaining, [])
    assert.equal(actual.cleanupComplete, true); assert.deepEqual(actual.cleanup, [])
    if (label === 'omit-navigation' || label === 'omit-native-continuation' || label === 'undefined-webcontents') {
      assert.equal(row.process.exitCode, 1); assert.equal(actual.failure?.name, 'AssertionError')
      if (label === 'undefined-webcontents') {
        assert.ok(actual.failure.message.includes('Actual native popup construction succeeds'), 'Actual original constructor exception reaches its owning assertion')
        assert.ok(actual.constructionFailures?.some(row => row.name === 'TypeError' && row.message === 'options.webContents must be a WebContents'), 'Original undefined WebContents regression reproduces its exact native TypeError')
        assert.ok(actual.uncaughtExceptions?.some(row => row.name === 'TypeError' && row.message === 'options.webContents must be a WebContents'), 'Original native exception is observed before the private fixture suppresses its modal dialog')
        row.owningAssertion = 'OriginalExceptionRED'
      } else {
        assert.ok(actual.failure.message.includes(label === 'omit-navigation' ? 'Actual navigation dispatch changes the original child URL' : 'Actual native continuation navigates the original guestless child URL'), 'Actual navigation owning AssertionRED')
        row.owningAssertion = 'AssertionRED'
      }
    } else {
      assert.equal(row.process.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true)
      assert.equal(actual.cases.length, captureHandoff ? 1 : 15, 'All nonempty original-protocol/navigation cases ran')
      assert.ok(actual.calls.length > 0); assert.ok(actual.originalCallbacks?.length > 0, 'The real BVM callback options are nonempty');
      const supplied = actual.originalCallbacks.filter(row => row.guestId !== null)
      assert.ok(supplied.length > 0); assert.equal(supplied.every(row => row.exactGuest && row.sameSession), true)
      if (!captureHandoff) {
        assert.equal(actual.nativeLinkObservations.length, 5, 'All native guestless input variants are nonempty')
        assert.equal(actual.nativeLinkObservations.every(row => row.callback.guestId === null && row.events.length === 1 && row.actualURL === row.target), true)
        assert.deepEqual(actual.uncaughtExceptions ?? [], [])
      }
      assert.equal(actual.runtimeConnections, 0); assert.equal(actual.clipboardWrites, 0)
      if (label === 'baseline') {
        if (!actual.visualUnavailable) assert.equal(actual.images.length, 6, 'Normal/narrow/short in light and dark actual OS window images are nonempty')
        else receipt.visualUnavailable = actual.visualUnavailable
        for (const image of actual.images) { const file = join(directory, image.file); assert.equal(sha(await readFile(file)), image.sha256); receipt.images.push({ ...image, file }) }
      }
    }
    await save()
  }
  await currentSources()
  receipt.behaviorPassed = !captureHandoff
  receipt.captureCompleted = captureHandoff
  receipt.passed = !captureHandoff && !args.includes('--baseline-only') && receipt.images.length === 6
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  process.exitCode = 1
} finally { await save() }
console.log(JSON.stringify({ passed: receipt.passed, behaviorPassed: receipt.behaviorPassed, visualReview: receipt.visualReview, receipt: receiptFile }))
