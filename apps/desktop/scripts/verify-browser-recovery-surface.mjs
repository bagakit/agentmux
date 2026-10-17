import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, readdir, stat, symlink, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const take = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
assert.ok(args.every((arg, index) => ['--receipt', '--reuse-renderer', '--baseline-only'].includes(arg) || ['--receipt', '--reuse-renderer'].includes(args[index - 1])), 'Unsupported recovery proof option')
const reuseFile = take('--reuse-renderer') ? resolve(take('--reuse-renderer')) : undefined
const reuseBytes = reuseFile ? await readFile(reuseFile) : undefined
const reuse = reuseBytes ? JSON.parse(reuseBytes) : undefined
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build: viteBuild } = await import(pathToFileURL(require.resolve('vite')))
const { build: esbuild, transform: syntaxTransform } = createRequire(require.resolve('vite/package.json'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const proofRoot = join(root, '.tmp/browser-recovery-surface')
await mkdir(proofRoot, { recursive: true })
const out = await mkdtemp(join(proofRoot, 'attempt-')), source = join(out, 'source')
const receiptFile = take('--receipt') ? resolve(take('--receipt')) : join(out, 'receipt.json')
try { await stat(receiptFile); throw new Error('Preserve the original proof receipt; choose a new output') } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(source, { recursive: true })
const fixture = 'apps/desktop/scripts/fixtures/browser-recovery-surface'
const ownerFiles = [
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/components/BrowserAddressInput.tsx',
  'apps/desktop/src/renderer/src/components/BrowserRecoverySurface.tsx',
  'apps/desktop/src/renderer/src/styles/browser.css',
  'apps/desktop/src/renderer/src/styles/browser-recovery-surface.css'
]
const observedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()
const candidate = reuse?.candidate ?? observedHead
if (reuse) {
  assert.equal(reuse.schema, 'agentmux.browser-recovery-surface.proof.v1')
  for (const file of ownerFiles) assert.equal(sha(await readFile(join(root, file))), reuse.overlays[file], 'Explicit reused Renderer retains the actual current recovery owner: ' + file)
}
const paths = ['package.json', 'apps/desktop/package.json', 'apps/desktop/src', 'apps/desktop/browser-extension', 'apps/desktop/resources']
for (const name of await readdir(join(root, 'packages'))) for (const leaf of ['src', 'package.json']) {
  const file = 'packages/' + name + '/' + leaf
  try { execFileSync('git', ['cat-file', '-e', candidate + ':' + file], { cwd: root, stdio: 'pipe' }); paths.push(file) } catch { /* Only existing candidate packages. */ }
}
execFileSync('tar', ['-x', '-C', source], { input: execFileSync('git', ['archive', candidate, ...paths], { cwd: root, maxBuffer: 128 * 1024 * 1024 }) })
const overlays = {}
for (const file of [...ownerFiles, ...['main.ts', 'renderer.tsx', 'fixture.css', 'index.html'].map(name => fixture + '/' + name)]) {
  const bytes = await readFile(join(root, file)), target = join(source, file)
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); overlays[file] = sha(bytes)
}
const aliases = []
for (const folder of ['', 'apps/desktop', ...paths.filter(file => file.startsWith('packages/') && file.endsWith('/package.json')).map(dirname)]) {
  await symlink(join(root, folder, 'node_modules'), join(source, folder, 'node_modules')).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (!folder.startsWith('packages/')) continue
  const pkg = JSON.parse(await readFile(join(source, folder, 'package.json')))
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = typeof value === 'string' ? value : value.browser ?? value.import
    if (typeof target !== 'string') continue
    const mapped = target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts')
    const name = pkg.name + (key === '.' ? '' : key.slice(1)), wildcard = name.includes('*')
    let replacement = resolve(source, folder, mapped)
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
const receipt = { schema: 'agentmux.browser-recovery-surface.proof.v1', passed: false, actualPassed: false,
  candidate, observedHead, out, source, overlays, sources: {}, externalInputs: {}, bundles: {}, runs: [],
  driverSha256: sha(await readFile(import.meta.filename)), images: [], independentVisualReview: 'required',
  boundary: 'Private source projection with explicit current recovery-owner overlays. Exact actual Renderer/full IPC/BVM proof. PNGs are uncomposed Renderer capturePage surfaces; no OS/installed/cache/ordinary-restart or clipboard-write claim.' }
const bind = async path => {
  const file = path.split('?')[0]
  try {
    const bytes = await readFile(file)
    if (file.startsWith(source + '/') && !file.includes('/node_modules/')) receipt.sources[relative(source, file)] = sha(bytes)
    else if (isAbsolute(file)) receipt.externalInputs[file] = sha(bytes)
  } catch (error) { if (error.code !== 'EISDIR') throw error }
}
const sourcePlugin = mutation => ({ name: 'actual-recovery-sources', enforce: 'pre',
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
    if (!id.startsWith(source + '/') || id.includes('/node_modules/')) return
    await bind(id)
    if (mutation && id.split('?')[0] === join(source, ownerFiles[0])) {
      const from = 'return browser.error ? await api.browser.reload(tab.browserId) : browser'
      assert.equal(code.split(from).length, 2, 'One actual original Retry dispatch mutation anchor')
      const changed = code.replace(from, 'return browser')
      await syntaxTransform(changed, { loader: 'tsx', jsx: 'automatic' })
      receipt.mutation = { file: ownerFiles[0], before: sha(code), after: sha(changed), from, to: 'return browser' }
      return { code: changed, map: null }
    }
  }
})
try {
  const worker = join(source, 'packages/core/dist/control-endpoint-listener-worker.js')
  await mkdir(dirname(worker), { recursive: true })
  await esbuild({ entryPoints: [join(source, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: worker,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error' })
  await bind(join(source, 'packages/core/src/control-endpoint-listener-worker.ts'))
  receipt.bundles.listenerWorker = { file: worker, sha256: sha(await readFile(worker)) }
  const compiled = join(out, 'compiled'); await mkdir(compiled)
  const preload = join(compiled, 'preload.cjs')
  if (!reuse) {
  const result = await esbuild({ entryPoints: [join(source, 'apps/desktop/src/preload/index.ts')], outfile: preload,
    bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', conditions: ['module', 'browser', 'production'],
    mainFields: ['browser', 'module', 'jsnext:main', 'jsnext', 'main'], external: ['electron'], metafile: true, logLevel: 'error',
    plugins: [{ name: 'original-preload', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\// }, args => { for (const alias of aliases) if (alias.find.test(args.path)) return { path: args.path.replace(alias.find, alias.replacement) } })
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        if (!path.startsWith(source + '/') || path.includes('/node_modules/')) return
        await bind(path); return { contents: await readFile(path, 'utf8'), loader: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'js' }
      })
    } }] })
  assert.ok(Object.values(result.metafile.outputs).every(value => value.imports.every(input => input.path === 'electron')), 'Original sandbox preload requires only Electron')
  receipt.bundles.preload = { file: preload, sha256: sha(await readFile(preload)) }
  } else {
    assert.ok(Object.keys(reuse.sources ?? {}).length > 0, 'Explicit compiled inputs are nonempty')
    for (const [file, digest] of Object.entries(reuse.sources)) {
      if (file === fixture + '/main.ts') continue
      assert.equal(sha(await readFile(join(source, file))), digest, 'Reused Renderer/preload retains its original source bytes: ' + file)
      receipt.sources[file] = digest
    }
    for (const [file, digest] of Object.entries(reuse.externalInputs)) {
      assert.equal(sha(await readFile(file)), digest, 'Explicit reused dependency bytes: ' + file)
      receipt.externalInputs[file] = digest
    }
    assert.equal(sha(await readFile(reuse.bundles.preload.file)), reuse.bundles.preload.sha256)
    receipt.bundles.preload = reuse.bundles.preload
    receipt.reuse = { prepared: reuseFile, sha256: sha(reuseBytes), candidate: reuse.candidate,
      scope: 'Original compiled Renderer/preload with identical frozen sources and current recovery owners. Only this attempt Main fixture is recompiled. No original native outcome is reused.' }
    receipt.mutation = reuse.mutation
  }
  await viteBuild({ configFile: false, root: source, logLevel: 'error', ssr: { noExternal: true }, resolve: { alias: aliases }, plugins: [sourcePlugin(false)],
    build: { ssr: true, outDir: join(compiled, 'main'), minify: false, rollupOptions: { input: join(source, fixture, 'main.ts'),
      external: id => id === 'electron' || isBuiltin(id), output: { entryFileNames: 'main.mjs', format: 'es',
        banner: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" } } } })
  const main = join(compiled, 'main/main.mjs')
  receipt.bundles.main = { file: main, sha256: sha(await readFile(main)) }
  for (const mutation of args.includes('--baseline-only') ? [false] : [false, true]) {
    const label = mutation ? 'omit-retry' : 'source', directory = join(compiled, label)
    if (reuse) {
      const original = reuse.bundles[label]
      assert.ok(original && Object.keys(original.files).length > 0, 'Explicit compiled asset manifest is nonempty: ' + label)
      for (const [file, digest] of Object.entries(original.files)) assert.equal(sha(await readFile(join(original.directory, file))), digest, 'Original compiled asset: ' + label + '/' + file)
      receipt.bundles[label] = original
      continue
    }
    await viteBuild({ configFile: false, root: join(source, fixture), base: './', logLevel: 'error', worker: { format: 'es' }, esbuild: { jsx: 'automatic' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, resolve: { dedupe: ['react', 'react-dom'], alias: aliases },
      css: { postcss: { plugins: [{ postcssPlugin: 'actual-recovery-css', async OnceExit(_sheet, { result }) {
        for (const message of result.messages) if (message.type === 'dependency' && typeof message.file === 'string') await bind(message.file)
      } }] } },
      plugins: [{ ...sourcePlugin(mutation), resolveId: undefined, resolveImportMeta: undefined }],
      build: { outDir: join(directory, 'renderer'), minify: false, rollupOptions: { input: join(source, fixture, 'index.html') } } })
    await copyFile(preload, join(directory, 'preload.cjs'))
    const files = {}
    async function collect(folder) { for (const item of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, item.name); if (item.isDirectory()) await collect(file); else files[relative(directory, file)] = sha(await readFile(file))
    } }
    await collect(directory); receipt.bundles[label] = { directory, files }
  }
  for (const file of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/preload/index.ts', ...ownerFiles,
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/clipboard-copy.ts']) assert.ok(receipt.sources[file], 'Nonempty actual production consumer: ' + file)
  await writeFile(join(out, 'prepared.json'), JSON.stringify(receipt, null, 2) + '\n')
  const executable = require('electron')
  receipt.engine = { executable, sha256: sha(await readFile(executable)), version: require('electron/package.json').version }
  for (const label of args.includes('--baseline-only') ? ['baseline'] : ['baseline', 'omit-retry', 'restored']) {
    const variant = label === 'omit-retry' ? 'omit-retry' : 'source', assets = receipt.bundles[variant].directory
    const directory = join(out, label); await mkdir(directory)
    const privateRoot = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'amx-recovery-'))
    const bootstrap = join(directory, 'bootstrap.cjs')
    await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(privateRoot)};for(const key of ['home','appData','userData','sessionData']){const value=path.join(root,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.commandLine.appendSwitch('no-proxy-server');app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(main).href)})).catch(e=>{console.error(e);app.exit(1)});`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { HOME: join(privateRoot, 'home'), XDG_CACHE_HOME: join(privateRoot, 'cache'), XDG_CONFIG_HOME: join(privateRoot, 'config'), XDG_DATA_HOME: join(privateRoot, 'data'),
      AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'), AGENTMUX_RECOVERY_HOME: privateRoot,
      AGENTMUX_RECOVERY_OUT: directory, AGENTMUX_RECOVERY_ASSETS: assets, AGENTMUX_RECOVERY_IMAGES: label === 'baseline' ? '1' : '0' })
    const logs = []
    const processResult = await runProbeProcess(executable, [bootstrap], { cwd: privateRoot, env, timeoutMs: 60000, onLine: line => logs.push(line) })
    await writeFile(join(directory, 'process.log'), logs.join('\n'))
    await stopProbeProcesses(processResult.originalPid, privateRoot)
    const remaining = await listProbeProcesses(processResult.originalPid, privateRoot)
    const bytes = await readFile(join(directory, 'native.json')), actual = JSON.parse(bytes)
    const row = { label, privateRoot, process: processResult, native: { file: join(directory, 'native.json'), sha256: sha(bytes) }, actual, remaining }
    receipt.runs.push(row)
    await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
    assert.equal(processResult.timedOut, false, 'A setup/timeout is not semantic evidence')
    assert.equal(processResult.exitSignal, null); assert.deepEqual(remaining, [])
    assert.equal(actual.cleanupComplete, true); assert.deepEqual(actual.cleanup, [])
    if (label === 'omit-retry') {
      assert.equal(processResult.exitCode, 1); assert.equal(actual.failure?.name, 'AssertionError')
      assert.ok(actual.failure.message.includes('Actual recovery Retry reaches the original BVM reload exactly once'), 'Owning actual Retry dispatch AssertionRED')
      row.owningAssertion = 'AssertionRED'
    } else {
      assert.equal(processResult.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true)
      assert.equal(actual.cases.length, 4, 'Nonempty actual cases all ran')
      if (label === 'baseline') {
        assert.equal(actual.images.length, 4, 'Actual normal/narrow/short and light/dark Renderer images are nonempty')
        for (const image of actual.images) {
          const file = join(directory, image.file); assert.equal(sha(await readFile(file)), image.sha256)
          receipt.images.push({ ...image, file })
        }
      }
    }
  }
  for (const [file, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(join(source, file))), digest, 'Fixed candidate source: ' + file)
  for (const [file, digest] of Object.entries(overlays)) assert.equal(sha(await readFile(join(root, file))), digest, 'Original recovery owner/fixture remained fixed: ' + file)
  receipt.actualPassed = true
  receipt.passed = !args.includes('--baseline-only')
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
}
await mkdir(dirname(receiptFile), { recursive: true })
await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ actualPassed: receipt.actualPassed, passed: receipt.passed, receipt: relative(root, receiptFile), images: receipt.images.length, failure: receipt.failure?.message }))
