import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()

// Resolve each workspace public export to this checkout's source. Native SDK
// and third-party modules remain installed dependencies, never stale Core dist.
async function sourceAliases(root, browser, identityRuntimeSource) {
  const aliases = []
  for (const name of [...(await readdir(join(root, 'packages'))), 'host']) {
    const directory = join(root, name === 'host' ? 'apps' : 'packages', name)
    if (!existsSync(join(directory, 'package.json'))) continue
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (!manifest.name?.startsWith('@agentmux/')) continue
    for (const [entry, value] of Object.entries(manifest.exports ?? {}).sort(([a], [b]) =>
      Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
      const target = typeof value === 'string' ? value : (browser ? value.browser ?? value.import : value.import)
      if (!target) continue
      let source = target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts')
      if (name === 'identity' && entry === './runtime-source') {
        aliases.push({ find: /^@agentmux\/identity\/runtime-source$/, replacement: identityRuntimeSource })
        continue
      }
      if (name === 'identity' && entry === './runtime') source = './src/runtime-entry.ts'
      let replacement = resolve(directory, source)
      if (!source.includes('*') && !existsSync(replacement)) replacement = replacement.replace(/\.ts$/, '.tsx')
      if (!source.includes('*')) assert.ok(existsSync(replacement), `Current public source missing: ${manifest.name}${entry}`)
      const specifier = manifest.name + (entry === '.' ? '' : entry.slice(1))
      const pattern = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)')
      aliases.push({ find: new RegExp(`^${pattern}$`), replacement: replacement.replace('*', '$1') })
    }
  }
  return aliases
}

export async function verifyWorkbenchRestart({ root, evidence }) {
  root = resolve(root)
  evidence = resolve(evidence)
  const fixture = join(root, 'apps/desktop/scripts/fixtures/durable-workbench-storage')
  const require = createRequire(join(root, 'apps/desktop/package.json'))
  const { build: viteBuild } = await import(pathToFileURL(require.resolve('vite')).href)
  const { build: esbuild, transform } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
  const temporary = await realpath(await mkdtemp('/tmp/amw-build-'))
  const renderer = join(temporary, 'renderer'), main = join(temporary, 'main.mjs')
  const inputs = {}, report = { schema: 'agentmux.workbench-native-restart.v1', passed: false,
    boundary: 'Actual App/Store/native-host writer/Main durable file/Core spatial owner and one private ctxmux Terminal per mode. Only the first process seeds legacy bytes and original graph. Unrelated service ports are controlled. No upstream Provider recovery claim. Diagnostic sidecar completion is not a save or exit gate.',
    inputs, modes: [] }
  const apiPath = join(root, 'apps/desktop/src/renderer/src/lib/api.ts')
  const apiOriginal = await readFile(apiPath, 'utf8')
  const originalExport = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
  assert.equal(apiOriginal.split(originalExport).length - 1, 1)
  const apiLoaded = apiOriginal.replace(originalExport, 'export const api = mockApi')
  report.controlledApiPort = { file: relative(root, apiPath), originalSHA256: hash(apiOriginal), loadedSHA256: hash(apiLoaded),
    purpose: 'Store compiles production persistence branch. Main-owned storage/spatial/Runtime ports replace controlled API methods before real initialize; actual writer/store are unchanged.' }
  const record = async (file, contents) => {
    file = file.split('?')[0]
    if (file.startsWith(root + '/') && !file.includes('/node_modules/') && /\.(?:[cm]?[jt]sx?|css|html|json)$/.test(file)) {
      const key = relative(root, file)
      if (contents !== undefined || !Object.hasOwn(inputs, key)) inputs[key] = hash(contents ?? await readFile(file))
    }
  }
  await mkdir(evidence, { recursive: true })
  try {
    const { bundleIdentityRuntime } = await import(pathToFileURL(join(root, 'packages/identity/scripts/runtime-bundle.mjs')).href)
    const identityRuntime = await bundleIdentityRuntime(), identityRuntimeSource = join(temporary, 'identity-runtime-source.mjs')
    await writeFile(identityRuntimeSource, `export const identityRuntimeSource = ${JSON.stringify(identityRuntime.source)};\n`)
    for (const file of (await files(join(root, 'packages/identity/src')))) await record(file)
    await record(join(root, 'packages/identity/scripts/runtime-bundle.mjs'))
    report.generatedIdentityRuntimeSHA256 = hash(identityRuntime.source)
    const aliases = await sourceAliases(root, true, identityRuntimeSource)
    aliases.unshift({ find: /^@xterm\/xterm$/, replacement: join(root, 'apps/desktop/scripts/fixtures/terminal-wheel/xterm-instrumented.ts') })
    // A directory-prefix alias bypasses react-dom's browser conditional export
    // for /server, which the actual shared UI uses for static SVG markup.
    aliases.unshift({ find: /^react-dom\/server$/, replacement: join(root, 'apps/desktop/node_modules/react-dom/server.browser.js') })
    aliases.push(...['react', 'react-dom'].map(find => ({ find, replacement: join(root, 'apps/desktop/node_modules', find) })))
    await viteBuild({ configFile: false, root: fixture, base: './', logLevel: 'error',
      resolve: { alias: aliases, conditions: ['browser', 'production', 'import', 'default'], dedupe: ['react', 'react-dom'] }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'false', __TERMINAL_WHEEL_UMD_URL__: '"unused"', 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'current-workbench-restart-inputs', enforce: 'pre', async transform(code, id) {
        await record(id, id === apiPath ? apiLoaded : id.includes('?') ? undefined : code)
        if (id === apiPath) { assert.equal(code, apiOriginal); return { code: apiLoaded, map: null } }
      }, async generateBundle() { await Promise.all(this.getWatchFiles().filter(file => file !== apiPath).map(file => record(file))) } }],
      build: { target: 'esnext', outDir: renderer, emptyOutDir: true, minify: false, cssMinify: false, reportCompressedSize: false,
        rollupOptions: { input: join(fixture, 'index.html') } } })
    const mainAliases = await sourceAliases(root, false, identityRuntimeSource)
    await esbuild({ entryPoints: [join(fixture, 'main.ts')], outfile: main, bundle: true, platform: 'node', format: 'esm',
      target: 'node24', logLevel: 'error', metafile: true,
      banner: { js: 'import {createRequire as __restartCreateRequire} from "node:module"; const require=__restartCreateRequire(import.meta.url);' },
      plugins: [{ name: 'current-workbench-main-inputs', setup(build) {
        build.onResolve({ filter: /^[^./]|^@/ }, async args => {
          if (args.pluginData?.resolvedDependency) return
          if (isBuiltin(args.path) || args.path === 'electron') return { path: args.path, external: true }
          const alias = mainAliases.find(alias => alias.find.test(args.path))
          if (alias) return { path: args.path.replace(alias.find, alias.replacement) }
          if (args.kind === 'entry-point') return
          const resolved = await build.resolve(args.path, { resolveDir: dirname(args.importer), kind: 'import-statement', pluginData: { resolvedDependency: true } })
          if (resolved.errors.length) return { errors: resolved.errors }
          return { path: resolved.path, external: true }
        })
        build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
          const original = await readFile(args.path, 'utf8')
          await record(args.path, original)
          // Source-owned native artifact/bin locations must retain source URLs
          // when the current modules are bundled into this private executable.
          const loader = args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js'
          const transformed = await transform(original, { loader, format: 'esm', target: 'node24', define: {
            'import.meta.url': JSON.stringify(pathToFileURL(args.path).href), 'import.meta.dirname': JSON.stringify(dirname(args.path)) } })
          return { contents: transformed.code, loader: 'js' }
        })
      } }] })
    for (const owner of ['App.tsx', 'store.ts', 'workbench-user-storage.ts', 'persisted-ui-writer.ts', 'workbench-user-state.ts', 'spatial-state.ts'])
      assert.ok(Object.keys(inputs).some(file => file.endsWith('/' + owner)), 'Actual product source compiled: ' + owner)
    await record(fileURLToPath(import.meta.url))
    await record(join(fixture, 'preload.cjs'))
    report.compiled = Object.fromEntries(await Promise.all((await files(temporary)).map(async file => [relative(temporary, file), hash(await readFile(file))])))
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER'].filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]]))
    for (const mode of ['normal', 'abrupt']) {
      const privateRoot = await realpath(await mkdtemp('/tmp/amw-run-')), output = join(evidence, mode)
      const receipt = { mode, privateRoot, passed: false, phases: [] }
      await mkdir(output, { recursive: true })
      try {
        await Promise.all(['user-data', 'session-data', 'work', 'home'].map(path => mkdir(join(privateRoot, path), { recursive: true })))
        await writeFile(join(privateRoot, 'producer.cjs'), `process.stdout.write('ORIGINAL-LIVE\\n');process.stdin.on('data',data=>process.stdout.write('ACK:'+data.toString().trim()+'\\n'));setInterval(()=>{},1000);\n`)
        for (const phase of ['seed', 'restore']) {
          const log = []
          const phaseReceipt = { phase, process: null, actual: null }; receipt.phases.push(phaseReceipt)
          const outcome = await runProbeProcess(require('electron'), [main, join(renderer, 'index.html'), privateRoot, output,
            phase, mode, join(fixture, 'preload.cjs'), process.execPath], { cwd: root, env: { ...env,
              AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'),
              AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson'), HOME: join(privateRoot, 'home') },
              timeoutMs: 60000, onLine: line => log.push(line) })
          phaseReceipt.process = outcome
          await writeFile(join(output, phase + '.log'), log.join('\n'))
          const actual = JSON.parse(await readFile(join(output, phase + '.json'), 'utf8'))
          phaseReceipt.actual = actual
          assert.equal(outcome.timedOut, false)
          assert.equal(actual.passed, true, actual.failure?.message)
          if (phase === 'seed' && mode === 'abrupt') assert.equal(outcome.exitSignal, 'SIGKILL')
          else assert.equal(outcome.exitCode, 0, actual.failure?.message)
        }
        assert.notEqual(receipt.phases[0].actual.pid, receipt.phases[1].actual.pid)
        assert.equal(receipt.phases[1].actual.nativeInputConfirmed, true)
        receipt.passed = true
      } catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
      finally {
        try {
          await stopProbeProcesses(-1, privateRoot)
          receipt.cleanup = { remaining: await listProbeProcesses(-1, privateRoot) }
          if (!receipt.cleanup.remaining.length) { await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.removed = true }
        } catch (error) { receipt.passed = false; receipt.cleanupFailure = { name: error.name, message: error.message } }
        await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
      }
      report.modes.push({ mode, passed: receipt.passed, receipt: relative(evidence, join(output, 'receipt.json')) })
      assert.equal(receipt.passed, true, receipt.failure?.message ?? receipt.cleanupFailure?.message)
    }
    report.passed = true
  } catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    await rm(temporary, { recursive: true, force: true })
    report.buildCleanup = { removed: true }
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2) + '\n')
  }
  assert.equal(report.passed, true, report.failure?.message)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(process.argv[2] ?? join(root, '.tmp/durable-workbench-storage/restart'))
  try { const report = await verifyWorkbenchRestart({ root, evidence }); console.log(JSON.stringify({ passed: report.passed, evidence })) }
  catch (error) { console.error(JSON.stringify({ passed: false, evidence, failure: error.message })); process.exitCode = 1 }
}
