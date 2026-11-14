const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [url, evidence, phase] = process.argv.slice(2)
app.setPath('userData', path.join(evidence, 'profile'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, phase, images: [], boundary: 'Actual HTTP Mobile main/ConnectionRoot/App/Composer and original browser storage. SDK transport facts alone reuse the controlled product fixture; actual E2EE is separately proved.' }
app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } })
    const read = code => win.webContents.executeJavaScript(code)
    const until = async code => { for (let i=0;i<300;i++) { if (await read(`(()=>{try{return Boolean(${code})}catch{return false}})()`)) return; await pause(30) }; throw Error('Original product observation not available: ' + code) }
    await win.loadURL(url)
    if (phase === 'initial') {
      await until('document.querySelector(".mobile-connect-page")?.textContent.includes("正在读取连接")')
      assert.equal(await read('shortLinkProbe.facts().calls.filter(c=>c.method==="fixture.connect").length'), 0)
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      await fs.writeFile(path.join(evidence, 'short-link-reading-390.png'), (await win.webContents.capturePage()).toPNG())
      result.images.push('short-link-reading-390.png')
      process.stderr.write('short-link:metadata-painted\n')
    }
    await until('document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")')
    const facts = () => read('shortLinkProbe.facts()')
    const before = await facts()
    assert.equal(before.record.host.origin, new URL(url).origin)
    assert.equal(before.record.host.hostId, 'host-original')
    assert.equal(before.record.selectedSessionId, 'session-mote')
    assert.ok(before.page.namespaceDigest?.startsWith('sha256:'))
    assert.match(new URL(before.url).pathname, /^\/m\/[A-Za-z0-9_-]{43}\/$/u)
    assert.equal(new URL(before.url).hash, '')
    if (phase !== 'initial') {
      const original = JSON.parse(await fs.readFile(path.join(evidence, 'initial.json'), 'utf8'))
      assert.notEqual(process.pid, original.pid, 'Restoration must run in another actual OS process')
      const restored = structuredClone((await facts()).record)
      if (!Object.hasOwn(original.record.presentation, 'recentMoteSpaceId')) {
        assert.equal(restored.presentation.recentMoteSpaceId, original.record.presentation.identity.mote.spaceId, 'Startup derives recent Mote from the original saved identity')
        delete restored.presentation.recentMoteSpaceId
      }
      assert.deepEqual(restored, original.record, 'All original device record and retained draft fields survive')
      assert.equal(await read('shortLinkProbe.keyHash()'), original.keyHash, 'Original IndexedDB device key survives')
      assert.equal((await facts()).offer, original.offer, 'Original confirmed full offer survives')
    }
    await until('document.querySelector(".mobile-conversation-panel:not([hidden]) [contenteditable=true]")?.textContent.includes("原短链接草稿跨进程保留")')
    const final = await facts()
    assert.equal(final.calls.filter(call => /submit|ensureAgentContinuity|signalAgent|agent\.open|agent\.automation\.pause|stopAgent|createAgent/u.test(call.method)).length, 0, 'Viewing and restoring never dispatches business input or lifecycle')
    Object.assign(result, final, { keyHash: await read('shortLinkProbe.keyHash()'), passed: true })
  } catch (error) { result.error = { message: error.message, stack: error.stack } }
  finally {
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
