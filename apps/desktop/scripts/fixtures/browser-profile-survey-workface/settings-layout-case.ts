import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

export async function settingsLayoutCase({ phase, directory, window, evaluate, click, result, receipt, pageUrl }: {
  phase: string; directory: string; window: BrowserWindow; evaluate(expression: string): Promise<any>
  click(selector: string): Promise<void>; result(args: string[]): Promise<any>; receipt: any; pageUrl: string
}) {
  const contents = window.webContents
  const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
  const wait = async (expression: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      const value = await evaluate(expression)
      if (value) return value
      await pause(45)
    }
    throw Error('Settings layout did not confirm: ' + expression)
  }
  async function type(target: string, value: string) {
    await click(target)
    await evaluate(`document.querySelector(${JSON.stringify(target)}).select()`)
    await contents.debugger.sendCommand('Input.insertText', { text: value })
  }
  async function capture(scene: string, theme: 'light' | 'dark', width: number, height: number, anchor?: string) {
    window.setContentSize(width, height)
    await pause(110)
    await evaluate(`profileSurveyNative.appearance(${JSON.stringify(theme)})`)
    const appearance = 'document.documentElement.dataset.appearance'
    await wait(`${appearance} === ${JSON.stringify(theme)} && !document.documentElement.hasAttribute('data-theme-changing')`)
    if (anchor) await evaluate(`document.querySelector(${JSON.stringify(anchor)}).scrollIntoView({ block: 'start' })`)
    const image = await window.capturePage()
    assert.equal(await evaluate(appearance), theme)
    const file = `${phase}-${scene}-${theme}.png`
    receipt.frames.push({ scene, theme, file, size: image.getSize() })
    await writeFile(join(directory, file), image.toPNG())
  }
  const field = (target: string) => `[data-settings-field="${target}"]`
  const pane = (id: string) => `[data-settings-pane="${id}"]`
  const readPref = async (target: string) => (await result(['settings', 'inspect', target])).entries[0]?.value
  const select = async (target: string, value: string) => {
    await click(target)
    await click(`[role="option"][data-value="${value}"]`)
  }
  const readManagement = () => receipt.ipc.filter((event: { channel: string }) =>
    event.channel === 'browser:listTargets' || event.channel === 'browser:listRetainedUploads').length
  const identity = async () => ({
    placement: await readPref('browser.newPagePlacement.survey'),
    grouping: await readPref('browser.surveyBrowsing.pageGrouping'),
    pages: (await result(['space', 'survey-list'])).pageReferences
  })
  await click('[aria-label="Settings"]')
  if (phase === 'restart') {
    receipt.recoveredIdentity = await identity()
    assert.deepEqual(receipt.recoveredIdentity, JSON.parse(await readFile(join(directory, 'settings-layout-identity.json'), 'utf8')))
    receipt.cases.push({ kind: 'settings-layout', passed: true })
    return
  }

  const hiddenReads = readManagement()
  await click('[data-settings-target="browser"]')
  await wait(`Boolean(document.querySelector('${pane('browser')} [aria-label="New webpage in Survey"]'))`)
  await pause(250)
  assert.equal(readManagement(), hiddenReads, 'Opening Browser preferences must not observe the closed management section')
  await capture('browser-preferences', 'dark', 1180, 800)

  await type('[aria-label="Search settings"]', 'exit check')
  await click('[data-settings-search-result="browser:exit-check"]')
  assert.ok(await wait(`document.querySelector('${field('exit-check')}').closest('details').open && document.activeElement?.ariaLabel === 'Exit check address'`))
  await capture('browser-network', 'light', 850, 650)
  await select('[aria-label="New webpage in Survey"]', 'window')
  await click(`${pane('browser')} [data-settings-save-bar] button`)
  await wait(`document.querySelector('${pane('browser')} [data-settings-save-bar] button').disabled`)
  assert.equal(await readPref('browser.newPagePlacement.survey'), 'window')

  await click('[aria-label="Close settings"]')
  const original = await evaluate(`profileSurveyNative.openSurveyUrl(${JSON.stringify(pageUrl)})`)
  assert.equal(original.state, 'opened')
  await click('[aria-label="Settings"]')
  await type('[aria-label="Search settings"]', 'browser resources')
  await click('[data-settings-search-result="browser:browser-resources"]')
  await wait(`document.querySelector('${field('browser-resources')}').closest('details').open && document.querySelector('[data-browser-resource="${original.browserId}"]')`)
  assert.ok(readManagement() > hiddenReads, 'Explicit management discovery must activate real observation')
  await capture('browser-management', 'dark', 1180, 680, '.settings-browser > details > summary')

  await click('[aria-label="Clear settings search"]')
  await click('[data-settings-target="survey"]')
  await capture('survey-overview', 'light', 1180, 800)
  await capture('survey-overview-short', 'dark', 800, 540)
  if (await evaluate('Boolean(document.querySelector(".settings-survey__handlers"))')) {
    await click('.settings-survey__handlers > summary')
    await capture('survey-handlers', 'light', 1180, 800, '[data-settings-field="default-browser"]')
    await click('.settings-survey__handlers > summary')
  }
  await type('[aria-label="Search settings"]', 'start page title')
  await click('[data-settings-search-result="survey:start-title"]')
  await wait(`document.querySelector('${field('start-title')}').closest('details').open && document.activeElement?.ariaLabel === 'Start page title'`)
  await type('[aria-label="Start page title"]', 'Field notes')
  await capture('survey-start', 'dark', 850, 720)
  await capture('survey-start-save', 'dark', 850, 640, '[aria-label="Start page draft preview"]')
  await capture('survey-start-wide', 'light', 1180, 800)
  await click('[aria-label="Clear settings search"]')
  await click('[data-settings-target="browser"]')
  await click('[data-settings-target="survey"]')
  assert.equal(await evaluate('document.querySelector("[aria-label=\\"Start page title\\"]").value'), 'Field notes')
  assert.notEqual(await readPref('browser.startPage.title'), 'Field notes')
  await click(`${pane('survey')} details:first-child > summary`)
  await capture('survey-thumbnails', 'light', 1180, 800)
  await select('[aria-label="Group saved webpages"]', 'time')
  await click('[aria-label="Survey browsing"] [data-settings-save-bar] button')
  await wait('document.querySelector("[aria-label=\\"Survey browsing\\"] [data-settings-save-bar] button").disabled')
  assert.equal(await readPref('browser.surveyBrowsing.pageGrouping'), 'time')

  receipt.savedIdentity = await identity()
  assert.deepEqual(receipt.savedIdentity.pages, [{ regionId: original.reference.regionId, browserId: original.browserId }])
  await evaluate('profileSurveyNative.checkpoint()')
  await writeFile(join(directory, 'settings-layout-identity.json'), JSON.stringify(receipt.savedIdentity))
  receipt.cases.push({ kind: 'settings-layout', passed: true })
}
