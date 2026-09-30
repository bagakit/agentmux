// Run with ego-browser nodejs < this file in the Goal's existing Space 1 / p3.
const fs = await import('node:fs/promises')
const assert = (await import('node:assert/strict')).default
const proof = '.bagakit/feature-tracker/conversation-input-cards-artifacts/T006'
const server = JSON.parse(await fs.readFile(proof + '/preview-server.json', 'utf8'))
const page = (await taskSpace(1)).page('p3')
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false })
await page.goto(server.url)
await page.waitForFunction(() => window.nativeRefreshRead?.nativeHistoryPage?.items.length === 1)
await page.fill('textarea[aria-label="Reply draft"]', 'Keep the original unsent reply draft.')
await page.click('button[aria-label="Copy message"]')
await page.evaluate(() => {
  window.nativeOriginalBody = document.querySelector('.activity-feed .log-turn__body p')
  const range = document.createRange(); range.selectNodeContents(window.nativeOriginalBody)
  window.nativeOriginalRange = range
})
await page.screenshot({ path: proof + '/images/wide-initial.png' })
await page.click('text="Append recorded inputs"')
await page.waitForFunction(() => window.nativeRefreshRead.nativeHistoryPage.items.length === 3 && document.querySelectorAll('.recent-focus__message').length === 2)
const appended = await page.evaluate(() => ({
  ids: window.nativeRefreshRead.nativeHistoryPage.items.map(item => item.id),
  sameBody: window.nativeOriginalBody === document.querySelector('.activity-feed .log-turn__body p'),
  rangeConnected: window.nativeOriginalRange.startContainer === window.nativeOriginalBody && window.nativeOriginalBody.isConnected,
  draft: document.querySelector('textarea').value, copies: window.nativeRefreshPreview.copies,
  controls: window.nativeRefreshPreview.controls, reads: window.nativeRefreshPreview.reads.length,
  watchers: window.nativeRefreshPreview.listeners.size,
  markers: [...document.querySelectorAll('.recent-focus__message')].map(node => node.dataset.messageId)
}))
assert.deepEqual(appended.ids, ['row-0', 'same-body-new', 'untimed-new'])
assert.equal(appended.sameBody, true); assert.equal(appended.rangeConnected, true)
assert.deepEqual(appended.controls, []); assert.equal(appended.markers.length, 2)
await page.screenshot({ path: proof + '/images/wide-appended.png' })
await page.click('button[aria-label="View input records"]')
await page.waitForSelector('[data-input-message-id="native:claude:native-main:untimed-new"]')
await page.click('[data-input-message-id="native:claude:native-main:untimed-new"]')
await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('Record time unknown'))
const records = await page.evaluate(() => ({
  ids: [...document.querySelectorAll('[data-input-source="native"][data-input-message-id]')].map(node => node.dataset.inputMessageId),
  unknownTime: document.querySelector('[role="dialog"]').textContent.includes('Record time unknown'),
  body: document.querySelector('[role="dialog"]').textContent
}))
assert.equal(records.ids.length, 3); assert.equal(records.unknownTime, true)
await page.screenshot({ path: proof + '/images/wide-input-records.png' })
await page.keyboard.press('Escape'); await page.waitForSelector('[role="dialog"]', { state: 'hidden' })
await page.click('text="Simulate read failure"'); await page.waitForFunction(() => !!window.nativeRefreshRead.error)
const failure = await page.evaluate(() => ({
  error: window.nativeRefreshRead.error.message, ids: window.nativeRefreshRead.nativeHistoryPage.items.map(item => item.id),
  sameBody: window.nativeOriginalBody === document.querySelector('.activity-feed .log-turn__body p'), draft: document.querySelector('textarea').value
}))
assert.equal(failure.ids.length, 3); assert.equal(failure.sameBody, true)
await page.screenshot({ path: proof + '/images/wide-read-failure.png' })
await page.click('text="Restore source reading"'); await page.waitForFunction(() => !window.nativeRefreshRead.error && !window.nativeRefreshRead.loading)
await page.click('text="Pause reading"'); await page.waitForFunction(() => window.nativeRefreshPreview.listeners.size === 0)
const paused = await page.evaluate(() => ({ reads: window.nativeRefreshPreview.reads.length, draft: document.querySelector('textarea').value, sameBody: window.nativeOriginalBody === document.querySelector('.activity-feed .log-turn__body p') }))
await page.click('text="Append recorded inputs"'); assert.equal(await page.evaluate(() => window.nativeRefreshPreview.reads.length), paused.reads)
await page.click('text="Return to reading"'); await page.waitForFunction(reads => window.nativeRefreshPreview.reads.length === reads + 1 && !window.nativeRefreshRead.loading, paused.reads)
const returned = await page.evaluate(() => ({
  sameBody: window.nativeOriginalBody === document.querySelector('.activity-feed .log-turn__body p'),
  rangeConnected: window.nativeOriginalRange.startContainer === window.nativeOriginalBody && window.nativeOriginalBody.isConnected,
  controls: window.nativeRefreshPreview.controls, draft: document.querySelector('textarea').value, watchers: window.nativeRefreshPreview.listeners.size
}))
assert.equal(returned.sameBody, true); assert.equal(returned.rangeConnected, true); assert.deepEqual(returned.controls, [])
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 370, height: 1000, deviceScaleFactor: 1, mobile: false })
await page.goto(server.url + '?width=332'); await page.waitForFunction(() => window.nativeRefreshRead?.nativeHistoryPage?.items.length === 1)
await page.click('text="Append recorded inputs"'); await page.waitForFunction(() => window.nativeRefreshRead.nativeHistoryPage.items.length === 3)
await page.screenshot({ path: proof + '/images/narrow-appended.png' })
await page.click('button[aria-label="View input records"]')
await page.waitForSelector('[data-input-message-id="native:claude:native-main:untimed-new"]')
await page.click('[data-input-message-id="native:claude:native-main:untimed-new"]')
await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('Record time unknown'))
await page.screenshot({ path: proof + '/images/narrow-input-records.png' })
const narrow = await page.evaluate(() => ({
  width: document.querySelector('main').getBoundingClientRect().width,
  records: document.querySelectorAll('[data-input-source="native"][data-input-message-id]').length,
  unknownTime: document.querySelector('[role="dialog"]').textContent.includes('Record time unknown'), controls: window.nativeRefreshPreview.controls, draft: document.querySelector('textarea').value
}))
assert.equal(Math.round(narrow.width), 332); assert.equal(narrow.records, 3); assert.deepEqual(narrow.controls, [])
const images = ['wide-initial', 'wide-appended', 'wide-input-records', 'wide-read-failure', 'narrow-appended', 'narrow-input-records'].map(name => proof + '/images/' + name + '.png')
await fs.writeFile(proof + '/actions.json', JSON.stringify({
  passed: true, boundary: 'Actual compiled product Hook/Conversation/Focus with real public reader descriptors and page sample; declared preview invalidation/read failure adapter; no user App/Run/Runtime.',
  appended, records, failure, paused, returned, narrow, images
}, null, 2) + '\n')
console.log({ passed: true, images: images.length, appended, returned, narrow })
console.log(await page.snapshot())
