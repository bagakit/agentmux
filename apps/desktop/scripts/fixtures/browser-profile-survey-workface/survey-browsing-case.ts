import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebContentsView, type BrowserWindow } from 'electron'

export async function surveyBrowsingCase({ phase, directory, window, evaluate, result, receipt, pageUrl, holdProfileRead }: {
  phase: string; directory: string; window: BrowserWindow; evaluate(expression: string): Promise<any>
  result(args: string[]): Promise<any>; receipt: any; pageUrl: string
  holdProfileRead(): { arrived: Promise<void>; release(): void }
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
    const first = await open(pageUrl + '?source=one#evidence')
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
    assert.equal((await profileSelection()).selection.browserId, third.browserId)
    receipt.manualSurveySwitchMs = performance.now() - switchStarted
    await switchToSpace()
    const held = holdProfileRead(), started = performance.now()
    const repeated = open(pageUrl + '?source=one#evidence')
    try {
      await held.arrived
      await wait(visibleSurvey)
      assert.deepEqual((await profileSelection()).selection, { kind: 'page', browserId: third.browserId, regionId: third.reference.regionId })
      receipt.surfaceBeforeProfileReadback = { elapsedMs: performance.now() - started, retainedBrowserId: third.browserId }
    } finally { held.release() }
    assert.deepEqual(await repeated, first, 'The repeated link must return the original Browser and Region')
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
