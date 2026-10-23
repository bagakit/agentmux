const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron'), { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot,'user-data')); app.setPath('sessionData',path.join(privateRoot,'session-data'))
const result={passed:false,frames:[],interactions:[],boundary:'Original MoteBotSetup/hook and production CSS, synthetic preview DTOs only. Business owner, PNG and File receipts are qualified separately; no live platform or installed App.'};let win
app.whenReady().then(async()=>{try {
 win=new BrowserWindow({width:1040,height:960,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});await win.loadFile(html)
 const {read,until,settle,click}=nativeRendererInput(win,result.interactions,'');await until('window.motePreparedProof?.ready && document.body.textContent.includes("Your original request is retained")')
 await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
 win.showInactive();win.focus();win.webContents.focus();await until('document.hasFocus()')
 const capture=async name=>{await settle();fs.writeFileSync(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());result.frames.push(name+'.png')}
 await click('.mote-bot-setup button.primary-button');await until('document.body.textContent.includes("Your original request is retained")')
 assert.equal(await read('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="Continue this request")'),false)
 await capture('mote-legacy-unknown-wide');win.setContentSize(390,960);await until('innerWidth===390');await capture('mote-legacy-unknown-narrow')
 await read('window.motePreparedProof.select("prepared")');await until('document.querySelector(".mote-bot-creation img")')
 await capture('mote-prepared-admission-narrow');win.setContentSize(1040,960);await until('innerWidth===1040');await capture('mote-prepared-admission-wide')
 const facts=await read('({errors:window.motePreparedProof.errors,overflow:document.documentElement.scrollWidth>innerWidth,avatar:document.querySelector(".mote-bot-creation img")?.alt,text:document.body.textContent})')
 assert.deepEqual(facts.errors,[]);assert.equal(facts.overflow,false);assert.equal(facts.avatar,'Avatar chosen for this bot');result.facts=facts;result.passed=true
 }catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};if(win&&!win.isDestroyed())fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}finally{fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)}})
