import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat, symlink, rm, copyFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixturePath } from './lib/fixture-values.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild'), { build: viteBuild } = require('vite')
const baselineOnly = process.argv.includes('--baseline')
const foreground = process.argv.includes('--foreground')
const captureHandoff = process.argv.includes('--capture-handoff')
const output = join(root, '.tmp/browser-agent-collaboration', foreground ? 'contextual-composer-foreground-proof' : 'contextual-composer-proof')
assert.ok(process.argv.slice(2).every(arg => ['--baseline', '--foreground', '--capture-handoff'].includes(arg)), 'Unsupported contextual proof argument')
assert.ok(!captureHandoff || foreground, 'External native capture needs the explicit foreground mode')
assert.ok(!foreground || process.platform === 'darwin', 'Exact native foreground capture currently uses the macOS window source')
await mkdir(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), sources = new Map()
const receipt = { schema: 'agentmux.browser-contextual-composer.proof.v1', passed: false, diagnostic: baselineOnly,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), runs: [],
  sharedTreeMutations: 0, independentVisualReview: 'not-performed', physicalInputQualified: false,
  boundary: 'Actual mounted BrowserPane/Store/NativeOverlay and sandbox preload/full Main registerIpc/RuntimeController, original Hosted/Core capture reader and shipped CodexProvider over real ctxmux PTY to a repository-controlled CLI. CDP Renderer interaction and Renderer captures do not qualify OS foreground input or a composed whole-window visual review.' }
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify({ ...receipt, sources: Object.fromEntries(sources) }, null, 2))
async function bind(file) { const name = relative(root, file), digest = hash(await readFile(file)); if (sources.has(name)) assert.equal(sources.get(name), digest, 'Changed proof input: ' + name); sources.set(name, digest) }
await bind(fileURLToPath(import.meta.url))
const mutations = [
  { id: 'gui-frozen-capture-bridge', file: 'apps/desktop/src/renderer/src/components/BrowserContextualComposer.tsx',
    from: '...(capture ? { browserInput: { control: original.control, capture } } : {})', to: '/* private mutation: lose the original frozen GUI capture */',
    expected: 'GUI queue reference must reach the original Host capture reader' },
  { id: 'captured-reader-context', file: 'packages/client-ui/src/components/CapturedConversationMessage.tsx',
    from: '...(input.inputContext ? { inputContext: input.inputContext, inputContextSource: input.inputContextSource } : {})',
    to: '/* private mutation: lose the structured Browser observation on the shipped Reader */',
    expected: 'The shared Reader folds the generated Browser context separately from the original opinion' },
  { id: 'native-reader-provenance', file: 'packages/client-ui/src/components/ConversationInputText.tsx',
    from: "source={index === matching ? inputContextSource ?? 'caller-declared' : 'caller-declared'}", to: 'source="host-capture"',
    expected: 'Native wire cannot borrow the Main capture source' },
  { id: 'live-trace-flow-space', file: 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
    from: ": traceCanDock ? 'docked' : 'floating'", to: ": 'docked'",
    expected: 'Opening a live trace must float without taking page flow space' },
  { id: 'live-dock-footprint', file: 'apps/desktop/src/renderer/src/components/BrowserTraceReadingHost.tsx',
    from: "if (mode === 'docked') return open || held && reserved ?", to: "if (mode === 'docked') return open ?",
    expected: 'Closing a previously docked trace must preserve the live page footprint' },
  { id: 'live-anchor-commit', file: 'apps/desktop/src/renderer/src/components/BrowserTraceReadingHost.tsx',
    from: 'queueMicrotask(() => {', to: '((work: () => void) => work())(() => {',
    expected: 'The live trace must actually be painted after its original parent ref commits' }
]
for (const mutation of mutations) {
  const file = join(root, mutation.file); await bind(file)
  assert.equal((await readFile(file, 'utf8')).split(mutation.from).length, 2, 'Unique owning production mutation: ' + mutation.id)
}
const aliases = {}, workspacePackages = new Map()
for (const name of await readdir(join(root, 'packages'))) {
  const manifest = join(root, 'packages', name, 'package.json')
  let pkg; try { pkg = JSON.parse(await readFile(manifest, 'utf8')) } catch { continue }
  workspacePackages.set(pkg.name, { directory: dirname(manifest), exports: pkg.exports ?? {} })
  for (const [key, spec] of Object.entries(pkg.exports ?? {})) {
    const target = typeof spec === 'string' ? spec : spec.import
    if (!target?.startsWith('./dist/')) continue
    const source = resolve(dirname(manifest), target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    try { await stat(source); aliases[key === '.' ? pkg.name : pkg.name + key.slice(1)] = source } catch {}
  }
}
async function workspaceSource(name) {
  const parts = name.split('/'), packageName = name.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
  const pkg = workspacePackages.get(packageName)
  if (!pkg) return null
  const key = parts.length ? './' + parts.join('/') : '.'
  for (const [pattern, spec] of Object.entries(pkg.exports).sort(([left], [right]) => right.length - left.length)) {
    const [prefix, suffix] = pattern.split('*')
    if (pattern.includes('*') ? !key.startsWith(prefix) || !key.endsWith(suffix) : pattern !== key) continue
    const substitution = pattern.includes('*') ? key.slice(prefix.length, key.length - suffix.length) : ''
    const declared = typeof spec === 'string' ? spec : spec.browser ?? spec.import
    if (typeof declared !== 'string') continue
    const target = declared.replace('*', substitution).replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts')
    for (const candidate of [resolve(pkg.directory, target), resolve(pkg.directory, target.replace(/\.ts$/u, '.tsx'))]) {
      try { await stat(candidate); return candidate } catch {}
    }
  }
  return null
}
async function execute(executable, args, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; process.stdout.write(bytes) })
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 180000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, log, timedOut, pid: child.pid }) })
  })
}
async function native(label, mutation) {
  const directory = await mkdtemp(fixturePath('tmp/amx-bcui-')), packageRoot = join(directory, 'package'), dist = join(packageRoot, 'dist')
  await mkdir(dist, { recursive: true })
  for (const name of ['bin', 'vendor', 'package.json', 'node_modules']) await symlink(join(root, 'packages/core', name), join(packageRoot, name))
  await symlink(join(root, 'apps/desktop/resources'), join(directory, 'resources'))
  const options = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: aliases,
    external: ['electron'], metafile: true, logLevel: 'warning', banner: { js: "import {createRequire as __createProofRequire} from 'node:module';const require=__createProofRequire(import.meta.url);" },
    plugins: [{ name: 'actual-contextual-production', setup(plugin) {
      plugin.onResolve({ filter: /codex-managed-run\.js$/ }, async () => {
        const source = join(root, 'packages/core/src/providers/codex-managed-run.ts'), asset = join(root, 'packages/core/dist/providers/codex-managed-run.js')
        await bind(source); await bind(asset); return { path: asset, external: true }
      })
      plugin.onResolve({ filter: /^[^./]/ }, async args => {
        const workspace = await workspaceSource(args.path)
        if (workspace) return { path: workspace }
        if (isBuiltin(args.path) || args.path === 'electron') return null
        const resolver = createRequire(args.importer || join(root, 'package.json'))
        const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
        let entry
        for (const directory of resolver.resolve.paths(name) ?? []) {
          try {
            const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
            const spec = pkg.exports?.[parts.length ? './' + parts.join('/') : '.'] ?? (!parts.length ? pkg.exports : undefined)
            const target = typeof spec === 'string' ? spec : typeof spec?.import === 'string' ? spec.import : spec?.import?.default
            if (!target) continue
            entry = resolve(dirname(manifest), target); await stat(entry); await bind(manifest); break
          } catch {}
        }
        return { path: entry ?? resolver.resolve(args.path), external: true }
      })
    } }] }
  try {
    const main = await build({ ...options, entryPoints: ['apps/desktop/scripts/fixtures/browser-contextual-composer/main.ts'], outfile: join(dist, 'main.mjs') })
    const listener = await build({ ...options, entryPoints: ['packages/core/src/control-endpoint-listener-worker.ts'], outfile: join(dist, 'control-endpoint-listener-worker.js') })
    for (const file of new Set([...Object.keys(main.metafile.inputs), ...Object.keys(listener.metafile.inputs)])) await bind(resolve(root, file))
    for (const file of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/host/src/input-context-capture-reader.ts', 'packages/core/src/hosted-runtime-service.ts']) assert.ok(main.metafile.inputs[file], 'Actual Main/Host owner is in the product bundle: ' + file)
    const preload = await build({ absWorkingDir: root, bundle: true, platform: 'browser', format: 'cjs',
      conditions: ['module', 'browser', 'production'], mainFields: ['browser', 'module', 'jsnext:main', 'jsnext', 'main'],
      external: ['electron'], metafile: true, logLevel: 'warning', entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: join(directory, 'preload.cjs') })
    assert.ok(Object.values(preload.metafile.outputs).every(result => result.imports.every(input => input.path === 'electron')), 'Sandboxed production preload only requires Electron')
    for (const file of Object.keys(preload.metafile.inputs)) await bind(resolve(root, file))
    const rendererInputs = new Set(); let applied = false, consumed
    await viteBuild({ configFile: false, logLevel: 'error', root: join(root, 'apps/desktop/scripts/fixtures/browser-contextual-composer'), base: './',
      define: { __AGENTMUX_WEB_PREVIEW__: 'false' },
      worker: { format: 'es' },
      resolve: { dedupe: ['react', 'react-dom'], alias: Object.entries(aliases).map(([name, path]) => ({ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$'), replacement: path })) },
      plugins: [{ name: 'actual-renderer-inputs', enforce: 'pre', async resolveId(id) { return await workspaceSource(id) },
        async load(id) {
          if (id.includes('?') || !id.startsWith(root + '/') || id.includes('/node_modules/') || !/\.(?:[cm]?[jt]sx?|css)$/u.test(id)) return
          const original = await readFile(id, 'utf8'); await bind(id)
          if (!mutation || id !== join(root, mutation.file)) return original
          assert.equal(original.split(mutation.from).length, 2)
          const changed = original.replace(mutation.from, mutation.to)
          applied = true; consumed = { file: mutation.file, original: hash(original), mutated: hash(changed) }
          return changed
        }, moduleParsed(info) { if (info.id.startsWith(root + '/') && !info.id.includes('/node_modules/')) rendererInputs.add(info.id.split('?')[0]) } }],
      build: { outDir: join(directory, 'renderer'), emptyOutDir: false, minify: false, sourcemap: false, target: 'esnext' } })
    for (const file of rendererInputs) await bind(file)
    assert.equal(applied, Boolean(mutation), 'The exact owning production module must consume its private mutation')
    for (const file of ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/components/BrowserContextualComposer.tsx']) assert.ok(rendererInputs.has(join(root, file)), 'Renderer consumes actual production: ' + file)
    await writeFile(join(directory, 'bootstrap.cjs'), `const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(directory)};for(const key of ['home','appData','userData','sessionData']){const p=path.join(root,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}const fail=error=>{console.error(error);fs.writeFileSync(path.join(root,'native-receipt.json'),JSON.stringify({passed:false,failure:{message:error.message,stack:error.stack}}));app.exit(1)};process.on('uncaughtException',fail);app.whenReady().then(()=>import(${JSON.stringify(join(dist, 'main.mjs'))})).catch(fail);`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { AGENTMUX_CONTEXTUAL_ROOT: directory, AGENTMUX_CONTEXTUAL_SOURCE: root,
      AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })
    if (foreground && !mutation) {
      const helper = join(root, 'apps/desktop/scripts/fixtures/browser-contextual-composer/native-window.swift')
      await bind(helper)
      execFileSync('/usr/bin/xcrun', ['swiftc', helper, '-o', join(directory, 'native-window')])
      env.AGENTMUX_CONTEXTUAL_FOREGROUND = '1'
      if (captureHandoff) env.AGENTMUX_CONTEXTUAL_CAPTURE_HANDOFF = '1'
    }
    console.log(label + ': private native fixture ' + directory)
    const result = await execute(require('electron'), [join(directory, 'bootstrap.cjs')], env)
    await writeFile(join(output, label + '.log'), result.log)
    assert.equal(result.timedOut, false, 'Timeout is not behavioral RED')
    assert.equal(result.signal, null, 'Process failure is not behavioral RED')
    const actual = JSON.parse(await readFile(join(directory, 'native-receipt.json'), 'utf8'))
    await writeFile(join(output, label + '.json'), JSON.stringify(actual, null, 2))
    for (const name of await readdir(directory)) if (name.endsWith('.png')) await copyFile(join(directory, name), join(output, label + '-' + name))
    assert.deepEqual(actual.cleanupFailures, [], 'All original private native owners must clean up')
    if (mutation) {
      assert.notEqual(result.code, 0); assert.equal(actual.passed, false)
      assert.equal(actual.failure?.name, 'AssertionError', 'Only original behavior assertion failure qualifies RED')
      assert.ok(actual.failure.message.includes(mutation.expected), 'The owning assertion must fail: ' + mutation.id + '\n' + actual.failure.message)
      assert.equal(consumed.original, sources.get(mutation.file))
    } else {
      assert.equal(result.code, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true)
      assert.equal(actual.cases.length, 2); assert.equal(actual.trace.length, 9)
    }
    receipt.runs.push({ label, mutation: mutation?.id ?? null, consumed, actual }); await save()
    console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
  } finally {
    const listing = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    for (const line of listing.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
      if (match && match[2].includes('/ctxmuxd ') && match[2].includes('--socket ' + join(directory, 'runtime/ctxmux.sock')) && match[2].includes('--state-dir ' + join(directory, 'state/ctxmux'))) process.kill(Number(match[1]), 'SIGTERM')
    }
    if (receipt.runs.at(-1)?.label === label) await rm(directory, { recursive: true, force: true })
    else receipt.retainedDiagnosticRoot = directory
  }
}
try {
  await native('native-baseline')
  if (!baselineOnly) {
    const queueReceipt = join(output, 'queue.json')
    const queue = await execute(process.execPath, ['apps/desktop/scripts/verify-browser-contextual-queue.mjs', '--receipt', queueReceipt], process.env)
    await writeFile(join(output, 'queue.log'), queue.log)
    assert.equal(queue.code, 0, 'Independent queue owner proof must qualify'); assert.equal(queue.signal, null); assert.equal(queue.timedOut, false)
    const qualified = JSON.parse(await readFile(queueReceipt, 'utf8'))
    assert.equal(qualified.schema, 'agentmux.browser-contextual-queue-proof.v1'); assert.equal(qualified.passed, true)
    assert.equal(qualified.candidate, receipt.candidate); assert.equal(qualified.sharedTreeMutations, 0)
    assert.equal(qualified.runs.length, 6, 'Queue proof includes baseline, four owning mutants and restored')
    assert.ok(Object.keys(qualified.sources).length >= 3)
    for (const [file, digest] of Object.entries(qualified.sources)) { await bind(join(root, file)); assert.equal(sources.get(file), digest) }
    receipt.queue = { file: relative(root, queueReceipt), sha256: hash(await readFile(queueReceipt)), candidate: qualified.candidate }
    for (const mutation of mutations) await native('mutant-' + mutation.id, mutation)
    await native('native-restored')
    assert.equal(receipt.runs.length, mutations.length + 2)
    for (const file of sources.keys()) await bind(join(root, file))
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), receipt.candidate, 'The qualified candidate must stay exact')
    receipt.passed = true
  }
  await save()
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; await save(); throw error }
