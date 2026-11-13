import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, session, type WebContents } from 'electron'
import type { BrowserEvent } from '../../../src/shared/contracts.js'
import { mintObjectId } from '@agentmux/core/object-id'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../../../src/main/browser-profile-control.js'
import { AgentMuxControlServer, AgentMuxClient, AgentMuxFileAgentSessionStore, DurableAgentMuxMessageQueue, AgentMuxError, connectAgentMuxRpc } from '@agentmux/core'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../../../packages/core/test/helpers/object-cli-rpc.js'

const home = process.env.AGENTMUX_ENV_PROOF_HOME!, root = process.env.AGENTMUX_ENV_PROOF_ROOT!
const output = process.env.AGENTMUX_ENV_PROOF_OUTPUT!, phase = process.env.AGENTMUX_ENV_PROOF_PHASE!
const url = process.env.AGENTMUX_ENV_PROOF_URL!
const report: any = { passed: false, phase, versions: process.versions, observations: [], cleanup: [] }
const stage = (name: string) => { console.log('Profile environment proof: ' + name) }
let win: BrowserWindow | undefined, browsers: BrowserViewManager | undefined, profiles: BrowserProfileManager | undefined
let server: AgentMuxControlServer | undefined, client: AgentMuxClient | undefined
let profileClient: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
const sample = async (page: WebContents) => page.executeJavaScript(`({userAgent:navigator.userAgent, language:navigator.language,
  languages:[...navigator.languages], headers:window.originalHeaders, draft:document.querySelector('input').value,
  url:location.href, hints:navigator.userAgentData?.toJSON()})`)
async function page(id: string): Promise<WebContents> {
  const contents = (browsers as any).entries.get(id)?.view.webContents as WebContents | undefined
  assert.ok(contents, 'The original Browser owner retains its exact native handle')
  if (contents.isLoading()) await new Promise<void>((done, reject) => {
    contents.once('did-finish-load', () => done()); contents.once('did-fail-load', (_e, _code, message) => reject(new Error(message)))
  })
  return contents
}
async function cli(args: string[]) {
  stage('CLI ' + args[0] + ' requested')
  const result = await runCompiledObjectCli(['browser', 'profile', ...args], objectCliEnvironment(home, {
    ELECTRON_RUN_AS_NODE: '1', AGENTMUX_TEST_OBJECT_CLI: join(root, 'packages/core/bin/amux'), NODE_NO_WARNINGS: '1'
  }), '', 30_000).catch(error => { throw new Error(`Private CLI ${args[0]} observation failed: ${error.message}`, { cause: error }) })
  assert.equal(result.code, 0, result.stderr)
  const receipt = JSON.parse(result.stdout)
  assert.equal(receipt.ok, true, result.stdout)
  stage('CLI ' + args[0] + ' confirmed')
  return receipt.result
}
app.on('window-all-closed', () => {})
await app.whenReady()
app.setActivationPolicy?.('prohibited')
try {
  stage('owners initializing')
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(home, 'profiles.json')))
  await profiles.initialize()
  // The same persisted-facts port used by public CLI tests. No Native Run is created or certified.
  client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(home, 'sessions.json')), providers: [],
    controlSocketPath: join(home, 'control.sock') })
  const inner = client as any
  inner.connected = true; inner.kernel.isConnected = () => true
  inner.kernel.status = async () => { throw new AgentMuxError('This private Browser fixture has no Native Run owner.', 'STATUS_UNAVAILABLE') }
  inner.messageQueue = new DurableAgentMuxMessageQueue(join(home, 'messages.ndjson'))
  await inner.registry.load('local')
  server = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: async () => [{ hostId: 'local', client: client! }],
    execute: async (request, context) => {
      if (request.operation === 'browser.targets') return { operation: request.operation, targets: browsers!.targets(), coverage: 'complete' }
      if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected native proof request')
      return executeBrowserProfileControl(request, { profiles: profiles!, usage: { usage: async () => ({ complete: true, browsers: [] }) } as never,
        network: {} as never }, context?.actor)
    } })
  await server.start()
  profileClient = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  browsers = new BrowserViewManager(win, profiles, new BrowserRefLedgerStore(join(home, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => { throw new Error('No external navigation in this proof') } })
  const events: BrowserEvent[] = [], originalSend = (browsers as any).send.bind(browsers)
  ;(browsers as any).send = (event: BrowserEvent) => { events.push(structuredClone(event)); originalSend(event) }
  if (phase === 'seed') {
    const id = profiles.defaultProfileId(), oldId = mintObjectId()
    stage('original Browser creating')
    await browsers.create(oldId, url, 'proof-workspace', id)
    const oldPage = await page(oldId), baseline = await sample(oldPage)
    stage('original Browser loaded')
    await oldPage.executeJavaScript(`document.querySelector('input').value='original unsaved draft'`)
    let navigations = 0; oldPage.on('did-start-navigation', () => navigations++)
    const settings = { userAgent: 'Profile-A/1.0', acceptLanguages: ['fr-FR', 'de-DE'] }
    const saved = await cli(['update', '--profile', id, '--expected-revision', String(profiles.listRevision()), '--environment', JSON.stringify(settings)])
    assert.equal(saved.profile.environmentApplication.status, 'applied', 'Native setter receipt must be applied')
    assert.equal(saved.profile.environmentApplication.userAgent, settings.userAgent, 'Native UA setter must change the original session')
    assert.deepEqual(saved.profile.environment, settings)
    const oldAfter = await sample(oldPage)
    assert.equal(oldAfter.draft, 'original unsaved draft', 'Saving an environment preserves the original unsaved page')
    assert.equal(oldAfter.userAgent, baseline.userAgent, 'Existing page UA stays unchanged')
    assert.equal(navigations, 0, 'Saving never reloads the original page')
    const oldRequest = await oldPage.executeJavaScript(`fetch('/headers').then(response=>response.json())`)
    assert.equal(oldRequest['accept-language'], 'fr-FR,de-DE;q=0.9', 'Request languages affect subsequent requests')
    assert.equal(oldRequest['user-agent'], baseline.userAgent, 'Existing request UA remains the page UA')
    const newId = mintObjectId(); await browsers.create(newId, url, 'proof-workspace', id)
    const created = await sample(await page(newId))
    stage('new Browser loaded')
    assert.equal(created.userAgent, settings.userAgent, 'New page navigator reads the native UA')
    assert.equal(created.headers['user-agent'], settings.userAgent, 'New page server reads the native UA')
    assert.equal(created.headers['accept-language'], 'fr-FR,de-DE;q=0.9')
    assert.deepEqual(created.languages, baseline.languages, 'Request languages do not override navigator.languages')
    assert.equal(created.language, baseline.language)
    stage('RPC sibling Profile preparing')
    const sibling = (await profileClient.call('browser.profile.create', { label: 'Separate Profile' })).profile
    await profileClient.call('browser.profile.update', { profileId: sibling.id, expectedRevision: profiles.listRevision(),
      edit: { environment: { userAgent: 'Profile-B/2.0', acceptLanguages: ['ja-JP'] } } })
    const siblingId = mintObjectId(); await browsers.create(siblingId, url, 'proof-workspace', sibling.id)
    const siblingObserved = await sample(await page(siblingId))
    stage('sibling Browser loaded')
    assert.equal(siblingObserved.headers['user-agent'], 'Profile-B/2.0')
    assert.equal(siblingObserved.headers['accept-language'], 'ja-JP')
    stage('failed native setter service feedback')
    const originalSession = session.fromPartition(profiles.resolvePartition(id)), originalSetter = Object.getOwnPropertyDescriptor(originalSession, 'setUserAgent')
    const beforeFailure = await sample(oldPage), siblingPage = await page(siblingId), beforeSibling = await sample(siblingPage)
    events.length = 0
    let failure: any
    try {
      Object.defineProperty(originalSession, 'setUserAgent', { configurable: true, value: () => { throw new Error('Private native setter unavailable') } })
      failure = { profile: await profiles.updateProfile(id, { environment: { userAgent: 'Unconfirmed/3.0', acceptLanguages: ['fr-FR'] } }, profiles.listRevision()) }
      assert.equal(failure.profile.environmentApplication.status, 'unknown')
      assert.deepEqual(failure.profile.environment, { userAgent: 'Unconfirmed/3.0', acceptLanguages: ['fr-FR'] }, 'A saved environment is not rolled back after native failure')
      const publicTargets = (await profileClient.call('browser.targets', {})).targets
      for (const browserId of [oldId, newId]) {
        assert.match(publicTargets.find((row: any) => row.id === browserId)?.warning ?? '', /user agent and request-language session defaults could not be confirmed/, 'Public targets retain the exact affected Profile warning')
        assert.ok(events.some(event => event.type === 'updated' && event.browser.id === browserId && /session defaults could not be confirmed/.test(event.browser.activity.warning ?? '')), 'The existing Browser activity warning consumer receives the native outcome')
      }
      assert.equal(publicTargets.find((row: any) => row.id === siblingId)?.warning, undefined, 'Another Profile has no false environment warning')
      assert.ok(events.every(event => event.type !== 'updated' || event.browser.id !== siblingId || !/session defaults could not be confirmed/.test(event.browser.activity.warning ?? '')), 'Another Profile receives no false failure projection')
      assert.deepEqual(await sample(oldPage), beforeFailure, 'Native failure preserves the original document and its unsent draft')
      assert.deepEqual(await sample(siblingPage), beforeSibling, 'Native failure leaves another Profile page and draft intact')
      assert.equal(navigations, 0, 'Failure never reloads or replaces the original page')
      report.observations.push({ failure, publicTargets, feedbackBrowserIds: events.filter(event => event.type === 'updated').map(event => event.browser.id), beforeFailure, beforeSibling })
    } finally {
      if (originalSetter) Object.defineProperty(originalSession, 'setUserAgent', originalSetter)
      else delete (originalSession as any).setUserAgent
    }
    events.length = 0
    await profiles.prepareSession(id)
    for (const browserId of [oldId, newId]) {
      assert.equal(browsers.target(browserId)?.warning, undefined, 'A confirmed retry clears the environment warning without a page reload')
      assert.ok(events.some(event => event.type === 'updated' && event.browser.id === browserId && !event.browser.activity.warning), 'The same warning consumer receives confirmed recovery')
    }
    await profiles.updateProfile(id, { environment: settings }, profiles.listRevision())
    const original = browsers.targets().find(row => row.id === newId)!
    const released = await browsers.release(newId, original.navigationId!)
    stage('Browser release observed')
    assert.equal(released.status, 'released', 'Clean native Browser can release without changing its Profile')
    await browsers.restore(newId)
    const restored = await sample(await page(newId))
    stage('Browser restore loaded')
    assert.equal(restored.userAgent, settings.userAgent, 'Same Browser restore uses the saved Profile environment')
    assert.equal(restored.headers['accept-language'], 'fr-FR,de-DE;q=0.9')
    const descriptor = { id: newId, profileId: id, workspaceId: 'proof-workspace', url, title: original.title, mode: 'normal' as const, viewport: 'responsive' as const }
    await writeFile(join(home, 'descriptor.json'), JSON.stringify({ descriptor, settings, baseline, siblingId: sibling.id }))
    const inspected = await profileClient.call('browser.profile.inspect', { profileId: id })
    assert.deepEqual(inspected.profile.environmentApplication, saved.profile.environmentApplication, 'Public inspect retains the original native receipt')
    report.observations.push({ baseline, saved, oldAfter, oldRequest, created, siblingObserved, restored, descriptor })
  } else {
    const { descriptor, settings, baseline, siblingId } = JSON.parse(await readFile(join(home, 'descriptor.json'), 'utf8'))
    const before = await cli(['inspect', '--profile', descriptor.profileId])
    assert.equal(before.profile.environmentApplication.status, 'not-applied', 'A new process does not claim an old native application')
    assert.deepEqual(before.profile.environment, settings, 'Original saved Profile configuration survives process restart')
    await browsers.ensure(descriptor.id, async () => descriptor)
    const recovered = await sample(await page(descriptor.id))
    assert.equal(recovered.userAgent, settings.userAgent, 'Cold Browser acquire prepares the original Profile session')
    assert.equal(recovered.headers['accept-language'], 'fr-FR,de-DE;q=0.9')
    const cleared = await cli(['update', '--profile', descriptor.profileId, '--expected-revision', String(profiles.listRevision()), '--environment', 'null'])
    assert.equal(cleared.profile.environment, undefined)
    const afterClearId = mintObjectId(); await browsers.create(afterClearId, url, 'proof-workspace', descriptor.profileId)
    const clearedPage = await sample(await page(afterClearId))
    assert.equal(clearedPage.userAgent, baseline.userAgent, 'Clear restores the original native UA')
    assert.equal(clearedPage.headers['accept-language'], baseline.headers['accept-language'], 'Clear restores the native application request locale')
    const sibling = profiles.listProfiles().find(row => row.id === siblingId)!
    assert.deepEqual(sibling.environment, { userAgent: 'Profile-B/2.0', acceptLanguages: ['ja-JP'] })
    report.observations.push({ before, recovered, cleared, clearedPage, originalBrowserId: descriptor.id, originalProfileId: descriptor.profileId })
  }
  report.passed = true
} catch (error) {
  report.failure = { message: (error as Error).message, stack: (error as Error).stack }
} finally {
  stage('owners disposing')
  for (const dispose of [() => browsers?.dispose(), () => profiles?.dispose(), () => profileClient?.dispose(), () => server?.stop(), () => client?.dispose(), () => win?.destroy()]) {
    try { await dispose() } catch (error) { report.cleanup.push((error as Error).message) }
  }
  report.passed &&= report.cleanup.length === 0
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  app.exit(report.passed ? 0 : 1)
}
