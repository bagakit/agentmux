import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { createServer as tcpServer, connect } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'
const repo = resolve(import.meta.dirname, '../../..'), req = createRequire(join(repo, 'apps/desktop/package.json'))
const { build } = createRequire(req.resolve('vite/package.json'))('esbuild'), electron = req('electron'), hash = value => createHash('sha256').update(value).digest('hex')
const directory = join(repo, '.tmp/browser-proxy-transport-tcp'); await mkdir(directory, { recursive: true })
const out = await mkdtemp(join(directory, 'attempt-')), home = await mkdtemp('/tmp/amux-proxy-tcp-'), fixture = join(repo, 'apps/desktop/scripts/fixtures/browser-proxy-transport-tcp')
const inputs = new Map(), servers = [], sockets = new Set(), upstreams = new Map()
const mutationName = process.argv.find(value => value.startsWith('--mutation='))?.split('=')[1]
const mutations = {
 connect: ["context.server.on('connect', (request_, client, head) => {", "context.server.on('connect', (request_, client, head) => { client.end('HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n'); return;"],
 unknown: ["if (credential === undefined && previous?.active && same(previous.route, network))", 'if (false)'],
 scope: ['const context = contexts.get(session)\n      if (!context?.active', 'const context = [...contexts.values()][0]\n      if (!context?.active'],
 header: ["delete output['proxy-authorization'];", 'void output;']
}
if (mutationName && !mutations[mutationName]) throw Error('Unknown exact TCP production mutation')
const counts = { auth: { connections: 0, accepted: 0, rejected: 0, commands: [] }, plain: { connections: 0, accepted: 0, rejected: 0, commands: [] }, requests: [] }
const receipt = { schema: 'agentmux.profile-transport.tcp.native.v1', tcpPassed: false, taskComplete: false, unfinished: ['UDP relay', 'QUIC'], out,
 head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), source: {}, sourceDrift: [], mutation: mutationName ?? null, mutationHits: [], processes: [], counts, historyReadSnapshots: [],
 electron: { version: req('electron/package.json').version, executableSha256: hash(await readFile(electron)) },
 boundary: 'Real local HTTP/HTTPS and authenticated SOCKS TCP, original production Profile Store/Manager/Session/credential/networkControl and compiled current public CLI/RPC. Exact leaf certificate is accepted only by these private native Sessions. No global certificate override, UDP/QUIC, installed App, full Desktop/Agent Run recovery or external account claim.' }
const tracked = socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket }
const listen = async server => { servers.push(server); server.on('connection', tracked); await new Promise(resolve_ => server.listen(0, '127.0.0.1', resolve_)); return server.address().port }
let probe
try {
 const sslConfig = '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n'
 await writeFile(join(home, 'openssl.cnf'), sslConfig)
 for (const name of ['trusted', 'other']) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(home, 'openssl.cnf'), '-keyout', join(home, name + '.key'), '-out', join(home, name + '.pem')], { stdio: 'ignore', timeout: 20_000 })
 const certificate = await readFile(join(home, 'trusted.pem')), fingerprint = new X509Certificate(certificate).fingerprint256
 const otherCertificate = await readFile(join(home, 'other.pem'))
 receipt.certificates = { acceptedLeafFingerprint256: fingerprint, acceptedPemSha256: hash(certificate), otherLeafFingerprint256: new X509Certificate(otherCertificate).fingerprint256, policy: 'exact leaf and exact hostname on private fixture Sessions only' }
 await writeFile(join(out, 'accepted-public-certificate.pem'), certificate)
 const site = `<!doctype html><input aria-label="Original site draft"><script>
 document.querySelector('input').value=localStorage.getItem('original-site-draft')||'';
 const openDB=()=>new Promise((resolve,reject)=>{const q=indexedDB.open('original-tcp-site',1);q.onupgradeneeded=()=>q.result.createObjectStore('values');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
 globalThis.tcpSeedSite=async id=>{localStorage.setItem('original-site-draft','draft-'+id);document.querySelector('input').value='draft-'+id;document.cookie='original_tcp_site='+id+'; Max-Age=3600; Secure; SameSite=Lax';const db=await openDB();await new Promise((resolve,reject)=>{const t=db.transaction('values','readwrite');t.objectStore('values').put('indexed-'+id,'proof');t.oncomplete=resolve;t.onerror=()=>reject(t.error)});db.close()};
 globalThis.tcpSiteFacts=async()=>{const db=await openDB();const value=await new Promise((resolve,reject)=>{const q=db.transaction('values').objectStore('values').get('proof');q.onsuccess=()=>resolve(q.result??null);q.onerror=()=>reject(q.error)});db.close();return{url:location.href,draft:document.querySelector('input').value,cookie:document.cookie,local:localStorage.getItem('original-site-draft'),indexed:value}};
 </script>`
 const handler = kind => (request_, response) => {
  const via = upstreams.get(request_.socket.localPort + ':' + request_.socket.remotePort) ?? 'direct'
  counts.requests.push({ kind, path: request_.url, via, tls: Boolean(request_.socket.encrypted), proxyAuthorizationPresent: Boolean(request_.headers['proxy-authorization']), proxyConnectionPresent: Boolean(request_.headers['proxy-connection']), cookiePresent: Boolean(request_.headers.cookie) })
  response.setHeader('Content-Type', request_.url === '/form' ? 'text/html' : 'text/plain')
  response.end(request_.url === '/form' ? site : request_.url === '/exit' ? '203.0.113.29' : 'original TCP endpoint')
 }
 const httpPort = await listen(httpServer(handler('http')))
 const tls = httpsServer({ key: await readFile(join(home, 'trusted.key')), cert: certificate }, handler('https')); tls.on('tlsClientError', () => {})
 const httpsPort = await listen(tls)
 const badTls = httpsServer({ key: await readFile(join(home, 'other.key')), cert: await readFile(join(home, 'other.pem')) }, handler('other-certificate')); badTls.on('tlsClientError', () => {})
 const badPort = await listen(badTls), allowedPorts = new Set([httpPort, httpsPort, badPort])
 const socks = async (authentication, stats) => await listen(tcpServer(socket => {
  stats.connections++; let bytes = Buffer.alloc(0), phase = 'greeting'
  const data = part => { bytes = Buffer.concat([bytes, part]); for (;;) {
   if (phase === 'greeting') { if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return; const methods = bytes.subarray(2, 2 + bytes[1]); bytes = bytes.subarray(2 + bytes[1]); const method = authentication ? 2 : 0; if (!methods.includes(method)) { phase = 'done'; socket.end(Buffer.from([5, 255])); return } socket.write(Buffer.from([5, method])); phase = authentication ? 'authentication' : 'request' }
   else if (phase === 'authentication') {
    if (bytes.length < 2 || bytes.length < 3 + bytes[1] || bytes.length < 3 + bytes[1] + bytes[2 + bytes[1]]) return
    const n = bytes[1], m = bytes[2 + n], accepted = bytes[0] === 1 && bytes.subarray(2, 2 + n).toString() === 'synthetic-native-user' && bytes.subarray(3 + n, 3 + n + m).toString() === 'synthetic-native-password'
    bytes = bytes.subarray(3 + n + m); stats[accepted ? 'accepted' : 'rejected']++; socket.write(Buffer.from([1, accepted ? 0 : 1])); phase = accepted ? 'request' : 'done'; if (!accepted) { socket.end(); return }
   } else if (phase === 'request') {
    if (bytes.length < 5) return
    const size = bytes[3] === 1 ? 4 : bytes[3] === 3 ? 1 + bytes[4] : bytes[3] === 4 ? 16 : 0, length = 4 + size + 2
    if (!size) { socket.destroy(); return }; if (bytes.length < length) return
    const command = bytes[1], port = bytes.readUInt16BE(length - 2), host = bytes[3] === 1 ? [...bytes.subarray(4, 8)].join('.') : bytes[3] === 3 ? bytes.subarray(5, 5 + bytes[4]).toString() : ''
    stats.commands.push({ command, port }); bytes = bytes.subarray(length)
    if (command !== 1 || !allowedPorts.has(port) || !['127.0.0.1', 'localhost'].includes(host)) { socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); phase = 'done'; return }
    phase = 'pipe'; socket.off('data', data)
    const upstream = tracked(connect(port, '127.0.0.1', () => { const key = port + ':' + upstream.localPort; upstreams.set(key, authentication ? 'auth' : 'plain'); upstream.once('close', () => upstreams.delete(key)); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (bytes.length) upstream.write(bytes); socket.pipe(upstream); upstream.pipe(socket) })); upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy()); return
   } else return
  } }
  socket.on('data', data)
 }))
 const plainPort = await socks(false, counts.plain), authPort = await socks(true, counts.auth)
 const manifest = JSON.parse(await readFile(join(repo, 'packages/core/package.json'), 'utf8'))
 const alias = Object.fromEntries(Object.entries(manifest.exports).filter(([, value]) => value?.types).map(([name, value]) => ['@agentmux/core' + (name === '.' ? '' : name.slice(1)), join(repo, 'packages/core', value.types.replace('./dist/', 'src/').replace('.d.ts', '.ts'))]))
 const sourcePlugin = { name: 'original-profile-tcp-loaded-source', setup(builder) {
  builder.onResolve({ filter: /^[^./]/ }, async args => { if (args.pluginData?.resolved || args.path === 'electron' || args.path.startsWith('node:')) return; const result = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolved: true } }); if (result.errors.length) return { errors: result.errors }; return { path: result.path, external: !result.path.startsWith(join(repo, 'packages/core/src') + '/') && !result.path.includes('/src/') } })
  builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
   if (!args.path.startsWith(repo + '/') || args.path.includes('/node_modules/')) return
   const raw = await readFile(args.path); inputs.set(args.path, hash(raw)); let code = raw.toString()
   if (mutationName && args.path === join(repo, 'apps/desktop/src/main/browser-profile-socks-transport.ts')) { const [before, after] = mutations[mutationName]; assert.equal(code.split(before).length, 2, 'Mutation must load exactly one production branch'); code = code.replace(before, after); receipt.mutationHits.push({ name: mutationName, path: relative(repo, args.path), originalSha256: hash(raw), effectiveSha256: hash(code) }) }
   return { contents: code.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href)).replaceAll('import.meta.dirname', JSON.stringify(dirname(args.path))), loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' }
  })
 } }
 const options = { bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['electron', 'node:*'], banner: { js: "import{createRequire as __r}from'node:module';const require=__r(import.meta.url);" }, plugins: [sourcePlugin] }
 inputs.set(import.meta.filename, hash(await readFile(import.meta.filename)))
 await mkdir(join(repo, 'packages/core/dist'), { recursive: true })
 await build({ ...options, entryPoints: [join(repo, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: join(repo, 'packages/core/dist/control-endpoint-listener-worker.js') })
 inputs.set(join(repo, 'packages/core/dist/control-endpoint-listener-worker.js'), hash(await readFile(join(repo, 'packages/core/dist/control-endpoint-listener-worker.js'))))
 await build({ ...options, alias, entryPoints: [join(fixture, 'main.ts')], outfile: join(out, 'main.mjs') })
 await build({ ...options, entryPoints: [join(repo, 'packages/core/src/agentmux.ts')], outfile: join(out, 'cli.mjs') })
 if (mutationName) assert.equal(receipt.mutationHits.length, 1)
 await symlink(join(repo, 'apps/desktop/node_modules'), join(out, 'node_modules'))
 await writeFile(join(out, 'bootstrap.cjs'), `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const name of ['home','appData','userData','sessionData']){const p=path.join(process.env.TCP_NATIVE_HOME,name);fs.mkdirSync(p,{recursive:true});app.setPath(name,p)}app.whenReady().then(()=>import('./main.mjs')).catch(error=>{console.error(error);app.exit(1)});`)
 receipt.bundles = Object.fromEntries(await Promise.all(['main.mjs', 'cli.mjs', 'bootstrap.cjs'].map(async name => [name, hash(await readFile(join(out, name)))])))
 const reports = [], envBase = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE' && !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
 for (const phase of ['first', 'second']) {
  const authBefore = counts.auth.connections, plainBefore = counts.plain.connections, lines = []
  probe = await runProbeProcess(electron, [join(out, 'bootstrap.cjs')], { cwd: home, temporaryRoot: home, env: { ...envBase, TCP_NATIVE_HOME: home, TCP_NATIVE_OUT: out, TCP_NATIVE_NODE: process.execPath, TCP_NATIVE_PHASE: phase, TCP_NATIVE_CONFIG: JSON.stringify({ plainPort, authPort, httpOrigin: `http://127.0.0.1:${httpPort}`, httpsOrigin: `https://127.0.0.1:${httpsPort}`, badHttpsOrigin: `https://127.0.0.1:${badPort}`, fingerprint }) }, timeoutMs: 90_000, onLine: line => {
   lines.push(line)
   try { const marker = JSON.parse(line); if (marker.type === 'tcp-native-stage' && marker.phase === 'second' && marker.stage === 'history-read-without-dispatch') receipt.historyReadSnapshots.push({ pid: marker.pid, authConnections: counts.auth.connections - authBefore, plainConnections: counts.plain.connections - plainBefore }) } catch { /* Native runtime diagnostic, not a protocol receipt. */ }
  } })
  await stopProbeProcesses(probe.originalPid, home); const remaining = await listProbeProcesses(probe.originalPid, home)
  receipt.processes.push({ phase, ...probe, remaining }); await writeFile(join(out, phase + '.log'), lines.join('\n'))
  const actual = JSON.parse(await readFile(join(out, phase + '.json'), 'utf8')); reports.push(actual)
  assert.equal(probe.timedOut, false); assert.equal(probe.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true, JSON.stringify(actual.failure)); assert.deepEqual(remaining, [])
  assert.equal(actual.pid, probe.originalPid)
 }
 assert.notEqual(reports[0].pid, reports[1].pid); assert.deepEqual(reports[0].original, reports[1].original)
 assert.equal(receipt.historyReadSnapshots.length, 1); assert.equal(receipt.historyReadSnapshots[0].pid, reports[1].pid); assert.equal(receipt.historyReadSnapshots[0].authConnections, 0); assert.equal(receipt.historyReadSnapshots[0].plainConnections, 0)
 assert.ok(counts.requests.some(row => row.kind === 'https' && row.via === 'auth' && row.tls), 'Native authenticated HTTPS must traverse the original SOCKS TCP backend')
 assert.ok(counts.requests.some(row => row.kind === 'http' && row.path === '/http-control' && row.via === 'auth' && !row.tls), 'Native ordinary HTTP must traverse the same authenticated transport')
 assert.ok(counts.requests.some(row => row.kind === 'https' && row.via === 'plain' && row.tls)); assert.ok(counts.requests.some(row => row.kind === 'https' && row.via === 'direct' && row.tls))
 assert.ok(counts.auth.rejected > 0); assert.ok(counts.auth.accepted > 0); assert.ok(counts.auth.commands.every(row => row.command === 1))
 assert.equal(counts.requests.some(row => row.path === '/refused-credential' || row.path === '/unadmitted-local'), false)
 assert.equal(counts.requests.some(row => row.proxyAuthorizationPresent || row.proxyConnectionPresent), false, 'Private proxy authorization must never reach the original endpoint')
 receipt.tcpPassed = true
} catch (cause) { receipt.failure = { message: cause.message, stack: cause.stack } }
finally {
 if (probe) await stopProbeProcesses(probe.originalPid, home)
 for (const socket of sockets) socket.destroy(); await Promise.all(servers.map(server => new Promise(resolve_ => server.close(resolve_))))
 receipt.source = Object.fromEntries([...inputs].map(([file, digest]) => [relative(repo, file), digest])); for (const [file, digest] of inputs) if (hash(await readFile(file)) !== digest) receipt.sourceDrift.push(relative(repo, file))
 if (receipt.sourceDrift.length) { receipt.tcpPassed = false; receipt.failure ??= { message: 'Native TCP source changed during qualification' } }
 await rm(home, { recursive: true, force: true }); receipt.privateHomeRemoved = true
 await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ tcpPassed: receipt.tcpPassed, taskComplete: false, receipt: join(out, 'receipt.json'), mutation: mutationName ?? null })); if (!receipt.tcpPassed) process.exitCode = 1
}
