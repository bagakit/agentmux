import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, realpath, stat, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'
import { fixturePath } from './lib/fixture-values.mjs'

// One bounded Source/native producer. --prepare-only builds but never opens a page or calls a pending API.
const repository = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const prepareOnly = args.includes('--prepare-only'), paintOnly = args.includes('--paint-only'), iframeOnly = args.includes('--iframe-only'), outputIndex = args.indexOf('--output')
assert.ok(args.every((arg, index) => ['--prepare-only', '--paint-only', '--iframe-only', '--output'].includes(arg) || index === outputIndex + 1 && outputIndex >= 0))
assert.ok(Number(prepareOnly) + Number(paintOnly) + Number(iframeOnly) <= 1, 'Choose exactly one bounded probe scope.')
const output = resolve(outputIndex < 0 ? join(repository, '.artifacts/browser-clean-capture/native-runs', randomUUID()) : args[outputIndex + 1])
const require = createRequire(join(repository, 'apps/desktop/package.json')), { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const temporary = await realpath(await mkdtemp(fixturePath('tmp/amx-clean-capture-')))
await mkdir(output, { recursive: true })
const receipt = { schema: 'agentmux.browser-clean-capture.native.v1', passed: false, prepared: false,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  source: {}, loaded: [], artifacts: {}, cleanup: {}, scope: paintOnly ? 'paint-only-http-visible-hidden' : iframeOnly ? 'iframe-only-http-public' : 'full-native-slice',
  boundary: 'Actual private Electron/BVM/feedback/input/RPC/CLI Source. Not installed Desktop, user work, Provider/Run, OS foreground/compositor or hardware input qualification.' }
const workspace = new Map(), sources = new Map(), externals = new Map()
let processResult
try {
  for (const area of ['packages', 'apps']) for (const name of await readdir(join(repository, area))) {
    const directory = join(repository, area, name)
    try { const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); workspace.set(manifest.name, { directory, manifest }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const fixture = join(repository, 'apps/desktop/scripts/fixtures/browser-clean-capture')
  // Use the original package self-resolution recipe for its real listener fork,
  // without reading or writing the workspace's shared dist.
  const privatePackage = join(temporary, 'core'), privateDist = join(privatePackage, 'dist')
  await mkdir(privateDist, { recursive: true })
  const coreManifest = await readFile(join(repository, 'packages/core/package.json'))
  await writeFile(join(privatePackage, 'package.json'), coreManifest)
  // Source createRequire(import.meta.url) file-lock consumers retain their actual
  // maintained native dependency. This is not a workspace/dist search path.
  const coreRequire = createRequire(join(repository, 'packages/core/package.json'))
  const nativeEntry = coreRequire.resolve('fs-native-extensions'), nativePackage = dirname(nativeEntry)
  await mkdir(join(privatePackage, 'node_modules'), { recursive: true })
  await symlink(nativePackage, join(privatePackage, 'node_modules/fs-native-extensions'), 'dir')
  for (const path of [nativeEntry, join(nativePackage, 'package.json')]) externals.set(path, sha(await readFile(path)))
  receipt.dynamicNative = { name: 'fs-native-extensions', entry: nativeEntry,
    entrySHA256: sha(await readFile(nativeEntry)), boundary: 'Only the original native file-lock package is linked; no first-party dist or general module fallback.' }
  const { bundleIdentityRuntime } = await import(pathToFileURL(join(repository, 'packages/identity/scripts/runtime-bundle.mjs')).href)
  const identity = await bundleIdentityRuntime(), generated = join(temporary, 'identity-runtime-source.mjs')
  await writeFile(generated, `export const identityRuntimeSource=${JSON.stringify(identity.source)};\n`)
  const sourcePlugin = { name: 'clean-capture-exact-workspace-source', setup(builder) {
    builder.onResolve({ filter: /^@agentmux\// }, async input => {
      if (input.path === '@agentmux/identity/runtime-source') return { path: generated }
      const match = /^(@agentmux\/[^/]+)(\/.*)?$/.exec(input.path), owner = match && workspace.get(match[1])
      assert.ok(owner, 'An actual workspace package owns ' + input.path)
      const key = match[2] ? '.' + match[2] : '.', exports = owner.manifest.exports
      let entry = exports?.[key], wildcard
      if (!entry) for (const pattern of Object.keys(exports ?? {}).filter(key => key.includes('*')).sort((a, b) => b.length - a.length)) {
        const [before, after] = pattern.split('*')
        if (key.startsWith(before) && key.endsWith(after)) { entry = exports[pattern]; wildcard = key.slice(before.length, after ? -after.length : undefined); break }
      }
      let target = typeof entry === 'string' ? entry : entry?.import ?? entry?.default
      assert.ok(target, 'Exact package export exists: ' + input.path)
      if (wildcard !== undefined) target = target.replace('*', wildcard)
      if (input.path === '@agentmux/identity/runtime') target = './src/runtime-entry.ts'
      let path = resolve(owner.directory, target.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
      try { await stat(path) } catch (error) { if (error.code !== 'ENOENT') throw error; path = path.replace(/\.ts$/, '.tsx'); await stat(path) }
      assert.ok(!path.includes('/dist/'), 'No first-party dist fallback: ' + input.path)
      return { path }
    })
    builder.onResolve({ filter: /^[^./]/ }, async input => {
      if (input.pluginData?.resolvedExternal) return
      if (input.path === 'electron' || isBuiltin(input.path)) return { path: input.path, external: true }
      const resolved = await builder.resolve(input.path, { resolveDir: input.resolveDir, kind: input.kind, pluginData: { resolvedExternal: true } })
      if (resolved.errors.length) return { errors: resolved.errors }
      const bytes = await readFile(resolved.path); externals.set(resolved.path, sha(bytes)); return { path: resolved.path, external: true }
    })
    builder.onLoad({ filter: /\.(?:ts|tsx|mjs|js)$/ }, async input => {
      if (!input.path.startsWith(repository + '/') && input.path !== generated) return
      const bytes = await readFile(input.path), file = input.path === generated ? 'generated/identity-runtime-source.mjs' : relative(repository, input.path)
      sources.set(input.path, { file, sha256: sha(bytes), bytes: bytes.length, generated: input.path === generated })
      return undefined
    })
  } }
  const options = { absWorkingDir: repository, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    jsx: 'automatic', logLevel: 'silent', metafile: true, plugins: [sourcePlugin],
    banner: { js: "import{createRequire as __require}from'node:module';const require=__require(import.meta.url);" } }
  const compiled = join(privateDist, 'index.js'), cli = join(privateDist, 'agentmux.js'), listener = join(privateDist, 'control-endpoint-listener-worker.js')
  const [mainBuild, cliBuild, listenerBuild] = await Promise.all([
    build({ ...options, entryPoints: [join(fixture, 'main.ts')], outfile: compiled }),
    build({ ...options, entryPoints: [join(repository, 'packages/core/src/agentmux.ts')], outfile: cli }),
    build({ ...options, entryPoints: [join(repository, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: listener })
  ])
  for (const [label, result] of [['main', mainBuild], ['cli', cliBuild], ['listener', listenerBuild]]) {
    const actual = Object.keys(result.metafile.inputs).map(file => resolve(repository, file))
    assert.ok(actual.length > 0)
    receipt.loaded.push(...actual.map(path => ({ stage: label, file: path === generated ? 'generated/identity-runtime-source.mjs' : relative(repository, path),
      sourceSHA256: sources.get(path)?.sha256, transformed: false })))
  }
  for (const file of ['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-control-feedback.ts', 'apps/desktop/src/main/browser-operation-feedback.ts',
    'packages/browser/src/browser-page-dispatch.ts', 'packages/core/src/public-rpc-server.ts', 'packages/core/src/agentmux.ts']) {
    assert.ok(receipt.loaded.some(row => row.file === file), 'Actual source consumer must be loaded: ' + file)
  }
  for (const [path, row] of sources) {
    receipt.source[row.file] = row.sha256
    const copy = join(output, 'source-inputs', row.file); await mkdir(dirname(copy), { recursive: true }); await writeFile(copy, await readFile(path))
  }
  for (const name of ['verify-browser-clean-capture-native.mjs', 'probe-process.mjs', 'package-smoke-context.mjs']) {
    const path = join(repository, 'apps/desktop/scripts', name); receipt.source[relative(repository, path)] = sha(await readFile(path))
  }
  for (const name of ['page.html', 'frame.html', 'scenario.md']) {
    const path = join(fixture, name); receipt.source[relative(repository, path)] = sha(await readFile(path))
  }
  receipt.externalEntries = Object.fromEntries(externals)
  for (const path of [compiled, cli, listener]) receipt.artifacts[relative(temporary, path)] = sha(await readFile(path))
  receipt.privatePackage = { manifestSource: 'packages/core/package.json', manifestSHA256: sha(coreManifest), listenerSource: 'packages/core/src/control-endpoint-listener-worker.ts',
    boundary: 'Original package self-reference and original listener fork; outputs private to this probe, no shared dist or IPC mock.' }
  receipt.generatedIdentity = { recipe: 'packages/identity/scripts/runtime-bundle.mjs', sha256: sha(await readFile(generated)) }
  receipt.prepared = true
  if (!prepareOnly) {
    for (const directory of ['pages', 'user-data/home', 'session-data', 'runtime/tmp']) await mkdir(join(temporary, directory), { recursive: true })
    for (const name of ['page.html', 'frame.html']) await writeFile(join(temporary, 'pages', name), await readFile(join(fixture, name)))
    const bootstrap = join(temporary, 'bootstrap.cjs')
    await writeFile(bootstrap, `import('./core/dist/index.js').catch(error=>{console.error(error);require('electron').app.exit(1)});\n`)
    const env = { ...privatePackageSmokeEnvironment(process.env, { userData: join(temporary, 'user-data'), runtimeRoot: join(temporary, 'runtime'), readyFile: join(temporary, 'unused-ready') }),
      AGENTMUX_CLEAN_CAPTURE_ROOT: temporary, AGENTMUX_CLEAN_CAPTURE_OUT: output, AGENTMUX_CLEAN_CAPTURE_CLI: cli, AGENTMUX_CLEAN_CAPTURE_NODE: process.execPath,
      ...(paintOnly ? { AGENTMUX_CLEAN_CAPTURE_PAINT_ONLY: '1' } : {}), ...(iframeOnly ? { AGENTMUX_CLEAN_CAPTURE_IFRAME_ONLY: '1' } : {}) }
    delete env.ELECTRON_RUN_AS_NODE
    const logs = [], executable = require('electron')
    receipt.engine = { executable, version: require('electron/package.json').version, sha256: sha(await readFile(executable)) }
    processResult = await runProbeProcess(executable, [bootstrap], { temporaryRoot: temporary, cwd: temporary, env, timeoutMs: 90_000, onLine: line => logs.push(line) })
    receipt.process = processResult; await writeFile(join(output, 'process.log'), logs.join('\n'))
    const actualPath = join(output, 'native-process.json'), bytes = await readFile(actualPath), actual = JSON.parse(bytes)
    receipt.actual = { path: actualPath, sha256: sha(bytes) }
    assert.equal(processResult.exitCode, 0, actual.failure?.message); assert.equal(processResult.timedOut, false)
    assert.equal(actual.passed, true); assert.ok(actual.frames.length > 0 && actual.cases.length > 0)
    receipt.frames = actual.frames; receipt.passed = true
  }
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; if (error.probe) receipt.process = error.probe }
finally {
  receipt.drift = []
  for (const [path, row] of sources) if (sha(await readFile(path)) !== row.sha256) receipt.drift.push(row.file)
  for (const [path, before] of externals) if (sha(await readFile(path)) !== before) receipt.drift.push(path)
  if (receipt.drift.length) receipt.passed = false
  if (processResult?.originalPid) receipt.cleanup.remaining = await listProbeProcesses(processResult.originalPid, temporary)
  else receipt.cleanup.remaining = []
  if (!receipt.cleanup.remaining.length) { await rm(temporary, { recursive: true, force: true }); receipt.cleanup.removed = true }
  else { receipt.cleanup.removed = false; receipt.passed = false }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ receipt: join(output, 'receipt.json'), passed: receipt.passed, prepared: receipt.prepared, prepareOnly }))
if (receipt.failure || !prepareOnly && !receipt.passed) process.exitCode = 1
