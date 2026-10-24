const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), os = require('node:os')
const [url, evidence] = process.argv.slice(2)
const temporary = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'amux-collaboration-'))
app.setPath('userData', path.join(temporary, 'user')); app.setPath('sessionData', path.join(temporary, 'session'))
const {createHash} = require('node:crypto')
const owned = ['packages/client-ui/src/components/ConversationMessageCard.tsx','packages/client-ui/src/components/ConversationMessage.tsx','packages/client-ui/src/components/ConversationView.tsx','packages/client-ui/src/styles/conversation-collaboration.css','packages/client-ui/src/styles/conversation-message.css','packages/client-ui/src/theme/icon-catalog.ts','packages/client-ui/src/theme/icon-authored.ts','apps/desktop/scripts/fixtures/conversation-collaboration/entry.tsx','apps/desktop/scripts/fixtures/conversation-collaboration/preview.css']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = Object.fromEntries(owned.map(file=>[file,hash(require('node:fs').readFileSync(file))]))
const result = { sources, temporary, passed: false, images: [], operations: [], errors: [], boundary: 'Isolated Electron; actual shared ConversationView and Desktop avatar/CSS; private Provider history. No live user Run or installed App replacement.' }
app.whenReady().then(async () => {
 const window = new BrowserWindow({ width: 1000, height: 850, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
 const read = code => window.webContents.executeJavaScript(typeof code === 'function' ? `(${code.toString()})()` : code)
 const settle = () => read(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
 const until = async predicate => { const end = Date.now()+10000; while(!await read(predicate)) { assert.ok(Date.now()<end,'Actual shared conversation did not become readable'); await new Promise(r=>setTimeout(r,80)) } await settle() }
 const frame = async name => { await settle(); const file = name+'.png'; await fs.writeFile(path.join(evidence,file),(await window.webContents.capturePage()).toPNG()); result.images.push(file); result.imageHashes ??= {}; result.imageHashes[file] = hash(await fs.readFile(path.join(evidence,file))) }
 const click = async selector => {
  const point = await read(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  window.webContents.sendInputEvent({type:'mouseMove',...point}); window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point}); window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point}); await settle()
 }
 const keyboard = async selector => { await read(`document.querySelector(${JSON.stringify(selector)}).focus()`); window.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'}); window.webContents.sendInputEvent({type:'char',keyCode:'\r'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'}); await settle() }
 window.webContents.on('console-message', e=>{if(e.level==='error')result.errors.push(e.message)})
 try {
  await fs.mkdir(evidence,{recursive:true}); await window.loadURL(url); await until(()=>document.querySelectorAll('[data-native-collaboration]').length===6); await read(()=>document.fonts.ready)
  const noOverflow=async()=>assert.equal(await read(()=>document.documentElement.scrollWidth<=innerWidth),true,'Page must not overflow')
  await noOverflow()
  assert.equal(await read(()=>document.querySelectorAll('[data-native-collaboration] .log-turn__node').length),0)
  assert.equal(await read(()=>[...document.querySelectorAll('[data-native-collaboration]')].filter(row=>!row.querySelector('.log-turn__collaboration-preview')).length),3)
  assert.equal(await read(()=>window.collaborationPreview.resourceReads.length),0)
  const geometry=async name=>{
    const snapshot=await read(()=>{
      const bounds=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}
      const rows=[...document.querySelectorAll('[data-native-collaboration]')].map(row=>{
        const toggle=row.querySelector('.log-turn__collaboration-toggle'), time=toggle.querySelector('.log-turn__time'), preview=toggle.querySelector('.log-turn__collaboration-preview')
        return {toggle:bounds(toggle),time:bounds(time),preview:preview?bounds(preview):null,chevron:bounds(toggle.querySelector('.log-turn__collaboration-chevron')),tag:bounds(toggle.querySelector('.log-turn__collaboration-label'))}
      })
      return {rows,process:bounds(document.querySelector('.log-fold__chevron')),snapshot:bounds(document.querySelector('.conversation-reply-observation__toggle > svg'))}
    }); result.geometry??={}; result.geometry[name]=snapshot
    for(const row of snapshot.rows){assert.equal(row.chevron.x,snapshot.process.x,'Native disclosure aligns with execution process');assert.ok(Math.abs(row.chevron.x-snapshot.snapshot.x)<=2,'Observation glyphs share the reading origin');assert.ok(row.toggle.height<=32,'Summary must stay in one compact line'); assert.ok(row.time.x<row.toggle.x+180,'Time must remain in left identity group'); if(row.preview){assert.ok(row.preview.width>=24,'Preview retains readable width');assert.ok(Math.abs(row.preview.y-row.time.y)<8,'Preview stays beside time')}}
  }
  await geometry('wide')
  assert.equal(await read(()=>document.body.textContent.includes('暂无可读正文')),false)
  await frame('wide-dark-collapsed')
  window.setContentSize(332,850); await settle(); await noOverflow(); await geometry('narrow'); await frame('narrow-dark-collapsed')
  await read(()=>window.collaborationPreview.theme('light')); await settle(); await frame('narrow-light-collapsed')
  const timeBefore=await read(()=>document.querySelector('[data-native-record-id="preview-readable"] .log-turn__time').getBoundingClientRect().x)
  await click('[data-native-record-id="preview-readable"] [title="Copy message"]')
  assert.equal(await read(()=>document.querySelector('[data-native-record-id="preview-readable"] .log-turn__collaboration-toggle').getAttribute('aria-expanded')),'false')
  assert.equal(await read(()=>document.querySelector('[data-native-record-id="preview-readable"] .log-turn__time').getBoundingClientRect().x),timeBefore)
  await click('[data-native-record-id="preview-readable"] [aria-label="Message details"]')
  assert.equal(await read(()=>document.querySelector('[data-native-record-id="preview-readable"] .log-turn__collaboration-toggle').getAttribute('aria-expanded')),'false')
  await click('[data-native-record-id="preview-readable"] [aria-label="Message details"]')
  await keyboard('[data-native-record-id="preview-readable"] .log-turn__collaboration-toggle')
  assert.equal(await read(()=>document.querySelector('[data-native-record-id="preview-readable"] .log-turn__collaboration-toggle').getAttribute('aria-expanded')),'true')
  assert.equal(await read(()=>document.querySelector('[data-native-record-id="preview-readable"] .log-turn__collaboration-label svg').getAttribute('data-semantic-icon')),'object.subagent')
  assert.equal(await read(()=>getComputedStyle(document.querySelector('[data-native-record-id="preview-readable"] .log-turn__collaboration-label svg')).transform),'none')
  assert.equal(await read(()=>{const el=document.querySelector('[data-native-record-id="preview-readable"] .log-turn__collaboration-participants'); const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);return getSelection().toString().includes('/root/review/layout')}),true)
  await read(()=>getSelection().removeAllRanges())
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
  await click('[data-native-record-id="preview-opaque"] [title="Copy message"]')
  assert.equal(await read(()=>window.collaborationPreview.copies.at(-1).includes('original-opaque-payload')),true)
  await click('[data-native-record-id="preview-readable"] [title="Copy message"]')
  assert.equal(await read(()=>window.collaborationPreview.copies.at(-1).startsWith('Message Type: MESSAGE')),true)
  assert.equal(await read(()=>document.querySelector('[aria-label="Reply draft"]').value),'保留这份尚未发送的草稿。')
  await click('[data-native-record-id="preview-resource"] .log-turn__collaboration-toggle')
  await click('[data-native-record-id="preview-resource"] [title="Copy message"]')
  assert.equal(await read(()=>window.collaborationPreview.copies.at(-1)),'按需读取的协作详情，保留原记录。')
  assert.equal(await read(()=>window.collaborationPreview.resourceReads.length>0),true)
  result.operations.push('Inline tag, left time, preview and independent actions', 'Selectable original participant paths', 'Actual deferred resource Copy', 'Three independent empty reports without placeholder previews','Opaque complete original copied','Keyboard expand','332px/1000px dark/light','No horizontal overflow','Original node/selection survives append and folds','Original envelope copied','Opaque record inspectable','Draft retained')
  for(const [file,sha] of Object.entries(sources)) assert.equal(hash(await fs.readFile(file)),sha,'Source changed during capture: '+file)
  assert.deepEqual(result.errors,[]); result.passed=true
 } catch(error) { result.failure={message:error.message,stack:error.stack}; await frame('failure') }
 finally { await fs.writeFile(path.join(evidence,'capture.json'),JSON.stringify(result,null,2));window.destroy();app.exit(result.passed?0:1) }
})
