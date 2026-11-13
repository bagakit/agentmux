import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { BrowserCdpSession } from '../../../src/main/browser-cdp-session.js'
import type { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import type { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserSitePermissions } from '../../../src/main/browser-site-permissions.js'
import type { BrowserProfileEnvironment } from '@agentmux/core/control'

const environment: BrowserProfileEnvironment = {
  userAgent: 'ScopedProfile/1.0',
  acceptLanguages: ['fr-FR', 'fr'],
  timeZone: 'Pacific/Honolulu',
  locale: 'fr-FR',
  geolocation: { latitude: 12.34, longitude: 56.78, accuracy: 9 },
  hardwareConcurrency: 3,
  screen: { width: 1200, height: 800 },
  userAgentMetadata: {
    brands: [{ brand: 'ScopedProfile', version: '1' }],
    fullVersionList: [{ brand: 'ScopedProfile', version: '1.0.0.0' }],
    platform: 'ProbeOS',
    platformVersion: '1',
    architecture: 'arm',
    model: '',
    mobile: false
  }
}
const expression = `(async()=>({ua:navigator.userAgent,language:navigator.language,languages:[...navigator.languages],locale:Intl.DateTimeFormat().resolvedOptions().locale,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,hardware:navigator.hardwareConcurrency,screen:{width:screen.width,height:screen.height,innerWidth,innerHeight,dpr:devicePixelRatio},metadata:navigator.userAgentData?await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList']):null,draft:document.querySelector('input')?.value,first:window.firstEnvironment,headers:window.originalHeaders,children:window.childEnvironments,worker:window.workerEnvironment,url:location.href}))()`
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const value = await read()
    if (value) return value as NonNullable<T>
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Original native scope observation expired: ' + label)
}
export async function runProfileEnvironmentScope(input: {
  home: string
  phase: string
  url: string
  profiles: BrowserProfileManager
  browsers: BrowserViewManager
  page(id: string): Promise<Electron.WebContents>
  cli(args: string[]): Promise<any>
  report: any
  stage(name: string): void
}) {
  const { home, phase, url, profiles, browsers, page, cli, report, stage } = input
  report.scopeCases = []
  const observe = async (name: string, run: () => Promise<void>) => {
    console.log('Native environment scope: ' + name)
    await run()
    report.scopeCases.push(name)
  }
  const sample = async (id: string) => {
    const original = await page(id)
    stage('native sample requested: ' + id)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        original.executeJavaScript(expression),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Original native sample unavailable: ' + id)), 15_000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const applied = async (profileId: string, browserId: string) =>
    await until(() => {
      const value = profiles
        .environmentApplication(profileId)
        ?.pages?.find((page) => page.browserId === browserId)
      return value?.status === 'applied' ? value : undefined
    }, 'native settings on ' + browserId)
  const settings = async (profileId: string, value: BrowserProfileEnvironment | null) =>
    await cli([
      'update',
      '--profile',
      profileId,
      '--expected-revision',
      profiles.listProfiles().find(profile => profile.id === profileId)!.revision,
      '--environment',
      JSON.stringify(value)
    ])
  browsers.sitePermissions = new BrowserSitePermissions(join(home, 'scope-permissions.json'), (id) =>
    browsers.refreshSitePermissions(id)
  )
  if (process.env.AGENTMUX_ENV_PROOF_COLD_TARGET === '1') {
    const id = profiles.defaultProfileId()
    await settings(id, environment)
    await browsers.create('cold-scope-browser', url, 'proof-workspace', id)
    await applied(id, 'cold-scope-browser')
    report.coldTarget = await sample('cold-scope-browser')
    assert.equal(report.coldTarget.hardware, 3)
    assert.equal(report.coldTarget.locale, 'fr-FR')
    assert.equal(profiles.environmentApplication(id)!.pages![0]!.scope.initialScripts, 'unknown')
    report.scopeCases.push('original-configured-cold-native-target')
    return
  }
  if (phase === 'restart') {
    const saved = JSON.parse(await readFile(join(home, 'scope-original.json'), 'utf8'))
    assert.equal(profiles.defaultProfileId(), saved.profileId)
    assert.deepEqual(profiles.environmentSettings(saved.profileId), environment)
    await browsers.create(saved.browserId, url, 'proof-workspace', saved.profileId, 'normal', 'mobile')
    await applied(saved.profileId, saved.browserId)
    const actual = await sample(saved.browserId)
    assert.equal(actual.locale, 'fr-FR')
    assert.equal(actual.timeZone, 'Pacific/Honolulu')
    assert.equal(actual.hardware, 3)
    assert.equal(actual.screen.width, 1200)
    assert.equal(actual.screen.innerWidth, saved.nativeViewportWidth)
    assert.equal(
      profiles.environmentApplication(saved.profileId)!.pages![0]!.scope.initialScripts,
      'unknown',
      'A restored target does not claim its first-script scope'
    )
    report.restart = { profileId: saved.profileId, browserId: saved.browserId, actual }
    report.scopeCases.push('same-profile-and-browser-after-real-process-restart')
    return
  }
  console.log('Native scope: original Profile Browser creating')
  const profileId = profiles.defaultProfileId(),
    browserId = 'original-scope-browser'
  await browsers.create(browserId, url, 'proof-workspace', profileId, 'normal', 'mobile')
  console.log('Native scope: original Browser created, awaiting document load')
  const original = await page(browserId)
  stage('original native scope document loaded')
  const baseline = await sample(browserId)
  await original.executeJavaScript(`document.querySelector('input').value='original unsaved scope input'`)
  let navigations = 0
  const track = () => navigations++
  original.on('did-start-navigation', track)
  await observe('public-cli-native-current-document-and-original-viewport', async () => {
    const saved = await settings(profileId, environment)
    assert.deepEqual(saved.profile.environment, environment)
    const receipt = await applied(profileId, browserId),
      actual = await sample(browserId)
    assert.equal(actual.locale, 'fr-FR', 'Native locale command must affect the original current page')
    assert.equal(actual.timeZone, 'Pacific/Honolulu')
    assert.equal(actual.hardware, 3)
    assert.equal(actual.ua, environment.userAgent)
    assert.deepEqual(actual.languages, ['fr-FR', 'fr'])
    assert.equal(actual.metadata.platform, 'ProbeOS')
    assert.equal(actual.screen.width, 1200, 'Original native screen application must change the current page')
    assert.equal(
      actual.screen.innerWidth,
      baseline.screen.innerWidth,
      'Screen editing must preserve the fixed Viewport layout'
    )
    assert.equal(actual.draft, 'original unsaved scope input')
    assert.equal(navigations, 0, 'Environment editing must not reload the original page')
    assert.deepEqual(receipt.scope, {
      currentDocument: 'applied',
      futureNavigation: 'applied',
      subdocuments: 'unknown',
      workers: 'unknown',
      initialScripts: 'unknown'
    })
    report.current = { baseline, actual, receipt }
  })
  if(process.env.AGENTMUX_ENV_PROOF_RELEASE==='1'){
    await observe('native-background-environment-keeps-clean-release-and-same-browser-restore',async()=>{
      const id='clean-environment-release'
      await browsers.create(id,url,'proof-workspace',profileId)
      await applied(profileId,id)
      const contents=await page(id),program=BrowserCdpSession.attach(contents)
      const retention=()=>browsers.resourceTargets(null).find(row=>row.id===id)!.resource!.retention
      assert.ok(retention().reasons.includes('debugger'),'Another exact native consumer retains its page')
      const protectedRelease=await browsers.release(id,browsers.target(id)!.navigationId!)
      assert.equal(protectedRelease.status,'retained')
      program.detach()
      await until(()=>retention().status==='eligible','clean background environment release eligibility')
      const released=await browsers.release(id,browsers.target(id)!.navigationId!)
      assert.equal(released.status,'released','A sole background environment lease must allow clean native release')
      await browsers.restore(id)
      await applied(profileId,id)
      const restored=await sample(id)
      assert.equal(restored.locale,'fr-FR')
      assert.equal(restored.hardware,3)
      assert.equal(restored.screen.width,1200)
      assert.equal(browsers.target(id)?.id,id)
      assert.equal(browsers.target(id)?.profile?.id,profileId)
      report.nativeRelease={protectedRelease,released,restored,browserId:id,profileId}
    })
    return
  }
  await observe(
    'geolocation-keeps-original-site-permission-and-uses-native-coordinates-only-after-person-answer',
    async () => {
      await original.executeJavaScript(
        `window.scopeGeo=null;navigator.geolocation.getCurrentPosition(point=>window.scopeGeo={latitude:point.coords.latitude,longitude:point.coords.longitude,accuracy:point.coords.accuracy},error=>window.scopeGeo={error:error.code});'requested'`
      )
      const request = await until(
        () =>
          browsers
            .target(browserId)
            ?.sitePermissions?.requests.find((request) => request.permissions.includes('geolocation')),
        'original native geolocation permission'
      )
      assert.equal(
        await original.executeJavaScript('window.scopeGeo'),
        null,
        'Environment configuration must not grant website location access'
      )
      // The private fixture acts as the authorized person at the original Main permission surface;
      // T017 separately certifies its actual trusted Renderer IPC and visible controls.
      await browsers.answerSitePermission(browserId, {
        requestId: request.requestId,
        navigationId: request.navigationId,
        allow: true,
        remember: false
      })
      const point = await until(
        () => original.executeJavaScript('window.scopeGeo'),
        'original native location result'
      )
      assert.deepEqual(point, { latitude: 12.34, longitude: 56.78, accuracy: 9 })
      report.geolocation = { requestId: request.requestId, result: point }
    }
  )
  await observe(
    'new-main-document-native-target-and-observed-initial-script-child-worker-boundaries',
    async () => {
      await browsers.create('new-scope-browser', url + '?new=1', 'proof-workspace', profileId)
      await applied(profileId, 'new-scope-browser')
      const actual = await sample('new-scope-browser')
      assert.equal(actual.locale, 'fr-FR')
      assert.equal(actual.timeZone, 'Pacific/Honolulu')
      assert.equal(actual.hardware, 3)
      await until(async () => {
        const value = await sample('new-scope-browser')
        return value.worker && value.children?.same && value.children?.cross ? value : undefined
      }, 'native child and Worker observations')
      report.childrenAndWorker = await sample('new-scope-browser')
      const receipt = profiles
        .environmentApplication(profileId)!
        .pages!.find((page) => page.browserId === 'new-scope-browser')!
      assert.equal(receipt.scope.workers, 'unknown')
      assert.equal(receipt.scope.subdocuments, 'unknown')
      const newer = await page('new-scope-browser')
      await newer.loadURL(url + '?next=1')
      const later = await sample('new-scope-browser')
      assert.equal(later.locale, 'fr-FR')
      assert.equal(later.first.timeZone, 'Pacific/Honolulu')
    }
  )
  await observe('sibling-profile-retains-its-native-environment', async () => {
    const sibling = await profiles.createProfile('Independent environment scope')
    await browsers.create('sibling-scope-browser', url, 'proof-workspace', sibling.id)
    const actual = await sample('sibling-scope-browser')
    assert.equal(actual.locale, baseline.locale)
    assert.equal(actual.timeZone, baseline.timeZone)
    assert.equal(actual.ua, baseline.ua)
    report.sibling = { profileId: sibling.id, actual }
  })
  await observe('actual-devtools-detach-unknown-and-close-reapplies-without-reload', async () => {
    const opened = new Promise<void>((resolve) => original.once('devtools-opened', () => resolve()))
    original.openDevTools({ mode: 'detach', activate: false })
    await opened
    const devtools = original.devToolsWebContents
    if (devtools) BrowserWindow.fromWebContents(devtools)?.hide()
    report.devtoolsCoexist = {
      opened: original.isDevToolsOpened(),
      attached: original.debugger.isAttached(),
      application: profiles.environmentApplication(profileId)
    }
    if (original.debugger.isAttached()) {
      await settings(profileId, { ...environment, locale: 'de-DE' })
      await applied(profileId, browserId)
      assert.equal(
        (await sample(browserId)).locale,
        'de-DE',
        'An open DevTools surface alone does not revoke the healthy original lease'
      )
      original.debugger.detach()
    }
    const unknown = await until(() => {
      const page = profiles
        .environmentApplication(profileId)
        ?.pages?.find((page) => page.browserId === browserId)
      return page?.status === 'unknown' ? page : undefined
    }, 'actual native detach outcome')
    assert.match(unknown.reason ?? '', /detach/)
    assert.equal((await sample(browserId)).draft, 'original unsaved scope input')
    await settings(profileId, { ...environment, locale: 'ja-JP' })
    assert.equal(
      original.isDevToolsOpened(),
      true,
      'Environment update must not steal an open DevTools connection'
    )
    const closed = new Promise<void>((resolve) => original.once('devtools-closed', () => resolve()))
    original.closeDevTools()
    await closed
    await applied(profileId, browserId)
    const actual = await sample(browserId)
    assert.equal(actual.locale, 'ja-JP')
    assert.equal(actual.draft, 'original unsaved scope input')
    assert.equal(navigations, 0)
    report.devtools = { unknown, afterClose: actual }
  })
  await observe('clear-restores-native-fields-and-keeps-another-original-debugger-consumer', async () => {
    const program = BrowserCdpSession.attach(original)
    try {
      await settings(profileId, null)
      await applied(profileId, browserId)
      const actual = await sample(browserId)
      for (const key of ['ua', 'language', 'locale', 'timeZone', 'hardware'])
        assert.equal(actual[key], baseline[key], 'Native clear must restore ' + key)
      assert.deepEqual(actual.metadata, baseline.metadata)
      assert.deepEqual(
        actual.screen,
        baseline.screen,
        'Clear must restore the original fixed Viewport and screen'
      )
      assert.equal(actual.draft, 'original unsaved scope input')
      assert.equal(navigations, 0)
      assert.equal(
        original.debugger.isAttached(),
        true,
        'Clearing Profile settings must preserve the program consumer'
      )
      assert.ok(await program.sendCommand('DOM.getDocument'))
      report.cleared = actual
    } finally {
      program.detach()
    }
  })
  await observe('responsive-screen-override-retains-view-layout-and-clears-without-input-loss', async () => {
    await browsers.setViewport(browserId, 'responsive')
    const responsive = await sample(browserId)
    await settings(profileId, { screen: { width: 1300, height: 900 } })
    await applied(profileId, browserId)
    const actual = await sample(browserId)
    assert.equal(actual.screen.width, 1300)
    assert.equal(actual.screen.innerWidth, responsive.screen.innerWidth)
    await settings(profileId, null)
    await applied(profileId, browserId)
    const cleared = await sample(browserId)
    assert.deepEqual(cleared.screen, responsive.screen)
    assert.equal(cleared.draft, 'original unsaved scope input')
  })
  await browsers.setViewport(browserId, 'mobile')
  await settings(profileId, environment)
  await applied(profileId, browserId)
  await writeFile(
    join(home, 'scope-original.json'),
    JSON.stringify({
      profileId,
      browserId,
      nativeViewportWidth: (await sample(browserId)).screen.innerWidth
    }) + '\n'
  )
  original.off('did-start-navigation', track)
}
