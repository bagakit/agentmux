import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, stat, readdir, symlink, rm, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const proof = join(root, '.tmp/browser-site-permissions'); await mkdir(proof, { recursive: true })
const out = await mkdtemp(join(proof, 'attempt-')), fixture = join(root, 'apps/desktop/scripts/fixtures/browser-site-permissions')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.browser-site-permissions.native.v1', passed: false, out, sources: {}, runs: [],
  dependency: { electron: await realpath(require('electron')), sha256: sha(await readFile(require('electron'))), version: require('electron/package.json').version },
  boundary: 'Private App; production preload/complete trusted IPC/BVM/permission owner/BrowserPane/CSS. Actual Notification/media requests use a Chromium fake video device, never a personal camera or microphone. No Native Run, Provider/hook connection, installed app, user Profile, HOME override or external website. capturePage proves the App Renderer, not OS child-view composition.' }
const aliases = [], mainModules = []
for (const directory of [...(await readdir(join(root, 'packages'))).map(name => join(root, 'packages', name)), join(root, 'apps/host')]) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const id = pkg.name + (key === '.' ? '' : key.slice(1)), wildcard = id.includes('*')
    const pattern = new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$')
    const browserTarget = typeof value === 'string' ? value : value.browser ?? value.import
    if (typeof browserTarget === 'string') {
      let source = resolve(directory, browserTarget.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
      if (!wildcard) { try { await stat(source) } catch { source = source.replace(/\.ts$/u, '.tsx'); try { await stat(source) } catch { source = undefined } } }
      if (source) aliases.push({ find: pattern, replacement: source.replace('*', '$1'), wildcard, id })
    }
    const mainTarget = typeof value === 'string' ? value : value.import
    if (typeof mainTarget !== 'string') continue
    const artifact = resolve(directory, mainTarget)
    let source = resolve(directory, mainTarget.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    let external = !wildcard && await stat(artifact).then(value => value.isFile(), () => false)
    if (!external && !wildcard) { try { await stat(source) } catch { source = source.replace(/\.ts$/u, '.tsx'); try { await stat(source) } catch { continue } } }
    mainModules.push({ find: pattern, replacement: (external ? artifact : source).replace('*', '$1'), wildcard, id, external })
  }
}
for (const list of [aliases, mainModules]) list.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.id.length - a.id.length)
let mode = 'plain'; const held = new Set()
const helpers = `<script>window.askNotifications=()=>{window.note='pending';return Notification.requestPermission().then(value=>window.note=value)};window.askCamera=()=>{window.camera='pending';return navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{window.stream=stream;window.camera='allowed'},error=>window.camera=error.name)};window.addEventListener('message',event=>{if(event.data==='camera')window.askCamera()});</script>`
let otherOrigin
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/control') {
    const selected = url.searchParams.get('mode')
    if (selected === 'release') { for (const pending of held) pending.end(''); held.clear(); mode = 'plain' } else mode = selected
    response.end('ok'); return
  }
  if (url.pathname === '/hold') { held.add(response); response.once('close', () => held.delete(response)); return }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Permissions-Policy', `camera=(self "${otherOrigin}")`)
  if (url.pathname === '/embed') { response.end('<!doctype html><title>Embedded request</title><input value="Original draft">' + helpers + `<iframe allow="camera" src="${otherOrigin}/page"></iframe>`); return }
  const selected = url.pathname === '/page' ? mode : 'plain'
  if (url.pathname === '/page') mode = 'plain'
  if (selected === 'fail-next') { request.socket.destroy(); return }
  response.end('<!doctype html><title>Private permission page</title><input value="Original draft">' + helpers +
    (selected === 'candidate' ? '<script>window.askCamera()</script>' : '') + (selected === 'candidate' || selected === 'hold-next' ? '<img src="/hold">' : ''))
})
const other = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Other native origin</title><input value="Original draft">' + helpers) })
await new Promise(done => other.listen(0, '127.0.0.1', done)); otherOrigin = `http://127.0.0.1:${other.address().port}`
await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${server.address().port}`
const urls = { page: origin + '/page', other: otherOrigin + '/page', embed: origin + '/embed', control: origin + '/control' }
function sourcePlugin(mutation) {
  return { name: 'exact-permission-source', setup(bundler) {
    bundler.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      let code = await readFile(path, 'utf8'); receipt.sources[relative(root, path)] = sha(code)
      if (path === join(root, 'apps/desktop/src/main/browser-site-permissions.ts')) {
        const anchor = 'await durableWriteFile(this.path,'
        assert.equal(code.split(anchor).length - 1, 1)
        code = code.replace(anchor, 'await globalThis.__permissionBeforeWrite?.(); ' + anchor)
      }
      if (mutation && path === join(root, mutation.file)) {
        assert.equal(code.split(mutation.from).length - 1, 1, 'Exact production mutation source')
        const before = sha(code); code = code.replace(mutation.from, mutation.to); mutation.loaded = { before, after: sha(code) }
      }
      return { contents: code, loader: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'js' }
    })
  } }
}
const mutation = { name: 'lost-precommit-site-owner', file: 'apps/desktop/src/main/browser-session-permissions.ts',
  from: 'const original = siteOwner(contents)', to: 'const original = undefined', assertion: 'Private permission observation expired: original native notification request' }
try {
  const preload = join(out, 'preload.cjs')
  await build({ entryPoints: [join(root, 'apps/desktop/src/preload/index.ts')], outfile: preload, bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
    conditions: ['browser', 'production'], external: ['electron'], plugins: [{ name: 'source-preload', setup(bundler) {
      bundler.onResolve({ filter: /^@agentmux\// }, args => { for (const alias of aliases) if (alias.find.test(args.path)) return { path: args.path.replace(alias.find, alias.replacement) } })
    } }, sourcePlugin(null)] })
  const renderer = join(out, 'renderer')
  await build({ entryPoints: [join(fixture, 'renderer.tsx')], outdir: renderer, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic',
    conditions: ['browser', 'production'], define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    loader: Object.fromEntries(['.woff2', '.woff', '.ttf', '.svg', '.png', '.jpg', '.gif', '.avif'].map(value => [value, 'file'])),
    plugins: [{ name: 'actual-browser-pane', setup(bundler) {
      bundler.onResolve({ filter: /^@agentmux\// }, args => { for (const alias of aliases) if (alias.find.test(args.path)) return { path: args.path.replace(alias.find, alias.replacement) } })
      bundler.onResolve({ filter: /\?(?:worker|url)$/ }, async args => {
        const suffix = args.path.slice(args.path.lastIndexOf('?') + 1), resolved = await bundler.resolve(args.path.slice(0, args.path.lastIndexOf('?')), { resolveDir: args.resolveDir, kind: 'import-statement' })
        return resolved.errors.length ? { errors: resolved.errors } : { path: resolved.path, namespace: 'permission-' + suffix }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'permission-url' }, async ({ path }) => ({ contents: await readFile(path), loader: 'file' }))
      bundler.onLoad({ filter: /.*/, namespace: 'permission-worker' }, async ({ path }) => {
        const name = sha(path).slice(0, 16) + '.js'; await build({ entryPoints: [path], outfile: join(renderer, 'workers', name), bundle: true, platform: 'browser', format: 'esm', target: 'es2022' })
        return { contents: `export default class extends Worker { constructor(options={}) { super(new URL('./workers/${name}',import.meta.url), {...options,type:'module'}) } }`, loader: 'js' }
      })
      bundler.onLoad({ filter: /\.css$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
        const contents = await readFile(path, 'utf8'); receipt.sources[relative(root, path)] = sha(contents); return { contents, loader: 'css', resolveDir: dirname(path) } })
    } }, sourcePlugin(null)] })
  await writeFile(join(renderer, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>')
  const home = await mkdtemp('/tmp/amux-permissions-')
  for (const candidate of [{ name: 'candidate', phases: ['seed', 'restart'], home }, { name: mutation.name, phases: ['seed'], home: await mkdtemp('/tmp/amux-permissions-mutation-'), mutation },
    { name: 'restored', phases: ['seed'], home: await mkdtemp('/tmp/amux-permissions-restored-') }]) {
    const compiled = join(out, candidate.name); await mkdir(compiled)
    await symlink(join(root, 'apps/desktop/node_modules'), join(compiled, 'node_modules')); await symlink(renderer, join(compiled, 'renderer')); await symlink(preload, join(compiled, 'preload.cjs'))
    const main = join(compiled, 'main.mjs')
    await build({ entryPoints: [join(fixture, 'main.ts')], outfile: main, bundle: true, external: ['electron'], platform: 'node', format: 'esm', target: 'node24',
      banner: { js: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" },
      plugins: [{ name: 'owning-workspace-modules', setup(bundler) { bundler.onResolve({ filter: /^@agentmux\// }, args => {
        for (const entry of mainModules) if (entry.find.test(args.path)) return { path: args.path.replace(entry.find, entry.replacement), external: entry.external }
      })
      // Source-bundled Host modules retain their own dependency resolution, rather than looking
      // for a transitive package in Desktop's node_modules beside this selected fixture output.
      bundler.onResolve({ filter: /^[^./]/ }, async args => {
        if (args.path.startsWith('@agentmux/') || isBuiltin(args.path) || args.pluginData?.absoluteExternal) return
        const selected = await bundler.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { absoluteExternal: true } })
        return selected.errors.length ? { errors: selected.errors } : { path: selected.path, external: true }
      }) } }, sourcePlugin(candidate.mutation)] })
    for (const phase of candidate.phases) {
      mode = 'plain'
      const phaseOut = join(compiled, phase); await mkdir(phaseOut)
      const bootstrap = join(phaseOut, 'bootstrap.cjs')
      await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(candidate.home)};for(const key of ['home','appData','userData','sessionData']){const value=path.join(root,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.commandLine.appendSwitch('no-proxy-server');app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(main).href)})).catch(e=>{console.error(e);app.exit(1)});`)
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
      Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(candidate.home, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(candidate.home, 'state'),
        AGENTMUX_PERMISSION_HOME: candidate.home, AGENTMUX_PERMISSION_OUT: phaseOut, AGENTMUX_PERMISSION_ASSETS: compiled, AGENTMUX_PERMISSION_URLS: JSON.stringify(urls),
        AGENTMUX_PERMISSION_PHASE: phase, AGENTMUX_PERMISSION_CAPTURE: candidate.name === 'candidate' && phase === 'seed' ? '1' : '0',
        AGENTMUX_PERMISSION_NODE: process.execPath, AGENTMUX_PERMISSION_CLI: join(root, 'packages/core/bin/amux') })
      const logs = [], processResult = await runProbeProcess(require('electron'), [bootstrap], { cwd: candidate.home, env, timeoutMs: 120000,
        onLine: line => { logs.push(line); console.log(`[${candidate.name}/${phase}] ${line}`) } })
      await writeFile(join(phaseOut, 'process.log'), logs.join('\n')); await stopProbeProcesses(processResult.originalPid, candidate.home)
      const remaining = await listProbeProcesses(processResult.originalPid, candidate.home)
      const row = { name: candidate.name, phase, home: candidate.home, process: processResult, remaining, actual: null, mutation: candidate.mutation ?? null }
      receipt.runs.push(row); await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
      const actual = JSON.parse(await readFile(join(phaseOut, 'native.json'), 'utf8')); row.actual = actual
      assert.equal(processResult.timedOut, false); assert.deepEqual(remaining, []); assert.deepEqual(actual.cleanup, []); assert.equal(actual.cleanupComplete, true)
      if (candidate.mutation) { assert.ok(candidate.mutation.loaded); assert.equal(processResult.exitCode, 1); assert.equal(actual.failure?.message, candidate.mutation.assertion)
        assert.ok(actual.native.some(row => row.permission === 'notifications' && row.answers.length === 1 && row.answers[0] === false), 'Mutation must fail the actual original native request, not bootstrap') }
      else { assert.equal(processResult.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true); assert.equal(actual.runtimeConnections, 0) }
      for (const pending of held) pending.end(''); held.clear()
    }
    await rm(candidate.home, { recursive: true, force: true })
  }
  for (const file of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-site-permissions.ts',
    'apps/desktop/src/main/browser-session-permissions.ts', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/components/BrowserSitePermissions.tsx',
    'apps/desktop/src/renderer/src/styles/browser.css', 'apps/desktop/src/preload/index.ts']) assert.ok(receipt.sources[file], 'Actual source consumer: ' + file)
  receipt.passed = true
} finally {
  for (const pending of held) pending.end(''); server.closeAllConnections(); other.closeAllConnections()
  await Promise.all([server, other].map(value => new Promise(done => value.close(done))))
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }))
}
