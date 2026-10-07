const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const [html, privateRoot, receiptPath] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile'))
app.setPath('sessionData', path.join(privateRoot, 'session'))
const result = { passed: false, scenes: [], browserDriverUsed: false, screenshots: [], visualAcceptance: false,
  qualification: 'Private hidden Electron layout of original components with controlled records; no Provider or user Run.' }
let win
const read = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(expression) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await read(expression)) return; await delay(20) }
  throw new Error('Original component did not become ready: ' + expression)
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 420, height: 900, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
    await win.loadFile(html)
    await until(`Boolean(document.querySelector('button[aria-label="Message details"]'))`)
    for (const native of [false, true]) for (const appearance of ['light', 'dark']) for (const width of [320, 420, 920]) {
      win.setContentSize(width, 900)
      await read(`detailsWidthFixture.render(${native},${JSON.stringify(appearance)})`)
      await until(`Boolean(document.querySelector('[data-native-record-id]'))===${native}`)
      await read(`{const button=document.querySelector('button[aria-label="Message details"]');if(button.getAttribute('aria-expanded')!=='true')button.click()}`)
      await until('Boolean(document.querySelector(".conversation-input-details__body"))')
      await delay(30)
      const actual = await read(`(()=>{const row=document.querySelector('.log-turn'),head=row.querySelector('.log-turn__head'),details=row.querySelector('.conversation-input-details__body'),name=row.querySelector('.log-turn__who'),range=document.createRange();range.selectNodeContents(name);const r=e=>{const b=e.getBoundingClientRect();return{left:b.left,right:b.right,width:b.width,height:b.height}};return{row:r(row),head:r(head),details:r(details),name:r(name),nameLines:range.getClientRects().length,feed:document.querySelector('.activity-feed').clientWidth,feedScroll:document.querySelector('.activity-feed').scrollWidth,values:[...details.querySelectorAll('dd,code')].map(e=>({text:e.textContent,rect:r(e),scroll:e.scrollWidth,client:e.clientWidth})),body:row.querySelector('.log-turn__body').textContent,text:details.textContent,copy:Boolean(row.querySelector('button[title="Copy message"]'))}})()`)
      result.scenes.push({ native, appearance, width, actual })
      assert.ok(actual.name.width > 0 && actual.nameLines === 1, 'Original short author label stays on one readable line')
      assert.ok(actual.row.right <= width + 1 && actual.feedScroll <= actual.feed + 1, 'Original row stays inside its reading column')
      assert.ok(actual.details.left >= actual.head.left - 1 && actual.details.right <= actual.head.right + 1, 'Details stay inside the original message header')
      for (const value of actual.values) assert.ok(value.rect.right <= actual.details.right + 1 && value.scroll <= value.client + 1, 'Full reference and value wrap inside details')
      const reference = await read('detailsWidthFixture.reference')
      assert.ok(actual.values.some(value => value.text === reference), 'Full exact reference retained')
      assert.equal(actual.body, await read('detailsWidthFixture.body'))
      assert.ok(actual.text.includes(native ? 'Unconfirmed · original text retained' : 'Recorded separately from generated context'))
      assert.ok(actual.text.includes('Requires the original audience and sharing authorization')); assert.ok(actual.copy)
      const copiedBefore = await read('detailsWidthFixture.copies.length')
      await read(`document.querySelector('.log-turn button[title="Copy message"]').click()`)
      await until(`detailsWidthFixture.copies.length>${copiedBefore}`)
      assert.equal(await read('detailsWidthFixture.copies.at(-1)'), await read('detailsWidthFixture.body'))
      await read(`document.querySelector('button[aria-label="Message details"]').click()`)
      await until('!document.querySelector(".conversation-input-details__body")')
    }
    assert.deepEqual(await read('detailsWidthFixture.controls'), [])
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error) }
  finally { await fs.writeFile(receiptPath, JSON.stringify(result, null, 2) + '\n'); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
