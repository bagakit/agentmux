import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { createServer as tcpServer, connect } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const repo = resolve(import.meta.dirname, '../../..'), require = createRequire(join(repo, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild'), { build: renderer } = await import(pathToFileURL(require.resolve('vite')))
const electron = require('electron'), hash = value => createHash('sha256').update(value).digest('hex')
const directory = join(repo, '.tmp/browser-proxy-probes'); await mkdir(directory, { recursive: true })
const out = await mkdtemp(join(directory, 'attempt-')), home = await mkdtemp('/tmp/amux-proxy-probes-')
const fixture = join(repo, 'apps/desktop/scripts/fixtures/browser-proxy-probes'), inputs = new Map(), servers = [], sockets = new Set()
const counts = { httpConnects: 0, socksConnections: 0, socksAuthentications: 0, socksAccepted: 0, exitRequests: [] }
const receipt = { schema: 'agentmux.browser-proxy-probes.native.v1', passed: false, out, source: {}, runs: [], images: [], counts,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  electron: { version: require('electron/package.json').version, sha256: hash(await readFile(electron)) },
  boundary: 'Actual private production Profile owners and native sessions, compiled public CLI and real HTTP CONNECT/RFC1929 servers. Component/styles use actual Main IPC facts. This is not an installed-App or complete Desktop workbench/Agent Run recovery test.' }
const listen = async server => { servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) }); await new Promise(done => server.listen(0, '127.0.0.1', done)); return server.address().port }
let probe
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', join(home, 'key.pem'), '-out', join(home, 'certificate.pem')], { stdio: 'ignore', timeout: 20_000 })
  const throughProxy = new Set()
  const target = httpsServer({ key: await readFile(join(home, 'key.pem')), cert: await readFile(join(home, 'certificate.pem')) }, (request, response) => {
    const viaProxy = throughProxy.has(request.socket.remotePort)
    if (request.url === '/drop') { request.destroy(); return }
    if (request.url === '/form') { response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><input aria-label="Draft"><script>document.querySelector('input').value=localStorage.getItem('profile-draft')||'';globalThis.profileProbePageFacts=()=>({url:location.href,draft:document.querySelector('input').value,cookie:document.cookie,local:localStorage.getItem('profile-draft')})</script>`); return }
    if (request.url === '/exit') { counts.exitRequests.push({ viaProxy }); response.end('203.0.113.19'); return }
    response.end('')
  })
  const targetPort = await listen(target), origin = `https://127.0.0.1:${targetPort}`
  const proxy = httpServer((_request, response) => { response.writeHead(502); response.end() })
  proxy.on('connect', (request, client, head) => {
    if (request.url !== `127.0.0.1:${targetPort}`) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
    counts.httpConnects++
    const upstream = connect(targetPort, '127.0.0.1', () => { throughProxy.add(upstream.localPort); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream) })
    sockets.add(upstream); upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.once('close', () => upstream.destroy())
    upstream.once('close', () => sockets.delete(upstream))
  })
  const httpPort = await listen(proxy)
  const socks = tcpServer(socket => {
    counts.socksConnections++; let buffer = Buffer.alloc(0), phase = 'greeting'
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes])
      if (phase === 'greeting' && buffer.length >= 2 + buffer[1]) {
        const methods = buffer.subarray(2, 2 + buffer[1]); buffer = buffer.subarray(2 + buffer[1]); phase = 'authentication'
        if (!methods.includes(2)) { socket.end(Buffer.from([5, 255])); phase = 'done' } else socket.write(Buffer.from([5, 2]))
        return
      }
      if (phase === 'authentication' && buffer.length >= 3 + buffer[1] && buffer.length >= 3 + buffer[1] + buffer[2 + buffer[1]]) {
        counts.socksAuthentications++
        const accepted = buffer[0] === 1 && buffer.subarray(2, 2 + buffer[1]).toString() === 'private-probe-user' && buffer.subarray(3 + buffer[1]).toString() === 'private-probe-password'
        if (accepted) counts.socksAccepted++; socket.write(Buffer.from([1, accepted ? 0 : 1])); phase = 'done'
      }
    })
  })
  const socksPort = await listen(socks)
  await renderer({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'profile-diagnostic-ui-source', async transform(code, id) { const path = id.split('?')[0]; if (path.startsWith(repo + '/') && !path.includes('/node_modules/')) inputs.set(path, hash(await readFile(path))) } }],
    build: { outDir: join(out, 'renderer'), emptyOutDir: false } })
  await symlink(join(repo, 'apps/desktop/node_modules'), join(out, 'node_modules')); await copyFile(join(fixture, 'preload.cjs'), join(out, 'preload.cjs'))
  await build({ entryPoints: [join(fixture, 'main.ts')], outfile: join(out, 'main.mjs'), platform: 'node', format: 'esm', target: 'node24', bundle: true, packages: 'external',
    banner: { js: "import{createRequire as __probeRequire}from'node:module';const require=__probeRequire(import.meta.url);" },
    plugins: [{ name: 'profile-diagnostic-main-source', setup(builder) { builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => { if (!args.path.startsWith(repo + '/') || args.path.includes('/node_modules/')) return; const source = await readFile(args.path); inputs.set(args.path, hash(source)); return { contents: source.toString(), loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' } }) } }] })
  for (const file of ['packages/core/dist/agentmux.js', 'packages/core/dist/browser-proxy-probe.js', 'packages/core/dist/browser-profile-control.js', 'packages/core/dist/rpc-business-codec.js', 'packages/core/src/browser-proxy-probe.ts', 'packages/core/src/browser-profile-control.ts', 'packages/core/src/rpc-business-codec.ts', 'apps/desktop/scripts/verify-browser-proxy-probes.mjs', 'apps/desktop/scripts/fixtures/browser-proxy-probes/preload.cjs']) inputs.set(join(repo, file), hash(await readFile(join(repo, file))))
  for (const file of ['apps/desktop/src/main/browser-profile-network-control.ts', 'apps/desktop/src/main/browser-profile-store.ts', 'apps/desktop/src/main/browser-profile-proxy-auth.ts', 'apps/desktop/src/main/browser-profile-exit-check.ts', 'apps/desktop/src/renderer/src/components/settings/ProfileNetworkDiagnostics.tsx']) assert.ok(inputs.has(join(repo, file)), 'Actual production consumer: ' + file)
  await writeFile(join(out, 'bootstrap.cjs'), `const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const key of ['home','appData','userData','sessionData']){const value=path.join(process.env.PROXY_PROBE_HOME,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.whenReady().then(()=>import('./main.mjs')).catch(error=>{console.error(error);fs.writeFileSync(path.join(process.env.PROXY_PROBE_OUT,process.env.PROXY_PROBE_PHASE+'.json'),JSON.stringify({passed:false,failure:{message:error.message,stack:error.stack}}));app.exit(1)});`)
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  const reports = []
  for (const phase of ['first', 'second']) {
    const beforeSocks = counts.socksAuthentications, lines = []
    const env = { ...cleanEnv, PROXY_PROBE_HOME: home, PROXY_PROBE_OUT: out, PROXY_PROBE_REPO: repo, PROXY_PROBE_NODE: process.execPath,
      PROXY_PROBE_PHASE: phase, PROXY_PROBE_ORIGIN: origin, PROXY_PROBE_HTTP: String(httpPort), PROXY_PROBE_SOCKS: String(socksPort) }
    probe = await runProbeProcess(electron, [join(out, 'bootstrap.cjs')], { cwd: home, temporaryRoot: home, env, timeoutMs: 180_000, onLine: line => { lines.push(line); console.log('[' + phase + '] ' + line) } })
    await stopProbeProcesses(probe.originalPid, home); const remaining = await listProbeProcesses(probe.originalPid, home)
    await writeFile(join(out, phase + '.log'), lines.join('\n')); const actual = JSON.parse(await readFile(join(out, phase + '.json'), 'utf8'))
    receipt.runs.push({ phase, process: probe, remaining }); reports.push(actual)
    assert.equal(probe.timedOut, false); assert.equal(probe.exitCode, 0, JSON.stringify(actual.failure)); assert.deepEqual(remaining, []); assert.equal(actual.passed, true)
    assert.ok(actual.cases.length >= (phase === 'first' ? 4 : 1) && actual.cli.length > 0)
    if (phase === 'second') assert.equal(counts.socksAuthentications, beforeSocks, 'History recovery must not authenticate again')
  }
  assert.notEqual(reports[0].pid, reports[1].pid); assert.deepEqual(reports[0].retained, reports[1].original)
  assert.ok(counts.httpConnects > 0 && counts.exitRequests.length > 0 && counts.exitRequests.every(row => row.viaProxy))
  assert.ok(counts.socksAccepted > 0 && counts.socksAuthentications > counts.socksAccepted)
  for (const file of reports[0].captures) receipt.images.push({ file, sha256: hash(await readFile(join(out, file))) })
  assert.equal(receipt.images.length, 4); receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  if (probe) await stopProbeProcesses(probe.originalPid, home)
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.map(server => new Promise(done => server.close(done))))
  const drift = []
  for (const [path, expected] of inputs) if (hash(await readFile(path)) !== expected) drift.push(relative(repo, path))
  receipt.source = Object.fromEntries([...inputs].map(([path, sha256]) => [relative(repo, path), sha256])); receipt.sourceDrift = drift
  if (drift.length) { receipt.passed = false; receipt.failure ??= { message: 'Native input source changed during this probe' } }
  for (const [source, name] of [[join(home, 'metadata/profiles.json'), 'original-profiles.json'], [join(home, 'retained.json'), 'original-retained.json']]) { try { await copyFile(source, join(out, name)) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  await rm(home, { recursive: true, force: true }); receipt.privateHomeRemoved = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') })); if (!receipt.passed) process.exitCode = 1
}
