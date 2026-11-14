const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const [html, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(evidence, 'user-data'))
const result = { passed:false, cases:[], images:[] }
let window
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ width:1080, height:690, show:false, webPreferences:{backgroundThrottling:false} })
    await window.loadFile(html)
    const read = source => window.webContents.executeJavaScript(source)
    const cdp = window.webContents.debugger
    cdp.attach('1.3')
    await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled:true })
    const wait = async source => {
      for(let i=0;i<100;i++) {
        if(await read(source)) return
        await new Promise(resolve=>setTimeout(resolve,25))
      }
      throw Error('Actual toolbar state unavailable: '+source)
    }
    const find = selector => 'document.querySelector('+JSON.stringify(selector)+')'
    const tool = name => find('.image-annotation-toolbar__tools button[aria-label="'+name+'"]')
    const point = expression => read(`(()=>{const b=${expression},r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`)
    const mouse = (type, at, buttons=0) => cdp.sendCommand('Input.dispatchMouseEvent',{type,x:at.x,y:at.y,buttons,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1})
    const click = async expression => {
      const at=await point(expression); assert.ok(at.hit, 'Actual markup action accepts a pointer: '+expression)
      await mouse('mouseMoved',at); await mouse('mousePressed',at,1); await mouse('mouseReleased',at)
    }
    const key = async (key,virtual) => {
      await cdp.sendCommand('Input.dispatchKeyEvent', { type:'keyDown', key, code:key, windowsVirtualKeyCode:virtual,
        ...(key === 'Enter' ? { text:'\r', unmodifiedText:'\r' } : {}) })
      await cdp.sendCommand('Input.dispatchKeyEvent', { type:'keyUp', key, code:key, windowsVirtualKeyCode:virtual })
    }
    const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const sample = expression => read(`(()=>{const b=${expression},s=getComputedStyle(b),mark=getComputedStyle(b,'::after');return {
      pressed:b.getAttribute('aria-pressed'),label:b.getAttribute('aria-label'),hover:b.matches(':hover'),focus:b.matches(':focus-visible'),
      background:s.backgroundColor, shadow:s.boxShadow,outline:s.outlineStyle, mark:mark.content, width:mark.width,height:mark.height,
      transition:s.transitionDuration, running:b.getAnimations().filter(animation=>animation.playState==='running').length
    }})()`)
    const shot = async name => {
      const bytes=(await window.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true})).data
      await fs.writeFile(path.join(evidence,name),Buffer.from(bytes,'base64'));result.images.push(name)
    }
    await wait('!!window.toolActionProof && !!document.querySelector("button")')
    await click(find('button'))
    await wait('document.querySelector(".image-annotation-editor canvas")?.width>100')
    await wait(`${tool('Pen')}?.getBoundingClientRect().width>0`)
    const owner = await read('window.originalBitmapEditor=document.querySelector(".image-annotation-editor canvas"); toolActionProof.observed()')

    for(const [appearance,reduced] of [['dark',false],['light',true]]) {
      await read(`toolActionProof.appearance(${JSON.stringify(appearance)})`)
      await cdp.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]})
      await click(tool('Select'))
      await mouse('mouseMoved',{x:14,y:window.getContentSize()[1]-12})
      await read(`Promise.allSettled(${tool('Pen')}.getAnimations().map(a=>a.finished))`)
      const idle=await sample(tool('Pen'))
      await click(tool('Pen'))
      await mouse('mouseMoved',{x:14,y:window.getContentSize()[1]-12})
      await read(`Promise.allSettled(${tool('Pen')}.getAnimations().map(a=>a.finished))`)
      const active=await sample(tool('Pen'))
      assert.equal(active.pressed,'true')
      assert.equal(active.hover,false)
      assert.equal(active.label,idle.label)
      assert.ok(active.mark!=='none' && parseFloat(active.width)>0 && parseFloat(active.height)>0, 'Shared persistent marker must be visible on the selected annotation tool')
      assert.equal(idle.mark,'none')
      assert.notEqual(active.background,idle.background)
      assert.equal(active.running,0)
      if(reduced) assert.equal(active.transition,'0s')
      const at=await point(tool('Pen'))
      await mouse('mouseMoved',at)
      await mouse('mousePressed',at,1)
      await read(`Promise.allSettled(${tool('Pen')}.getAnimations().map(a=>a.finished))`)
      const pressing=await sample(tool('Pen'))
      assert.notEqual(pressing.shadow,active.shadow)
      assert.equal(pressing.pressed,'true')
      await mouse('mouseReleased',at)
      await key('ArrowRight',39)
      await wait(`document.activeElement===${tool('Highlighter')}`)
      assert.equal((await sample(tool('Pen'))).pressed,'true')
      const focused=await sample(tool('Highlighter'))
      assert.equal(focused.pressed,'false')
      assert.equal(focused.focus,true)
      assert.equal(focused.outline,'solid')
      await mouse('mouseMoved',{x:14,y:window.getContentSize()[1]-12})
      await shot(`markup-tools-${appearance}-selected-and-focus.png`)
      await key('Enter',13)
      await wait(`${tool('Highlighter')}.getAttribute('aria-pressed')==='true'`)
      await click(tool('Arrow')); await click(tool('Pen')); await click(tool('Arrow'))
      await wait(`${tool('Arrow')}.getAttribute('aria-pressed')==='true'`)
      result.cases.push({appearance,reduced,idle,active,pressing,focused})
    }
    await read('toolActionProof.busy(true)')
    await wait(`${tool('Arrow')}.disabled && !${tool('Pan')}.disabled`)
    assert.equal((await sample(tool('Arrow'))).pressed,'true')
    await read('toolActionProof.busy(false)')
    window.setContentSize(560,570)
    const compact=find('.image-annotation-toolbar__compact')
    await wait(`${compact}?.getBoundingClientRect().width>0`)
    assert.ok(await read(`${compact}.textContent.includes('Arrow')`))
    await click(compact)
    const selected=find('.image-annotation-tools-menu [role=menuitemradio][aria-checked=true]')
    await wait(`${selected}?.getAttribute('aria-label')==='Arrow'`)
    assert.equal(await read(`Boolean(${selected}.querySelector('.image-annotation-tools-menu__selection svg'))`),true)
    await settle()
    await shot('markup-tools-narrow-light.png')
    await key('Escape',27)
    await wait('!document.querySelector(".image-annotation-tools-menu")')
    assert.equal(await read('document.querySelector(".image-annotation-editor canvas")===originalBitmapEditor'),true)
    assert.deepEqual(await read('toolActionProof.observed()'),owner)
    result.passed=true
  } catch(error){result.failure=error.message}
  finally {
    await fs.writeFile(path.join(evidence,'renderer.json'),JSON.stringify(result,null,2))
    window?.destroy(); app.exit(result.passed?0:1)
  }
})
