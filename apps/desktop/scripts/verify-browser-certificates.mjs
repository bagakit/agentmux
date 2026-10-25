import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, readdir, symlink, stat } from 'node:fs/promises'
import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { createSecureServer } from 'node:http2'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build: esbuild } = createRequire(require.resolve('vite/package.json'))('esbuild')
const proof = join(root, '.tmp/browser-certificates'); await mkdir(proof, { recursive: true })
const out = await mkdtemp(join(proof, 'attempt-')), fixture = join(root, 'apps/desktop/scripts/fixtures/browser-certificates')
const receipt = { schema: 'agentmux.browser-certificates.proof.v1', passed: false, sources: {}, runs: [], out,
  boundary: 'Private test App, actual BrowserPane/production preload/complete IPC/BVM, native TLS and compiled public CLI. Trusted CDP input is confined to this fixture; no user Browser, system trust or installed App is touched. Renderer capturePage images do not prove OS child composition.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const aliases = []
for (const folder of [...(await readdir(join(root, 'packages'))).map(name => join(root, 'packages', name)), join(root, 'apps/host')]) {
  const pkg = JSON.parse(await readFile(join(folder, 'package.json')))
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = typeof value === 'string' ? value : value.browser ?? value.import
    if (typeof target !== 'string') continue
    let replacement = resolve(folder, target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    const id = pkg.name + (key === '.' ? '' : key.slice(1)), wildcard = id.includes('*')
    if (!wildcard) { try { await stat(replacement) } catch { replacement = replacement.replace(/\.ts$/u, '.tsx'); try { await stat(replacement) } catch { continue } } }
    aliases.push({ find: new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$'), replacement: replacement.replace('*', '$1'), wildcard, id })
  }
}
aliases.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.id.length - a.id.length)
const mutations = [
  { name: 'lost-native-handle', file: 'apps/desktop/src/main/browser-view-manager.ts',
    from: 'const contents = pending.contents', to: 'const contents = pending.view.webContents', cleanupFailure: true,
    assertion: 'Owner browsers disposal failed' },
  { name: 'stale-answer', file: 'apps/desktop/src/main/browser-certificates.ts',
    from: "input.requestId !== request.requestId ||", to: 'false ||', assertion: 'A foreign certificate answer must be rejected' },
  { name: 'lost-public-facts', file: 'apps/desktop/src/main/browser-view-manager.ts',
    from: 'certificateRequest: entry.certificateDecision?.request ?? null,', to: 'certificateRequest: null,', firstOnly: true,
    assertion: 'Actual public CLI retains the original pending certificate facts' },
  { name: 'lost-human-answer', file: 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
    from: 'fingerprint: request.fingerprint, allow', to: 'fingerprint: request.fingerprint, allow: false',
    assertion: 'human acceptance resumes original native callback' }
]
function plugin(mutation) {
  return {
    async transform(code, id) {
      const file = id.split('?')[0]
      if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return
      receipt.sources[relative(root, file)] = sha(await readFile(file))
      if (mutation && file === join(root, mutation.file)) {
        const count = code.split(mutation.from).length - 1
        assert.equal(count, mutation.firstOnly ? 2 : 1, 'Unique actual source mutation anchor: ' + mutation.name)
        const changed = code.replace(mutation.from, mutation.to)
        mutation.loaded = { before: sha(code), after: sha(changed), count }
        return { code: changed, map: null }
      }
    }
  }
}
const keyFile = join(out, 'key.pem'), certFile = join(out, 'cert.pem')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Private Browser proof',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1', '-keyout', keyFile, '-out', certFile], { stdio: 'pipe' })
const tls = { key: await readFile(keyFile), cert: await readFile(certFile) }
const otherKey = join(out, 'other-key.pem'), otherCert = join(out, 'other-cert.pem')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Changed private certificate',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1', '-keyout', otherKey, '-out', otherCert], { stdio: 'pipe' })
const changedTls = { key: await readFile(otherKey), cert: await readFile(otherCert) }

const sessions = new Set(), sockets = new Set()
const servers = [createServer(tls, (_request, response) => response.end('<!doctype html><title>Private TLS page</title><h1>Original secure page</h1>')),
  createServer(changedTls, (_request, response) => response.end('<!doctype html><title>Independent TLS page</title>')),
  createSecureServer(tls)]
servers[2].on('stream', stream => { stream.respond({ ':status': 200, 'content-type': 'text/html' }); stream.end('<!doctype html><title>Private H2 page</title>') })
for (const server of servers) {
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)) })
  server.on('tlsClientError', () => {})
  await new Promise(done => server.listen(0, '127.0.0.1', done))
}
const urls = Object.fromEntries(['first', 'second', 'h2'].map((name, index) => [name, `https://127.0.0.1:${servers[index].address().port}/`]))
const rotation = createHttpServer((_request, response) => { servers[0].setSecureContext(changedTls); servers[0].closeAllConnections(); response.end('rotated') })
await new Promise(done => rotation.listen(0, '127.0.0.1', done))
urls.rotate = `http://127.0.0.1:${rotation.address().port}/`
const home = await mkdtemp(join(tmpdir(), 'amx-cert-'))
try {
  const unitFile = join(out, 'focused-tests.json')
  execFileSync(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/scripts/fixtures/browser-private/vitest.config.mts',
    'apps/desktop/test/browser-certificates.test.ts', 'apps/desktop/test/browser-view-manager.test.ts',
    '-t', 'original PEM|mismatched answers|owner changes|public discovery|trusted App sender|Profile candidate native destruction receipt',
    '--reporter=json', '--outputFile=' + unitFile], { cwd: root, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 })
  const unit = JSON.parse(await readFile(unitFile)); assert.equal(unit.success, true); assert.equal(unit.numPassedTests, 6)
  receipt.unit = { file: unitFile, passed: unit.numPassedTests }
  const preload = join(out, 'preload.cjs')
  await esbuild({ entryPoints: [join(root, 'apps/desktop/src/preload/index.ts')], outfile: preload, bundle: true, platform: 'browser', format: 'cjs',
    target: 'es2022', conditions: ['module', 'browser', 'production'], external: ['electron'], logLevel: 'error',
    plugins: [{ name: 'actual-preload', setup(build) { build.onResolve({ filter: /^@agentmux\// }, args => {
      for (const alias of aliases) if (alias.find.test(args.path)) return { path: args.path.replace(alias.find, alias.replacement) }
    }) } }] })
  let rendererAssets
  for (const mutation of process.env.AGENTMUX_CERT_BASELINE_ONLY === '1' ? [null] : [null, ...mutations, null]) {
    const name = mutation?.name ?? (receipt.runs.length ? 'restored' : 'baseline'), compiled = join(out, name)
    await mkdir(compiled); await symlink(join(root, 'apps/desktop/node_modules'), join(compiled, 'node_modules'))
    servers[0].setSecureContext(tls); servers[0].closeAllConnections()
    const main = join(compiled, 'main/main.mjs')
    await esbuild({ entryPoints: [join(fixture, 'main.ts')], outfile: main, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', logLevel: 'error',
      banner: { js: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" },
      plugins: [{ name: 'actual-main', setup(build) { build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async ({ path }) => {
        if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
        const code = await readFile(path, 'utf8')
        const changed = await plugin(mutation).transform(code, path)
        return { contents: changed?.code ?? code, loader: 'ts' }
      }) } }] })
    const rendererChanged = mutation?.name === 'lost-human-answer'
    if (rendererAssets && !rendererChanged) await symlink(rendererAssets, join(compiled, 'renderer'))
    else {
    await esbuild({ entryPoints: [join(fixture, 'renderer.tsx')], outdir: join(compiled, 'renderer'), bundle: true, platform: 'browser', format: 'esm',
      target: 'es2022', jsx: 'automatic', conditions: ['browser', 'production'], define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
      loader: Object.fromEntries(['.woff2', '.woff', '.ttf', '.svg', '.png', '.jpg', '.gif'].map(key => [key, 'file'])), logLevel: 'error', metafile: true,
      plugins: [{ name: 'actual-certificate-renderer', setup(build) {
        build.onResolve({ filter: /\?(?:worker|url)$/ }, async args => {
          const suffix = args.path.slice(args.path.lastIndexOf('?') + 1)
          const resolved = await build.resolve(args.path.slice(0, args.path.lastIndexOf('?')), { resolveDir: args.resolveDir, kind: 'import-statement' })
          if (resolved.errors.length) return { errors: resolved.errors }
          return { path: resolved.path, namespace: 'certificate-' + suffix }
        })
        build.onLoad({ filter: /.*/, namespace: 'certificate-url' }, async ({ path }) => ({ contents: await readFile(path), loader: 'file' }))
        build.onLoad({ filter: /.*/, namespace: 'certificate-worker' }, async ({ path }) => {
          const name = sha(Buffer.from(path)).slice(0, 16) + '.js'
          await esbuild({ entryPoints: [path], outfile: join(compiled, 'renderer/workers', name), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'error' })
          return { contents: `export default class extends Worker { constructor(options={}) { super(new URL('./workers/${name}',import.meta.url), {...options,type:'module'}) } }`, loader: 'js' }
        })
        build.onLoad({ filter: /\.css$/ }, async ({ path }) => {
          if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
          const contents = await readFile(path, 'utf8'); receipt.sources[relative(root, path)] = sha(Buffer.from(contents))
          return { contents, loader: 'css', resolveDir: dirname(path) }
        })
        build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
        const code = await readFile(path, 'utf8'), changed = await plugin(mutation).transform(code, path)
        return { contents: changed?.code ?? code, loader: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'js' }
      }) } }] })
    await writeFile(join(compiled, 'renderer/index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./renderer.css"><div id="root"></div><script type="module" src="./renderer.js"></script>')
    if (!rendererChanged) rendererAssets = join(compiled, 'renderer')
    }
    await writeFile(join(compiled, 'preload.cjs'), await readFile(preload))
    const bootstrap = join(compiled, 'bootstrap.cjs'), resultFile = join(compiled, 'native.json')
    await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(home)};for(const key of ['home','appData','userData','sessionData']){const value=path.join(root,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.commandLine.appendSwitch('no-proxy-server');app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(main).href)})).catch(e=>{console.error(e);app.exit(1)});`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { HOME: join(home, 'home'), AGENTMUX_RUNTIME_DIRECTORY: join(home, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(home, 'state'),
      AGENTMUX_CERT_HOME: home, AGENTMUX_CERT_OUT: compiled, AGENTMUX_CERT_ASSETS: compiled, AGENTMUX_CERT_URLS: JSON.stringify(urls),
      AGENTMUX_CERT_NODE: process.execPath, AGENTMUX_CERT_CLI: join(root, 'packages/core/bin/amux') })
    const logs = [], processResult = await runProbeProcess(require('electron'), [bootstrap], { cwd: home, env, timeoutMs: 45000, onLine: line => logs.push(line) })
    await writeFile(join(compiled, 'process.log'), logs.join('\n'))
    await stopProbeProcesses(processResult.originalPid, home)
    const remaining = await listProbeProcesses(processResult.originalPid, home)
    const actual = JSON.parse(await readFile(resultFile)), row = { name, process: processResult, remaining, actual, mutation }
    receipt.runs.push(row); await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    assert.equal(processResult.timedOut, false); assert.deepEqual(remaining, []); assert.equal(actual.cleanupComplete, true); if (!mutation?.cleanupFailure) assert.deepEqual(actual.cleanup, [])
    if (mutation) {
      assert.ok(mutation.loaded && mutation.loaded.before !== mutation.loaded.after, 'Nonempty loaded mutation')
      assert.equal(processResult.exitCode, 1);
      if (mutation.cleanupFailure) assert.ok(JSON.stringify(actual.cleanup).includes(mutation.assertion), 'Original candidate cleanup mutation must fail its real disposal')
      else assert.ok(actual.failure?.message.includes(mutation.assertion), JSON.stringify(actual.failure))
    } else {
      assert.equal(processResult.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true); assert.equal(actual.cases.length, 6)
      assert.equal(actual.images.length, 2)
      if (name === 'restored') assert.ok(actual.descriptor.previousRevision > 0, 'Actual original descriptor and default TLS decisions survive process restart')
    }
  }
  for (const file of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-certificates.ts',
    'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/components/BrowserCertificateSurface.tsx']) assert.ok(receipt.sources[file], 'Actual source consumer: ' + file)
  receipt.passed = true
} finally {
  await new Promise(done => rotation.close(done))
  for (const session of sessions) session.destroy()
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.map(server => new Promise(done => server.close(done))))
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }))
}
