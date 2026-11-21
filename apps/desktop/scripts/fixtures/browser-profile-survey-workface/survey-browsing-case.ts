import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebContentsView, type BrowserWindow } from 'electron'
import type { SystemWebUrlResult } from '../../../src/shared/system-web-url'

export async function surveyBrowsingCase({ phase, directory, window, evaluate, result, receipt, pageUrl, holdSurveyReply, openSystemUrl, until }: {
  phase: string; directory: string; window: BrowserWindow; evaluate(expression: string): Promise<any>
  result(args: string[]): Promise<any>; receipt: any; pageUrl: string
  holdSurveyReply(channel: 'browser:readProfiles' | 'browser:create' | 'spatial:commit'): { arrived: Promise<void>; release(): void }
  openSystemUrl(url: string): Promise<SystemWebUrlResult>
  until<T>(read: () => Promise<T> | T, label: string, budget?: number): Promise<T>
}) {
  const contents = window.webContents
  contents.debugger.attach('1.3')
  const wait = async (expression: string) => {
    const deadline = Date.now() + 15_000
    do {
      const value = await evaluate(expression)
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 40))
    } while (Date.now() < deadline)
    throw Error('Survey browsing did not confirm: ' + expression)
  }
  const click = async (target: string) => {
    const point = await wait(`(() => {
      const node = [...document.querySelectorAll(${JSON.stringify(target)})].find(node => node.checkVisibility());
      if (!node) return null;
      node.scrollIntoView({block: 'nearest'}); const r = node.getBoundingClientRect();
      return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    })()`)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
      ...point, type, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 })
    })
  }
  const startFrameObservation = () => evaluate(`(() => {
    const probe = { frames: [], active: true };
    window.surveyFrameProbe = probe;
    const visible = (selector, home) => [...home.querySelectorAll(selector)].find(node =>
      node.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
    const sample = () => {
      const home = document.getElementById('survey-surface-home');
      if (home?.checkVisibility()) {
        const browser = visible('[data-browser-surface]', home);
        const frame = visible('.browser-start-page', home) ? 'start' : visible('.launch-surface', home) ? 'launcher'
          : visible('[data-survey-opening-page]', home) ? 'opening' : browser ? 'browser:' + browser.dataset.browserSurface : 'empty';
        if (probe.frames.at(-1) !== frame) probe.frames.push(frame);
      }
      if (probe.active) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })()`)
  const exactBrowserFrame = (browserId: string) => `Boolean([...document.querySelectorAll(${JSON.stringify(`#survey-surface-home [data-browser-surface="${browserId}"]` )})].find(node =>
    node.checkVisibility({ visibilityProperty: true, opacityProperty: true })))`
  const finishFrameObservation = async (browserId: string) => {
    await wait(exactBrowserFrame(browserId))
    const frames = await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      window.surveyFrameProbe.active = false; resolve(window.surveyFrameProbe.frames)
    })))`)
    assert.deepEqual(frames, ['opening', 'browser:' + browserId], 'Survey must paint only the exact opening status followed by its Browser')
    return frames
  }
  const waitForOpening = () => wait('document.querySelector("#survey-surface-home [data-survey-opening-page]")?.checkVisibility()')
  const capture = async (scene: string, theme: 'light' | 'dark', width: number, height: number) => {
    window.setContentSize(width, height)
    await evaluate(`profileSurveyNative.appearance(${JSON.stringify(theme)})`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const file = `${phase}-survey-browsing-${scene}-${theme}.png`
    const image = await window.capturePage()
    receipt.frames.push({ file, size: image.getSize(), scene, theme })
    await writeFile(join(directory, file), image.toPNG())
  }
  const prefix = 'browser.surveyBrowsing'
  const getSettings = async () => Object.fromEntries((await result(['settings', 'inspect', prefix])).entries
    .map((entry: { key: string; value: unknown }) => [entry.key.split('.').at(-1), entry.value]))
  const open = (url: string) => evaluate(`profileSurveyNative.openSurveyUrl(${JSON.stringify(url)})`)
  const profileSelection = () => evaluate('profileSurveyNative.surveyBrowsingState()')
  const pageReferences = async () => (await result(['space', 'survey-list'])).pageReferences
  const labels = () => evaluate('[...document.querySelectorAll(".survey-automatic-page-group > h3")].map(node => node.textContent)')
  const identityPath = join(directory, 'survey-browsing-identity.json')
  if (phase === 'first') {
    assert.deepEqual(await getSettings(), { reuseOpenPages: true, pageGrouping: 'none', groupGapMinutes: 30 })
    const heldCreate = holdSurveyReply('browser:create'), heldPosition = holdSurveyReply('spatial:commit')
    const firstUrl = pageUrl + '?source=one#evidence'
    await startFrameObservation()
    const start = performance.now()
    let completed = false
    const firstPending = openSystemUrl(firstUrl).then(value => { completed = true; return value })
    try {
      await until(() => Promise.race([Promise.all([heldCreate.arrived, heldPosition.arrived]).then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 30))]), 'native creation while the position write is held')
      const guest = await until(() => window.contentView.children.find((view): view is WebContentsView => view instanceof WebContentsView &&
        !view.webContents.isDestroyed() && view.webContents.getURL() === firstUrl && view.webContents.getTitle() === 'Profile workface'),
      'the real webpage delivered before the Core position write')
      const loadedAtMs = performance.now() - start
      await waitForOpening()
      assert.equal((await profileSelection()).selection, null)
      await capture('opening-new-page', 'light', 1180, 800)
      heldCreate.release()
      await until(() => guest.getVisible() && guest.getBounds().width > 100 && !guest.webContents.isLoading(),
        'the same guest visible before the Core position write')
      const visibleAtMs = performance.now() - start
      assert.equal(completed, false)
      const browserId = (await profileSelection()).selection.browserId
      receipt.newPageTransition = await finishFrameObservation(browserId)
      assert.equal(await guest.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Website workface')
      const guestImage = await guest.webContents.capturePage(), guestFile = 'first-survey-browsing-native-before-position-saved.png'
      assert.ok(!guestImage.isEmpty(), 'The original native webpage must paint before the position write')
      await writeFile(join(directory, guestFile), guestImage.toPNG())
      await capture('page-before-position-saved', 'light', 1180, 800)
      assert.equal(completed, false)
      receipt.pageBeforePositionSave = { browserId, loadedAtMs, visibleAtMs, contentsId: guest.webContents.id,
        bounds: guest.getBounds(), guestFile, positionReleasedAtMs: performance.now() - start }
    } finally { heldCreate.release(); heldPosition.release() }
    const { requestId, operation, ...first } = await firstPending
    assert.equal(first.state, 'opened', JSON.stringify(first))
    assert.equal(first.browserId, receipt.pageBeforePositionSave.browserId)
    receipt.pageBeforePositionSave.requestId = requestId
    receipt.pageBeforePositionSave.operation = operation
    receipt.pageBeforePositionSave.resultAtMs = performance.now() - start
    const second = await open(pageUrl + '?source=two#evidence')
    const localHost = new URL(pageUrl)
    localHost.hostname = 'localhost'
    const third = await open(localHost.href)
    for (const page of [first, second, third]) assert.equal(page.state, 'opened', JSON.stringify(page))
    assert.equal(new Set([first.browserId, second.browserId, third.browserId]).size, 3)
    const original = await pageReferences()
    assert.equal(original.length, 3)
    const creates = receipt.ipc.filter((entry: { channel: string }) => entry.channel === 'browser:create').length
    const navigations = receipt.ipc.filter((entry: { channel: string }) => entry.channel === 'browser:navigate').length
    assert.ok(creates >= 3, 'The original pages must use native create IPC')
    const visibleSurvey = 'document.querySelector("[data-knowledge-surface=\\"survey\\"]")?.checkVisibility()'
    const switchToSpace = async () => {
      await click('[aria-label="Space: show terminal and file workbench"]')
      await wait('profileSurveyNative.read().mainSurface === "workbench"')
    }
    await switchToSpace()
    const switchStarted = performance.now()
    await click('[aria-label="Survey: browse and explore"]')
    await wait(visibleSurvey)
    await wait(exactBrowserFrame(third.browserId))
    assert.equal((await profileSelection()).selection.browserId, third.browserId)
    receipt.manualSurveySwitchMs = performance.now() - switchStarted
    await switchToSpace()
    const held = holdSurveyReply('browser:readProfiles')
    await startFrameObservation()
    const started = performance.now()
    const repeated = open(pageUrl + '?source=one#evidence')
    try {
      await Promise.race([held.arrived, repeated.then(value => { throw Error('Profile read completed before hold: ' + JSON.stringify(value)) })])
      await waitForOpening()
      assert.deepEqual((await profileSelection()).selection, { kind: 'page', browserId: third.browserId, regionId: third.reference.regionId })
      receipt.surfaceBeforeProfileReadback = { elapsedMs: performance.now() - started, retainedBrowserId: third.browserId }
      await capture('opening-existing-page', 'dark', 880, 580)
    } finally { held.release() }
    assert.deepEqual(await repeated, first, 'The repeated link must return the original Browser and Region')
    receipt.existingPageTransition = await finishFrameObservation(first.browserId)
    assert.deepEqual(await pageReferences(), original)
    assert.equal(receipt.ipc.filter((entry: { channel: string }) => entry.channel === 'browser:create').length, creates)
    assert.equal(receipt.ipc.filter((entry: { channel: string }) => entry.channel === 'browser:navigate').length, navigations)

    await click('[aria-label="Settings"]')
    await click('[data-settings-target="survey"]')
    await click('[aria-label="Group saved webpages"]')
    await click('[role="option"][data-value="time"]')
    await wait('Boolean(document.querySelector("[aria-label=\\"Minutes between webpage groups\\"]"))')
    await capture('settings', 'light', 1180, 800)
    await capture('settings', 'dark', 880, 680)
    await click('[aria-label="Survey browsing"] [data-settings-save-bar] button')
    await wait('document.querySelector("[aria-label=\\"Group saved webpages\\"]")?.dataset.value === "time" && !document.querySelector("[aria-label=\\"Survey browsing\\"] [data-settings-save-bar] button:not(:disabled)")')
    assert.equal((await getSettings()).pageGrouping, 'time', 'The settings view saved to the public configuration owner')
    await click('[aria-label="Close settings"]')
    await wait('document.querySelectorAll(".survey-automatic-page-group > h3").length === 1')
    await capture('time', 'dark', 880, 580)
    await result(['settings', 'set', prefix + '.pageGrouping', 'site'])
    await wait('document.querySelectorAll(".survey-automatic-page-group > h3").length >= 1')
    const deadline = Date.now() + 2500
    while (!(await labels()).includes('localhost') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40))
    assert.deepEqual((await labels()).sort(), ['127.0.0.1', 'localhost'], 'Different hosts form separate sections in the actual sidebar')
    await capture('site', 'light', 1180, 800)
    await capture('site', 'dark', 880, 580)
    const native = window.contentView.children.find((view): view is WebContentsView => view instanceof WebContentsView &&
      view.getVisible() && view.webContents.getURL() === pageUrl + '?source=one#evidence')
    assert.ok(native, 'The original selected native webpage must be visible in the matching Browser Region')
    const guestImage = await native.webContents.capturePage(), guestFile = 'first-survey-browsing-native-content.png'
    assert.ok(!guestImage.isEmpty(), 'The original native webpage must produce a content frame')
    await writeFile(join(directory, guestFile), guestImage.toPNG())
    receipt.nativeContent = { file: guestFile, bounds: native.getBounds(), url: native.webContents.getURL(), id: native.webContents.id }
    const { times, selection } = await profileSelection()
    assert.equal(Object.keys(times).length, 3)
    assert.deepEqual(selection, { kind: 'page', browserId: first.browserId, regionId: first.reference.regionId })
    receipt.savedIdentity = { references: original, times, selection, settings: await getSettings(), groups: await labels() }
    await evaluate('profileSurveyNative.checkpoint()')
    await writeFile(identityPath, JSON.stringify(receipt.savedIdentity))
  } else {
    const before = JSON.parse(await readFile(identityPath, 'utf8'))
    await wait('document.querySelectorAll(".survey-automatic-page-group > h3").length === 2')
    const { times, selection } = await profileSelection()
    receipt.recoveredIdentity = { references: await pageReferences(), times, selection, settings: await getSettings(), groups: await labels() }
    assert.deepEqual(receipt.recoveredIdentity, before, 'A second real process must show the original pages and grouping')
  }
  receipt.cases.push({ kind: 'survey-browsing', passed: true })
}
