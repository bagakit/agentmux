import assert from 'node:assert/strict'
import { app, BrowserWindow, dialog, nativeImage, screen } from 'electron'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CaptureSequenceOwner } from '../../../src/main/capture-sequence'
import { ScreenCapture } from '../../../src/main/screen-capture'
import { inspectGif } from '../../../src/shared/gif-metadata'
import { NativeDesktop } from '@agentmux/native-desktop'
import { AgentMuxRpcService } from '@agentmux/core'

const automatic = process.env.CAPTURE_AUTO_TEST === '1'
const live = process.env.CAPTURE_SEQUENCE_LIVE === '1', recorded = process.env.CAPTURE_RECORDED_NATIVE
let native: NativeDesktop | undefined, sourceWindow: BrowserWindow | undefined, server: { stop(): Promise<void> } | undefined
const out = process.env.CAPTURE_SEQUENCE_OUT!, mode = process.env.CAPTURE_SEQUENCE_MODE! as 'scroll' | 'gif'
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const result: any = { passed: false, mode, observations: [], screenshots: [] }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(name: string, read: () => Promise<T> | T): Promise<NonNullable<T>> {
  const start = performance.now()
  while (performance.now() - start < 10000) { const value = await read(); if (value) return value as NonNullable<T>; await wait(30) }
  const windows = BrowserWindow.getAllWindows(); const body = windows[0] ? await windows[0].webContents.executeJavaScript('document.body.innerText') : 'no window'
  throw new Error('Timed out: ' + name + '\n' + body)
}
function frame(offset: number) {
  const width = 480, height = 260, bitmap = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, row = y + offset
    bitmap[i] = (row * 13 + x * 3) % 251; bitmap[i + 1] = (row * 7 + x * 11) % 251; bitmap[i + 2] = (row * 23 + x * 7) % 251; bitmap[i + 3] = 255
  }
  const bytes = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG()
  return { image: { mimeType: 'image/png' as const, width, height, dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), byteLength: bytes.length }, bitmap }
}
async function run() {
  await app.whenReady()
  let sampleCount = 0
  let retainedFrames: Array<ReturnType<typeof frame>['image']> = []
  let initial = frame(0).image, source = { rect: { x: 10, y: 10, width: 480, height: 260 }, scale: 1, capturedAt: Date.now() }
  if (recorded) {
    const journal = JSON.parse(await readFile(join(recorded, 'receipt.json'), 'utf8'))
    source = journal.source
    for (const row of journal.frames) {
      const bytes = await readFile(join(recorded, row.file))
      retainedFrames.push({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), width: row.width, height: row.height, byteLength: bytes.length })
    }
    initial = retainedFrames[0]!
    result.observations.push({ recordedNativeSource: recorded, frames: retainedFrames.length, boundary: 'Saved actual SCK pixels reused for fresh product layout review; no new physical capture is claimed.' })
  }
  if (live) {
    native = new NativeDesktop({ executablePath: process.env.CAPTURE_SEQUENCE_HELPER!, connectTimeoutMs: 15000, requestTimeoutMs: 15000 })
    const area = screen.getPrimaryDisplay().workArea
    sourceWindow = new BrowserWindow({ x: area.x + Math.round((area.width - 740) / 2), y: area.y + Math.round((area.height - 520) / 2), width: 740, height: 520, show: true, alwaysOnTop: true, webPreferences: { backgroundThrottling: false } })
    const rows = Array.from({ length: 24 }, (_, index) => `<section style="height:85px;box-sizing:border-box;padding:14px 24px;background:hsl(${(index * 47) % 360} 30% 92%);color:#213044;border-bottom:1px solid #aebbc7"><b>${String(index + 1).padStart(2, '0')} · Capture evidence</b><div>Review the selected region, preserve the source, and annotate the exact frame.</div><small id="counter-${index}">Screen capture · frame 0</small></section>`).join('')
    await sourceWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;font:14px/1.5 system-ui">' + rows + '</body>'))
    await sourceWindow.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const bounds = sourceWindow.getContentBounds(); source.rect = { x: bounds.x, y: bounds.y, width: 480, height: 260 }
    const first = await native.captureScreenshot({ mode: 'rect', rect: source.rect })
    assert.equal(first.state, 'captured', JSON.stringify(first.error))
    const shot = first.screenshot!; initial = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + shot.data, width: shot.width, height: shot.height, byteLength: Buffer.byteLength(shot.data, 'base64') }; source.scale = shot.scale
    result.observations.push({ live: true, source: source.rect, scale: shot.scale, helper: process.env.CAPTURE_SEQUENCE_HELPER })
  }
  if (automatic) { sourceWindow = new BrowserWindow({ width: 240, height: 160, show: true }); await sourceWindow.loadURL('data:text/html,<body>Existing host window</body>') }
  const owner = new CaptureSequenceOwner({ directory: join(out, 'captures'), home: join(out, 'home'), appearance: () => ({ terminalTheme: 'graphite', appAppearance: 'dark' }),
    select: async () => ({ image: initial, source }), native: () => ({ captureScreenshot: async (params: any) => {
      assert.equal(params.mode, 'rect'); assert.deepEqual(params.rect, source.rect); assert.equal(params.excludeWindowIds.length, automatic ? 2 : 1, 'the actual excluded background preserves exact host window exclusions')
      if (automatic) {
        sampleCount++
        const next = recorded ? retainedFrames[sampleCount <= 2 ? 0 : 1]! : frame(sampleCount <= 2 ? 0 : 85).image
        return { state: 'captured' as const, screenshot: { format: 'png' as const, data: next.dataUrl.split(',')[1]!, width: next.width, height: next.height, scale: source.scale }, selectionRect: source.rect }
      }
      if (mode === 'scroll' && !live && sampleCount === 1) {
        sampleCount++
        const bitmap = Buffer.alloc(initial.width * initial.height * 4)
        for (let i = 3; i < bitmap.length; i += 4) bitmap[i] = 255
        const bytes = nativeImage.createFromBitmap(bitmap, { width: initial.width, height: initial.height }).toPNG()
        return { state: 'captured' as const, screenshot: { format: 'png' as const, data: bytes.toString('base64'), width: initial.width, height: initial.height, scale: source.scale }, selectionRect: source.rect }
      }
      if (recorded) {
        const next = retainedFrames[(++sampleCount === 1 ? 1 : 2)]!
        return { state: 'captured' as const, screenshot: { format: 'png' as const, data: next.dataUrl.split(',')[1]!, width: next.width, height: next.height, scale: source.scale }, selectionRect: source.rect }
      }
      if (live) {
        sampleCount++
        if (mode === 'scroll') {
          await sourceWindow!.webContents.executeJavaScript(`window.scrollTo(0, ${sampleCount * 85})`)
          await until('actual source scroll', async () => await sourceWindow!.webContents.executeJavaScript('document.scrollingElement.scrollTop') >= sampleCount * 85)
        } else await sourceWindow!.webContents.executeJavaScript(`document.querySelector('#counter-0').textContent='Screen capture · frame ${sampleCount}'`)
        await sourceWindow!.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        const captured = await native!.captureScreenshot(params)
        assert.equal(captured.state, 'captured', JSON.stringify(captured.error))
        const actualImage = nativeImage.createFromBuffer(Buffer.from(captured.screenshot!.data, 'base64'))
        const expectedImage = await sourceWindow!.webContents.capturePage({ x: 0, y: 0, width: 480, height: 260 })
        const expected = expectedImage.resize({ width: captured.screenshot!.width, height: captured.screenshot!.height }).toBitmap(), actual = actualImage.toBitmap()
        let matches = 0, count = 0
        for (let i = 0; i < actual.length; i += 148) { count++; if (Math.abs(actual[i]! - expected[i]!) < 16 && Math.abs(actual[i + 1]! - expected[i + 1]!) < 16 && Math.abs(actual[i + 2]! - expected[i + 2]!) < 16) matches++ }
        await writeFile(join(out, `source-native-${sampleCount}.png`), actualImage.toPNG()); await writeFile(join(out, `source-reference-${sampleCount}.png`), expectedImage.toPNG())
        assert.ok(matches / count > .9, `native capture excludes its control window and preserves the real source pixels: ${matches / count}, actual ${actual.length}, expected ${expected.length}`)
        result.observations.push({ actualNativeFrame: sampleCount, sourcePixelMatch: matches / count })
        return captured
      }
      sampleCount++
      const next = frame(mode === 'scroll' ? sampleCount === 1 ? 85 : 170 : sampleCount * 2).image
      return { state: 'captured' as const, screenshot: { format: 'png' as const, data: next.dataUrl.split(',')[1]!, width: next.width, height: next.height, scale: 1 }, selectionRect: source.rect }
    } }) })
  const evaluate = (code: string) => window.webContents.executeJavaScript(code)
  let window: BrowserWindow
  const click = async (label: string) => { await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing button '+${JSON.stringify(label)});button.click()})()`); await wait(80) }
  if (mode === 'scroll') {
    let delivered: any = null
    const capture = new ScreenCapture({ home: join(out, 'home'), native: () => ({ captureScreenshot: async () => { throw Error('Wrong source') }, writeClipboardImage: async () => {} }),
      appActive: () => true, present: async session => { await session.complete(initial, source, 'fixture', automatic ? 'excluded' : 'included'); return { state: 'completed' } },
      sequence: (kind, selection) => owner.edit(kind, selection), reportIssue: error => { throw error }, edit: async image => { delivered = image } })
    const closed = capture.capture(false, 'scroll')
    window = await until('capture window', () => BrowserWindow.getAllWindows().find(w => w !== sourceWindow))
    if (live) window.setAlwaysOnTop(true, 'floating', 1)
    await until('scrolling controls', async () => await evaluate("document.body.textContent.includes('Capture next')"))
    if (automatic) {
      await click('Start scrolling capture')
      await until('automatic changed frame', async () => await evaluate("document.body.textContent.includes('2 frames')"))
      assert.ok(sampleCount >= 3, 'unchanged native samples do not grow the captured sequence')
      const compact = window.getContentBounds()
      assert.ok(compact.width <= 440 && compact.height <= 360, 'automatic capture uses a compact accessible control window')
      assert.ok(compact.x >= source.rect.x + source.rect.width || compact.x + compact.width <= source.rect.x || compact.y >= source.rect.y + source.rect.height || compact.y + compact.height <= source.rect.y, 'controls use available space outside the selected source')
      for (const theme of ['dark', 'light']) {
        await evaluate(`window.setCaptureFixtureTheme('${theme}')`)
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        const file = `scroll-sampling-${theme}.png`; await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG()); result.screenshots.push(file)
      }
      await click('Stop scrolling capture')
      await until('automatic capture returned to review', async () => await evaluate("document.body.textContent.includes('Start scrolling capture') && !document.querySelector('button.primary-button').disabled"))
      assert.ok(window.getContentBounds().width > compact.width, 'stop restores review in the same window')
      const snapshot = await evaluate("window.captureSequence.load()")
      assert.equal(snapshot.frames.length, 2, 'a stopped automatic sequence retains only its actual changed frames')
      for (const theme of ['dark', 'light']) for (const width of [860, 440]) {
        await evaluate(`window.setCaptureFixtureTheme('${theme}')`); window.setContentSize(width, 640)
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        const file = `scroll-auto-review-${theme}-${width}.png`; await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG()); result.screenshots.push(file)
      }
      await click('Edit long image'); await closed
      assert.equal(delivered.height, initial.height + 85 * source.scale, 'automatic deduplication and the actual joined pixels reach the original editor consumer')
      result.observations.push({ automatic: true, exactBackground: true, nativeSamples: sampleCount, acceptedFrames: 2, outputHeight: delivered.height })
      result.passed = true; return
    }
    await click('Capture next'); await until('second frame', async () => await evaluate("document.body.textContent.includes('2 frames') && !document.querySelector('button.primary-button').disabled"))
    if (!live) {
      await click('Capture next')
      await until('uncertain overlap is explicit', async () => await evaluate("document.body.textContent.includes('overlap is unclear') && !document.querySelector('button.primary-button').disabled"))
      window.setContentSize(440, 640); await evaluate("window.setCaptureFixtureTheme('light')")
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const file = 'scroll-error-narrow-light.png'; await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG()); result.screenshots.push(file)
      await click('Undo last frame'); await until('uncertain frame can be undone', async () => await evaluate("document.body.textContent.includes('2 frames') && !document.querySelector('button.primary-button').disabled"))
      result.observations.push({ ambiguousFrameRetained: true, undoRecovered: true })
    }
    await click('Capture next'); await until('third frame', async () => await evaluate("document.body.textContent.includes('3 frames') && !document.querySelector('button.primary-button').disabled"))
    for (const theme of ['dark', 'light']) for (const width of [860, 440]) {
      await evaluate(`window.setCaptureFixtureTheme('${theme}')`); window.setContentSize(width, 640)
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const file = `scroll-review-${theme}-${width}.png`; await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG()); result.screenshots.push(file)
    }
    await click('Edit long image'); await closed
    assert.equal(delivered.width, initial.width); assert.equal(delivered.height, 430 * source.scale, 'two real overlaps append exactly 170 new rows')
    if (!live && !recorded) {
    const actual = nativeImage.createFromBuffer(Buffer.from(delivered.dataUrl.split(',')[1], 'base64')).toBitmap()
    const expectedTop = frame(0).bitmap, expectedBottom = frame(170).bitmap
    assert.deepEqual(actual.subarray(0, expectedTop.length), expectedTop, 'the first viewport remains exact')
    assert.deepEqual(actual.subarray(260 * 480 * 4), expectedBottom.subarray(90 * 480 * 4), 'the appended pixels preserve the actual scrolled rows')
    }
    result.observations.push({ sourceCalls: sampleCount, output: [delivered.width, delivered.height] })
  } else {
    const service = new AgentMuxRpcService({ coreClients: () => [], sequences: owner }), input = { hostId: 'local', operationId: 'original-sequence', mode: 'gif' as const }, context = { principal: { kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` } }
    const opened = await service.call('capture.sequence.open', input, context); assert.equal(opened.state, 'selecting')
    await service.call('capture.sequence.open', input, context)
    window = await until('capture window', () => BrowserWindow.getAllWindows().find(w => w !== sourceWindow)); assert.equal(BrowserWindow.getAllWindows().filter(w => w !== sourceWindow).length, 1, 'repeated open never starts a second sequence')
    if (live) window.setAlwaysOnTop(true, 'floating', 1)
    await until('recording controls', async () => await evaluate("document.body.textContent.includes('Start recording')"))
    await click('Start recording'); await until('four captured frames', async () => (await service.call('capture.sequence.inspect', { hostId: 'local', operationId: input.operationId }, context)).frameCount >= 4)
    for (const theme of ['dark', 'light']) {
      await evaluate(`window.setCaptureFixtureTheme('${theme}')`)
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const file = `gif-sampling-${theme}.png`; await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG()); result.screenshots.push(file)
    }
    await service.call('capture.sequence.stop', { hostId: 'local', operationId: input.operationId }, context)
    await until('review controls', async () => await evaluate("document.body.textContent.includes('Mark current frame')"))
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Previous frame').click()")
    await click('Mark current frame')
    await evaluate("(()=>{const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'这里是关键帧：检查滚动与标注 ✓');t.dispatchEvent(new Event('input',{bubbles:true}))})()")
    const gifPath = join(out, 'annotated.gif')
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: gifPath })) as typeof dialog.showSaveDialog
    console.log('stage: save'); await click('Save GIF…'); await until('GIF exported', async () => { try { return (await readFile(gifPath)).length > 0 } catch { return false } })
    console.log('stage: file read'); const bytes = await readFile(gifPath), info = inspectGif(bytes)
    assert.ok(info.delays.length >= 4); assert.equal(info.metadata?.keyframes.length, 1)
    assert.equal(info.metadata!.keyframes[0]!.note, '这里是关键帧：检查滚动与标注 ✓', 'the actual exported file carries Unicode notes')
    await until('original export receipt', async () => (await service.call('capture.sequence.inspect', { hostId: 'local', operationId: input.operationId }, context)).state === 'completed')
    console.log('stage: public read'); const artifact = await service.call('capture.sequence.read', { hostId: 'local', operationId: input.operationId }, context)
    const page = await service.call('capture.sequence.read', { hostId: 'local', operationId: input.operationId, maxBytes: 100 }, context)
    assert.equal(page.artifact!.nextOffsetBytes, 100); assert.deepEqual(Buffer.from(page.artifact!.data, 'base64'), bytes.subarray(0, 100))
    assert.deepEqual(Buffer.from(artifact.artifact!.data, 'base64'), bytes, 'public read consumes the original GUI artifact')
    const { AgentMuxControlServer } = await import(process.env.CAPTURE_CORE_DIST! + '/public-rpc-server.js')
    const endpointDirectory = await mkdtemp('/tmp/amux-seq-'), endpoint = join(endpointDirectory, 'rpc.sock')
    const rpc = new AgentMuxControlServer({ socketPath: endpoint, coreClients: () => [], sequences: owner }); server = rpc
    await rpc.start()
    const cliResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
      env.ELECTRON_RUN_AS_NODE = '1'
      const child = spawn(process.execPath, [process.env.CAPTURE_CORE_DIST! + '/agentmux.js', '--endpoint', 'unix:' + endpoint, 'capture', 'sequence', 'read', '--input', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify({ hostId: 'local', operationId: input.operationId }))
    })
    assert.equal(cliResult.code, 0, cliResult.stderr)
    assert.deepEqual(Buffer.from(JSON.parse(cliResult.stdout).result.artifact.data, 'base64'), bytes, 'actual CLI and Unix RPC consume the same original GUI artifact')
    await rpc.stop(); server = undefined; await rm(endpointDirectory, { recursive: true })
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [gifPath] })) as typeof dialog.showOpenDialog
    await until('export action has settled in the renderer', async () => await evaluate("![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open GIF…').disabled"))
    await click('Remove keyframe')
    assert.equal(await evaluate("document.querySelector('nav').textContent.includes('这里是关键帧')"), false, 'the current in-memory notes are cleared before reimport')
    console.log('stage: reopen'); await click('Open GIF…'); await until('GIF reopened', async () => await evaluate("document.querySelector('nav').textContent.includes('这里是关键帧')"))
    await evaluate("document.querySelector('nav button').click()")
    await until('note restored on exact frame', async () => await evaluate("document.querySelector('textarea')?.value.includes('检查滚动与标注')"))
    window.webContents.debugger.attach('1.3')
    console.log('stage: snapshots'); for (const theme of ['dark', 'light']) for (const width of [860, 440]) {
      await evaluate(`window.setCaptureFixtureTheme('${theme}')`)
      window.setContentSize(width, width === 440 ? 640 : 650)
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      await evaluate(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Previous frame').click()`)
      const marker = await evaluate(`(()=>{const b=document.querySelector('.capture-sequence__markers button'),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b}})()`)
      assert.ok(marker.width >= 24 && marker.height >= 24 && marker.hit, 'keyframe markers have a real 24px target and remain hittable')
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: marker.x, y: marker.y, button: 'left', buttons: 1, clickCount: 1 })
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: marker.x, y: marker.y, button: 'left', buttons: 0, clickCount: 1 })
      await until('marker selects its exact annotated frame', async () => await evaluate("document.querySelector('textarea')?.value.includes('检查滚动与标注')"))
      console.log('stage: capture', width, window.isVisible(), window.isMinimized()); const file = `gif-review-${theme}-${width}.png`; await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG()); result.screenshots.push(file)
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, 'controls remain inside the viewport')
    }
    await click('Use GIF'); await until('GIF handoff completed', () => window.isDestroyed())
    const attachments = (await readdir(join(out, 'home'), { recursive: true })).filter(file => file.endsWith('.gif'))
    assert.equal(attachments.length, 1); assert.deepEqual(await readFile(join(out, 'home', attachments[0]!)), bytes, 'Use GIF retains the same embedded notes in the original image persistence owner')
    result.observations.push({ markerHitTest: true, gifHandoff: true, frames: info.delays.length, keyframes: info.metadata!.keyframes, publicRead: true, reopened: true })
    if (!window.isDestroyed()) window.close()
  }
  result.passed = true
}
void run().catch(error => { result.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }).finally(async () => {
  await server?.stop(); native?.dispose(); sourceWindow?.destroy()
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2))
  app.exit(result.passed ? 0 : 1)
})
