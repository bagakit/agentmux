const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, profile, evidence, mode] = process.argv.slice(2)
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
const report = { passed: false, mode, scenarios: [], userRunTouched: false }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const evaluate = code => win.webContents.executeJavaScript(code, true)
  const facts = () => evaluate('conversationKeyframeProbe.facts()')
  async function until(expression, message, timeout = 12000) {
    const deadline = Date.now() + timeout
    while (!await evaluate(expression)) { assert.ok(Date.now() < deadline, message); await delay(25) }
    await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  }
  async function capture(name) { await delay(80); await fs.writeFile(path.join(evidence, `${mode}-${name}.png`), (await win.webContents.capturePage()).toPNG()) }
  async function click(selector, index = 0) {
    const point = await evaluate(`(() => {const r=document.querySelectorAll(${JSON.stringify(selector)})[${index}].getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await delay(60)
  }
  const assertPixels = frames => {
    assert.equal(frames.length, 2, 'Exactly the two visual original records must have cached keyframes')
    const [red, green] = frames.map(frame => frame.pixel)
    assert.ok(red[3] > 240 && red[0] > 180 && red[1] < 70 && red[2] < 70, 'The keyframe must contain the decoded original red image pixels')
    assert.ok(green[3] > 240 && green[0] < 70 && green[1] > 130 && green[2] < 100, 'The keyframe must contain the decoded original green image pixels')
    for (const frame of frames) {
      assert.ok(frame.src.startsWith('data:image/webp;'), 'The cache must contain a bounded encoded frame, not source owners or URLs')
      assert.ok(frame.naturalWidth <= 128 && frame.naturalHeight <= 80, 'The cache must stay within its 128 × 80 pixel budget')
    }
  }
  try {
    await win.loadFile(html)
    await until("document.querySelectorAll('.conversation-axis__keyframe').length === 2 && [...document.querySelectorAll('.conversation-axis__keyframe')].every(image=>image.naturalWidth)", 'The real message image decode must reach the original axis')
    for (const [name, width, height, theme] of [['normal-light', 1100, 850, 'light'], ['normal-dark', 1100, 850, 'dark'], ['narrow-dark', 390, 800, 'dark']]) {
      win.setContentSize(width, height)
      await evaluate(`conversationKeyframeProbe.configure(${JSON.stringify({ theme })})`)
      await delay(90)
      const value = await facts(); report.scenarios.push({ name, value }); await capture(name)
      assert.equal(value.hidden, false, 'The private native probe must actually expose visible decoded document facts')
      assert.equal(value.appearance, theme)
      assertPixels(value.keyframes)
      assert.equal(value.axis.height, 24, 'The existing axis must retain its 24px reading density')
      assert.ok(value.marks.every(mark => mark.height === 24 && mark.avatar), 'Every marker must retain its original avatar and full hit target')
      assert.ok(value.marks.every(mark => mark.avatarGlyph), 'The actual Provider artwork must remain present for visual identity review')
      assert.equal(value.marks[2].keyframe, false, 'A text-only original must retain its avatar without a fabricated keyframe')
      assert.equal(value.reads.length, 2, 'Timeline observations must not add another original media read')
      assert.ok(value.messages.every(message => message.sourceKey === JSON.stringify(['keyframe-session', 'captured', message.id])), 'Every message and record association must use the exact production source-key contract')
      assert.ok(value.originalImages.every(image => image.complete && image.width === 320 && image.height === 160), 'The unchanged real message images must remain decoded')
    }
    await click('.conversation-axis__mark', 0)
    const selected = await facts(); report.scenarios.push({ name: 'selected-original', value: selected }); await capture('selected-original')
    assert.equal(selected.selections.at(-1), 'red-original', 'The original axis selection callback must receive the exact red record')
    assert.equal(selected.messages.find(message => message.id === 'red-original').located, 'true')
    assert.equal(selected.messages.find(message => message.id === 'red-original').active, true, 'Original click navigation must focus the original message')
    await evaluate('conversationKeyframeProbe.configure({cluster:true})')
    await until("document.querySelector('.conversation-axis__count')?.textContent === '2'", 'Dense original records must cluster honestly')
    await click('.conversation-axis__cluster')
    await until("document.querySelectorAll('.conversation-axis__entry-keyframe').length === 2", 'Opening a cluster must retain one original frame per visual record')
    const clustered = await facts(); report.scenarios.push({ name: 'cluster-records', value: clustered }); await capture('cluster-records')
    assert.equal(clustered.marks.find(mark => mark.count).keyframe, false, 'A cluster count must not pretend one frame represents several records')
    assert.equal(clustered.entries.length, 2)
    assert.ok(clustered.entries.every(entry => entry.avatar && entry.keyframe))
    assertPixels(clustered.keyframes)
    assert.ok(clustered.entries[0].text.includes('Red review frame') && clustered.entries[1].text.includes('Green accepted frame'), 'Each cluster row must retain its own exact original excerpt')
    await click('.conversation-axis__entry', 1)
    assert.equal((await facts()).selections.at(-1), 'green-original', 'Cluster selection must navigate to the chosen exact original')
    await evaluate('conversationKeyframeProbe.configure({cluster:false, invalidated:true})')
    await until("document.querySelectorAll('.conversation-axis__keyframe').length === 1 && document.querySelectorAll('.md-conversation-image__thumb').length === 1", 'Removing a visual from the exact current body must evict its old frame')
    const invalidated = await facts(); report.scenarios.push({ name: 'changed-current-body', value: invalidated }); await capture('changed-current-body')
    assert.equal(invalidated.marks[0].keyframe, false, 'A changed text-only record must not inherit its old visual')
    assert.equal(invalidated.marks[1].keyframe, true)
    assert.equal(invalidated.reads.length, 2, 'Invalidation must not perform a hidden replacement media read')
    const beforeIdle = invalidated.reads.length
    await evaluate("document.querySelector('.activity-feed').dispatchEvent(new Event('scroll'))")
    await delay(120)
    assert.equal((await facts()).reads.length, beforeIdle, 'Scroll observation must not perform another original read')
    report.passed = true
  } catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    win.destroy(); report.remainingWindows = BrowserWindow.getAllWindows().length
    await fs.writeFile(path.join(evidence, `${mode}.render.json`), JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1)
  }
}).catch(async error => { report.failure = { name: error.name, message: error.message, stack: error.stack }; await fs.writeFile(path.join(evidence, `${mode}.render.json`), JSON.stringify(report, null, 2)); app.exit(1) })
