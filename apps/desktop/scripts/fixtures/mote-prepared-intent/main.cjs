const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron'), { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
const accountSummary = process.argv.includes('--account-summary')
app.setPath('userData', path.join(privateRoot,'user-data')); app.setPath('sessionData',path.join(privateRoot,'session-data'))
const result={passed:false,frames:[],interactions:[],boundary:'Original MoteBotSetup/hook and production CSS, synthetic preview DTOs only. Business owner, PNG and File receipts are qualified separately; no live platform or installed App.'};let win
app.whenReady().then(async()=>{try {
 win=new BrowserWindow({width:1040,height:960,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});await win.loadFile(html, {query: accountSummary ? {'account-summary':'1'} : {}})
 const {read,until,settle,press}=nativeRendererInput(win,result.interactions,'');await until('window.motePreparedProof?.ready && ' + (accountSummary ? '!!document.querySelector(".connector-account-summary")' : 'document.body.textContent.includes("original bot hosting owner is unconfirmed")'))
 await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
 win.showInactive();win.focus();win.webContents.focus();await until('document.hasFocus()')
 const capture=async name=>{await settle();fs.writeFileSync(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());result.frames.push(name+'.png')}
 if(accountSummary){
  await until('!!document.querySelector("[data-mote-enrollment-action=confirm-account]")')
  await read('window.motePreparedProof.theme("light")'); await capture('account-confirmation-wide-light')
  win.setContentSize(390,960);await until('innerWidth===390');await read('window.motePreparedProof.theme("dark")');await capture('account-confirmation-narrow-dark')
  result.facts=await read('({errors:window.motePreparedProof.errors,overflow:document.documentElement.scrollWidth>innerWidth,account:window.motePreparedProof.account,text:document.querySelector(".connector-account-summary").textContent,images:document.querySelectorAll(".connector-account-summary img").length,confirmation:!!document.querySelector("[data-mote-enrollment-action=confirm-account]")})')
  assert.deepEqual(result.facts.errors,[]);assert.equal(result.facts.overflow,false);assert.equal(result.facts.images,0);assert.equal(result.facts.confirmation,true)
  assert.ok(result.facts.text.includes(result.facts.account.userId));assert.ok(result.facts.text.includes(result.facts.account.tenantId));result.passed=true;return
 }
 await press('Tab')
 assert.equal(await read('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="Check original result")'),false)
 assert.equal(await read('Array.from(document.querySelectorAll("p")).filter(p=>p.textContent.includes("hosting owner is unconfirmed")).length'),1)
 assert.equal(await read('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="Continue this request")'),false)
 await capture('mote-legacy-unknown-wide');win.setContentSize(390,960);await until('innerWidth===390');await capture('mote-legacy-unknown-narrow')
 if(process.env.MOTE_PREPARED_CAPTURE_OWNERLESS_ONLY!=='1'){
 await read('window.motePreparedProof.select("prepared")');await until('document.querySelector(".mote-bot-creation img")')
 await capture('mote-prepared-admission-narrow');win.setContentSize(1040,960);await until('innerWidth===1040');await capture('mote-prepared-admission-wide')
 await read('window.motePreparedProof.select("chat")');await until('document.querySelector(".mote-chat-requests") && document.body.textContent.includes("hosting owner is unconfirmed")')
 assert.equal(await read('document.querySelector(".mote-chat-requests button").disabled'),true)
 await capture('mote-chat-owner-unconfirmed-wide');win.setContentSize(390,960);await until('innerWidth===390');await capture('mote-chat-owner-unconfirmed-narrow')
 await read('window.motePreparedProof.select("prepared")');await until('document.querySelector(".mote-bot-creation img")')
 const facts=await read('({errors:window.motePreparedProof.errors,overflow:document.documentElement.scrollWidth>innerWidth,avatar:document.querySelector(".mote-bot-creation img")?.alt,text:document.body.textContent})')
 assert.deepEqual(facts.errors,[]);assert.equal(facts.overflow,false);assert.equal(facts.avatar,'Avatar chosen for this bot');result.facts=facts
 } else {
 const facts=await read('({errors:window.motePreparedProof.errors,overflow:document.documentElement.scrollWidth>innerWidth,text:document.body.textContent})');assert.deepEqual(facts.errors,[]);assert.equal(facts.overflow,false);result.facts=facts
 }
 result.passed=true
 }catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};if(win&&!win.isDestroyed())fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}finally{fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)}})
