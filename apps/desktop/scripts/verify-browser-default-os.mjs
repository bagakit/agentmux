import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { readPackageIdentity } from './package-identity.mjs'
import { createPrivateRuntimeScope } from './package-runtime-upgrade.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex')
const wait = ms => new Promise(done => setTimeout(done, ms))
async function eventually(read, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let last
  do {
    try { const value = await read(); if (value) return value } catch (error) { last = error }
    await wait(100)
  } while (Date.now() < deadline)
  throw new Error(description + ' was not confirmed.', { cause: last })
}
async function command(file, args, options = {}) {
  return await exec(file, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, ...options })
}

// Read-only LaunchServices facts. No setDefaultApplication, registration or handler rewrite.
const workspaceRead = `ObjC.import('AppKit'); function run(argv) {
  const workspace=$.NSWorkspace.sharedWorkspace;
  return JSON.stringify(argv.map(value=>{const url=$.NSURL.URLWithString(value);
    const handler=workspace.URLForApplicationToOpenURL(url), applications=workspace.URLsForApplicationsToOpenURL(url), candidates=[];
    for(let i=0;i<applications.count;i++){const item=applications.objectAtIndex(i);candidates.push({path:item.path.js,bundleId:$.NSBundle.bundleWithURL(item).bundleIdentifier.js})}
    return {url:value,handler:handler ? handler.path.js : null,handlerBundleId:handler ? $.NSBundle.bundleWithURL(handler).bundleIdentifier.js : null,candidates};}));
}`
export async function inspectSystemBrowserHandlers() {
  const result = await command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', workspaceRead, 'http://example.org/', 'https://example.org/'])
  const value = JSON.parse(result.stdout)
  assert.equal(value.length, 2, 'Both protocols must have actual OS observations')
  assert.ok(value.every(item => item.handler && Array.isArray(item.candidates)), 'Unknown OS handlers are environment-unknown')
  return value
}
const systemHandlers = inspectSystemBrowserHandlers

async function cdp(url) {
  const socket = new WebSocket(url), pending = new Map()
  let sequence = 0
  await new Promise((yes, no) => {
    const timer = setTimeout(() => { socket.close(); no(new Error('Original CDP connection timed out')) }, 5_000)
    socket.addEventListener('open', () => { clearTimeout(timer); yes() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); no(new Error('Original CDP connection failed')) }, { once: true })
  })
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)), current = pending.get(message.id)
    if (!current) return
    pending.delete(message.id); clearTimeout(current.timer)
    if (message.error) current.no(new Error(JSON.stringify(message.error)))
    else current.yes(message.result)
  })
  socket.addEventListener('close', () => { for (const current of pending.values()) { clearTimeout(current.timer); current.no(new Error('Original CDP target closed')) } pending.clear() })
  const call = async (method, params = {}) => await new Promise((yes, no) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); no(new Error(method + ' timed out')) }, 10_000)
    pending.set(id, { yes, no, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  return { call, close: () => socket.close(), async evaluate(expression) {
    const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert.ok(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails))
    return reply.result.value
  } }
}

// Fixture configuration only. The production package, Main, preload, Renderer and
// public service are never bundled again or replaced by this seed producer.
export async function seedPrivateConfiguration(repository, scope, userData) {
  const require = createRequire(join(repository, 'apps/desktop/package.json'))
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  const scratch = join(scope.directory, 'scratch'), notes = join(scope.directory, 'notes')
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(scratch), mkdir(notes), mkdir(join(scope.directory, 'state'), { recursive: true })])
  const seedDirectory = join(repository, 'apps/desktop/.local/browser-default')
  await mkdir(seedDirectory, { recursive: true })
  const seedModule = join(seedDirectory, 'config-seed-' + randomUUID() + '.mjs')
  const source = join(repository, 'apps/desktop/src/main/config-store.ts')
  try {
    await build({ stdin: { contents: `export { DEFAULT_CONFIG } from ${JSON.stringify(source)}`, resolveDir: repository },
      outfile: seedModule, platform: 'node', format: 'esm', bundle: true, packages: 'external', logLevel: 'silent',
      plugins: [{ name: 'private-configuration-input-only', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'private-seed-electron', namespace: 'seed' }))
        builder.onLoad({ filter: /.*/, namespace: 'seed' }, () => ({ contents: `export const app={getPath(name){if(name==='home')return ${JSON.stringify(scope.directory)};if(name==='userData')return ${JSON.stringify(userData)};throw Error('Unexpected seed path '+name)}};export const nativeImage={};`, loader: 'js' }))
      } }] })
    const { DEFAULT_CONFIG } = await import(pathToFileURL(seedModule).href)
    const config = { ...structuredClone(DEFAULT_CONFIG), startup: { skipAgentAvailabilityCheckWait: true },
      browser: { ...DEFAULT_CONFIG.browser, agentAutomation: true }, workspaces: [{ id: '__scratch__', name: 'Scratch', hostId: 'local', path: scratch, kind: 'folder' }] }
    await writeFile(join(userData, 'agentmux.config.json'), JSON.stringify(config) + '\n', { mode: 0o600 })
    await writeFile(join(scope.directory, 'state/notes-location.json'), JSON.stringify({ schemaVersion: 1, directory: notes, operations: {}, pending: null }) + '\n', { mode: 0o600 })
    return { source: 'apps/desktop/src/main/config-store.ts', sha256: hash(await readFile(source)), scratch, notes, configSha256: hash(JSON.stringify(config)) }
  } finally { await rm(seedModule, { force: true }) }
}

export async function verifyDefaultBrowserOs({ repository, appPath, output }) {
  assert.equal(process.platform, 'darwin', 'This proof requires actual macOS LaunchServices')
  const app = await realpath(resolve(repository, appPath)), packageIdentity = await readPackageIdentity(app)
  const resources = join(app, 'Contents/Resources/app'), core = join(resources, 'node_modules/@agentmux/core')
  const executable = join(app, 'Contents/MacOS/AgentMux'), scope = await createPrivateRuntimeScope(core)
  const evidence = join(output, 'os-' + randomUUID()), userData = join(scope.directory, 'user-data')
  await mkdir(evidence, { recursive: true })
  const receipt = { schema: 'agentmux.browser-default-os-proof.v1', status: 'running', app, packageIdentity,
    boundary: 'Exact non-installed production App; read-only OS handlers; explicit-app HTTP(S) routing is not proof of a changed default. Private user data, Scratch, Notes, Core and Runtime. No product replacement or automatic OS setter.', cases: [], images: [] }
  const writeReceipt = async () => { const file = join(evidence, 'receipt.tmp'); await writeFile(file, JSON.stringify(receipt, null, 2) + '\n'); await rename(file, join(evidence, 'receipt.json')) }
  let page, browser, rpc, server, failure, terminalControl
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_|ELECTRON_)/.test(key)))
  const environment = { ...cleanEnvironment, AGENTMUX_DESKTOP_USER_DATA: userData, AGENTMUX_DISABLE_CRASH_REPORTER: '1',
    AGENTMUX_RUNTIME_DIRECTORY: scope.directory, AGENTMUX_STATE_DIRECTORY: join(scope.directory, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(userData, 'agent-sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(scope.directory, 'state/messages.ndjson') }
  const cli = async args => {
    const result = await command(join(core, 'bin/amux'), ['--endpoint', 'unix:' + join(scope.directory, 'control.sock'), ...args], { env: cleanEnvironment })
    const value = JSON.parse(result.stdout); assert.equal(value.ok, true, result.stderr); return value.result
  }
  try {
    await writeReceipt()
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    const info = JSON.parse((await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')])).stdout)
    assert.ok(info.CFBundleURLTypes.some(type => type.CFBundleURLSchemes.includes('amux')), 'Original amux registration is retained')
    assert.ok(info.CFBundleURLTypes.some(type => type.CFBundleTypeRole === 'Viewer' && ['http', 'https'].every(scheme => type.CFBundleURLSchemes.includes(scheme))), 'Both web schemes must be declared by the actual package')
    receipt.artifacts = Object.fromEntries(await Promise.all(['Contents/Info.plist', 'Contents/Resources/app/package-identity.json', 'Contents/Resources/app/out/main/index.js', 'Contents/Resources/app/out/preload/index.cjs'].map(async file => [file, hash(await readFile(join(app, file)))])))
    receipt.handlersBefore = await systemHandlers()
    assert.ok(receipt.handlersBefore.every(item => item.handlerBundleId !== info.CFBundleIdentifier || resolve(item.handler) === app), 'Another copy of this bundle is already the current default. Do not register a competing private copy or change the original handler route.')
    receipt.seed = await seedPrivateConfiguration(repository, scope, userData)
    const token = randomUUID(), requests = []
    server = createServer((request, response) => {
      requests.push(request.url)
      const form = request.url.startsWith('/alternate') ? '<main><article><h1>Alternate document</h1><form><input aria-label="Research query" value="kept"></form></article></main>' : '<main><h1>Primary document</h1><section><button>Inspect item</button></section></main>'
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>System link ' + token + '</title>' + form)
    })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const origin = 'http://127.0.0.1:' + server.address().port
    const coldUrl = origin + '/primary?request=' + token + '&q=one%20two#section-a'
    const launchArgs = ['-n', '-a', app, '--stdout', join(evidence, 'main.stdout.log'), '--stderr', join(evidence, 'main.stderr.log')]
    for (const [key, value] of Object.entries(environment).filter(([key]) => key.startsWith('AGENTMUX_'))) launchArgs.push('--env', key + '=' + value)
    launchArgs.push(coldUrl, '--args', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--browser-default-proof=' + scope.directory)
    await command('/usr/bin/open', launchArgs, { env: cleanEnvironment })
    const { connectAgentMuxRpc, formatAmuxObjectLink } = await import(pathToFileURL(join(core, 'dist/index.js')).href)
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(scope.directory, 'control.sock') } })
    const bundledRenderer = JSON.parse(await readFile(join(resources, 'out/renderer/release.json'), 'utf8'))
    const observation = async () => {
      const result = await rpc.call('app.inspect', {}), value = result.observation
      assert.equal(value.main.package.sourceCommit, packageIdentity.sourceCommit)
      assert.equal(value.main.package.sourceTree, packageIdentity.sourceTree)
      assert.equal(await realpath(value.main.storage.userData), userData)
      assert.equal(value.main.renderer.kind, 'bundled')
      assert.equal(value.main.renderer.id, bundledRenderer.id)
      assert.deepEqual(value.main.renderer.identity, bundledRenderer.identity)
      return value
    }
    const initial = await eventually(async () => { const value = await observation(); return !value.workbench.loading && value }, 'Original workbench initialization')
    receipt.main = initial.main
    const initialProcess = await command('/bin/ps', ['-p', String(initial.main.pid), '-o', 'uid=,lstart=,command='], { env: { ...cleanEnvironment, LC_ALL: 'C' } })
    assert.ok(initialProcess.stdout.includes(executable) && initialProcess.stdout.includes('--browser-default-proof=' + scope.directory), 'Actual original Main process must belong to this invocation')
    receipt.mainProcess = initialProcess.stdout.trim()
    const devtools = (await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).trim().split('\n'), port = Number(devtools[0])
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536 && devtools[1].startsWith('/devtools/browser/'), 'Original browser endpoint must be observed')
    const rootTarget = async () => {
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      return targets.find(target => target.type === 'page' && target.url.startsWith(pathToFileURL(join(resources, 'out/renderer/index.html')).href))
    }
    const attachPage = async () => { const target = await eventually(rootTarget, 'Actual bundled workbench target'); page = await cdp(target.webSocketDebuggerUrl); return target }
    let target = await attachPage()
    browser = await cdp('ws://127.0.0.1:' + port + devtools[1])
    const profiles = await page.evaluate('window.agentmux.browser.listProfiles()'), defaultProfiles = profiles.filter(profile => profile.isDefault)
    assert.equal(defaultProfiles.length, 1, 'The actual normal Profile owner must confirm one default')
    const expectedProfileId = defaultProfiles[0].id
    receipt.originalProfiles = profiles
    const click = async selector => {
      const point = await page.evaluate(`(() => { const e=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.getClientRects().length&&!e.closest('[hidden],[inert]')); if(!e)return null; e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width&&r.height&&e.contains(document.elementFromPoint(x,y)) ? {x,y}:null })()`)
      assert.ok(point, 'Actual visible reachable control ' + selector)
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    }
    const startPageTitleSelector = 'input[aria-label="Start page title"]'
    const openSurveySettings = async () => {
      await click('button[aria-label="Settings"]')
      await eventually(() => page.evaluate('!!document.querySelector(".settings-page:not([hidden])")'), 'Actual Settings surface')
      await click('button[data-settings-target="survey"]')
      await eventually(() => page.evaluate('!!document.querySelector(' + JSON.stringify('.settings-page[data-settings-page=survey] ' + startPageTitleSelector) + ')'), 'Existing Survey Settings module')
    }
    const regions = value => value.workbench.tabs.flatMap(tab => tab.regions.map(region => ({ ...region, tabId: tab.id })))
    const assertSurveyPage = async (url, minimum = 1) => {
      const value = await eventually(async () => {
        const current = await observation(), matching = regions(current).filter(region => region.kind === 'browser' && region.url === url && !region.loading)
        return matching.length >= minimum && { current, matching }
      }, 'Actual new original Browser for ' + url)
      const targets = await rpc.call('browser.targets', {}), catalog = (await rpc.call('space.ls', { target: {}, presentation: true })).catalog
      receipt.lastSurveyPageObservation = { url, browsers: value.matching, targets, catalog }
      const pageReads = []
      for (const region of value.matching) {
        assert.equal(region.workspaceId, '__scratch__')
        assert.equal(region.mode, 'normal', 'System web links use ordinary Browsers, independent of private-page entry points')
        assert.equal(region.profileId, expectedProfileId, 'The original normal Profile owner supplies this new page')
        assert.ok(targets.targets.some(item => item.id === region.browserId && item.url === url && item.mode === 'normal'), 'Original Main Browser target must match its actual storage mode')
        const tab = catalog.tabs.find(item => item.tabId === region.tabId)
        assert.ok(tab?.zoneId && catalog.survey?.items.some(item => item.zoneId === tab.zoneId), 'Original Core Zone must be collected by Survey')
        assert.ok(catalog.regions.some(item => item.regionId === region.regionId && item.browserId === region.browserId), 'Exact Core Region owns the Browser')
        if (url.startsWith(origin + '/')) {
          assert.equal(region.error, null, 'The actual local page must load normally')
          const read = await rpc.call('browser.run', { browserId: region.browserId, operationId: randomUUID(), code: 'return {info:await pageInfo(),text:await snapshotText()}' })
          assert.equal(read.outcome.kind, 'completed', 'Real packaged SDK must read its actual page')
          assert.equal(read.result.info.url, url)
          assert.ok(read.result.text.includes(url.includes('/alternate') ? 'Alternate document' : 'Primary document'), 'Original page snapshot must expose the requested document')
          pageReads.push({ browserId: region.browserId, read })
        }
      }
      receipt.cases.push({ name: 'actual-OS-URL-to-original-Survey', url, browsers: value.matching, pageReads, catalog })
      return value.matching
    }
    const [original] = await assertSurveyPage(coldUrl)
    assert.ok(requests.includes(new URL(coldUrl).pathname + new URL(coldUrl).search), 'The actual local page must load')
    const run = await rpc.call('terminal.open', { destination: { kind: 'new-tab', after: { kind: 'tab', tabId: original.tabId } } })
    receipt.terminalRunId = run.region.runId
    const terminal = await eventually(async () => regions(await observation()).find(region => region.kind === 'terminal' && region.control?.run.runId === run.region.runId && region.processState === 'running'), 'Private original healthy terminal Run')
    terminalControl = terminal.control
    receipt.originalTerminal = terminal
    receipt.runtime = await eventually(() => scope.observeOwner(), 'Exact private Runtime owner after actual Terminal launch')
    await openSurveySettings()
    const draft = 'Unsubmitted research title ' + token
    await click(startPageTitleSelector)
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] })
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
    const draftInput = await page.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(startPageTitleSelector)});return {focused:document.activeElement===input,start:input.selectionStart,end:input.selectionEnd,value:input.value}})()`)
    assert.equal(draftInput.focused, true, 'The original Settings input owns focus before typing')
    assert.equal(draftInput.start, 0, 'The original input selection starts at the first character')
    assert.equal(draftInput.end, draftInput.value.length, 'The original input selection includes its complete old value')
    receipt.draftInputBeforeTyping = draftInput
    await page.call('Input.insertText', { text: draft })
    assert.equal(await page.evaluate('document.querySelector(' + JSON.stringify(startPageTitleSelector) + ').value'), draft, 'Original Settings owns the real unsubmitted draft')
    const beforeWarm = await observation()
    const warmUrl = origin + '/alternate?request=' + token + '#section-b'
    // Two OS requests, rather than relying on duplicate arguments surviving
    // one LaunchServices batch. The application must retain both intents.
    await command('/usr/bin/open', ['-a', app, warmUrl], { env: cleanEnvironment })
    await command('/usr/bin/open', ['-a', app, warmUrl], { env: cleanEnvironment })
    const warm = await assertSurveyPage(warmUrl, 2)
    assert.equal(new Set(warm.map(item => item.browserId)).size, warm.length, 'Repeated equal URLs remain separate OS intents')
    const afterWarm = await observation(), keptOriginal = regions(afterWarm).find(item => item.browserId === original.browserId)
    assert.deepEqual(keptOriginal, regions(beforeWarm).find(item => item.browserId === original.browserId), 'Original URL/Profile/navigation stay untouched')
    assert.ok(regions(afterWarm).some(region => region.control?.run.runId === run.region.runId && region.processState === 'running'), 'Original healthy Run survives URL burst')
    assert.equal(await page.evaluate('document.querySelector(' + JSON.stringify(startPageTitleSelector) + ').value'), draft, 'OS URL burst must keep the original unsubmitted Settings draft')
    const inspection = await rpc.call('settings.browser-default.inspect', {})
    assert.deepEqual(await cli(['settings', 'browser-default', 'inspect']), inspection, 'Actual packaged SDK and CLI share Main facts')
    assert.deepEqual(await page.evaluate('window.agentmux.ui.inspectDefaultBrowser()'), inspection, 'Original preload shares the same Main owner')
    for (const [index, scheme] of ['http', 'https'].entries()) {
      const fact = inspection.protocols?.[scheme], os = receipt.handlersBefore[index]
      assert.equal(fact?.state, 'known', 'Actual handler observation must be available for this OS proof')
      assert.equal(fact.isCurrentApplication, os.handlerBundleId === info.CFBundleIdentifier, 'Native Main fact agrees with independent LaunchServices handler identity')
      assert.equal(await realpath(fact.application.path), await realpath(os.handler), 'Native Main reads the original OS handler')
    }
    receipt.inspection = inspection
    // HTTPS ingress retains the normal certificate policy. A local self-signed
    // endpoint is deliberately not trusted or substituted by this verifier.
    const secureUrl = 'https://example.org/?system-link=' + token + '#secure-intent'
    await command('/usr/bin/open', ['-a', app, secureUrl], { env: cleanEnvironment })
    await assertSurveyPage(secureUrl)
    await click('button[aria-label="Close settings"]')
    const browserIdsBeforeAmux = regions(await observation()).filter(region => region.kind === 'browser').map(region => region.browserId).sort()
    const internalUrl = formatAmuxObjectLink({ kind: 'region', regionId: original.regionId })
    await command('/usr/bin/open', ['-a', app, internalUrl], { env: cleanEnvironment })
    const internal = await eventually(async () => { const value = await observation(); return value.workbench.desktop.selection.space?.regionId === original.regionId && value }, 'Original amux exact-object navigation')
    assert.deepEqual(regions(internal).filter(region => region.kind === 'browser').map(region => region.browserId).sort(), browserIdsBeforeAmux, 'Original amux does not become a web Browser intent')
    receipt.cases.push({ name: 'original-amux-handler-retains-accurate-region', url: internalUrl, selection: internal.workbench.desktop.selection })
    await page.evaluate('window.close()').catch(() => {})
    await eventually(async () => !await rootTarget(), 'Original Main remains running with no workbench window')
    assert.doesNotThrow(() => process.kill(initial.main.pid, 0), 'Closing the window must not quit this private Main')
    const noWindowUrl = origin + '/primary?request=' + token + '&state=no-window#return'
    await command('/usr/bin/open', ['-a', app, noWindowUrl], { env: cleanEnvironment })
    target = await attachPage()
    await assertSurveyPage(noWindowUrl)
    const reopened = await observation()
    assert.equal(reopened.main.pid, initial.main.pid, 'No-window ingress reuses original Main')
    assert.ok(regions(reopened).some(region => region.control?.run.runId === run.region.runId && region.processState === 'running'), 'No-window ingress retains the original Run')
    const browsersBeforeObjectReopen = regions(reopened).filter(region => region.kind === 'browser')
      .map(({ browserId, profileId, mode, url }) => ({ browserId, profileId, mode, url })).sort((left, right) => left.browserId.localeCompare(right.browserId))
    await page.evaluate('window.close()').catch(() => {})
    await eventually(async () => !await rootTarget(), 'Original Main has no window before exact-object reentry')
    assert.doesNotThrow(() => process.kill(initial.main.pid, 0), 'Exact-object reentry keeps the same private Main')
    await command('/usr/bin/open', ['-a', app, internalUrl], { env: cleanEnvironment })
    target = await attachPage()
    const objectReopened = await eventually(async () => {
      const value = await observation()
      return !value.workbench.loading && value.workbench.desktop.selection.space?.regionId === original.regionId && value
    }, 'No-window amux reentry reaches the exact original Core Region')
    assert.equal(objectReopened.main.pid, initial.main.pid, 'Both no-window protocols reuse the original Main')
    assert.deepEqual(regions(objectReopened).filter(region => region.kind === 'browser')
      .map(({ browserId, profileId, mode, url }) => ({ browserId, profileId, mode, url })).sort((left, right) => left.browserId.localeCompare(right.browserId)),
    browsersBeforeObjectReopen, 'Exact-object reentry preserves every original Browser and Profile without a new URL intent')
    assert.ok(regions(objectReopened).some(region => region.control?.run.runId === run.region.runId && region.processState === 'running'), 'Both no-window protocols retain the original healthy Run')
    receipt.cases.push({ name: 'no-window-amux-restores-original-region-main-and-run', mainPid: objectReopened.main.pid,
      runId: run.region.runId, selection: objectReopened.workbench.desktop.selection, browsers: browsersBeforeObjectReopen })
    const currentWindow = await browser.call('Browser.getWindowForTarget', { targetId: target.id })
    await openSurveySettings()
    const originalTitle = await page.evaluate('document.querySelector(' + JSON.stringify(startPageTitleSelector) + ').value')
    assert.notEqual(originalTitle, draft, 'An unsubmitted start-page draft must not have been silently saved')
    const settingsButton = '[data-settings-pane="survey"] .settings-group button.small-button:first-of-type'
    await click(settingsButton)
    await eventually(() => page.evaluate('Array.from(document.querySelectorAll("[data-settings-pane=survey] [role=status]")).some(e=>e.textContent.includes("System Settings requested."))'), 'Actual Settings request result distinct from handler fact')
    receipt.requested = true
    const systemSettings = await command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit');function run(){const apps=$.NSWorkspace.sharedWorkspace.runningApplications;for(let i=0;i<apps.count;i++)if(apps.objectAtIndex(i).bundleIdentifier.js==='com.apple.systempreferences')return 'running';return 'not-running'}`])
    assert.equal(systemSettings.stdout.trim(), 'running', 'The original request must reach the actual system settings application')
    for (const [name, width, height] of [['normal', 1180, 820], ['narrow', 720, 760]]) {
      await browser.call('Browser.setWindowBounds', { windowId: currentWindow.windowId, bounds: { width, height } })
      await page.evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      const screenshot = await page.call('Page.captureScreenshot', { format: 'png' }), bytes = Buffer.from(screenshot.data, 'base64'), file = 'settings-survey-' + name + '.png'
      await writeFile(join(evidence, file), bytes)
      receipt.images.push({ file, sha256: hash(bytes), bounds: (await browser.call('Browser.getWindowBounds', { windowId: currentWindow.windowId })).bounds })
    }
    const eligible = await systemHandlers()
    receipt.eligibility = eligible
    for (const protocol of eligible) assert.ok(protocol.candidates.some(candidate => resolve(candidate.path) === app && candidate.bundleId === info.CFBundleIdentifier), 'Exact production App must be an eligible ' + new URL(protocol.url).protocol + ' application')
    assert.deepEqual(eligible.map(item => item.handler), receipt.handlersBefore.map(item => item.handler), 'The original OS default handlers are preserved')
    receipt.cases.push({ name: 'original-public-preload-facts-and-actual-package-eligibility', inspection, eligible })
    const final = await observation(), expectedCounts = new Map([[coldUrl, 1], [warmUrl, 2], [secureUrl, 1], [noWindowUrl, 1]])
    for (const [url, count] of expectedCounts) assert.equal(regions(final).filter(region => region.kind === 'browser' && region.url === url).length, count, 'Exact original Browser count; no silent replay for ' + url)
    assert.equal(regions(final).filter(region => region.kind === 'browser').length, 5, 'The complete original Browser set contains exactly the five explicit URL intents')
    for (const [file, before] of Object.entries(receipt.artifacts)) assert.equal(hash(await readFile(join(app, file))), before, 'Actual candidate input changed: ' + file)
    receipt.status = 'passed'; receipt.visualReview = 'pending-independent-review'
  } catch (error) {
    failure = error; receipt.status = 'failed'; receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    const cleanup = []
    if (terminalControl) {
      try {
        await page.evaluate('window.agentmux.sessions.stop(' + JSON.stringify(terminalControl) + ')')
        const ended = await eventually(async () => {
          const value = await page.evaluate('window.agentmux.sessions.refresh(' + JSON.stringify(terminalControl) + ')')
          assert.equal(value.control.run.runId, terminalControl.run.runId)
          return value.processState === 'exited' && value
        }, 'Original private Terminal Run exit after explicit Core stop', 5_000)
        receipt.cleanupTerminal = { control: terminalControl, stopAcknowledged: true, ended }
      } catch (error) { cleanup.push('Original private Terminal exit is unconfirmed: ' + error.message) }
    } else if (receipt.terminalRunId) cleanup.push('The created private Terminal control was not observed; its exit is unconfirmed.')
    try { await rpc?.dispose() } catch (error) { cleanup.push(error.message) }
    try { page?.close(); browser?.close() } catch (error) { cleanup.push(error.message) }
    if (server) await new Promise(done => server.close(done))
    try { await stopProbeProcesses(-1, scope.directory); receipt.cleanupProcesses = await listProbeProcesses(-1, scope.directory) } catch (error) { cleanup.push(error.message) }
    try { receipt.cleanupRuntime = await scope.cleanup() } catch (error) { cleanup.push(error.message) }
    try { receipt.handlersAfter = await systemHandlers(); if (receipt.handlersBefore) assert.deepEqual(receipt.handlersAfter.map(item => item.handler), receipt.handlersBefore.map(item => item.handler)) } catch (error) { cleanup.push(error.message) }
    receipt.cleanup = { errors: cleanup, retained: cleanup.length > 0, privateDirectory: scope.directory }
    if (!cleanup.length) await rm(scope.directory, { recursive: true })
    if (cleanup.length) { receipt.status = 'failed'; failure ??= new Error('Private proof cleanup or original handlers are unconfirmed') }
    await writeReceipt()
  }
  if (failure) throw Object.assign(failure, { evidence })
  return { evidence, receipt }
}
