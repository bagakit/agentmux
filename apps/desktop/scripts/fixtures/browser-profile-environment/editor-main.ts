import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { DEFAULT_CONFIG } from '../../../src/main/config-store.js'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import { WorkbenchUserStateStore } from '../../../src/main/workbench-user-state.js'
import {
  registerBrowserProfileEditorIpc,
  readBrowserProfileSnapshot
} from '../../../src/main/browser-profile-editor-ipc.js'
import { assertAppDocumentSender, isAppDocumentSender } from '../../../src/main/ipc-sender-trust.js'
import type { WorkbenchUserStateWrite } from '../../../src/shared/workbench-user-state.js'
import {
  executeBrowserProfileControl,
  isBrowserProfileControlRequest
} from '../../../src/main/browser-profile-control.js'
import { THEME_BOOTSTRAP_CHANNEL } from '../../../src/shared/theme-bootstrap.js'
import {
  AgentMuxClient,
  AgentMuxControlServer,
  AgentMuxFileAgentSessionStore,
  connectAgentMuxRpc,
  AgentMuxError,
  DurableAgentMuxMessageQueue
} from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import {
  objectCliEnvironment,
  runCompiledObjectCli
} from '../../../../../packages/core/test/helpers/object-cli-rpc.js'

const directory = process.env.AGENTMUX_EDITOR_HOME!,
  output = process.env.AGENTMUX_EDITOR_OUTPUT!,
  root = process.env.AGENTMUX_EDITOR_ROOT!
const compiled = process.env.AGENTMUX_EDITOR_COMPILED!,
  phase = process.env.AGENTMUX_EDITOR_PHASE!,
  url = process.env.AGENTMUX_EDITOR_URL!
const report: any = { passed: false, phase, versions: process.versions, observations: [], screenshots: [] }
const profileEdits: { profileId: unknown; edit: unknown; revision: unknown }[] = []
const stage = (name: string) => {
  report.lastStage = name
  writeFileSync(output, JSON.stringify(report, null, 2))
  console.log(name)
}
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
let win: BrowserWindow | undefined,
  manager: BrowserProfileManager | undefined,
  browsers: BrowserViewManager | undefined,
  client: AgentMuxClient | undefined,
  server: AgentMuxControlServer | undefined
let holdAck = false,
  releaseAck: (() => void) | undefined,
  writeFailure = false,
  readFailure = phase === 'read-failure',
  blockedNameMarkerFor: string | undefined,
  nameMarkerHeld = false
app.on('window-all-closed', () => {})
await app.whenReady()
app.setActivationPolicy?.('prohibited')
try {
  stage('original owners initializing')
  manager = new BrowserProfileManager(new BrowserProfileStore(join(directory, 'profiles.json')))
  await manager.initialize()
  const userStatePath = join(directory, 'workbench-user-state.json')
  const userState = new WorkbenchUserStateStore(userStatePath)
  win = new BrowserWindow({
    width: 1180,
    height: 900,
    show: false,
    webPreferences: {
      preload: join(compiled, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error('Renderer: ' + event.message)
  })
  const html = join(compiled, 'renderer', 'editor.html'),
    sources = { current: { mode: 'prod' as const, filePath: html }, loading: null }
  const handle = <A extends unknown[], R>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>
  ) => {
    ipcMain.handle(channel, async (event, ...args: A) => {
      assertAppDocumentSender(event, win!.webContents, sources)
      if (channel === 'browser:updateProfile') profileEdits.push({ profileId: args[0], edit: args[1], revision: args[2] })
      const result = await listener(event, ...args)
      if (channel === 'browser:updateProfile' && holdAck) {
        holdAck = false
        await new Promise<void>((done) => {
          releaseAck = done
        })
      }
      return result
    })
  }
  registerBrowserProfileEditorIpc({ handle, profiles: manager })
  handle('config:get', () => structuredClone(DEFAULT_CONFIG))
  // Exactly the same trusted Main registrar and original Desktop document owner.
  handle('ui:readWorkbenchState', () => {
    if (readFailure) throw Object.assign(new Error('Private draft read unconfirmed'), { code: 'EACCES' })
    return userState.read()
  })
  handle('ui:importWorkbenchState', (_event, value: string) => userState.importIfAbsent(value))
  handle('ui:writeWorkbenchState', async (event, request: WorkbenchUserStateWrite) => {
    if (writeFailure) throw new Error('Private draft write ACK unconfirmed')
    if (blockedNameMarkerFor && JSON.parse(request.value).desktopFragments?.browserProfileTextDrafts?.[blockedNameMarkerFor]?.label?.[0]?.state === 'saving') {
      nameMarkerHeld = true
      return await new Promise<never>(() => {})
    }
    return userState.writeFromRenderer(event.senderFrame!, request, () => isAppDocumentSender(event, win!.webContents, sources))
  })
  handle('browser:listProfileSites', () => ({ ok: true, value: [] }))
  handle('browser:readProfileProxySignIn', () => ({ ok: true, value: null }))
  ipcMain.on(THEME_BOOTSTRAP_CHANNEL, (event) => {
    event.returnValue = {
      status: 'unavailable',
      message: 'Private proof applies the original shared theme runtime.'
    }
  })
  const publish = () => {
    if (!win!.isDestroyed())
      win!.webContents.send('browser:profilesChanged', readBrowserProfileSnapshot(manager!))
  }
  manager.onChange(publish)
  manager.onEnvironmentApplicationChange(publish)
  browsers = new BrowserViewManager(win, manager, new BrowserRefLedgerStore(join(directory, 'refs.json')), {
    rememberedSchemes: async () => ({}),
    rememberScheme: async () => {},
    openExternal: () => {
      throw new Error('No external navigation in this proof')
    }
  })
  client = new AgentMuxClient({
    store: new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json')),
    providers: [],
    controlSocketPath: join(directory, 'control.sock')
  })
  const inner = client as any
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.status = async () => {
    throw new AgentMuxError('This private Browser fixture has no Native Run owner.', 'STATUS_UNAVAILABLE')
  }
  inner.messageQueue = new DurableAgentMuxMessageQueue(join(directory, 'messages.ndjson'))
  await inner.registry.load('local')
  server = new AgentMuxControlServer({
    socketPath: join(directory, 'control.sock'),
    coreClients: async () => [{ hostId: 'local', client: client! }],
    execute: async (request, context) => {
      if (!isBrowserProfileControlRequest(request))
        throw new Error('This proof only consumes Profile control')
      return executeBrowserProfileControl(
        request,
        {
          profiles: manager!,
          usage: { usage: async () => ({ complete: true, browsers: [] }) } as never,
          network: {} as never
        },
        context?.actor
      )
    }
  })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const cli = async (args: string[]) => {
    const result = await runCompiledObjectCli(
      ['browser', 'profile', ...args],
      objectCliEnvironment(directory, { AGENTMUX_CONTROL_SOCKET: server!.path, AGENTMUX_TEST_OBJECT_CLI: join(root, 'packages/core/bin/amux'), ELECTRON_RUN_AS_NODE: '1' }),
      '', 30_000, process.env.AGENTMUX_EDITOR_NODE
    )
    assert.equal(result.code, 0, result.stderr)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, true)
    return parsed.result
  }
  const id = manager.defaultProfileId(),
    browserId =
      phase === 'restart'
        ? JSON.parse(await readFile(join(directory, 'identities.json'), 'utf8')).browserId
        : mintObjectId()
  await browsers.create(browserId, url, 'private-editor-workspace', id)
  const page = (browsers as any).entries.get(browserId).view.webContents
  const evaluate = async (expression: string) => {
    const result = await win!.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const until = async (expression: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await wait(35)
    }
    throw new Error('Private observation pending: ' + expression)
  }
  const click = async (selector: string) => {
    const point = await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing real control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`
    )
    for (const type of ['mousePressed', 'mouseReleased'])
      await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: 'left',
        clickCount: 1
      })
    await wait(60)
  }
  const button = async (text: string, scope = '.profile-environment') => {
    await evaluate(
      `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(e=>e.textContent===${JSON.stringify(text)});if(!e)throw new Error('Missing '+${JSON.stringify(text)});document.querySelectorAll('[data-proof-click]').forEach(e=>e.removeAttribute('data-proof-click'));e.setAttribute('data-proof-click','yes')})()`
    )
    await click('[data-proof-click="yes"]')
  }
  const type = async (label: string, value: string) => {
    const selector = `:is(input, textarea)[aria-label="${label}"]`
    await click(selector)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`)
    await win!.webContents.debugger.sendCommand('Input.insertText', { text: value })
    await wait(40)
  }
  const capture = async (
    name: string,
    width: number,
    appearance: string,
    target = '.profile-environment'
  ) => {
    win!.setContentSize(width, 900)
    await evaluate(`environmentEditorProof.appearance(${JSON.stringify(appearance)})`)
    await wait(180)
    await evaluate(`document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'start'})`)
    await wait(120)
    const file = join(compiled, name + '.png')
    await writeFile(file, (await win!.webContents.capturePage()).toPNG())
    report.screenshots.push({ name, file, width, height: 900, appearance })
  }
  stage('shipping Renderer loading')
  win.webContents.debugger.attach('1.3')
  await win.loadFile(html)
  win.showInactive()
  await until(
    'Boolean(window.environmentEditorProof?.preloadAvailable && document.querySelector(".profile-environment"))'
  )
  if (phase.startsWith('text-')) {
    const owner = (await cli(['inspect', '--profile', id])).profile
    const secondName = 'Independent Profile'
    if (phase === 'text-seed') await cli(['create', '--operation-id', mintObjectId(), '--label', secondName])
    const second = (await cli(['ls'])).profiles.find((profile: { label: string }) => profile.label === secondName)
    const note = 'textarea[aria-label="Notes"]'
    const name = 'input[aria-label="Profile name"]'
    const firstRaw = '  Original conflicting draft\n  '
    const secondRaw = '  Newer typing while acknowledgement is held  '
    const nameRaw = '  Name typed before its save marker  '
    const notesFeedback = '[data-profile-text-draft="notes"]'
    const selectProfile = async (name: string) => {
      await evaluate(`(()=>{const e=[...document.querySelectorAll('[data-resource-row]')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)});if(!e)throw new Error('Missing expected Profile');document.querySelectorAll('[data-proof-profile]').forEach(e=>e.removeAttribute('data-proof-profile'));e.setAttribute('data-proof-profile','yes')})()`)
      await click('[data-proof-profile="yes"]')
      await until(`document.querySelector('.browser-profile-editor').getAttribute('aria-label')===${JSON.stringify(name)}`)
    }
    const expectNote = (value: string) => until(`document.querySelector(${JSON.stringify(note)})?.value === ${JSON.stringify(value)}`)
    const confirmedDocument = () => {
      const observed = userState.observe(), confirmation = observed.lastConfirmedWrite
      return confirmation?.diskDurability === 'confirmed' && observed.contentDigest === confirmation.contentDigest
    }
    assert.ok(second?.id && second.id !== id)
    await until(`document.querySelector('.browser-profile-library').textContent.includes(${JSON.stringify(secondName)})`)
    if (phase === 'text-seed') {
      stage('a late original Profile acknowledgement cannot clear newer input or another Profile conflict')
      await selectProfile(secondName)
      await click('.browser-profile-editor__note')
      await type('Notes', 'Earlier submitted value')
      holdAck = true
      await click('.settings-content__header')
      for (const deadline = Date.now() + 15_000; !releaseAck && Date.now() < deadline;) await wait(40)
      assert.equal(typeof releaseAck, 'function', 'The original Profile write must return before its single reply is held')
      assert.equal((await cli(['inspect', '--profile', second.id])).profile.notes, 'Earlier submitted value')
      await type('Notes', secondRaw)
      await selectProfile(owner.label)
      await click('.browser-profile-editor__note')
      await type('Notes', firstRaw)
      await cli(['update', '--profile', id, '--expected-revision', owner.revision, '--notes', 'Saved elsewhere'])
      await click('.settings-content__header')
      await until(`document.querySelector(${JSON.stringify(notesFeedback)})?.textContent.includes('Reload')`)
      releaseAck!()
      await expectNote(firstRaw)
      await capture('profile-notes-conflict-light', 1180, 'light', '.browser-profile-editor')
      await capture('profile-notes-conflict-narrow-dark', 520, 'dark', '.browser-profile-editor')
      win.setContentSize(1180, 900)
      await wait(180)
      await selectProfile(secondName)
      await expectNote(secondRaw)
      assert.equal((await cli(['inspect', '--profile', second.id])).profile.notes, 'Earlier submitted value')
      await selectProfile(owner.label)
      await expectNote(firstRaw)
      assert.deepEqual(profileEdits, [
        { profileId: second.id, edit: { notes: 'Earlier submitted value' }, revision: second.revision },
        { profileId: id, edit: { notes: firstRaw.trim() }, revision: owner.revision }
      ])
      const deadline = Date.now() + 15_000
      let stored
      while (Date.now() < deadline) {
        const raw = await userState.read()
        stored = raw === null ? undefined : JSON.parse(raw).desktopFragments?.browserProfileTextDrafts
        if (stored?.[id]?.notes?.[0]?.state === 'conflict' && stored?.[second.id]?.notes?.[0]?.value === secondRaw &&
            stored?.[second.id]?.notes?.[0]?.state === 'editing' && confirmedDocument()) break
        await wait(40)
      }
      assert.equal(stored?.[id]?.notes?.[0]?.value, firstRaw)
      assert.equal(stored?.[id]?.notes?.[0]?.state, 'conflict')
      assert.equal(stored?.[second.id]?.notes?.[0]?.value, secondRaw)
      assert.equal(stored?.[second.id]?.notes?.[0]?.state, 'editing')
      assert.ok(confirmedDocument(), 'The exact readback digest must match the original native durability receipt')
      report.observations.push({ kind: 'exact-late-ack-and-native-bounded-write', id, secondId: second.id, profileEdits })
      stage('the original name save applies while its client attempt marker is held from disk')
      const beforeName = (await cli(['inspect', '--profile', id])).profile
      await click('.browser-profile-editor__name')
      await type('Profile name', nameRaw)
      const storedName = async () => JSON.parse((await userState.read())!).desktopFragments.browserProfileTextDrafts[id]?.label?.[0]
      for (const limit = Date.now() + 15_000; (await storedName())?.value !== nameRaw || !confirmedDocument();) {
        assert.ok(Date.now() < limit, 'The exact pre-save name draft must be durably written first')
        await wait(40)
      }
      blockedNameMarkerFor = id
      releaseAck = undefined
      holdAck = true
      await click('.settings-content__header')
      for (const limit = Date.now() + 15_000; !nameMarkerHeld || !releaseAck;) {
        assert.ok(Date.now() < limit, 'Only the new Desktop marker and original Browser reply should remain held')
        await wait(40)
      }
      assert.deepEqual(profileEdits[2], { profileId: id, edit: { label: nameRaw.trim() }, revision: beforeName.revision })
      assert.equal((await cli(['inspect', '--profile', id])).profile.label, nameRaw.trim())
      assert.equal((await storedName()).state, 'editing')
      assert.ok(confirmedDocument())
      report.observations.push({ kind: 'name-write-applied-without-client-marker-or-reply', id, nameMarkerHeld, oldDocumentDigest: userState.observe().contentDigest })
      report.passed = true
      stage('both user drafts reached the original durable owner')
      // This marker is observed by the parent of this isolated process only.
      console.error('profile_text_crash_ready')
      await new Promise<never>(() => {})
    } else if (phase === 'text-restart') {
      stage('read the original conflicted note after abrupt restart')
      await expectNote(firstRaw)
      await until(`document.querySelector(${JSON.stringify(notesFeedback)})?.textContent.includes('Reload')`)
      await until(`document.querySelector(${JSON.stringify(name)})?.value === ${JSON.stringify(nameRaw)}`)
      assert.equal(owner.label, nameRaw.trim())
      await click(name)
      await click('.settings-content__header')
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(name)})?.value`), nameRaw)
      assert.deepEqual(profileEdits, [])
      assert.equal((await cli(['inspect', '--profile', id])).profile.notes, 'Saved elsewhere')
      await selectProfile(secondName)
      await expectNote(secondRaw)
      assert.equal((await cli(['inspect', '--profile', second.id])).profile.notes, 'Earlier submitted value')
      // A restored editing draft may be the older disk image of an in-flight save.
      await click(note)
      await click('.settings-content__header')
      await expectNote(secondRaw)
      await capture('profile-notes-other-draft-dark', 1180, 'dark', '.browser-profile-editor')
      await selectProfile(owner.label)
      await button('Discard draft', notesFeedback)
      await until(`!document.querySelector(${JSON.stringify(note)})`)
      assert.deepEqual(profileEdits, [])
      const deadline = Date.now() + 15_000
      for (;;) {
        const raw = await userState.read()
        const stored = raw === null ? undefined : JSON.parse(raw).desktopFragments?.browserProfileTextDrafts
        assert.equal(stored?.[second.id]?.notes?.[0]?.value, secondRaw)
        assert.equal(stored?.[id]?.label?.[0]?.value, nameRaw)
        if (!stored?.[id]?.notes && confirmedDocument()) break
        assert.ok(Date.now() < deadline, 'The exact discarded field must be removed by the original Desktop owner')
        await wait(40)
      }
      report.observations.push({ kind: 'same-identities-abrupt-restart-and-explicit-discard', id, secondId: second.id, profileEdits })
    } else {
      stage('verify the discarded draft stays absent after the next app process starts')
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(note)})?.value`), undefined)
      await until(`document.querySelector(${JSON.stringify(name)})?.value === ${JSON.stringify(nameRaw)}`)
      await selectProfile(secondName)
      await expectNote(secondRaw)
      assert.deepEqual(profileEdits, [])
      report.observations.push({ kind: 'exact-discard-restart', id, secondId: second.id, profileEdits })
    }
  } else if (phase === 'read-failure') {
    stage('original Desktop document read unknown preserves healthy Profile Apply')
    await until('document.querySelector(".profile-environment")?.textContent.includes("Draft storage unconfirmed")')
    await type('Time zone', 'Europe/Paris')
    await button('Apply environment')
    await until('document.querySelector(".profile-environment")?.textContent.includes("Settings saved.")')
    assert.equal((await cli(['inspect', '--profile', id])).profile.environment.timeZone, 'Europe/Paris')
    await type('Time zone', 'Asia/Tokyo')
    assert.equal(await evaluate('[...document.querySelectorAll(".profile-environment button")].find(e=>e.textContent==="Apply environment").disabled'), false)
    readFailure = false; await button('Retry draft storage')
    await until('!document.querySelector(".profile-environment")?.textContent.includes("Draft storage unconfirmed")')
    assert.equal(await evaluate('document.querySelector(\'input[aria-label="Time zone"]\').value'), 'Asia/Tokyo')
    const stored = JSON.parse((await userState.read())!)
    assert.equal(JSON.parse(stored.desktopFragments.profileEnvironmentDrafts).profiles[id].active.fields.timeZone, 'Asia/Tokyo')
    assert.equal(manager.environmentSettings(id)?.timeZone, 'Europe/Paris')
    report.observations.push({ kind: 'native-read-unknown-healthy-apply-and-recovery', id, savedTimeZone: 'Europe/Paris', rawInput: 'Asia/Tokyo', diskDurability: userState.observe().diskDurability })
  } else if (phase === 'restart') {
    stage('same Profile draft restoring after real process restart')
    await until('document.querySelector(\'input[aria-label="Time zone"]\')?.value === "Unfinished/"')
    const identities = JSON.parse(await readFile(join(directory, 'identities.json'), 'utf8'))
    assert.equal(id, identities.id)
    assert.equal(browserId, identities.browserId)
    assert.equal(manager.environmentSettings(id)?.timeZone, 'Pacific/Honolulu')
    const inspected = await cli(['inspect', '--profile', id])
    assert.equal(inspected.profile.environment.timeZone, 'Pacific/Honolulu')
    report.observations.push({
      kind: 'real-restart',
      id,
      browserId,
      restoredRawDraft: 'Unfinished/',
      saved: inspected.profile.environment
    })
  } else {
    stage('real inputs applying all supported native parameters')
    await type('Languages', 'fr-FR, en')
    await type('Time zone', 'Europe/Paris')
    await type('Formats (locale)', 'fr-FR')
    await click('input[aria-label="Languages"]')
    for (const type of ['keyDown', 'keyUp'])
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type,
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9
      })
    assert.equal(
      await evaluate('document.activeElement.getAttribute("aria-label")'),
      'Time zone',
      'Native keyboard order follows the visible regional fields'
    )
    await click('.profile-environment__group > summary')
    await click('.profile-environment__choice input')
    await type('Latitude', '12.3')
    await type('Longitude', '-56.7')
    await type('Accuracy (meters)', '4')
    await evaluate(`document.querySelectorAll('.profile-environment__group')[1].open=true`)
    await type('User agent', 'EnvironmentEditor/1.0')
    await evaluate(`document.querySelector('.profile-environment__hints').open=true`)
    await click('.profile-environment__hints input[type="checkbox"]')
    await type('Platform', 'EditorOS')
    await type('Platform version', '1')
    await type('Architecture', 'arm')
    await evaluate(`document.querySelectorAll('.profile-environment__group')[2].open=true`)
    await type('Screen width', '1440')
    await type('Screen height', '900')
    await type('CPU threads', '3')
    await button('Apply environment')
    await until('document.querySelector(".profile-environment")?.textContent.includes("Settings saved.")')
    const inspected = await cli(['inspect', '--profile', id]),
      settings = inspected.profile.environment
    assert.equal(settings.timeZone, 'Europe/Paris')
    assert.equal(settings.locale, 'fr-FR')
    assert.equal(settings.hardwareConcurrency, 3)
    assert.equal(settings.geolocation.latitude, 12.3)
    assert.equal(settings.userAgentMetadata.platform, 'EditorOS')
    assert.deepEqual(settings.screen, { width: 1440, height: 900 })
    assert.deepEqual(settings.acceptLanguages, ['fr-FR', 'en'])
    assert.equal(settings.userAgent, 'EnvironmentEditor/1.0')
    const native = await page.executeJavaScript(
      '({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,threads:navigator.hardwareConcurrency,screen:[screen.width,screen.height],ua:navigator.userAgent,draft:document.querySelector("input").value})'
    )
    assert.equal(native.zone, settings.timeZone)
    assert.equal(native.threads, settings.hardwareConcurrency)
    assert.deepEqual(native.screen, [1440, 900])
    assert.equal(native.ua, settings.userAgent)
    assert.equal(native.draft, 'Original page input')
    await until(
      'environmentEditorProof.snapshot().profiles[0].environmentApplication?.pages?.[0]?.status === "applied"'
    )
    report.observations.push({ kind: 'shipping-api-main-cli-native', id, browserId, settings, native })
    stage('real native detach and GUI saved-settings reapply preserve the current input token')
    page.debugger.detach()
    await until('document.querySelector(".profile-environment")?.textContent.includes("Reapply saved settings")')
    await click('.profile-environment__application > summary')
    await type('Time zone', 'Pacific/Honolulu')
    await button('Reapply saved settings')
    await until('document.querySelector(".profile-environment")?.textContent.includes("Settings saved.")')
    assert.equal(await evaluate('document.querySelector(\'input[aria-label="Time zone"]\').value'), 'Pacific/Honolulu')
    stage('late original save ACK retains newer raw input')
    holdAck = true
    await button('Apply environment')
    await until('environmentEditorProof.snapshot().profiles[0].environment.timeZone === "Pacific/Honolulu"')
    await type('Time zone', 'Asia/Tokyo')
    assert.ok(releaseAck, 'Original save ACK was held')
    releaseAck!()
    releaseAck = undefined
    await until(
      'document.querySelector(".profile-environment")?.textContent.includes("Earlier settings saved.")'
    )
    assert.equal(
      await evaluate('document.querySelector(\'input[aria-label="Time zone"]\').value'),
      'Asia/Tokyo'
    )
    stage('external CLI update conflicts without discarding the GUI draft')
    const previous = manager.listProfiles().find((value) => value.id === id)!
    await cli([
      'update',
      '--profile',
      id,
      '--expected-revision',
      previous.revision,
      '--notes',
      'External CLI configuration'
    ])
    await button('Apply environment')
    await until(
      'document.querySelector(".profile-environment")?.textContent.includes("configuration changed")'
    )
    assert.equal(
      await evaluate('document.querySelector(\'input[aria-label="Time zone"]\').value'),
      'Asia/Tokyo'
    )
    await button('Keep edits with current version')
    await evaluate(`document.querySelectorAll('.profile-environment__group')[1].open=false;document.querySelectorAll('.profile-environment__group')[2].open=false`)
    await capture('environment-wide-dark', 1180, 'dark')
    await capture('environment-narrow-light', 390, 'light')
    await button('Revert')
    await evaluate(
      `document.querySelectorAll('.profile-environment__group').forEach(e=>e.open=false);document.querySelectorAll('.profile-environment__group')[1].open=true;document.querySelector('.profile-environment__hints').open=true`
    )
    await capture(
      'environment-identity-wide-light',
      1180,
      'light',
      '.profile-environment__group:nth-of-type(2)'
    )
    await evaluate(
      `document.querySelectorAll('.profile-environment__group')[1].open=false;document.querySelectorAll('.profile-environment__group')[2].open=true;document.querySelector('.profile-environment__application').open=true`
    )
    await capture('environment-scope-narrow-dark', 390, 'dark', '.profile-environment__application')
    stage('real GUI restores engine defaults before explicit public restore')
    await button('Restore defaults')
    await button('Apply environment')
    await until('environmentEditorProof.snapshot().profiles[0].environment === undefined')
    assert.equal((await cli(['inspect', '--profile', id])).profile.environment, undefined)
    const defaults = manager.listProfiles().find((value) => value.id === id)!
    await cli([
      'update',
      '--profile',
      id,
      '--expected-revision',
      defaults.revision,
      '--environment',
      JSON.stringify({ ...settings, timeZone: 'Pacific/Honolulu' })
    ])
    await until('document.querySelector(\'input[aria-label="Time zone"]\')?.value === "Pacific/Honolulu"')
    stage('draft write unknown keeps current input and healthy Apply')
    writeFailure = true
    await type('Time zone', 'Unfinished/')
    await click('.settings-content__header')
    await until(
      'document.querySelector(".profile-environment")?.textContent.includes("Draft storage unconfirmed")'
    )
    assert.equal(
      await evaluate('document.querySelector(\'input[aria-label="Time zone"]\').value'),
      'Unfinished/'
    )
    writeFailure = false
    await button('Retry draft storage')
    await until('!document.querySelector(".profile-environment")?.textContent.includes("Draft storage unconfirmed")')
    const stored = JSON.parse((await userState.read())!)
    assert.equal(
      JSON.parse(stored.desktopFragments.profileEnvironmentDrafts).profiles[id].active.fields.timeZone,
      'Unfinished/'
    )
    await writeFile(join(directory, 'identities.json'), JSON.stringify({ id, browserId }))
    report.observations.push({
      kind: 'late-ack-conflict-draft-unknown',
      savedTimeZone: manager.environmentSettings(id)?.timeZone,
      retainedRawDraft: 'Unfinished/',
      diskDurability: userState.observe().diskDurability
    })
  }
  await rpc.dispose()
  report.passed = true
} catch (cause) {
  report.failure = { message: String(cause), stack: cause instanceof Error ? cause.stack : null }
  try {
    report.renderer = await win?.webContents.executeJavaScript(
      '({text:document.body.innerText,fields:[...document.querySelectorAll(".profile-environment input")].map(e=>({label:e.getAttribute("aria-label"),value:e.value,checked:e.checked})),buttons:[...document.querySelectorAll(".profile-environment button")].map(e=>({text:e.textContent,disabled:e.disabled}))})'
    )
    report.profiles = manager?.listProfiles()
    if (win) await writeFile(join(compiled, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } catch (observation) {
    report.failedObservation = String(observation)
  }
  console.error(cause)
} finally {
  stage(report.passed ? 'passed' : 'failed')
  const cleanup: string[] = []
  for (const dispose of [
    () => server?.stop(),
    () => client?.dispose(),
    () => browsers?.dispose(),
    () => manager?.dispose(),
    () => win?.destroy()
  ]) {
    try {
      await dispose()
    } catch (cause) {
      cleanup.push(String(cause))
    }
  }
  report.cleanup = cleanup
  report.passed &&= cleanup.length === 0
  await writeFile(output, JSON.stringify(report, null, 2))
  app.exit(report.passed ? 0 : 1)
}
