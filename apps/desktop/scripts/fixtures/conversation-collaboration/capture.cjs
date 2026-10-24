const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), os = require('node:os')
const [url, evidence] = process.argv.slice(2)
const temporary = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'amux-collaboration-'))
app.setPath('userData', path.join(temporary, 'user')); app.setPath('sessionData', path.join(temporary, 'session'))
const {createHash} = require('node:crypto')
const owned = ['packages/client-ui/src/components/ConversationMessageCard.tsx','packages/client-ui/src/components/ConversationMessage.tsx','packages/client-ui/src/components/ConversationView.tsx','packages/client-ui/src/styles/conversation-collaboration.css','packages/client-ui/src/styles/conversation-message.css','apps/desktop/scripts/fixtures/conversation-collaboration/entry.tsx','apps/desktop/scripts/fixtures/conversation-collaboration/preview.css']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = Object.fromEntries(owned.map(file=>[file,hash(require('node:fs').readFileSync(file))]))
const result = { sources, temporary, passed: false, images: [], operations: [], errors: [], boundary: 'Isolated Electron; actual shared ConversationView and Desktop avatar/CSS; private Provider history. No live user Run or installed App replacement.' }
app.whenReady().then(async () => {
 const window = new BrowserWindow({ width: 1000, height: 850, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
 const read = code => window.webContents.executeJavaScript(typeof code === 'function' ? `(${code.toString()})()` : code)
 const settle = () => read(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
 const until = async predicate => { const end = Date.now()+10000; while(!await read(predicate)) { assert.ok(Date.now()<end,'Actual shared conversation did not become readable'); await new Promise(r=>setTimeout(r,80)) } await settle() }
 const frame = async name => { await settle(); const file = name+'.png'; await fs.writeFile(path.join(evidence,file),(await window.webContents.capturePage()).toPNG()); result.images.push(file); result.imageHashes ??= {}; result.imageHashes[file] = hash(await fs.readFile(path.join(evidence,file))) }
 const click = async selector => { await read(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle() }
 const keyboard = async selector => { await read(`document.querySelector(${JSON.stringify(selector)}).focus()`); window.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'}); window.webContents.sendInputEvent({type:'char',keyCode:'\r'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'}); await settle() }
 window.webContents.on('console-message', e=>{if(e.level==='error')result.errors.push(e.message)})
 try {
  await fs.mkdir(evidence,{recursive:true}); await window.loadURL(url); await until(()=>document.querySelectorAll('[data-native-collaboration]').length===5); await read(()=>document.fonts.ready)
  const noOverflow=async()=>assert.equal(await read(()=>document.documentElement.scrollWidth<=innerWidth),true,'Page must not overflow')
  await noOverflow()
  assert.equal(await read(()=>document.querySelectorAll('[data-collaboration-empty]').length),3)
  assert.equal(await read(()=>document.querySelectorAll('[data-collaboration-empty] .log-turn__collaboration-preview').length),0)
  assert.equal(await read(()=>document.body.textContent.includes('暂无可读正文')),false)
  await frame('wide-dark-collapsed')
  window.setContentSize(332,850); await settle(); await noOverflow(); await frame('narrow-dark-collapsed')
  await read(()=>window.collaborationPreview.theme('light')); await settle(); await frame('narrow-light-collapsed')
  await keyboard('[data-native-record-id="preview-readable"] .log-turn__collaboration-toggle')
  assert.equal(await read(()=>document.querySelector('[data-native-record-id="preview-readable"] .log-turn__collaboration-toggle').getAttribute('aria-expanded')),'true')
  await frame('narrow-light-expanded')
  window.setContentSize(1000,850); await read(()=>window.collaborationPreview.theme('dark')); await settle()
  await click('[data-native-record-id="preview-opaque"] .log-turn__collaboration-toggle'); await frame('wide-dark-expanded')
  await read(()=>{const b=document.querySelector('[data-native-record-id="preview-readable"] .log-turn__body');window.retainedBody=b; const r=document.createRange();r.selectNodeContents(b);getSelection().addRange(r);window.retainedText=getSelection().toString();window.collaborationPreview.append()}); await settle()
  assert.equal(await read(()=>window.retainedBody===document.querySelector('[data-native-record-id="preview-readable"] .log-turn__body') && getSelection().toString()===window.retainedText),true)
  await click('[data-native-record-id="preview-readable"] .log-turn__collaboration-toggle'); await click('[data-native-record-id="preview-readable"] .log-turn__collaboration-toggle')
  assert.equal(await read(()=>window.retainedBody===document.querySelector('[data-native-record-id="preview-readable"] .log-turn__body')),true)
  await read(()=>getSelection().removeAllRanges())
  await click('[data-native-record-id="preview-opaque"] [aria-label="Message details"]'); await click('[data-native-record-id="preview-opaque"] .log-turn__collaboration-original summary')
  await frame('wide-dark-original')
  await click('[data-native-record-id="preview-opaque"] [aria-label="Copy message"]')
  assert.equal(await read(()=>window.collaborationPreview.copies.at(-1).includes('original-opaque-payload')),true)
  await click('[data-native-record-id="preview-readable"] [aria-label="Copy message"]')
  assert.equal(await read(()=>window.collaborationPreview.copies.at(-1).startsWith('Message Type: MESSAGE')),true)
  assert.equal(await read(()=>document.querySelector('[aria-label="Reply draft"]').value),'保留这份尚未发送的草稿。')
  result.operations.push('Three independent empty reports without placeholder previews','Opaque complete original copied','Keyboard expand','332px/1000px dark/light','No horizontal overflow','Original node/selection survives append and folds','Original envelope copied','Opaque record inspectable','Draft retained')
  for(const [file,sha] of Object.entries(sources)) assert.equal(hash(await fs.readFile(file)),sha,'Source changed during capture: '+file)
  assert.deepEqual(result.errors,[]); result.passed=true
 } catch(error) { result.failure={message:error.message,stack:error.stack}; await frame('failure') }
 finally { await fs.writeFile(path.join(evidence,'capture.json'),JSON.stringify(result,null,2));window.destroy();app.exit(result.passed?0:1) }
})
