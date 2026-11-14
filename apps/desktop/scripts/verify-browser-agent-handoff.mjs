import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat, symlink, copyFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fixturePath } from './lib/fixture-values.mjs'

// A current-source private consumer. It never builds, installs or restarts the user's App.
const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = browserSourceBuild(createRequire(join(root, 'packages/core/package.json'))('esbuild'))
const { build: viteBuild } = require('vite')
const args = process.argv.slice(2), outputIndex = args.indexOf('--output')
assert.ok(args.every((arg, index) => arg === '--output' || index === outputIndex + 1 && outputIndex >= 0), 'Only --output PATH is supported')
assert.ok(outputIndex < 0 || args[outputIndex + 1], '--output requires an exact directory')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
// Local derived evidence is reusable only after an independent visual review.
// Explicit --output always launches an isolated new observation.
if (outputIndex < 0) {
  let pointer
  try { pointer = JSON.parse(await readFile(join(root, '.tmp/browser-agent-handoff/latest-green.json'), 'utf8')) } catch {}
  if (pointer) {
    try {
      const raw = await readFile(pointer.proof), proof = JSON.parse(raw), reviewRaw = await readFile(pointer.review), review = JSON.parse(reviewRaw)
      assert.equal(pointer.schema, 'agentmux.browser-agent-handoff.qualification.v1')
      assert.equal(hash(raw), pointer.proofSha256); assert.equal(hash(reviewRaw), pointer.reviewSha256)
      assert.equal(proof.schema, 'agentmux.browser-agent-handoff.proof.v1'); assert.equal(proof.passed, true)
      assert.equal(review.schema, 'agentmux.browser-agent-handoff.visual-review.v1'); assert.equal(review.status, 'approved')
      assert.equal(review.proofSha256, pointer.proofSha256)
      assert.equal(proof.phases.length, 2); assert.ok(proof.phases.every(phase => phase.passed && phase.code === 0))
      assert.notEqual(proof.phases[0].pid, proof.phases[1].pid)
      assert.ok(Object.keys(proof.sources ?? {}).length > 0)
      assert.equal(Object.keys(proof.sources).length, proof.sourceCount)
      for (const [file, digest] of Object.entries(proof.sources)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Changed qualification source: ' + file)
      for (const phase of proof.phases) assert.equal(hash(await readFile(resolve(dirname(pointer.proof), phase.receipt))), phase.sha256)
      assert.ok(proof.savedState?.length > 0)
      for (const saved of proof.savedState) assert.equal(hash(await readFile(resolve(dirname(pointer.proof), saved.file))), saved.sha256)
      assert.ok(review.frames.length > 0)
      for (const frame of review.frames) assert.equal(hash(await readFile(resolve(dirname(pointer.proof), frame.file))), frame.sha256)
      process.stdout.write('Browser Agent handoff proof: GREEN (reused exact current sources and approved visual evidence)\n' + pointer.proof + '\n')
      process.exit(0)
    } catch (error) { process.stdout.write('Previous Browser proof is not reusable: ' + error.message + '\n') }
  }
}
const output = resolve(outputIndex < 0 ? join(root, '.tmp/browser-agent-handoff', randomUUID()) : args[outputIndex + 1])
const directory = await mkdtemp(fixturePath('tmp/amx-bh-'))
const fixtures = join(root, 'apps/desktop/scripts/fixtures/browser-agent-handoff')
const packageRoot = join(directory, 'package'), dist = join(packageRoot, 'dist')
const sources = new Map()
const receipt = { schema: 'agentmux.browser-agent-handoff.proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceMode: 'current-worktree-source-private-bundles', directory, phases: [],
  independentVisualReview: 'not-performed', physicalInputQualified: false,
  boundary: 'Actual BrowserPane/Store and production sandbox preload/registerIpc/BrowserViewManager/RuntimeController, real isolated Core Sessions and stock Electron, public RPC and current-source CLI. A second private process reads the first process saved data. No user App, Browser, Run, clipboard, credentials or upstream model is used.' }
await mkdir(output, { recursive: true }); await mkdir(dist, { recursive: true })
async function bind(file) {
  const absolute = resolve(file), name = relative(root, absolute), bytes = await readFile(absolute), digest = hash(bytes)
  if (sources.has(name)) assert.equal(sources.get(name), digest, 'The original qualification input changed: ' + name)
  sources.set(name, digest)
}
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify({ ...receipt, sources: Object.fromEntries(sources) }, null, 2))
const workspacePackages = new Map()
for (const directory of [...(await readdir(join(root, 'packages'))).map(name => join(root, 'packages', name)), join(root, 'apps/host')]) {
  let manifest; try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) } catch { continue }
  await bind(join(directory, 'package.json'))
  workspacePackages.set(manifest.name, { directory, exports: manifest.exports ?? {} })
}
async function workspaceSource(specifier, browser = false) {
  const parts = specifier.split('/'), name = specifier.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
  const pkg = workspacePackages.get(name)
  if (!pkg) return null
  const key = parts.length ? './' + parts.join('/') : '.'
  if (name === '@agentmux/identity' && key === './runtime') return join(pkg.directory, 'src/runtime-entry.ts')
  for (const [pattern, declaration] of Object.entries(pkg.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
    const [prefix, suffix = ''] = pattern.split('*')
    if (pattern.includes('*') ? !key.startsWith(prefix) || !key.endsWith(suffix) : pattern !== key) continue
    const substitution = pattern.includes('*') ? key.slice(prefix.length, key.length - suffix.length) : ''
    const selected = typeof declaration === 'string' ? declaration : browser ? declaration.browser ?? declaration.import : declaration.import ?? declaration.browser
    if (typeof selected !== 'string') continue
    const declared = selected.replace('*', substitution)
    const stem = declared.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts')
    for (const candidate of [resolve(pkg.directory, stem), resolve(pkg.directory, stem.replace(/\.ts$/u, '.tsx'))]) {
      try { await stat(candidate); return candidate } catch {}
    }
    // This one export is an explicitly generated runtime program, not a missing source alias.
    if (name === '@agentmux/identity' && key === './runtime-source') { const file = resolve(pkg.directory, declared); await bind(file); return file }
    throw new Error('Current public workspace source is unavailable: ' + specifier)
  }
  return null
}
async function externalSource(specifier, importer) {
  const resolver = createRequire(importer || join(root, 'package.json')), parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const manifestFile = join(directory, name, 'package.json')
    let manifest; try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')) } catch { continue }
    const entry = manifest.exports?.[parts.length ? './' + parts.join('/') : '.'] ?? (!parts.length ? manifest.exports : undefined)
    const target = typeof entry === 'string' ? entry : typeof entry?.import === 'string' ? entry.import : entry?.import?.default
    if (!target) continue
    const file = resolve(dirname(manifestFile), target)
    await stat(file); await bind(manifestFile); await bind(file)
    return file
  }
  return resolver.resolve(specifier)
}
const browserAliases = [...workspacePackages].flatMap(([name, pkg]) => Object.entries(pkg.exports)
  .sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).flatMap(([entry, declaration]) => {
  const target = typeof declaration === 'string' ? declaration : declaration.browser
  if (!target?.startsWith('./') || target.startsWith('./dist/')) return []
  return [{ find: new RegExp('^' + (name + (entry === '.' ? '' : entry.slice(1))).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$'),
    replacement: resolve(pkg.directory, target).replace('*', '$1') }]
}))
// The external origin outlives both App processes. Restart does not reseed any
// App/Core data, and the original saved URL remains a genuinely loadable page.
const pageServer = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Original Browser workface</title><style>body{font:16px system-ui;margin:32px;background:#f3f7f4;color:#19342b}button{padding:12px}input{padding:10px;margin:16px 0}</style><h1>Original live page</h1><p>This page stays with its original Browser while collaborators change.</p><button>Page action</button><br><input aria-label="Original page draft" value="Keep this page input"><script>globalThis.handoffProof={calls:0};</script>') })
await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve))
const pageUrl = 'http://127.0.0.1:' + pageServer.address().port + '/original'
async function execute(phase) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_HANDOFF_ROOT: directory, AGENTMUX_HANDOFF_SOURCE: root, AGENTMUX_HANDOFF_PHASE: phase,
    AGENTMUX_HANDOFF_PAGE_URL: pageUrl,
    AGENTMUX_HANDOFF_NODE: process.execPath, AGENTMUX_HANDOFF_CLI: join(dist, 'agentmux.js'),
    AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_SPATIAL_STATE_STORE: join(directory, 'state/spatial-state.json'),
    AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(require('electron'), [join(directory, 'bootstrap.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; process.stdout.write(bytes) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 180000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, timedOut, pid: child.pid, log }) })
  })
  await writeFile(join(output, phase + '.log'), result.log)
  assert.equal(result.timedOut, false, 'Private observation timeout is not a behavioral result')
  assert.equal(result.signal, null, 'Private process failure is not a behavioral result')
  const native = JSON.parse(await readFile(join(directory, phase + '-receipt.json'), 'utf8'))
  await writeFile(join(output, phase + '.json'), JSON.stringify(native, null, 2))
  for (const file of await readdir(directory)) if (file.startsWith(phase + '-') && file.endsWith('.png')) await copyFile(join(directory, file), join(output, file))
  if (native.passed) {
    receipt.savedState ??= []
    for (const [path, owner] of [['state/spatial-state.json', 'core-spatial'], ['workbench-user-state.sqlite', 'desktop-user-state']]) {
      const bytes = await readFile(join(directory, path)), file = phase + '-saved-' + owner + (path.endsWith('.sqlite') ? '.sqlite' : '.json')
      await writeFile(join(output, file), bytes); receipt.savedState.push({ phase, owner, file, sha256: hash(bytes) })
    }
  }
  receipt.phases.push({ phase, pid: result.pid, code: result.code, receipt: phase + '.json', sha256: hash(await readFile(join(output, phase + '.json'))), passed: native.passed })
  await save()
  assert.equal(result.code, 0, native.failure?.stack ?? result.log)
  assert.equal(native.passed, true)
  assert.deepEqual(native.cleanupFailures, [], 'Test-owned native resources clean up')
  return native
}
try {
  await bind(import.meta.filename)
  await bind(join(fixtures, 'index.html'))
  for (const name of ['bin', 'vendor', 'package.json', 'node_modules']) await symlink(join(root, 'packages/core', name), join(packageRoot, name))
  await symlink(join(root, 'apps/desktop/resources'), join(directory, 'resources'))
  const options = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', packages: 'external', external: ['electron'],
    metafile: true, logLevel: 'warning', banner: { js: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" },
    plugins: [{ name: 'current-handoff-workspace-sources', setup(builder) {
      builder.onResolve({ filter: /codex-managed-run\.js$/ }, () => ({ path: join(dist, 'providers/codex-managed-run.js'), external: true }))
      builder.onResolve({ filter: /^[^./]/ }, async args => {
        const workspace = await workspaceSource(args.path)
        if (workspace) return { path: workspace }
        if (isBuiltin(args.path) || args.path === 'electron') return null
        return { path: await externalSource(args.path, args.importer), external: true }
      })
    } }] }
  for (const [source, target] of [
    ['packages/core/src/providers/codex-managed-run.ts', 'providers/codex-managed-run.js'],
    ['packages/core/src/control-endpoint-listener-worker.ts', 'control-endpoint-listener-worker.js'],
    ['packages/core/src/agentmux.ts', 'agentmux.js'],
    ['apps/desktop/scripts/fixtures/browser-agent-handoff/main.ts', 'main.mjs']
  ]) {
    const compiled = await build({ ...options, entryPoints: [source], outfile: join(dist, target) })
    for (const file of Object.keys(compiled.metafile.inputs)) await bind(resolve(root, file))
    if (source.endsWith('/main.ts')) for (const required of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/browser-view-manager.ts',
      'apps/desktop/src/main/runtime-controller.ts', 'packages/core/src/public-rpc-service.ts']) assert.ok(compiled.metafile.inputs[required], 'Real owning module is consumed: ' + required)
  }
  const preload = await build({ absWorkingDir: root, bundle: true, platform: 'browser', format: 'cjs', conditions: ['module', 'browser', 'production'],
    mainFields: ['browser', 'module', 'main'], external: ['electron'], metafile: true, logLevel: 'warning',
    plugins: [{ name: 'current-preload-workspaces', setup(builder) { builder.onResolve({ filter: /^@agentmux\// }, async args => ({ path: await workspaceSource(args.path, true) })) } }],
    entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: join(directory, 'preload.cjs') })
  for (const file of Object.keys(preload.metafile.inputs)) await bind(resolve(root, file))
  const rendererInputs = new Set()
  await viteBuild({ configFile: false, logLevel: 'error', root: fixtures, base: './', define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, worker: { format: 'es' },
    resolve: { dedupe: ['react', 'react-dom'], alias: browserAliases },
    css: { postcss: { plugins: [{ postcssPlugin: 'handoff-css-source-inputs', async OnceExit(_sheet, { result }) {
      for (const message of result.messages) if (message.type === 'dependency' && typeof message.file === 'string' && message.file.startsWith(root + '/') && !message.file.includes('/node_modules/')) await bind(message.file)
    } }] } },
    plugins: [{ name: 'current-handoff-renderer', enforce: 'pre', async resolveId(id) { return workspaceSource(id, true) },
      async load(id) { if (id.startsWith(root + '/') && !id.includes('/node_modules/') && !id.includes('?') && /\.(?:[cm]?[jt]sx?|css)$/u.test(id)) await bind(id) },
      moduleParsed(info) { if (info.id.startsWith(root + '/') && !info.id.includes('/node_modules/')) rendererInputs.add(info.id.split('?')[0]) } }],
    build: { outDir: join(directory, 'renderer'), emptyOutDir: false, minify: false, sourcemap: false, target: 'esnext' } })
  for (const required of ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
    'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx']) assert.ok(rendererInputs.has(join(root, required)), 'Real Renderer consumer is bundled: ' + required)
  await writeFile(join(directory, 'bootstrap.cjs'), `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(directory)};for(const key of['home','appData','userData','sessionData']){const p=path.join(root,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}const fail=error=>{console.error(error);fs.writeFileSync(path.join(root,process.env.AGENTMUX_HANDOFF_PHASE+'-receipt.json'),JSON.stringify({passed:false,failure:{name:error.name,message:error.message,stack:error.stack},cleanupFailures:[]}));app.exit(1)};process.on('uncaughtException',fail);app.whenReady().then(()=>import(${JSON.stringify(join(dist, 'main.mjs'))})).catch(fail);`)
  receipt.sourceCount = sources.size; assert.ok(sources.size > 0); await save()
  const first = await execute('first'), restart = await execute('restart')
  assert.notEqual(first.pid, restart.pid, 'Recovery uses a second physical process')
  assert.deepEqual(restart.recoveredIdentity, first.savedIdentity, 'The second process reads original Browser/Tab/Region/Agent/draft identities without reseeding')
  for (const [file, digest] of sources) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Qualification candidate remained unchanged: ' + file)
  receipt.passed = true; await save()
  process.stdout.write('Browser Agent handoff proof: GREEN\n' + join(output, 'receipt.json') + '\n')
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; await save(); throw error
} finally {
  pageServer.closeAllConnections(); await new Promise(resolve => pageServer.close(resolve))
}
// Keep the bounded private run and its receipts available for review; no user directory is cleaned.
