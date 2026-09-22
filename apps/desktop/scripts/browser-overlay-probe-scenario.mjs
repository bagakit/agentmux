import assert from 'node:assert/strict'
import { join } from 'node:path'
import { captureOsWindow } from './browser-window-visual-capture.mjs'
import { installNativeChromeStageObserver } from './browser-native-chrome-stage-observer.mjs'
import { observeOriginalOverlayPaint } from './browser-overlay-paint-observer.mjs'

export const overlayFixture = '<style>body{font:18px system-ui;background:#f5fff8;color:#203628;padding:24px}button,input{display:block;margin:20px 0;padding:10px}</style><button id="page-action">Continue on the page</button><input aria-label="Page name"><script>globalThis.pageClicks=0;globalThis.pageEvents=[];const button=document.querySelector("button");button.onclick=e=>{pageClicks++;globalThis.pageTrusted=e.isTrusted};for(const type of ["mousedown","mouseup","click"])button.addEventListener(type,e=>pageEvents.push({type:e.type,target:e.target.id,trusted:e.isTrusted}))</script>'

const activitySelector='[aria-label="Open browser activity timeline"]'
const electron = ctx => `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot,'package.json'))})('electron')`

async function owners(ctx) {
  return ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=${electron(ctx)};const window=BrowserWindow.getAllWindows()[0];return window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()).map(view=>({id:view.webContents.id,url:view.webContents.getURL(),visible:view.getVisible(),bounds:view.getBounds()}))})()`)
}
const pageOwner = (ctx, entries) => entries.filter(entry => entry.url.split('#')[0] === ctx.pageUrl)
const chromeOwners = entries => entries.filter(entry => entry.url.startsWith('data:text/html,') && entry.url.includes('Content-Security-Policy'))
async function pageInput(ctx) {
  // Frames and geometry have their own unforced gates. Focus is a documented
  // prerequisite of Electron sendInputEvent, acquired only for this input stage.
  const inputFocus = await ctx.probe.main.evaluate(`(async()=>{const {app,BrowserWindow}=${electron(ctx)};if(process.pid!==${ctx.probe.child.pid})throw new Error('Only the owned private Main can receive input focus');const window=BrowserWindow.getAllWindows()[0],state=()=>({windowId:window.id,focused:window.isFocused(),focusable:window.isFocusable(),visible:window.isVisible(),minimized:window.isMinimized(),appActive:app.isActive(),appHidden:app.isHidden(),dockVisible:app.dock.isVisible()});const before=state();if(!before.focused){app.focus({steal:true});window.focus()}const end=Date.now()+1500;while(!window.isFocused()&&Date.now()<end)await new Promise(done=>setTimeout(done,20));const after=state();return{before,after,scope:'private probe input only; not a frame or geometry repair',delivery:after.focused?'documented focus prerequisite observed; one planned native attempt':'documented focus prerequisite unobserved; one planned native attempt'}})()`)
  ;(ctx.receipt.overlayInputFocus??=[]).push(inputFocus)
  const floatingBefore = await ctx.probe.cdp.evaluate('Array.from(document.querySelectorAll("[role=menu],[role=tooltip]")).filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden").map(e=>({role:e.getAttribute("role"),text:e.textContent}))')
  const result = await ctx.probe.main.evaluate(`(async()=>{const {BrowserWindow}=${electron(ctx)};const window=BrowserWindow.getAllWindows()[0];const views=window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL().split('#')[0]===${JSON.stringify(ctx.pageUrl)});if(views.length!==1)throw new Error('Expected one actual Browser owner');const view=views[0];const before=await view.webContents.executeJavaScript('globalThis.pageClicks'),beforeEvents=await view.webContents.executeJavaScript('globalThis.pageEvents.length');const cssPoint=await view.webContents.executeJavaScript('(()=>{const target=document.querySelector("#page-action"),r=target.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(document.elementFromPoint(x,y)!==target)throw new Error("Actual page button is covered");return{x,y,target:target.id}})()');const zoomFactor=view.webContents.getZoomFactor(),point={x:Math.round(cssPoint.x*zoomFactor),y:Math.round(cssPoint.y*zoomFactor)};if(point.x<0||point.y<0||point.x>=view.getBounds().width||point.y>=view.getBounds().height)throw new Error('Actual page button is clipped');const world={x:point.x+view.getBounds().x,y:point.y+view.getBounds().y};const floating=window.contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed()&&v.webContents.getURL().startsWith('data:text/html,')&&v.webContents.getURL().includes('Content-Security-Policy')).map(v=>v.getBounds());if(floating.some(b=>world.x>=b.x&&world.x<b.x+b.width&&world.y>=b.y&&world.y<b.y+b.height))throw new Error('Native page input point is occluded by the actual floating content');view.webContents.focus();const delivery={windowId:window.id,ownerWindowId:view.webContents.getOwnerBrowserWindow()?.id,parentFocused:window.isFocused(),pageFocused:view.webContents.isFocused()};if(delivery.ownerWindowId!==window.id)throw new Error('Native page input must belong to the exact private window');view.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});view.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});await new Promise(done=>setTimeout(done,80));return{before,delivery,world,floating,cssPoint,point,zoomFactor,after:await view.webContents.executeJavaScript('({count:globalThis.pageClicks,trusted:globalThis.pageTrusted,events:globalThis.pageEvents.slice('+beforeEvents+')})'),ownerId:view.webContents.id,visible:view.getVisible(),bounds:view.getBounds()}})()`)
  if (result.after.count !== result.before + 1) {
    ctx.receipt.overlayInputFailure = { result, floatingBefore,
      observed: await ctx.probe.main.evaluate(`(async()=>{const {BrowserWindow}=${electron(ctx)},window=BrowserWindow.getAllWindows()[0];const pages=window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL().split('#')[0]===${JSON.stringify(ctx.pageUrl)});return{window:{focused:window.isFocused(),visible:window.isVisible(),minimized:window.isMinimized()},pages:await Promise.all(pages.map(async view=>({id:view.webContents.id,focused:view.webContents.isFocused(),bounds:view.getBounds(),state:await view.webContents.executeJavaScript('({documentFocused:document.hasFocus(),clicks:globalThis.pageClicks,trusted:globalThis.pageTrusted,button:!!document.querySelector("#page-action"),visibility:document.visibilityState})')})))}})()`) }
  }
  assert.equal(result.after.count, result.before + 1)
  assert.equal(result.after.trusted, true)
  assert.deepEqual(result.after.events,[{type:'mousedown',target:'page-action',trusted:true},{type:'mouseup',target:'page-action',trusted:true},{type:'click',target:'page-action',trusted:true}])
  assert.equal(result.visible, true)
  assert.ok(result.bounds.width > 0 && result.bounds.height > 0)
  return {...result,floatingBefore,inputFocus}
}
async function hover(ctx, selector) {
  const point = await ctx.probe.cdp.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Actual hover target unavailable');const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await ctx.probe.cdp.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
}
async function close(ctx) {
  await ctx.probe.cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await ctx.probe.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await hover(ctx,'[aria-label="Browser address"]')
  await ctx.waitFor('closed actual floating panel',async()=>!(await ctx.probe.cdp.evaluate('Array.from(document.querySelectorAll("[role=menu],[role=tooltip]")).some(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden")')))
  await ctx.waitFor('native Chrome released after close',async()=>chromeOwners(await owners(ctx)).length===0)
}
async function captureChrome(ctx,label) {
  const directory = ctx.receipt.visual.captureDirectory
  try {
    // Allocation precedes the asynchronously loaded source image. Observe that
    // boundary before the pixel gate; this never repairs or retries capturePage.
    const readiness = await ctx.probe.main.evaluate(`(async()=>{
      const {BrowserWindow}=${electron(ctx)},window=BrowserWindow.getAllWindows()[0];
      const views=window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL().startsWith('data:text/html,')&&view.webContents.getURL().includes('Content-Security-Policy'));
      if(!views.length)throw new Error('No actual Chrome owner to observe');
      const start=Date.now(),attempts=[];
      do{
        const states=await Promise.all(views.map(async view=>{
          if(view.webContents.isDestroyed())return{id:view.webContents.id,destroyed:true};
          return{id:view.webContents.id,...await view.webContents.executeJavaScript('(()=>{const image=document.querySelector("img");return {sourceAssigned:!!image.getAttribute("src"),sourceLength:(image.getAttribute("src")??"").length,complete:image.complete,width:image.naturalWidth,height:image.naturalHeight}})()')};
        }));
        attempts.push({elapsedMs:Date.now()-start,owners:states});
        if(states.every(state=>state.complete&&state.width>0&&state.height>0))return{ready:true,budgetMs:1500,elapsedMs:Date.now()-start,attempts};
        if(Date.now()-start>=1500)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }while(true);
      return{ready:false,budgetMs:1500,elapsedMs:Date.now()-start,attempts};
    })()`)
    ctx.receipt.overlayChromeReadiness ??= []
    ctx.receipt.overlayChromeReadiness.push({label,...readiness})
    assert.equal(readiness.ready,true,'Actual Chrome source image did not load within its bounded observation')
    return await ctx.probe.main.evaluate(`(async()=>{const {BrowserWindow}=${electron(ctx)};const window=BrowserWindow.getAllWindows()[0];const views=window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL().startsWith('data:text/html,')&&view.webContents.getURL().includes('Content-Security-Policy'));const result=[];for(const [index,view] of views.entries()){const loaded=await view.webContents.executeJavaScript('(()=>{const image=document.querySelector("img");return {complete:image.complete,width:image.naturalWidth,height:image.naturalHeight}})()');if(!loaded.complete||loaded.width<=0||loaded.height<=0)throw new Error('Chrome source image has not loaded');const image=await view.webContents.capturePage();if(image.isEmpty())throw new Error('Empty actual Chrome projection frame');const bytes=image.toPNG(),file=${JSON.stringify(join(directory,label))}+'-native-chrome-'+index+'.png';process.getBuiltinModule('fs').writeFileSync(file,bytes);result.push({file,id:view.webContents.id,bounds:view.getBounds(),size:image.getSize(),sha256:process.getBuiltinModule('crypto').createHash('sha256').update(bytes).digest('hex')})}return result})()`)
  } catch (error) {
    // This diagnostic runs only after the original gate has failed. A frame
    // produced by invalidate() cannot retroactively make that capture pass.
    ctx.receipt.overlayNativeFrameFailure = { label, originalError: String(error), diagnosticOnly: true }
    try {
      ctx.receipt.overlayNativeFrameFailure.observation = await ctx.probe.main.evaluate(`(async()=>{
        const {BrowserWindow}=${electron(ctx)},window=BrowserWindow.getAllWindows()[0];
        const views=window.contentView.children.filter(v=>v.webContents&&!v.webContents.isDestroyed());
        const pages=views.filter(v=>v.webContents.getURL().split('#')[0]===${JSON.stringify(ctx.pageUrl)});
        const chrome=views.filter(v=>v.webContents.getURL().startsWith('data:text/html,')&&v.webContents.getURL().includes('Content-Security-Policy'));
        const frame=async(view,index)=>{
          const wc=view.webContents,observed={id:wc.id,url:wc.getURL(),visible:view.getVisible(),bounds:view.getBounds(),
            ownerWindowId:wc.getOwnerBrowserWindow()?.id,childIndex:views.indexOf(view),framesSeen:0,
            mechanism:'beginFrameSubscription(false) plus one invalidate(), budget 1500ms; no focus/visibility change'};
          try {
            observed.renderer={zoom:wc.getZoomFactor(),backgroundThrottling:wc.getBackgroundThrottling(),
              loading:wc.isLoading(),dom:await wc.executeJavaScript('(()=>{const root=document.documentElement,image=document.querySelector("img"),box=image?.getBoundingClientRect();return {visibility:document.visibilityState,focused:document.hasFocus(),innerWidth,innerHeight,clientWidth:root.clientWidth,clientHeight:root.clientHeight,devicePixelRatio,image:image&&{complete:image.complete,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,box:box&&{x:box.x,y:box.y,width:box.width,height:box.height}}}})()')};
            observed.presentation=await new Promise(resolve=>{
              let finished=false,timer;
              const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);if(!wc.isDestroyed())wc.endFrameSubscription();resolve(value)};
              timer=setTimeout(()=>finish({presented:false}),1500);
              try {
                wc.beginFrameSubscription(false,(image,dirtyRect)=>{
                  observed.framesSeen++;
                  if(image.isEmpty())return;
                  try {
                    const bytes=image.toPNG(),file=${JSON.stringify(join(directory,label))}+'-diagnostic-presentation-'+index+'.png';
                    process.getBuiltinModule('fs').writeFileSync(file,bytes);
                    finish({presented:true,file,size:image.getSize(),dirtyRect,
                      sha256:process.getBuiltinModule('crypto').createHash('sha256').update(bytes).digest('hex')});
                  }catch(failure){finish({error:String(failure)})}
                });
                wc.invalidate();
              }catch(failure){finish({error:String(failure)})}
            });
            try{const image=await wc.capturePage();observed.after={empty:image.isEmpty(),size:image.getSize()}}
            catch(failure){observed.after={error:String(failure)}}
          }catch(failure){observed.error=String(failure)}
          return observed;
        };
        return {electron:process.versions.electron,window:{id:window.id,visible:window.isVisible(),focused:window.isFocused(),
          minimized:window.isMinimized(),bounds:window.getBounds()},actualPageOwners:pages.length,
          actualChromeOwners:chrome.length,frames:await Promise.all([...pages,...chrome].slice(0,9).map(frame))};
      })()`)
    } catch (failure) { ctx.receipt.overlayNativeFrameFailure.diagnosticError = String(failure) }
    if (process.env.AGENTMUX_OVERLAY_DIAGNOSTIC_SYNC_THROTTLING === '1') {
      // A bounded intervention on this failed private owner, never a product repair
      // or a replacement for the original capture gate. No visibility/focus flip.
      try {
        ctx.receipt.overlayNativeFrameFailure.throttlingSynchronization = await ctx.probe.main.evaluate(`(async()=>{
          const {BrowserWindow}=${electron(ctx)},window=BrowserWindow.getAllWindows()[0];
          const candidates=window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL().startsWith('data:text/html,')&&view.webContents.getURL().includes('Content-Security-Policy'));
          if(candidates.length!==1)throw new Error('Expected exactly one failed private Chrome owner');
          const view=candidates[0],wc=view.webContents;
          const state=()=>({id:wc.id,ownerWindowId:wc.getOwnerBrowserWindow()?.id,bounds:view.getBounds(),visible:view.getVisible(),backgroundThrottling:wc.getBackgroundThrottling(),loading:wc.isLoading(),windowFocused:window.isFocused(),windowBounds:window.getBounds()});
          const observed={mechanism:'One explicit setBackgroundThrottling(false) on the attached, loaded private Chrome; 1500ms bounded observation; original gate remains failed',before:state(),framesSeen:0,attempts:[]};
          if(observed.before.loading||observed.before.ownerWindowId!==window.id)throw new Error('Chrome is not the loaded private native owner');
          try{
            wc.beginFrameSubscription(false,(image)=>{observed.framesSeen++;if(!image.isEmpty())observed.subscriptionFrame={size:image.getSize()}});
            wc.setBackgroundThrottling(false);
            const end=Date.now()+1500;
            do{
              try{const image=await wc.capturePage();observed.attempts.push({empty:image.isEmpty(),size:image.getSize()});if(!image.isEmpty()){const bytes=image.toPNG(),file=${JSON.stringify(join(directory,label))}+'-diagnostic-throttling-sync.png';process.getBuiltinModule('fs').writeFileSync(file,bytes);observed.frame={file,size:image.getSize(),sha256:process.getBuiltinModule('crypto').createHash('sha256').update(bytes).digest('hex')};break}}
              catch(failure){observed.attempts.push({error:String(failure)})}
              await new Promise(resolve=>setTimeout(resolve,100));
            }while(Date.now()<end);
          }finally{if(!wc.isDestroyed())wc.endFrameSubscription()}
          observed.after=state();return observed;
        })()`)
      } catch (failure) { ctx.receipt.overlayNativeFrameFailure.throttlingSynchronizationError = String(failure) }
    }
    throw error
  }
}
async function menu(ctx,label) {
  await hover(ctx,'[aria-label="Browser address"]')
  await ctx.probe.cdp.evaluate('document.querySelector(".browser-operation-status__trigger").focus()')
  for(const type of ['keyDown','keyUp'])await ctx.probe.cdp.call('Input.dispatchKeyEvent',{type,key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40})
  await ctx.waitFor('actual Browser operation popover',()=>ctx.probe.cdp.evaluate(`document.querySelector(${JSON.stringify(activitySelector)})?.getClientRects().length`))
  const projected = await ctx.waitFor('native Chrome covers only the actual intersecting menu',async()=>{const entries=await owners(ctx);return chromeOwners(entries).length?entries:null})
  const pages = pageOwner(ctx,projected)
  assert.equal(pages.length,1);assert.equal(pages[0].visible,true)
  const whileOpen = await pageInput(ctx)
  assert.ok(whileOpen.floatingBefore.some(float=>float.role==='menu'))
  const stillOpen = await ctx.probe.cdp.evaluate(`!!document.querySelector(${JSON.stringify(activitySelector)})?.getClientRects().length`)
  assert.equal(stillOpen,false,'Keyboard-opened menu must dismiss on the real native page click')
  await ctx.waitFor('outside-dismissed Chrome released',async()=>chromeOwners(await owners(ctx)).length===0)
  await ctx.click(ctx.probe.cdp,ctx.selectors('.browser-operation-status__trigger'))
  await ctx.waitFor('actual menu reopened for native selection',async()=>chromeOwners(await owners(ctx)).length>0)
  await captureOsWindow(ctx,label)
  const chrome = await captureChrome(ctx,label)
  assert.ok(chrome.length>0)
  await ctx.capture(ctx.probe,label,'overlay',ctx.pageUrl)
  const point = await ctx.probe.cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(activitySelector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  // Actual native pointer input is forwarded into the original mounted menu, not a duplicate UI.
  const input = await ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=${electron(ctx)};const window=BrowserWindow.getAllWindows()[0],zoom=window.webContents.getZoomFactor(),point={x:${point.x}*zoom,y:${point.y}*zoom};const candidates=window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL().startsWith('data:text/html,')&&view.webContents.getURL().includes('Content-Security-Policy'));const view=candidates.find(view=>{const b=view.getBounds();return point.x>=b.x&&point.x<b.x+b.width&&point.y>=b.y&&point.y<b.y+b.height});if(!view)throw new Error('The real menu point is not in projected native Chrome');const bounds=view.getBounds(),local={x:Math.round(point.x-bounds.x),y:Math.round(point.y-bounds.y)};view.webContents.sendInputEvent({type:'mouseDown',...local,button:'left',clickCount:1});view.webContents.sendInputEvent({type:'mouseUp',...local,button:'left',clickCount:1});return{id:view.webContents.id,point,bounds,zoom}})()`)
  await ctx.waitFor('native click reaches original product Activity action',()=>ctx.probe.cdp.evaluate('!!document.querySelector(".browser-trace-rail")&&document.querySelector(".browser-trace-rail").getClientRects().length>0'))
  await close(ctx)
  return {pages,chrome,input,whileOpen,pageInput:await pageInput(ctx)}
}

async function screenshotEditor(ctx, label) {
  const before = pageOwner(ctx, await owners(ctx)); assert.equal(before.length, 1)
  await ctx.click(ctx.probe.cdp, `${ctx.selectors('[aria-label="Screenshot"]')}.filter(button=>button.closest('.browser-surface')?.querySelector('[aria-label="Browser address"]')?.value.split('#')[0]===${JSON.stringify(ctx.pageUrl)})`)
  const geometry = await ctx.waitFor('the original loaded screenshot editor in its window Portal', () => ctx.probe.cdp.evaluate(`(()=>{
    const editor=document.querySelector('[aria-label="Screenshot editor"]'),image=editor?.querySelector('img'),canvas=editor?.querySelector('canvas');
    if(!editor||!image?.complete||!image.naturalWidth||!canvas?.width||!canvas.height)return null;
    const copy=Array.from(editor.querySelectorAll('button')).filter(button=>button.textContent.trim()==='Copy PNG');if(copy.length!==1)throw new Error('Expected exactly one original Copy action');
    const surfaces=Array.from(document.querySelectorAll('.browser-surface')).filter(surface=>surface.querySelector('[aria-label="Browser address"]')?.value.split('#')[0]===${JSON.stringify(ctx.pageUrl)});if(surfaces.length!==1)throw new Error('Expected exactly one original screenshot Browser surface');
    const box=canvas.getBoundingClientRect(),stage=surfaces[0].querySelector('[data-native-browser-stage]').getBoundingClientRect(),dialog=editor.getBoundingClientRect();
    return{portal:!!editor.closest('[data-overlay-layer="dialog"]'),box:{x:box.x,y:box.y,width:box.width,height:box.height},stage:{x:stage.x,y:stage.y,width:stage.width,height:stage.height},dialog:{x:dialog.x,y:dialog.y,width:dialog.width,height:dialog.height},copyEnabled:!copy[0].disabled};})()`))
  assert.equal(geometry.portal, true); assert.equal(geometry.copyEnabled, true)
  for (const key of ['x','y','width','height']) assert.ok(Math.abs(geometry.stage[key]-geometry.dialog[key])<1, 'The screenshot Portal must follow the actual Browser stage')
  const ink = () => ctx.probe.cdp.evaluate(`(()=>{const canvas=document.querySelector('[aria-label="Screenshot editor"] canvas');if(!canvas)throw new Error('Original editor canvas is absent');const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let pixels=0,minX=canvas.width,maxX=-1;for(let offset=3;offset<data.length;offset+=4)if(data[offset]){pixels++;const x=((offset-3)/4)%canvas.width;minX=Math.min(minX,x);maxX=Math.max(maxX,x)}return{width:canvas.width,height:canvas.height,pixels,minX,maxX}})()`)
  assert.equal((await ink()).pixels, 0)
  const zoom=await ctx.probe.cdp.evaluate('window.agentmux.ui.getZoomFactor()')
  await ctx.waitFor('the actual native owner for the original screenshot dialog',async()=>chromeOwners(await owners(ctx)).some(owner=>['x','y','width','height'].every(key=>Math.abs(owner.bounds[key]-geometry.dialog[key]*zoom)<2)),1500)
  const initial = await captureChrome(ctx, `${label}-screenshot-empty`); assert.ok(initial.length > 0)
  ;(ctx.receipt.screenshotEditorAttempts??=[]).push({label,geometry,initialChrome:initial})
  const observeInput = process.env.AGENTMUX_SCREENSHOT_OBSERVE_INPUT === '1'
  if (observeInput) {
    ctx.receipt.diagnosticMode = 'passive-original-screenshot-input'
    await ctx.probe.cdp.evaluate(`(()=>{const canvas=document.querySelector('[aria-label="Screenshot editor"] canvas');if(!canvas)throw new Error('Original canvas is required for observation');const events=[];const listener=event=>{if(events.length<100)events.push({type:event.type,pointerId:event.pointerId,buttons:event.buttons,x:event.clientX,y:event.clientY,target:event.target.tagName,trusted:event.isTrusted})};for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture'])canvas.addEventListener(type,listener);globalThis.__privateScreenshotInput={events,dispose:()=>{for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture'])canvas.removeEventListener(type,listener)}}})()`)
    await ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=${electron(ctx)},window=BrowserWindow.getAllWindows()[0];if(process.pid!==${ctx.probe.child.pid})throw new Error('Only the private Main is observed');const ids=${JSON.stringify(initial.map(frame=>frame.id))},views=window.contentView.children.filter(view=>view.webContents&&ids.includes(view.webContents.id)),events=[],listeners=[];if(views.length!==ids.length)throw new Error('The exact captured owners must still exist');for(const wc of [window.webContents,...views.map(view=>view.webContents)]){const listener=(_event,input)=>{if(events.length<100)events.push({ownerId:wc.id,type:input.type,x:input.x,y:input.y,button:input.button,modifiers:input.modifiers})};wc.on('input-event',listener);listeners.push([wc,listener])}globalThis.__privateScreenshotInput={events,dispose:()=>{for(const [wc,listener]of listeners)if(!wc.isDestroyed())wc.off('input-event',listener)}}})()`)
  }
  const pointer = async (point, type, buttons = 0) => ctx.probe.main.evaluate(`(()=>{
    const {BrowserWindow}=${electron(ctx)},window=BrowserWindow.getAllWindows()[0],zoom=window.webContents.getZoomFactor(),point={x:${point.x}*zoom,y:${point.y}*zoom};
    const candidates=window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()&&view.webContents.getURL().startsWith('data:text/html,')&&view.webContents.getURL().includes('Content-Security-Policy'));
    const view=candidates.find(view=>{const box=view.getBounds();return point.x>=box.x&&point.x<box.x+box.width&&point.y>=box.y&&point.y<box.y+box.height});if(!view)throw new Error('Actual screenshot input is outside native Chrome');
    const box=view.getBounds();view.webContents.sendInputEvent({type:${JSON.stringify(type)},x:Math.round(point.x-box.x),y:Math.round(point.y-box.y),button:'left',modifiers:${JSON.stringify(buttons?['leftbuttondown']:[])},clickCount:1});return view.webContents.id;})()`)
  const start={x:geometry.box.x+geometry.box.width*0.35,y:geometry.box.y+geometry.box.height*0.4}
  let drawn
  try {
    await pointer(start,'mouseDown',1)
    for (const fraction of [0.4,0.45,0.5]) await pointer({x:geometry.box.x+geometry.box.width*fraction,y:start.y},'mouseMove',1)
    await pointer({x:geometry.box.x+geometry.box.width*0.5,y:start.y},'mouseUp')
    drawn = await ctx.waitFor('real native drag paints a line across the original screenshot canvas', async () => { const value=await ink();return value.pixels>0&&value.maxX-value.minX>=value.width*0.1?value:null },1500)
  } catch (error) {
    ctx.receipt.screenshotDragFailure = {label,geometry,ink:await ink(),originalError:String(error)}
    throw error
  } finally {
    if (observeInput) {
      ;(ctx.receipt.screenshotInputObservations??=[]).push({label,
        renderer:await ctx.probe.cdp.evaluate('(()=>{const observation=globalThis.__privateScreenshotInput;observation.dispose();delete globalThis.__privateScreenshotInput;return observation.events})()'),
        native:await ctx.probe.main.evaluate('(()=>{const observation=globalThis.__privateScreenshotInput;observation.dispose();delete globalThis.__privateScreenshotInput;return observation.events})()')})
    }
  }
  await ctx.waitFor('the original committed markup is available to Undo',()=>ctx.probe.cdp.evaluate(`document.querySelector(${JSON.stringify('[aria-label="Screenshot editor"] [aria-label="Undo"]')})?.disabled===false`),1500)
  await ctx.waitFor('the original native screenshot projection repaints its new markup', async () => {
    const frames=await captureChrome(ctx, `${label}-screenshot-drawn`)
    return frames.length>0&&frames.some(frame=>initial.some(old=>old.id===frame.id&&old.sha256!==frame.sha256))?frames:null
  },1500)
  await ctx.capture(ctx.probe,`${label}-screenshot-drawn`,'overlay',ctx.pageUrl)
  const cancel=await ctx.probe.cdp.evaluate(`(()=>{const buttons=Array.from(document.querySelector('[aria-label="Screenshot editor"]').querySelectorAll('button')).filter(button=>button.textContent.trim()==='Cancel');if(buttons.length!==1)throw new Error('Expected one original Cancel action');const box=buttons[0].getBoundingClientRect();return{x:box.x+box.width/2,y:box.y+box.height/2}})()`)
  await pointer(cancel,'mouseDown',1); await pointer(cancel,'mouseUp')
  await ctx.waitFor('native Cancel releases the actual screenshot editor and floating owner',async()=>!(await ctx.probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify('[aria-label="Screenshot editor"]')}))`))&&chromeOwners(await owners(ctx)).length===0)
  const after = pageOwner(ctx, await owners(ctx)); assert.equal(after.length,1); assert.equal(after[0].id,before[0].id); assert.equal(after[0].visible,true)
  return {label,geometry,drawn,originalOwnerId:before[0].id,pageAfterCancel:await pageInput(ctx),copyBoundary:'The original Copy PNG action is loaded and enabled. This native scenario does not write the shared system clipboard.'}
}

export async function reviewOverlay(ctx) {
  for(const selector of ['[aria-label="Hide Space tools"]','[aria-label="Hide projects sidebar"]'])if(await ctx.probe.cdp.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`))await ctx.click(ctx.probe.cdp,ctx.selectors(selector))
  const start = pageOwner(ctx,await owners(ctx));assert.equal(start.length,1)
  const observations=[]
  ctx.receipt.overlay={originalOwner:start[0],observations,aestheticReview:'not-performed'}
  for(const [label,width,height] of [['normal',1440,900],['narrow',1000,720],['short',1000,660]]) {
    await ctx.resize(ctx.probe,width,height)
    await hover(ctx,'.surface-navigation__slot--surface')
    await ctx.waitFor('real navigation hover tooltip',()=>ctx.probe.cdp.evaluate('!!document.querySelector(".surface-navigation__tooltip[role=tooltip]")'))
    const tooltip=await ctx.probe.cdp.evaluate('(()=>{const element=document.querySelector(".surface-navigation__tooltip[role=tooltip]"),rect=element.getBoundingClientRect();return{x:rect.x,y:rect.y,width:rect.width,height:rect.height,text:element.textContent}})()')
    const tooltipOwners=await ctx.waitFor('actual intersecting tooltip Chrome owner',async()=>{const entries=await owners(ctx);return chromeOwners(entries).length?entries:null})
    const tooltipPage=pageOwner(ctx,tooltipOwners);assert.equal(tooltipPage.length,1);assert.equal(tooltipPage[0].visible,true);assert.equal(tooltipPage[0].id,start[0].id)
    const zoom=await ctx.probe.cdp.evaluate('window.agentmux.ui.getZoomFactor()'),bounds={x:tooltip.x*zoom,y:tooltip.y*zoom,width:tooltip.width*zoom,height:tooltip.height*zoom},pageBounds=tooltipPage[0].bounds
    assert.ok(bounds.x<pageBounds.x+pageBounds.width&&pageBounds.x<bounds.x+bounds.width&&bounds.y<pageBounds.y+pageBounds.height&&pageBounds.y<bounds.y+bounds.height,'Actual tooltip must overlap the native page')
    assert.ok(chromeOwners(tooltipOwners).some(owner=>Math.abs(owner.bounds.x-bounds.x)<=1&&Math.abs(owner.bounds.y-bounds.y)<=1&&Math.abs(owner.bounds.width-bounds.width)<=2&&Math.abs(owner.bounds.height-bounds.height)<=2),'Actual tooltip must have its matching native owner')
    await captureOsWindow(ctx,`${label}-hover-tooltip`)
    const tooltipChrome=await captureChrome(ctx,`${label}-hover-tooltip`);assert.ok(tooltipChrome.length>0)
    await ctx.capture(ctx.probe,`${label}-hover-tooltip`,'overlay',ctx.pageUrl)
    const tooltipInput = await pageInput(ctx)
    assert.ok(tooltipInput.floatingBefore.some(float=>float.role==='tooltip'))
    await close(ctx)
    observations.push({label,tooltip,tooltipPage,tooltipChrome,tooltipInput,menu:await menu(ctx,`${label}-browser-popover`)})
  }
  await ctx.resize(ctx.probe,1440,900)
  const observer = await installNativeChromeStageObserver(ctx)
  const originalPaintObserver = process.env.AGENTMUX_OVERLAY_OBSERVE_ORIGINAL_PAINT === '1' ? await observeOriginalOverlayPaint(ctx) : null
  try {
    await ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=${electron(ctx)};BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25)})()`)
    await ctx.waitFor('actual product zoom 1.25',()=>ctx.probe.cdp.evaluate('window.agentmux.ui.getZoomFactor()').then(value=>value===1.25))
    observations.push({label:'zoom-1.25',menu:await menu(ctx,'zoom-1.25-browser-popover')})
    ctx.receipt.screenshotEditor = [await screenshotEditor(ctx,'zoom-1.25')]
    await ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=${electron(ctx)};BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)})()`)
  } finally {
    // Passive observations survive a failed original image/capture gate. Restore
    // methods before the harness quits; no extra paint, focus or setter is issued.
    ctx.receipt.overlayStageObserver = await observer.restore()
    if (originalPaintObserver) ctx.receipt.originalOverlayPaintObserver = await originalPaintObserver()
  }
  ctx.receipt.overlay.inputBeforeRestart=await pageInput(ctx)
}

export async function recoverOverlay(ctx) {
  const pages=pageOwner(ctx,await owners(ctx));assert.equal(pages.length,1);assert.equal(pages[0].visible,true)
  assert.deepEqual(chromeOwners(await owners(ctx)),[],'Ordinary restart must not revive stale floating Chrome')
  ctx.receipt.overlay.restoredPage=pages[0]
  ctx.receipt.overlay.unforcedRestoredFrame=await ctx.nativeFrameReady(ctx.pageUrl)
  ctx.receipt.overlay.inputAfterRestart=await pageInput(ctx)
  ctx.receipt.screenshotEditor.push(await screenshotEditor(ctx,'restarted'))
  ctx.receipt.overlay.complete=true
}
