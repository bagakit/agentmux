import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage, screen } from 'electron'
import { spawn } from 'node:child_process'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CaptureSurface } from '../../../src/main/capture-surface'
import { ScreenCapture } from '../../../src/main/screen-capture'
import { SystemScreenshotEditor } from '../../../src/main/system-screenshot-editor'
import { createNativeDesktopPublicOwner } from '../../../src/main/native-desktop-public'
import { NativeDesktop } from '@agentmux/native-desktop'
import { AgentMuxControlServer } from '@agentmux/core'
const mode = process.env.CAPTURE_TOOLS_MODE!, out = process.env.CAPTURE_TOOLS_OUT!
const result: any = { passed: false, screenshots: [], observations: [], boundary: 'Actual Electron production surface, preload, editor, native OCR and CLI. Desktop screen pixels are controlled; no fresh physical screen capture or installed package is claimed.' }
app.setPath('userData', join(import.meta.dirname, 'user-data')); app.on('window-all-closed', () => {})
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(name: string, read: () => any) { for (let i = 0; i < 200; i++) { const value = await read(); if (value) return value; await wait(30) }; throw new Error('Timed out: ' + name) }
const js = (w: BrowserWindow, script: string) => w.webContents.executeJavaScript(script)
async function click(w: BrowserWindow, text: string) { await js(w, `(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)}));if(!b||b.disabled)throw Error('No enabled button: '+${JSON.stringify(text)});b.click()})()`); await wait(40) }
async function photo(w: BrowserWindow, name: string) { await js(w, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await writeFile(join(out, name + '.png'), (await w.webContents.capturePage()).toPNG()); result.screenshots.push(name + '.png') }
let editor: SystemScreenshotEditor | undefined, surface: CaptureSurface | undefined, native: NativeDesktop | undefined, server: AgentMuxControlServer | undefined
async function run() {
 await app.whenReady()
 const generator = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
 await generator.loadURL('data:text/html,<body></body>')
 const image = await js(generator, `(()=>{const c=document.createElement('canvas');c.width=900;c.height=400;const x=c.getContext('2d');x.fillStyle='#ffffff';x.fillRect(0,0,900,400);x.fillStyle='#18212a';x.font='28px Arial';['Capture tools - local image','team@example.test','Public project update','token: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].forEach((t,i)=>x.fillText(t,35,70+i*72));return {mimeType:'image/png',dataUrl:c.toDataURL(),width:900,height:400}})()`)
 image.byteLength = Buffer.from(image.dataUrl.split(',')[1], 'base64').length
 generator.destroy(); await writeFile(join(out, 'source.png'), Buffer.from(image.dataUrl.split(',')[1], 'base64'))
 if (mode === 'modes') {
  const displays = screen.getAllDisplays(), source = displays[0]!
  const bitmap = nativeImage.createFromBuffer(Buffer.from(image.dataUrl.split(',')[1], 'base64')).resize({ width: source.bounds.width * source.scaleFactor, height: source.bounds.height * source.scaleFactor }).toPNG()
  const sample = { ...image, width: source.bounds.width * source.scaleFactor, height: source.bounds.height * source.scaleFactor, dataUrl: 'data:image/png;base64,' + bitmap.toString('base64'), byteLength: bitmap.length }
  let lastMode = '', clipboard = 0, countdown = 0
  surface = new CaptureSurface({ appearance: () => ({ terminalTheme: 'graphite', appAppearance: 'dark' }), copyText: async () => {}, returnFocus: () => {}, pin: async () => { throw Error('Not used') }, native: () => ({ captureDisplays: async () => ({ state: 'captured' as const, capturedAt: Date.now(), timing: { contentMs: 0, windowListMs: 0, totalMs: 0, responseSerializationMs: 0, lazyConnectionMs: 0, socketReadMs: 0, jsonParseMs: 0, requestMs: 0, validationMs: 0 }, displays: displays.map(display => ({ displayId: display.id, frame: display.bounds, scale: display.scaleFactor, safeTop: 0, windows: [], png: sample.dataUrl.split(',')[1], width: sample.width, height: sample.height, engine: 'controlled', timing: { captureMs: 0, pngMs: 0, base64Ms: 0, totalMs: 0 } })) }) }) })
  const capture = new ScreenCapture({ home: join(out, 'home'), appActive: () => false, native: () => ({ writeClipboardImage: async () => { clipboard++ }, captureScreenshot: async (p: any) => { lastMode = p.mode; return { state: 'captured', screenshot: { format: 'png', data: image.dataUrl.split(',')[1], width: image.width, height: image.height, scale: 1 } } } }), present: s => surface!.present(s), edit: async (image, _, complete) => { await complete(image) }, reportIssue: error => { throw error }, chooseSource: async m => m === 'display' ? { mode: m, displayId: source.id } : { mode: m, windowId: 1, app: 'pid:1', processStartedAt: 1 }, countdown: async seconds => { countdown = seconds; return false }, sequence: async m => { lastMode = m; return m === 'gif' ? '/fixture/annotated.gif' : image } })
  async function open() { const promise = capture.capture(true); void promise.catch(error => console.error('capture failed', error)); const w = await until('surface window', () => BrowserWindow.getAllWindows()[0]); await until('mode choices', () => js(w, "!!document.querySelector('.capture-mode-bar') && document.querySelector('img')?.complete")); await wait(250); return { promise, w } }
  for (const [button, expected] of [['Scrolling', 'scroll'], ['GIF', 'gif']] as const) {
   const { promise, w } = await open(); w.webContents.debugger.attach('1.3')
   for (const [type, x, y] of [['mousePressed', 100, 170], ['mouseMoved', 680, 410], ['mouseReleased', 680, 410]] as const) await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 })
   await until('selection toolbar', () => js(w, "!!document.querySelector('.image-annotation-editor__capture-bar')")); await click(w, button)
   const other = BrowserWindow.getAllWindows().find(candidate => candidate !== w)
   if (other) assert.equal(await js(other, "(async()=>{const input=await window.captureSurface.load();try{await window.captureSurface.source(input.requestId,'window');return true}catch{return false}})()"), false, 'a locked display cannot replace the original display selection')
   for (const theme of ['dark', 'light']) { await js(w, `window.setFixtureTheme('${theme}')`); await photo(w, `capture-${expected}-${theme}`) }
   await click(w, expected === 'gif' ? 'Continue to GIF' : 'Continue to scroll'); const path = await promise
   assert.equal(lastMode, expected, 'selected mode reaches the original sequence owner'); assert.ok(path, 'the original capture consumer receives the result')
  }
  for (const selected of ['display', 'window', '3']) { const { promise, w } = await open(); await js(w, `(()=>{const s=document.querySelector('select');s.value='${selected}';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await promise; if (selected === '3') assert.equal(countdown, 3); else assert.equal(lastMode, selected) }
  assert.ok(clipboard >= 3); result.observations.push({ sourceChoices: true, originalConsumer: true, sourceAndDelayPreserved: true })
 } else {
  native = new NativeDesktop({ executablePath: process.env.CAPTURE_TOOLS_HELPER!, connectTimeoutMs: 15000, requestTimeoutMs: 15000 })
  let copied = '', delivered: any = null, failures = 0
  const common = { pin: async () => { throw Error('Not used') }, copyText: async (text: string) => { copied = text } }
  editor = new SystemScreenshotEditor(() => ({ terminalTheme: 'graphite', appAppearance: 'dark' }), { ...common, ...(mode === 'text' ? { recognizeText: (png: any) => native!.recognizeText(png) } : {}) })
  const editing = editor.edit(image, false, async png => { delivered = png })
  let w = await until('editor', () => BrowserWindow.getAllWindows()[0]); await until('text tools', () => js(w, "!!document.querySelector('.image-text-tools') && !!document.querySelector('canvas')"))
  await until('image drawable', () => js(w, "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Copy') && ![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Copy').disabled"))
  if (mode === 'text') {
   const recognized = await native.recognizeText(image); assert.ok(recognized.lines.some(l => l.text.includes('team@example.test'))); await writeFile(join(out, 'native-text.json'), JSON.stringify(recognized, null, 2))
   const owner = createNativeDesktopPublicOwner(native, { hostId: 'local' }, { captureSelection: async () => { throw Error('Not used') } })
   const directory = await mkdtemp(join(tmpdir(), 'capture-text-rpc-')), socketPath = join(directory, 'rpc.sock'); server = new AgentMuxControlServer({ socketPath, coreClients: () => [], nativeDesktop: owner }); await server.start()
   const handshake: any = await native.request('handshake'); const input = { hostId: 'local', instanceId: handshake.instanceId, data: image.dataUrl.split(',')[1], sensitiveOnly: true }
   const cli = await new Promise<any>((resolve, reject) => { const env: any = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))); env.ELECTRON_RUN_AS_NODE = '1'; const child = spawn(process.execPath, [process.env.CAPTURE_CORE_DIST! + '/agentmux.js', '--endpoint', 'unix:' + socketPath, 'native', 'text', 'recognize', '--data', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b }); child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input)) })
   assert.equal(cli.code, 0, cli.stderr); assert.ok(cli.stdout.includes('team@example.test'), 'actual CLI reaches system OCR'); assert.equal(cli.stdout.includes('Public project update'), false, 'CLI consumes the same sensitive pattern suggestions'); await server.stop(); server = undefined; await rm(directory, { recursive: true, force: true })
   await click(w, 'Extract text'); await until('OCR text', () => js(w, "document.querySelector('textarea[aria-label=\"Recognized text\"]')?.value.includes('team@example.test')")); await click(w, 'Copy text'); assert.ok(copied.includes('team@example.test'))
   await click(w, 'Find sensitive text'); await until('sensitive candidates', () => js(w, "document.querySelectorAll('.image-text-tools__candidates input').length===2"))
   for (const theme of ['dark', 'light']) for (const width of [860, 440]) { w.setContentSize(width, 680); await js(w, `window.setFixtureTheme('${theme}')`); await photo(w, `sensitive-${theme}-${width}`) }
   await js(w, "document.querySelector('.image-text-tools__candidates input').click()")
   await click(w, 'Cover selected lines'); await until('results cleared after edit', () => js(w, "!document.querySelector('.image-text-tools__results')")); await click(w, 'Copy'); await until('processed image delivered', () => delivered)
   const bitmap = nativeImage.createFromBuffer(Buffer.from(delivered.dataUrl.split(',')[1], 'base64')).toBitmap(), token = recognized.lines.find(l => l.text.toLowerCase().includes('token'))!
   for (let y = Math.ceil(token.rect.y); y < token.rect.y + token.rect.height - 1; y++) for (let x = Math.ceil(token.rect.x); x < token.rect.x + token.rect.width - 1; x++) { const i = (y * image.width + x) * 4; assert.deepEqual([...bitmap.subarray(i, i + 4)], [39, 24, 17, 255], 'selected sensitive line becomes opaque output pixels') }
   await writeFile(join(out, 'redacted.png'), Buffer.from(delivered.dataUrl.split(',')[1], 'base64')); result.observations.push({ actualNativeOCR: true, actualCli: true, selectedPixelCover: true, noBundledModel: true })
  } else {
   assert.equal(await js(w, "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Extract text').disabled"), true, 'unsupported text action is disabled')
   w.webContents.debugger.attach('1.3')
   for (const width of [860, 440]) { w.setContentSize(width, 650); const rect = await js(w, "(()=>{const r=document.querySelector('.image-text-tools__explain').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"); await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect }); await until('hover reason', () => js(w, "getComputedStyle(document.querySelector('[role=tooltip]')).display!=='none'")); await photo(w, `unavailable-hover-${width}`) }
   await js(w, "document.querySelector('.image-text-tools__explain').focus()"); assert.equal(await js(w, "getComputedStyle(document.querySelector('[role=tooltip]')).display"), 'block', 'keyboard focus explains the same disabled action')
   await click(w, 'Copy'); assert.ok(delivered, 'unsupported OCR never blocks ordinary copy'); w.close(); await editing; editor.dispose(); editor = undefined
   editor = new SystemScreenshotEditor(() => ({ terminalTheme: 'graphite', appAppearance: 'light' }), { ...common, recognizeText: async png => { if (!failures++) throw Error('Temporary recognition failure'); return native!.recognizeText(png) } })
   void editor.edit(image, false, async () => {}); w = await until('retry editor', () => BrowserWindow.getAllWindows()[0]); await until('retry image', () => js(w, "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Extract text') && ![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Extract text').disabled")); await click(w, 'Extract text'); await until('failure feedback', () => js(w, "document.body.textContent.includes('You can retry')")); assert.equal(await js(w, "document.body.textContent.includes('Error invoking remote method')"), false, 'recognition errors use the shared user-facing error presentation'); await photo(w, 'recognition-failure'); await click(w, 'Extract text'); await until('retry result', () => js(w, "document.querySelector('textarea[aria-label=\"Recognized text\"]')?.value.includes('team@example.test')")); result.observations.push({ hover: true, keyboard: true, ordinaryCopy: true, failureRetry: true })
  }
  w.close()
 }
 result.passed = true
}
run().catch(async error => { const w = BrowserWindow.getAllWindows()[0]; if (w) result.lastBody = await js(w, 'document.body.innerText'); result.failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error) }).finally(async () => { surface?.dispose(); editor?.dispose(); await server?.stop(); await native?.dispose(); await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2)); app.exit(result.passed ? 0 : 1) })
