import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { createBrowserProfileProxyAuth } from '../../../src/main/browser-profile-proxy-auth'
import { createBrowserProfileExitCheck } from '../../../src/main/browser-profile-exit-check'
import { createBrowserProfileNetworkControl } from '../../../src/main/browser-profile-network-control'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../../../src/main/browser-profile-control'

const home = process.env.PROXY_PROBE_HOME!, out = process.env.PROXY_PROBE_OUT!, repo = process.env.PROXY_PROBE_REPO!, node = process.env.PROXY_PROBE_NODE!
const phase = process.env.PROXY_PROBE_PHASE!, origin = process.env.PROXY_PROBE_ORIGIN!, httpPort = Number(process.env.PROXY_PROBE_HTTP!), socksPort = Number(process.env.PROXY_PROBE_SOCKS!)
const metadata = join(home, 'metadata'), stateFile = join(metadata, 'profiles.json'), descriptor = join(home, 'retained.json')
const report: any = { schema: 'agentmux.proxy-probe.native-process.v1', passed: false, phase, pid: process.pid, cases: [], captures: [], cli: [],
  boundary: 'Private original Profile Store/Manager/Session/credential and public RPC owners, real local HTTP CONNECT and SOCKS5 wire servers. Full Desktop workbench restoration and Chromium authenticated SOCKS business routing are not certified by this fixture.' }
app.on('window-all-closed', () => {})
const pause = (millis: number) => new Promise(done => setTimeout(done, millis))
const configuration = (profile: any) => { const { networkApplication, environmentApplication, ...original } = profile; return original }
let profiles: BrowserProfileManager | undefined, server: AgentMuxControlServer | undefined, page: BrowserWindow | undefined, editor: BrowserWindow | undefined
async function cli(args: string[]) {
  const result = await new Promise<any>((done, reject) => {
    const child = spawn(node, [join(repo, 'packages/core/bin/amux'), '--endpoint', 'unix:' + join(home, 'control.sock'), 'browser', 'profile', 'network', ...args], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE')), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; const deadline = setTimeout(() => { child.kill(); reject(new Error('Private CLI observation expired')) }, 60_000)
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject); child.once('close', code => { clearTimeout(deadline); done({ code, stdout, stderr }) })
  })
  report.cli.push({ command: args[0], code: result.code }); assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout).result
}
async function click(selector: string) {
  const point = await editor!.webContents.executeJavaScript(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing actual UI control');const rect=node.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`)
  editor!.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
  editor!.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
}
async function main() {
  try {
    await app.whenReady(); app.setActivationPolicy?.('prohibited'); await mkdir(metadata, { recursive: true })
    profiles = new BrowserProfileManager(new BrowserProfileStore(stateFile)); await profiles.initialize()
    const prior = phase === 'second' ? JSON.parse(await readFile(descriptor, 'utf8')) : null
    let httpId = prior?.httpId ?? profiles.defaultProfileId(), socksId = prior?.socksId
    if (!prior) {
      await profiles.updateProfile(httpId, { network: { mode: 'proxy', server: `http://127.0.0.1:${httpPort}`, bypass: ['<-loopback>'] } }, profiles.configurationRevision(httpId)!)
      socksId = (await profiles.createProfile('Research route', 'fixture-create-socks-profile', { kind: 'user', id: 'fixture-network-owner', verified: true })).id
      await profiles.updateProfile(socksId, { network: { mode: 'proxy', server: `socks5://127.0.0.1:${socksPort}`, bypass: ['<-loopback>'] } }, profiles.configurationRevision(socksId)!)
    }
    for (const id of [httpId, socksId]) profiles.sessions.nativeSession(id).setCertificateVerifyProc((request, done) => done(request.hostname === '127.0.0.1' ? 0 : -3))
    const signIn = createBrowserProfileProxyAuth({ path: join(home, 'sign-in.json'),
      crypto: { available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes) },
      profileOfSession: session => profiles!.profileOfSession(session), proxyOf: id => profiles!.proxyOf(id), configurationRevision: id => profiles!.configurationRevision(id), report: () => {} })
    profiles.bindProxyCredentialsBeforeNetworkChange = id => signIn.bindCurrentProxy(id)
    let address = origin + '/exit'
    const checkExit = createBrowserProfileExitCheck({ session: id => profiles!.sessions.nativeSession(id), prepare: id => profiles!.prepareSession(id), now: () => performance.now() })
    const network = createBrowserProfileNetworkControl({ profiles, proxyAuth: signIn, checkExit, checkAddress: () => address, reconnect: id => profiles!.sessions.nativeSession(id).closeAllConnections() })
    server = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: () => [], execute: async (request, context) => {
      if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected private probe operation')
      return await executeBrowserProfileControl(request, { profiles: profiles!, network, usage: {} as never }, context?.actor)
    } }); await server.start()
    await profiles.prepareSession(httpId)
    page = new BrowserWindow({ show: false, width: 720, height: 520, webPreferences: { partition: profiles.resolvePartition(httpId), sandbox: true, contextIsolation: true } })
    profiles.sessions.observe(page.webContents)
    await page.loadURL(origin + '/form')
    const facts = () => page!.webContents.executeJavaScript('profileProbePageFacts()')
    if (phase === 'first') {
      await page.webContents.executeJavaScript(`(()=>{document.querySelector('input').value='original unsent draft';localStorage.setItem('profile-draft','original unsent draft');document.cookie='retained-profile=value; Max-Age=3600; SameSite=Lax';return true})()`)
      const before = await facts(), profileBefore = profiles.listProfiles().find(row => row.id === httpId)!
      const observed = await cli(['probe', '--profile', httpId, '--operation-id', 'native-http'])
      assert.equal(observed.diagnostic.tcp.status, 'connected'); assert.equal(observed.diagnostic.authentication.status, 'not-applicable')
      assert.equal(observed.diagnostic.exit.status, 'reachable'); assert.equal(observed.diagnostic.exit.ip, '203.0.113.19')
      assert.deepEqual(observed.diagnostic.webrtc, { status: 'observed', policy: 'disable_non_proxied_udp', observedPages: 1 })
      assert.equal(page.webContents.getWebRTCIPHandlingPolicy(), observed.diagnostic.webrtc.policy)
      const unrelated = (await profiles.createProfile('Independent direct route', 'fixture-create-direct-profile', { kind: 'user', id: 'fixture-network-owner', verified: true })).id
      await profiles.updateProfile(unrelated, { network: { mode: 'direct' } }, profiles.configurationRevision(unrelated)!)
      await profiles.prepareSession(unrelated)
      const direct = new BrowserWindow({ show: false, webPreferences: { partition: profiles.resolvePartition(unrelated), sandbox: true } })
      try {
        profiles.sessions.observe(direct.webContents)
        await direct.loadURL('about:blank')
        assert.deepEqual(profiles.sessions.observeWebRtc(unrelated), { status: 'observed', policy: 'default', observedPages: 1 })
        assert.deepEqual(profiles.sessions.observeWebRtc(httpId), observed.diagnostic.webrtc)
      } finally { direct.destroy() }
      assert.deepEqual(await facts(), before); assert.deepEqual(profiles.listProfiles().find(row => row.id === httpId), profileBefore)
      address = origin + '/drop'
      const failed = await cli(['probe', '--profile', httpId, '--operation-id', 'native-exit-failure'])
      assert.equal(failed.diagnostic.exit.status, 'unknown'); assert.deepEqual(await facts(), before); assert.equal(page.isDestroyed(), false)
      address = origin + '/exit'
      report.cases.push({ kind: 'actual-http-connect-exit-and-healthy-page-on-failed-observation', observed, failed, before, after: await facts() })
      assert.equal(safeStorage.isEncryptionAvailable(), true, 'The actual Electron credential owner has native encryption available')
      await signIn.set(socksId, { username: 'private-probe-user', password: 'private-probe-password' })
      const socks = await cli(['probe', '--profile', socksId, '--operation-id', 'native-socks-auth'])
      assert.equal(socks.diagnostic.authentication.status, 'authenticated'); assert.equal(socks.diagnostic.tcp.status, 'connected')
      assert.equal(socks.diagnostic.exit.status, 'unknown', 'Probe authentication never certifies Chromium authenticated SOCKS business traffic')
      assert.deepEqual(socks.diagnostic.webrtc, { status: 'unknown', reason: 'no-live-page', observedPages: 0 })
      report.cases.push({ kind: 'real-rfc1929-sign-in-with-independent-native-session-exit', socks })
      await signIn.set(socksId, { username: 'private-probe-user', password: 'private-probe-wrong' })
      const record = profiles.recordNetworkDiagnostic.bind(profiles); let madeReadOnly = false
      profiles.recordNetworkDiagnostic = async diagnostic => {
        await record(diagnostic)
        if (diagnostic.id === 'native-pending' && !madeReadOnly) { madeReadOnly = true; await chmod(metadata, 0o500) }
      }
      const unconfirmed = await cli(['probe', '--profile', socksId, '--operation-id', 'native-pending'])
      await chmod(metadata, 0o700); profiles.recordNetworkDiagnostic = record
      assert.equal(madeReadOnly, true); assert.equal(unconfirmed.historySaved, false)
      assert.equal(unconfirmed.diagnostic.authentication.status, 'rejected')
      const pending = await cli(['history', '--profile', socksId, '--operation-id', 'native-pending'])
      assert.equal(pending.diagnostics[0].phase, 'pending')
      report.cases.push({ kind: 'real-eacces-after-original-registration-keeps-pending-history', unconfirmed, pending })
      ipcMain.handle('profile-probe:initial', () => ({ profile: profiles!.listProfiles().find(row => row.id === httpId) }))
      ipcMain.handle('profile-probe:run', (_event, id, operationId) => network.probe(id, operationId))
      ipcMain.handle('profile-probe:history', (_event, id, operationId, before) => profiles!.networkHistory(id, operationId, before))
      editor = new BrowserWindow({ show: false, width: 620, height: 720, webPreferences: { sandbox: true, contextIsolation: true, preload: join(out, 'preload.cjs'), backgroundThrottling: false } })
      await editor.loadFile(join(out, 'renderer/index.html')); editor.showInactive()
      for (let index = 0; index < 400 && !await editor.webContents.executeJavaScript('!!document.querySelector(".profile-network-diagnostics")'); index++) await pause(25)
      await click('.profile-network-diagnostics__heading button')
      for (let index = 0; index < 800 && !await editor.webContents.executeJavaScript('document.querySelectorAll(".profile-network-diagnostics dd").length===4'); index++) await pause(25)
      assert.equal(await editor.webContents.executeJavaScript('document.querySelectorAll(".profile-network-diagnostics dd").length'), 4)
      assert.match(await editor.webContents.executeJavaScript('document.querySelector(".profile-network-diagnostics").textContent'), /Non-proxied UDP disabled · 1 page/)
      await click('.profile-network-diagnostics__history summary')
      for (const appearance of ['dark', 'light']) for (const width of [620, 390]) {
        editor.setSize(width, 720)
        await editor.webContents.executeJavaScript(`profileProbeAppearance(${JSON.stringify(appearance)});new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`)
        const clipped = await editor.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.profile-network-diagnostics button,.profile-network-diagnostics dd')).filter(node=>{const rect=node.getBoundingClientRect();return rect.width>0&&(rect.left<0||rect.right>innerWidth+1)}).map(node=>node.textContent)`)
        assert.deepEqual(clipped, [])
        const file = 'diagnostics-' + appearance + '-' + width + '.png'
        await writeFile(join(out, file), (await editor.webContents.capturePage()).toPNG()); report.captures.push(file)
      }
      report.cases.push({ kind: 'production-diagnostic-component-native-input-and-four-width-theme-captures' })
      const httpHistory = await profiles.networkHistory(httpId), socksHistory = await profiles.networkHistory(socksId)
      report.retained = { httpId, socksId, httpProfile: configuration(profiles.listProfiles().find(row => row.id === httpId)), socksProfile: configuration(profiles.listProfiles().find(row => row.id === socksId)),
        httpHistory, socksHistory, page: await facts() }
      await writeFile(descriptor, JSON.stringify(report.retained))
      const raw = await readFile(stateFile, 'utf8')
      for (const value of ['private-probe-user', 'private-probe-password', 'private-probe-wrong']) assert.equal(raw.includes(value), false)
    } else {
      const httpHistory = await cli(['history', '--profile', httpId]), socksHistory = await cli(['history', '--profile', socksId])
      report.original = { ...prior, httpHistory: { diagnostics: httpHistory.diagnostics, nextCursor: httpHistory.nextCursor }, socksHistory: { diagnostics: socksHistory.diagnostics, nextCursor: socksHistory.nextCursor }, page: await facts(),
        httpProfile: configuration(profiles.listProfiles().find(row => row.id === httpId)), socksProfile: configuration(profiles.listProfiles().find(row => row.id === socksId)) }
      assert.deepEqual(report.original, prior)
      const recovered = await cli(['probe', '--profile', socksId, '--operation-id', 'native-pending'])
      assert.equal(recovered.diagnostic.phase, 'pending')
      assert.deepEqual((await profiles.networkHistory(socksId, 'native-pending')).diagnostics, [recovered.diagnostic])
      report.cases.push({ kind: 'second-process-original-history-config-and-page-state-without-protocol-replay', recovered })
    }
    profiles.sessions.nativeSession(httpId).flushStorageData(); report.passed = true
  } catch (error) { report.failure = { message: (error as Error).message, stack: (error as Error).stack }; console.error(error) }
  finally {
    await chmod(metadata, 0o700).catch(() => {})
    for (const name of ['initial', 'run', 'history']) ipcMain.removeHandler('profile-probe:' + name)
    await server?.stop(); editor?.destroy(); page?.destroy(); await profiles?.dispose()
    await writeFile(join(out, phase + '.json'), JSON.stringify(report, null, 2) + '\n'); app.exit(report.passed ? 0 : 1)
  }
}
void main()
