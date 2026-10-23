const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createServer } = require('node:http')
const { createHash } = require('node:crypto')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
const mailboxReading = process.argv.slice(5).includes('--mailbox-reading')
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], interactions: [], boundary: 'Original public Core input and cached profile DTOs. Actual common card, speaker resolver, Channel hook, header and cache management with production CSS; controlled later native/cache observations, no live tenant.' }
let win, avatarServer
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1000, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    if (mailboxReading) {
      // The producer's example URL is retained in the real img. Only its private
      // visual transport is redirected to a bounded, deterministic avatar asset.
      const avatar = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="#355e58"/><circle cx="48" cy="35" r="16" fill="#d2eee3"/><path d="M18 86a30 30 0 0 1 60 0" fill="#d2eee3"/></svg>'
      avatarServer = createServer((request, response) => {
        response.writeHead(request.url === '/avatar.svg' ? 200 : 404, { 'Content-Type': 'image/svg+xml' })
        response.end(request.url === '/avatar.svg' ? avatar : '')
      })
      await new Promise(resolve => avatarServer.listen(0, '127.0.0.1', resolve))
      const originalURLs = ['https://cdn.example/person.png', 'https://cdn.example/group.png']
      const redirectURL = `http://127.0.0.1:${avatarServer.address().port}/avatar.svg`
      win.webContents.session.webRequest.onBeforeRequest({ urls: originalURLs }, (_request, callback) => callback({ redirectURL }))
      result.avatarTransport = { originalURLs, assetSHA256: createHash('sha256').update(avatar).digest('hex'),
        boundary: 'Private loopback fixture avatar bytes only. The original observed profile URL and actual img loading remain visible; no tenant image or network delivery is claimed.' }
    }
    result.console = []
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.console.push(message) })
    await win.loadFile(html, mailboxReading ? { query: { 'mailbox-reading': '1' } } : undefined)
    const { read, until, settle, click } = nativeRendererInput(win, result.interactions, '')
    await until('window.channelProfilesProof?.ready && document.querySelector(".log-turn__sender")?.textContent === "Original native person"')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    async function capture(name) { await settle(); const file = name + '.png'; fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push(file) }
    await click('.channel-metadata summary'); await until('document.querySelector(".channel-metadata__identity strong")')
    await capture('profiles-wide')
    await read('window.channelProfilesProof.rename()'); await until('document.querySelector(".agent-region-header__connector")?.textContent.includes("Renamed original group")')
    win.setContentSize(360, 900); await until('innerWidth===360'); await capture('profiles-renamed-narrow')
    await read('window.channelProfilesProof.failNext=true')
    await click('.channel-metadata__actions button'); await until('document.querySelector(".channel-metadata__status")')
    await capture('profiles-busy-narrow')
    await until('document.querySelector(".channel-metadata__issue")'); await capture('profiles-failed-narrow')
    await click('.channel-metadata__actions button:last-child'); await until('document.querySelector(".channel-metadata__identity strong")?.textContent === "Profile not observed"')
    await capture('profiles-cleared-narrow')
    result.layout = await read('({width:innerWidth, content:document.documentElement.scrollWidth, originalCard:document.querySelector(".log-turn").getBoundingClientRect().toJSON()})')
    assert(result.layout.content <= result.layout.width, 'The original actor label must fit the narrow reading surface')
    if (mailboxReading) {
      win.setContentSize(1000, 900); await until('innerWidth===1000')
      await read('window.channelProfilesProof.openMailbox()')
      await until('!!document.querySelector(".composer__mailbox")')
      await click('.composer__mailbox')
      await until('document.querySelector(".composer-mailbox:popover-open")?.dataset.state === "open"')
      await click('.composer-mailbox [role="tab"][id$="-user-tab"]')
      const original = await read('window.channelProfilesProof.mailbox')
      assert.ok(original.historyKey && original.journalKey && original.avatar && original.name)
      assert.ok(original.historyBody && original.journalBody && original.journalReading.body && original.journalReading.quote.raw)
      const rowSelector = key => `.composer-mailbox__row[data-record-key=${JSON.stringify(key)}]`
      const avatarOf = selector => `(()=>{const n=document.querySelector(${JSON.stringify(selector)}),i=n?.querySelector('img');if(!n||!i)return null;const r=n.getBoundingClientRect();return {key:n.dataset.recordKey,url:i.getAttribute('src'),width:i.getAttribute('width'),loaded:i.complete&&i.naturalWidth>0,visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight,name:n.querySelector('strong')?.textContent}})()`
      for (const key of [original.historyKey, original.journalKey]) await until(`(${avatarOf(rowSelector(key))})?.loaded`)
      const rows = await Promise.all([original.historyKey, original.journalKey].map(key => read(avatarOf(rowSelector(key)))))
      for (const row of rows) {
        assert.equal(row.url, original.avatar); assert.equal(row.width, '18'); assert.equal(row.name, original.name)
        assert.equal(row.loaded, true); assert.equal(row.visible, true)
      }
      await capture('profiles-mailbox-list')
      const details = []
      for (const [kind, key, body] of [['history', original.historyKey, original.historyBody], ['journal', original.journalKey, original.journalBody]]) {
        await click(rowSelector(key))
        const selector = `.composer-mailbox__detail[data-record-key=${JSON.stringify(key)}] .log-turn`
        await until(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),i=n?.querySelector('.log-turn__node img');return i?.complete&&i.naturalWidth>0})()`)
        const detail = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),i=n.querySelector('.log-turn__node img'),r=n.getBoundingClientRect(),b=n.querySelector('.log-turn__body'),reading=b.cloneNode(true);reading.querySelectorAll('.conversation-protocol').forEach(n=>n.remove());return {key:${JSON.stringify(key)},messageId:n.dataset.messageId,url:i.getAttribute('src'),width:i.getAttribute('width'),loaded:i.complete&&i.naturalWidth>0,name:n.querySelector('.log-turn__sender')?.textContent,body:b.textContent,readingBody:reading.textContent,visibleBody:b.innerText,bodyVisible:b.checkVisibility(),visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight}})()`)
        assert.equal(detail.url, original.avatar); assert.equal(detail.width, '20'); assert.equal(detail.name, original.name)
        assert.equal(detail.loaded, true); assert.equal(detail.visible, true); assert.equal(detail.bodyVisible, true)
        let protocol = null
        if (kind === 'history') assert.equal(detail.body, body)
        else {
          // Read the body independently of its protocol card. Full wire is
          // checked through the actual Copy action below, never reconstructed.
          assert.equal(detail.readingBody, original.journalReading.body)
          assert.ok(detail.visibleBody.endsWith(original.journalReading.body), 'The complete original body is visible outside the protocol card')
          const quoteSelector = selector + ' .conversation-protocol[data-protocol-kind="channel-quote"]'
          protocol = await read(`(()=>{const nodes=document.querySelectorAll(${JSON.stringify(quoteSelector)}),n=nodes[0],d=n?.querySelector('details[data-channel-quote]');return {count:nodes.length,title:n?.querySelector('.conversation-protocol__title')?.textContent,tag:n?.querySelector('.conversation-protocol__header code')?.textContent,coverage:d?.dataset.channelQuote,summary:d?.querySelector('summary')?.textContent,visible:n?.checkVisibility(),originalSummary:n?.querySelector('.conversation-protocol__original summary')?.textContent}})()`)
          assert.equal(protocol.count, 1); assert.equal(protocol.visible, true)
          assert.equal(protocol.title, 'Quoted channel history'); assert.equal(protocol.tag, 'amux:quote')
          const quote = original.journalReading.quote.quote
          assert.equal(protocol.coverage, quote.coverage)
          assert.equal(protocol.summary, `${quote.records.length} earlier messages · ${quote.coverage === 'complete' ? 'Observed interval complete' : 'History has gaps'}`)
          assert.equal(protocol.originalSummary, 'Original protocol')
          const originalSelector = quoteSelector + ' .conversation-protocol__original'
          await click(originalSelector + ' > summary')
          await until(`document.querySelector(${JSON.stringify(originalSelector)})?.open`)
          protocol.original = await read(`(()=>{const n=document.querySelector(${JSON.stringify(originalSelector + ' > pre')});return {text:n?.textContent,visible:n?.checkVisibility()}})()`)
          assert.equal(protocol.original.text, original.journalReading.quote.raw); assert.equal(protocol.original.visible, true)
          await click(originalSelector + ' > summary')
          await until(`!document.querySelector(${JSON.stringify(originalSelector)})?.open`)
        }
        const copyIndex = await read('window.channelProfilesProof.copies.length')
        await click(selector + ' .log-turn__action[title="Copy message"]')
        await until(`window.channelProfilesProof.copies.length===${copyIndex + 1}&&document.querySelector(${JSON.stringify(selector + ' .log-turn__actions')})?.dataset.copyState==='copied'`)
        const copied = await read(`window.channelProfilesProof.copies[${copyIndex}]`)
        assert.equal(copied, body, 'Native whole-message Copy retains the complete original wire')
        details.push({ kind, ...detail, protocol, copied }); await capture('profiles-mailbox-' + kind)
        await click('[aria-label="Back to Inputs"]')
        await until(`(${avatarOf(rowSelector(original.historyKey))})?.loaded&&(${avatarOf(rowSelector(original.journalKey))})?.loaded`)
      }
      await click('[aria-label="Close mailbox"]')
      result.mailbox = { passed: true, original, rows, details,
        boundary: 'Native selection, protocol disclosure and whole-message Copy in actual SessionMailbox; the private clipboard sink records the original wire without touching the user clipboard. List and detail are mutually exclusive product states. The three images retain their real transitions, not a composite. Core/RPC correctness belongs to the bound original consumer proof.' }
    }
    result.facts = await read('({calls:window.channelProfilesProof.calls,errors:window.channelProfilesProof.errors})'); assert.deepEqual(result.facts.errors, [])
    result.passed = true
  } catch (error) {
    result.failure = { message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      result.scene = await win.webContents.executeJavaScript(`({text:document.body.innerText,ready:window.channelProfilesProof?.ready,
        errors:window.channelProfilesProof?.errors,calls:window.channelProfilesProof?.calls,original:window.channelProfilesProof?.mailbox,
        rows:[...document.querySelectorAll('.composer-mailbox__row')].map(n=>({key:n.dataset.recordKey,text:n.textContent,
          images:[...n.querySelectorAll('img')].map(i=>({url:i.getAttribute('src'),width:i.getAttribute('width'),complete:i.complete,naturalWidth:i.naturalWidth}))}))})`)
        .catch(failure => ({ message: failure.message }))
      try { fs.writeFileSync(path.join(evidence, 'profiles-failure.png'), (await win.webContents.capturePage()).toPNG()); result.failureImage = 'profiles-failure.png' }
      catch (failure) { result.failureImageError = failure.message }
    }
    process.exitCode = 1
  }
  finally {
    if (win && !win.isDestroyed()) win.destroy()
    if (avatarServer) { await new Promise(resolve => avatarServer.close(resolve)); result.avatarTransport.closed = !avatarServer.listening }
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); app.quit()
  }
}).catch(error => { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify({ passed: false, failure: { message: error.message } })); app.exit(1) })
