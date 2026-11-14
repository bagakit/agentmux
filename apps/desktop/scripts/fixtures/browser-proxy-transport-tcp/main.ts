import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { X509Certificate, createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { request } from 'node:http'
import { app, BrowserWindow, safeStorage, type Session } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { createBrowserProfileProxyAuth, createBrowserProfileProxyLoginHandler } from '../../../src/main/browser-profile-proxy-auth.js'
import { createBrowserProfileNetworkControl } from '../../../src/main/browser-profile-network-control.js'
import { createBrowserProfileExitCheck } from '../../../src/main/browser-profile-exit-check.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../../../src/main/browser-profile-control.js'
const home = process.env.TCP_NATIVE_HOME!, out = process.env.TCP_NATIVE_OUT!, node = process.env.TCP_NATIVE_NODE!, phase = process.env.TCP_NATIVE_PHASE!
const config = JSON.parse(process.env.TCP_NATIVE_CONFIG!), descriptor = join(home, 'retained.json'), credentialFile = join(home, 'credentials.json')
const user = 'synthetic-native-user', password = 'synthetic-native-password', refusedPassword = 'synthetic-refused-password'
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const report: any = { schema: 'agentmux.proxy-transport.tcp.process.v1', phase, pid: process.pid, passed: false, cases: [], cli: [], certificateFingerprint: config.fingerprint, pins: { accepted: 0, rejected: 0 }, stage: 'initializing',
 sharedLoginEntry: { owner: 'browser-profile-proxy-auth.ts', export: 'createBrowserProfileProxyLoginHandler', profileQueries: 0, transportQueries: 0, transportAnswers: 0 },
 boundary: 'Private original Profile Store/Manager/Session/credential/network owners and compiled public CLI. Exact private-session certificate pin, local HTTP/HTTPS and RFC1928/1929 TCP only. No UDP/QUIC, installed App, full workbench or Agent Run recovery claim.' }
let profiles: BrowserProfileManager | undefined, control: AgentMuxControlServer | undefined
const pages: BrowserWindow[] = []
app.on('window-all-closed', () => {})
async function cli(args: string[]) {
 const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(node, [join(out, 'cli.mjs'), '--endpoint', 'unix:' + join(home, 'control.sock'), 'browser', 'profile', 'network', ...args], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE' && !/^(AGENTMUX_|CTXMUX_)/u.test(name))), NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Original private network CLI reader expired')) }, 45_000)
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value }); child.once('error', reject); child.once('close', code => { clearTimeout(timeout); resolve({ code: code ?? -1, stdout, stderr }) })
 })
 report.cli.push({ method: args[0], code: result.code }); assert.equal(result.code, 0, 'Compiled original network CLI must complete: ' + result.stderr)
 const body = JSON.parse(result.stdout); assert.equal(body.ok, true); return body.result
}
const configuration = (profile: any) => { const { networkApplication, environmentApplication, ...saved } = profile; return saved }
async function facts(page: BrowserWindow) { return await page.webContents.executeJavaScript('tcpSiteFacts()') }
async function main() {
 try {
  assert.ok(phase === 'first' || phase === 'second', 'Only exact native qualification phases are supported')
  await app.whenReady(); app.setActivationPolicy?.('prohibited')
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(home, 'profiles.json'))); await profiles.initialize()
  const prior = phase === 'second' ? JSON.parse(await readFile(descriptor, 'utf8')) : null
  if (phase === 'second') assert.ok(prior?.ids && prior.partitions && prior.storagePaths && prior.site, 'Second PID must receive the original retained identities; no empty reseeding')
  const ids = prior ? prior.ids : { direct: profiles.defaultProfileId(), plain: (await profiles.createProfile('Original native plain SOCKS')).id, auth: (await profiles.createProfile('Original native authenticated SOCKS')).id }
  if (!prior) {
   await profiles.updateProfile(ids.direct, { network: { mode: 'direct' } }, profiles.configurationRevision(ids.direct)!)
   for (const [id, port] of [[ids.plain, config.plainPort], [ids.auth, config.authPort]] as const) await profiles.updateProfile(id, { network: { mode: 'proxy', server: `socks5://127.0.0.1:${port}`, bypass: ['<-loopback>'] } }, profiles.configurationRevision(id)!)
  } else {
   for (const id of Object.values(ids) as string[]) { assert.ok(profiles.listProfiles().some(profile => profile.id === id), 'Second PID must find the original Profile, not create a replacement'); assert.equal(profiles.resolvePartition(id), prior.partitions[id]) }
   assert.equal(hash(await readFile(credentialFile)), prior.encryptedCredentialHash)
  }
  for (const id of Object.values(ids) as string[]) profiles.sessions.nativeSession(id).setCertificateVerifyProc((request_, done) => {
   let accepted = false
   try { accepted = request_.hostname === '127.0.0.1' && new X509Certificate(request_.certificate.data).fingerprint256 === config.fingerprint } catch { /* This private fixture accepts only its exact leaf certificate. */ }
   report.pins[accepted ? 'accepted' : 'rejected']++; done(accepted ? 0 : -2)
  })
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'Native safeStorage must be available; no replacement cipher is used')
  const credential = createBrowserProfileProxyAuth({ path: credentialFile, crypto: { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) }, profileOfSession: session => profiles!.profileOfSession(session), proxyOf: id => profiles!.proxyOf(id), configurationRevision: id => profiles!.configurationRevision(id), report: () => {} })
  profiles.bindProxyCredentialsBeforeNetworkChange = id => credential.bindCurrentProxy(id)
  let address = config.httpsOrigin + '/exit'
  const checkExit = createBrowserProfileExitCheck({ session: id => profiles!.sessions.nativeSession(id), prepare: id => profiles!.prepareSession(id), fetch: (id, url, signal) => profiles!.sessions.fetch(id, url, signal), now: () => performance.now() })
  const network = createBrowserProfileNetworkControl({ profiles, proxyAuth: credential, checkExit, checkAddress: () => address, reconnect: id => profiles!.sessions.nativeSession(id).closeAllConnections() })
  app.on('login', createBrowserProfileProxyLoginHandler({
   profileOfSession: target => { report.sharedLoginEntry.profileQueries++; return profiles!.profileOfSession(target) },
   proxyOf: id => profiles!.proxyOf(id),
   answerProxyTransport: (target, auth, callback) => { report.sharedLoginEntry.transportQueries++; const answered = profiles!.sessions.answerProxyTransport(target, auth, callback); if (answered) report.sharedLoginEntry.transportAnswers++; return answered },
   proxyAuth: credential
  }))
  control = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: () => [], execute: async (request_, context) => {
   if (!isBrowserProfileControlRequest(request_)) throw new Error('Only original Profile network operations belong to this private endpoint')
   return await executeBrowserProfileControl(request_, { profiles: profiles!, network, usage: {} as never }, context?.actor)
  } }); await control.start()
  if (!prior) await network.setProxySignIn(ids.auth, { username: user, password })
  else {
   const history = await cli(['history', '--profile', ids.auth, '--operation-id', 'tcp-original-first'])
   assert.deepEqual(history.diagnostics, prior.originalDiagnostic)
   console.error(JSON.stringify({ type: 'tcp-native-stage', phase, stage: 'history-read-without-dispatch', pid: process.pid }))
   report.cases.push({ kind: 'original-network-history-in-new-process', originalId: 'tcp-original-first', count: history.diagnostics.length })
  }
  const openPage = async (id: string) => { await profiles!.prepareSession(id); const page = new BrowserWindow({ show: false, width: 680, height: 500, webPreferences: { partition: profiles!.resolvePartition(id), sandbox: true, contextIsolation: true } }); pages.push(page); profiles!.sessions.observe(page.webContents); await page.loadURL(config.httpsOrigin + '/form'); return page }
  report.stage = 'original-HTTPS-CONNECT-pages'
  const authPage = await openPage(ids.auth), plainPage = await openPage(ids.plain), directPage = await openPage(ids.direct)
  const windows = { [ids.auth]: authPage, [ids.plain]: plainPage, [ids.direct]: directPage }
  if (!prior) for (const [id, page] of Object.entries(windows)) await page.webContents.executeJavaScript(`tcpSeedSite(${JSON.stringify(id)})`)
  const originalFacts: Record<string, unknown> = {}
  for (const [id, page] of Object.entries(windows)) originalFacts[id] = await facts(page)
  const originalConfiguration = Object.fromEntries((Object.values(ids) as string[]).map(id => [id, configuration(profiles!.listProfiles().find(profile => profile.id === id))]))
  const partitions = Object.fromEntries((Object.values(ids) as string[]).map(id => [id, profiles!.resolvePartition(id)]))
  const storagePaths = Object.fromEntries((Object.values(ids) as string[]).map(id => [id, profiles!.sessions.nativeSession(id).storagePath]))
  if (prior) { assert.deepEqual(originalFacts, prior.site); assert.deepEqual(originalConfiguration, prior.configuration); assert.deepEqual(storagePaths, prior.storagePaths) }
  report.stage = 'public-network-owner'
  const checked = await cli(['check', '--profile', ids.auth]); assert.equal(checked.check.status, 'reachable'); assert.equal(checked.check.httpStatus, 200); assert.equal(checked.check.ip, '203.0.113.29')
  const diagnostic = await cli(['probe', '--profile', ids.auth, '--operation-id', phase === 'first' ? 'tcp-original-first' : 'tcp-second-explicit'])
  assert.equal(diagnostic.diagnostic.authentication.status, 'authenticated'); assert.equal(diagnostic.diagnostic.tcp.status, 'connected'); assert.equal(diagnostic.diagnostic.exit.status, 'reachable'); assert.equal(diagnostic.historySaved, true)
  const http = await profiles.sessions.fetch(ids.auth, config.httpOrigin + '/http-control'); assert.equal(http.status, 200); assert.equal(await http.text(), 'original TCP endpoint')
  const native = profiles.sessions.nativeSession(ids.auth), nativeRoute = await native.resolveProxy(config.httpsOrigin)
  assert.ok(/^PROXY 127\.0\.0\.1:\d+$/u.test(nativeRoute), 'Exact Session must use its private authenticated adapter; wire assertions separately prove SOCKS traffic')
  let crossSessionAnswer = false
  const localPort = Number(nativeRoute.slice(nativeRoute.lastIndexOf(':') + 1))
  assert.equal(profiles.sessions.answerProxyTransport(profiles.sessions.nativeSession(ids.direct), { isProxy: true, host: '127.0.0.1', port: localPort }, () => { crossSessionAnswer = true }), false); assert.equal(crossSessionAnswer, false)
  const localRejection = await new Promise<number>((resolve, reject) => { const req = request({ host: '127.0.0.1', port: localPort, path: config.httpOrigin + '/unadmitted-local', agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) }); req.on('error', reject); req.end() }); assert.equal(localRejection, 407)
  report.cases.push({ kind: 'native-HTTPS-CONNECT-and-public-network-owner', checked: checked.check, diagnosticId: diagnostic.diagnostic.id, originalProfileId: ids.auth, exactSessionCapability: true, unadmittedLocalStatus: localRejection })
  if (!prior) {
   report.stage = 'unknown-observations-keep-healthy-route'
   const setProxy = native.setProxy.bind(native), close = native.closeAllConnections.bind(native), hasCredentials = credential.hasTransportCredentials
   let rewrites = 0, closures = 0
   native.setProxy = async (...args) => { rewrites++; return setProxy(...args) }; native.closeAllConnections = async () => { closures++; return close() }
   try {
    address = config.badHttpsOrigin + '/exit'; const failed = await cli(['check', '--profile', ids.auth]); assert.equal(failed.check.status, 'unknown'); assert.ok(report.pins.rejected > 0)
    credential.hasTransportCredentials = async () => undefined; await profiles.refreshProxyTransport(ids.auth)
    assert.equal(rewrites, 0); assert.equal(closures, 0); assert.equal(await native.resolveProxy(config.httpsOrigin), nativeRoute)
    assert.equal(await authPage.webContents.executeJavaScript(`fetch('/exit').then(reply=>reply.status)`), 200)
    for (const [id, page] of Object.entries(windows)) { assert.deepEqual(await facts(page), originalFacts[id]); assert.equal(page.isDestroyed(), false) }
    report.cases.push({ kind: 'untrusted-certificate-and-unknown-credential-observation-preserve-native-route', failedStatus: failed.check.status, rewrites, closures, routePreserved: true, originalSiteDataPreserved: true })
   } finally { native.setProxy = setProxy; native.closeAllConnections = close; credential.hasTransportCredentials = hasCredentials; address = config.httpsOrigin + '/exit' }
   report.stage = 'credential-refusal-and-recovery'
   await network.setProxySignIn(ids.auth, { username: user, password: refusedPassword })
   let refused = false; try { const reply = await profiles.sessions.fetch(ids.auth, config.httpsOrigin + '/refused-credential'); await reply.text(); refused = reply.status !== 200 } catch { refused = true }
   assert.equal(refused, true, 'Refused SOCKS authentication must not produce a successful native TLS request')
   for (const [id, page] of Object.entries(windows)) assert.deepEqual(await facts(page), originalFacts[id])
   assert.equal(await directPage.webContents.executeJavaScript(`fetch('/exit').then(reply=>reply.status)`), 200)
   assert.equal(await plainPage.webContents.executeJavaScript(`fetch('/exit').then(reply=>reply.status)`), 200)
   await network.setProxySignIn(ids.auth, { username: user, password })
   const recovered = await profiles.sessions.fetch(ids.auth, config.httpsOrigin + '/recovered'); assert.equal(recovered.status, 200); await recovered.text()
   for (const [id, page] of Object.entries(windows)) assert.deepEqual(await facts(page), originalFacts[id])
   report.cases.push({ kind: 'real-authentication-refusal-and-explicit-recovery-preserve-all-original-pages', refused, recovered: true, independentProfilesHealthy: true })
  }
  report.stage = 'original-data-flush'
  for (const id of Object.values(ids) as string[]) { const session = profiles.sessions.nativeSession(id); await session.cookies.flushStore(); session.flushStorageData() }
  const encrypted = await readFile(credentialFile), metadata = await readFile(join(home, 'profiles.json'), 'utf8')
  for (const value of [user, password, refusedPassword]) { assert.equal(metadata.includes(value), false); assert.equal(encrypted.toString().includes(value), value === user) }
  const actual = { ids, partitions, storagePaths, configuration: originalConfiguration, site: originalFacts, encryptedCredentialHash: hash(encrypted), originalDiagnostic: (await profiles.networkHistory(ids.auth, 'tcp-original-first')).diagnostics }
  if (!prior) await writeFile(descriptor, JSON.stringify(actual))
  else assert.deepEqual(actual, prior)
  assert.ok(report.pins.accepted > 0)
  assert.ok(report.sharedLoginEntry.transportAnswers > 0, 'Native app login must invoke the shared production entrypoint and the original Session capability owner')
  report.original = actual; report.passed = true; report.stage = 'complete'
 } catch (cause) { report.failure = { message: cause instanceof Error ? cause.message : String(cause), stack: cause instanceof Error ? cause.stack : undefined } }
 finally { await control?.stop(); for (const page of pages) page.destroy(); await profiles?.dispose(); await writeFile(join(out, phase + '.json'), JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1) }
}
void main()
