const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const sourceSHA256 = require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(__filename)).digest('hex')
const input = JSON.parse(process.env.MOBILE_ASSET_TRANSFER_BROWSER_INPUT)
app.setPath('userData', path.join(input.evidence, 'profile'))
const result = { passed:false, sourceSHA256, processId:process.pid, boundary:'Private Chromium → original MobileAssetsOwner HTTP. Ordinary document navigation with default browser cache; no physical phone, user Browser or business input.', navigations:[], responses:[], cached:[] }
app.whenReady().then(async()=>{
  let win
  try {
    console.log('transfer-browser=ready');Menu.setApplicationMenu(null)
    win = new BrowserWindow({show:false,width:390,height:720,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
    win.webContents.session.webRequest.onCompleted(details=>{
      result.responses.push({url:details.url,mimeType:details.mimeType,headers:details.responseHeaders,fromCache:details.fromCache})
      if(details.fromCache)result.cached.push(details.url)
    })
    for(let index=0;index<2;index++) {
      // loadURL is an ordinary same-URL document navigation. Never disable/bypass
      // cache or reloadIgnoreCache: server request counts decide reuse below.
      console.log('transfer-browser=navigation-'+index)
      await win.loadURL(input.origin+'/?original=kept#retained-fragment')
      console.log('transfer-browser=loaded-'+index)
      const facts=await win.webContents.executeJavaScript(`({loads:Number(sessionStorage.getItem('transfer-loads')),sentinel:window.assetTransferSentinel,color:getComputedStyle(document.body).color,url:location.href,resources:performance.getEntriesByType('resource').map(e=>({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,decodedBodySize:e.decodedBodySize}))})`)
      assert.equal(facts.loads,index+1,'Each ordinary navigation creates its own original document')
      assert.equal(facts.sentinel,'Original decoded JavaScript 原字节🙂')
      assert.equal(facts.color,'rgb(20, 30, 40)')
      assert.ok(facts.url.endsWith('?original=kept#retained-fragment'))
      assert.ok(facts.resources.some(e=>e.name.endsWith('/assets/app.js'))&&facts.resources.some(e=>e.name.endsWith('/assets/app.css')))
      result.navigations.push(facts)
    }
    result.passed=true
  }catch(error){result.error={name:error.name,message:error.message,stack:error.stack};console.error(error.stack)}
  finally {
    await fs.mkdir(input.evidence,{recursive:true});console.log('transfer-browser=receipt');await fs.writeFile(path.join(input.evidence,'receipt.json'),JSON.stringify(result,null,2)+'\n');console.log('transfer-browser=receipt-written')
    win?.destroy();app.exit(result.passed?0:1)
  }
}).catch(error=>{console.error(error);app.exit(1)})
