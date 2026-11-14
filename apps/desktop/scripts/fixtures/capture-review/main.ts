import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CaptureSequenceOwner } from '../../../src/main/capture-sequence'
import { ScreenCapture } from '../../../src/main/screen-capture'
import type { BrowserPng } from '../../../src/shared/contracts'
const out = process.env.CAPTURE_REVIEW_OUT!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const result: any = { passed: false, controlledPixels: true, nativeInputClaim: false, screenshots: [] }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(name: string, read: () => T | Promise<T>): Promise<NonNullable<T>> {
  const started = Date.now()
  while (Date.now() - started < 12000) { const value = await read(); if (value) return value as NonNullable<T>; await wait(25) }
  throw new Error('Timed out: ' + name)
}
const js = (window: BrowserWindow, code: string) => window.webContents.executeJavaScript(code)
const click = async (window: BrowserWindow, label: string) => { await js(window, `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Missing enabled '+${JSON.stringify(label)});b.click()})()`); await wait(40) }
let source: BrowserWindow
async function run() {
  await app.whenReady()
  source = new BrowserWindow({ show: false, width: 640, height: 500, webPreferences: { backgroundThrottling: false } })
  const rows = ['Capture the whole conversation', 'Keep the details in view', 'Review before sharing', 'Annotations stay with the image', 'Ready for the next step'].map((t,i)=>`<section><small>0${i+1} / WORKFLOW</small><h2>${t}</h2><p>Keep the context together. A clear image helps everyone see the same details and decide what comes next.</p></section>`).join('')
  await source.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#233343;font:14px/1.6 system-ui}header{padding:24px 32px;background:#edf3f7;border-bottom:1px solid #d8e1e8}header small{letter-spacing:.12em;font-size:10px;color:#52697e}h1{font-size:24px;line-height:1.3;margin:8px 0}header p{margin:0;color:#52697e}section{height:170px;padding:24px 32px;border-bottom:1px solid #e3e9ee}section small{font-size:10px;color:#7b8c9a;letter-spacing:.1em}h2{font-size:17px;margin:6px 0}section p{color:#627383;margin:0;max-width:490px}</style><header><small>TEAM NOTES</small><h1>A complete picture</h1><p>From the first detail to the final decision.</p></header>${rows}`))
  async function shot(y: number, width = 600, height = 300): Promise<BrowserPng> {
    await js(source, `window.scrollTo(0,${y});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`)
    const image = await source.webContents.capturePage({ x: 0, y: 0, width, height }), bytes = image.toPNG(), size = image.getSize()
    return { mimeType: 'image/png', dataUrl: 'data:image/png;base64,'+bytes.toString('base64'), width: size.width, height: size.height, byteLength: bytes.length }
  }
  const initial = await shot(0), next = await shot(120), replacement = await shot(0, 400, 280)
  const scale = initial.width / 600, region = { rect: { x: 10, y: 50, width: 600, height: 300 }, scale, capturedAt: Date.now() }
  let samples = 0, selections = 0, replacing = false
  const selection = () => ({ image: replacement, source: { ...region, rect: { ...region.rect, width: 400, height: 280 }, capturedAt: Date.now() } })
  const owner = new CaptureSequenceOwner({ directory: join(out,'captures'), home: join(out,'home'), appearance: () => ({terminalTheme:'graphite',appAppearance:'dark'}),
    native: () => ({ captureScreenshot: async () => {
      const image = replacing ? replacement : samples++ === 0 ? initial : next
      return { state: 'captured' as const, screenshot: { format:'png' as const, data:image.dataUrl.split(',')[1]!, width:image.width,height:image.height,scale } }
    } }), select: async () => { selections++; if (selections === 1) return null; replacing = true; return selection() } })
  let delivered: BrowserPng | undefined
  const capture = new ScreenCapture({home:join(out,'home'),appActive:()=>true,native:()=>({captureScreenshot:async()=>{throw Error('Wrong source')},writeClipboardImage:async()=>{}}),
    present:async session=>{await session.complete(initial,region,'fixture');return {state:'completed'}},sequence:(mode,input)=>owner.edit(mode,{...input,startImmediately:true}),edit:async image=>{delivered=image},reportIssue:error=>{throw error}})
  const closed = capture.capture(false,'scroll')
  let window = await until('capture controls',()=>BrowserWindow.getAllWindows().find(w=>w!==source&&w.webContents.getURL().includes('screenshot-editor/index.html')))
  await until('two sampled frames',async()=>await js(window,'window.captureSequence.load().then(s=>s.frames.length>=2)'))
  await until('stop control',()=>js(window,"!![...document.querySelectorAll('button')].find(b=>b.textContent==='Stop scrolling capture')"))
  await click(window,'Stop scrolling capture')
  const ready = (window: BrowserWindow) => until('review is composed',()=>js(window,"!!document.querySelector('.capture-review__confirm')&&!document.querySelector('.capture-review__confirm').disabled&&!!document.querySelector('.capture-review__canvas img')"))
  await ready(window)
  const original = await js(window,'window.captureSequence.load()')
  assert.equal(original.frames.length,2)
  assert.equal(await js(window,"document.querySelector('.primary-button').textContent"),'Confirm')
  assert.equal(await js(window,"[...document.querySelectorAll('button')].some(b=>b.textContent==='Start scrolling capture')"),false)
  assert.equal(await js(window,"document.querySelector('.capture-review__secondary button').classList.contains('primary-button')"),false)
  const expectedHeight = initial.height + 120*scale
  assert.equal(await js(window,"document.querySelector('.capture-review__canvas img').naturalHeight"),expectedHeight)
  for (const theme of ['dark','light']) for(const size of [[860,650],[440,430]]) {
    window.setContentSize(size[0],size[1]); await js(window,`window.setCaptureFixtureTheme('${theme}');new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`)
    assert.equal(await js(window,"document.documentElement.scrollWidth>innerWidth||document.querySelector('.capture-review__confirm').getBoundingClientRect().bottom>innerHeight"),false,'Confirm is visible without scrolling the window')
    const name=`review-${theme}-${size[0]}.png`;await writeFile(join(out,name),(await window.webContents.capturePage()).toPNG());result.screenshots.push(name)
  }
  window.close(); await wait(60)
  assert.equal(window.isDestroyed(),false,'native close must retain unconfirmed review')
  await until('native close offers choice',()=>js(window,"!!document.querySelector('[role=alertdialog]')"))
  const warning='review-close-light-440.png';await writeFile(join(out,warning),(await window.webContents.capturePage()).toPNG());result.screenshots.push(warning)
  await click(window,'Continue review'); assert.equal(delivered,undefined)
  const before = await js(window,"document.querySelector('.capture-review__canvas img').src")
  await click(window,'Retake'); await ready(window)
  assert.equal(selections,1);assert.equal(await js(window,"document.querySelector('.capture-review__canvas img').src"),before,'cancelled new selection preserves original result')
  await click(window,'Close review');await until('UI close offers choice',()=>js(window,"!!document.querySelector('[role=alertdialog]')"));await click(window,'Continue review')
  const previousReviewId=window.id
  await click(window,'Retake')
  window=await until('fresh capture window',()=>BrowserWindow.getAllWindows().find(w=>w!==source&&w.id!==previousReviewId&&w.webContents.getURL().includes('screenshot-editor/index.html')))
  await until('fresh recording',()=>js(window,"!!document.querySelector('.capture-live-controls')"));await click(window,'Stop scrolling capture');await ready(window)
  const fresh=await js(window,'window.captureSequence.load()');assert.equal(fresh.requestId,original.requestId);assert.equal(fresh.frames.length,1,'Retake must reset confirmed frames rather than append');assert.equal(fresh.frames[0].image.width,replacement.width);assert.ok(fresh.frames[0].image.dataUrl===replacement.dataUrl,'the fresh selection supplies the retained first frame')
  const confirmedPreview=await js(window,"document.querySelector('.capture-review__canvas img').src")
  const directory=join(out,'captures',createHash('sha256').update(fresh.requestId).digest('hex'))
  await mkdir(join(directory,'result.png'))
  await click(window,'Confirm');await until('failure stays visible',()=>js(window,"!!document.querySelector('.capture-sequence__issue')&&!document.querySelector('.capture-review__confirm').disabled"))
  assert.equal(window.isDestroyed(),false);assert.equal(delivered,undefined)
  await rm(join(directory,'result.png'),{recursive:true});await click(window,'Confirm');await closed
  assert.ok(delivered!.dataUrl===confirmedPreview,'Confirm delivers exactly the preview accepted by the user to the original editor');assert.equal(delivered!.width,replacement.width);assert.equal(delivered!.height,replacement.height)
  await until('confirmed window closes',()=>window.isDestroyed())
  // The existing public owner returns exactly the artifact confirmed by the same review.
  const actor={actor:{kind:'user' as const,id:'review-fixture'}};const id={hostId:'local',operationId:'review-public'}
  await owner.call('capture.sequence.open',{...id,mode:'scroll'},actor)
  window=await until('public review window',()=>BrowserWindow.getAllWindows().find(w=>w!==source&&w.webContents.getURL().includes('screenshot-editor/index.html')));await ready(window);const publicPreview=await js(window,"document.querySelector('.capture-review__canvas img').src");await click(window,'Confirm')
  await until('public complete',async()=>(await owner.call('capture.sequence.inspect',id,actor)).state==='completed')
  const read=await owner.call('capture.sequence.read',id,actor);assert.ok(read.artifact!.data===publicPreview.split(',')[1],'the public owner returns exactly its confirmed preview artifact')
  const discard=owner.edit('scroll',{image:initial,source:region})
  window=await until('discard review',()=>BrowserWindow.getAllWindows().find(w=>w!==source&&w.webContents.getURL().includes('screenshot-editor/index.html')));await ready(window);window.close();await wait(50)
  assert.equal(window.isDestroyed(),false);await click(window,'Discard');assert.equal(await discard,null,'discard is explicit and never delivers an image')
  result.observations={originalConsumer:true,publicOwnerArtifact:true,retakeCancellationPreserves:true,freshSelectionResetsFrames:true,failedConfirmationPreserves:true,nativeAndUiCloseGuard:true,explicitDiscard:true,output:[delivered!.width,delivered!.height]};result.passed=true
}
void run().catch(error=>{result.failure={name:error.name,message:error.message,stack:error.stack}}).finally(async()=>{for(const w of BrowserWindow.getAllWindows())w.destroy();await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));app.exit(result.passed?0:1)})
