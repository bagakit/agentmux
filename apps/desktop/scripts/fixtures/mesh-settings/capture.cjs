const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const [url,profile,output,scenario,...requestedCases]=process.argv.slice(2)
app.setPath('userData',path.resolve(profile));app.disableHardwareAcceleration()
const delay=ms=>new Promise(r=>setTimeout(r,ms));const receipt={captureOnly:true,visualReview:'pending-independent-review',frames:[],console:[],passed:false,boundary:'Production Settings/components/theme using controlled observations; separate actual Unix Core/Native tests prove transport.'}
let window
app.whenReady().then(async()=>{try{
 window=new BrowserWindow({show:false,width:1280,height:980,webPreferences:{backgroundThrottling:false,sandbox:false}})
 window.webContents.on('console-message',(_event,_level,text)=>{if(receipt.console.length<40)receipt.console.push(text.slice(0,500))})
 const evaluate=code=>window.webContents.executeJavaScript(code,true)
 await window.loadURL(url)
 const openGateway=()=>evaluate(`document.querySelector('.settings-sidebar nav [data-settings-target="hosts:mesh-configuration"]')?.click()`)
 const paint=async()=>{await evaluate('document.fonts.ready');await delay(400)}
 const frame=async name=>{await paint();const file=name+'.png';await fs.writeFile(path.join(output,file),(await window.webContents.capturePage()).toPNG());receipt.frames.push(file)}
 if (scenario === '--gateway-join') {
   const until = async test => { for (let i=0;i<120;i++) { if (await evaluate(test)) return; await delay(50) }; throw Error(test) }
   const codeField = 'document.querySelector(\'[aria-label="Gateway connection code"]\')'
   const start = async () => {
     await until("Boolean(document.querySelector('.mesh-home-actions .primary-button'))")
     await evaluate("document.querySelector('.mesh-home-actions .primary-button').click()")
     await until(`Boolean(${codeField})`)
     await evaluate(`(() => { const field=${codeField}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,meshFixture.workflowCode);field.dispatchEvent(new Event('input',{bubbles:true})) })()`)
     await until("document.querySelector('.mesh-peer-preview')?.textContent.includes('gateway.example')")
   }
   await window.loadURL(url+'?scenario=gateway-join')
   await until("Boolean(document.querySelector('.mesh-home-actions .primary-button'))")
   await frame('gateway-entry-dark')
   await start()
   await until("document.querySelector('.mesh-join-form [type=submit]')?.disabled === false")
   await frame('gateway-preview-dark')
   await evaluate("document.querySelector('.mesh-join-form [type=submit]').click()")
   await until("document.querySelector('.mesh-join-result')?.textContent.includes('Gateway connection not yet confirmed')")
   await frame('gateway-approval-dark')
   await evaluate("meshFixture.confirmGateway();document.querySelector('.mesh-join-result button.primary-button').click()")
   await until("document.querySelector('.mesh-join-result')?.textContent.includes('Connected to gateway')")
   await frame('gateway-connected-dark')
   await evaluate("document.querySelector('.mesh-join-result button.primary-button').click()")
   await until("Boolean(document.querySelector('.mesh-home-actions'))")
   window.setContentSize(570,870)
   await window.loadURL(url+'?scenario=runtime-identity');await evaluate('meshFixture.theme("light")')
   await start()
   await until("Boolean(document.querySelector('.mesh-identity-recovery details'))")
   await evaluate("document.querySelector('.mesh-identity-recovery details').open=true")
   await frame('gateway-recovery-light-narrow')
   await window.loadURL(url+'?scenario=separate-gateway-identity');await evaluate('meshFixture.theme("light")')
   await until(`Boolean(${codeField}?.value)`)
   await frame('gateway-separate-light-narrow')
   receipt.passed = true
   return
 }
 if (scenario === '--settings-inputs') {
   receipt.providerToolbarGaps = []
   const element = selector => `document.querySelector(${JSON.stringify(selector)})`
   const until = async check => {
     for (let attempt = 0; attempt < 120; attempt++) { if (await evaluate(check)) return; await delay(50) }
     throw Error('Production Settings field did not appear: ' + check)
   }
   window.webContents.debugger.attach('1.3')
   const focus = async selector => {
     const target = element(selector)
     await until(`${target}?.checkVisibility()`)
     await evaluate(`${target}.focus({ preventScroll: true })`)
     for (const type of ['keyDown', 'keyUp']) {
       await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
     }
     await evaluate(`${target}.scrollIntoView({ block: 'center', inline: 'nearest' }); ${target}.focus({ preventScroll: true })`)
     assert.equal(await evaluate(`document.activeElement === ${target} && ${target}.matches(':focus-visible')`), true,
       'Original field receives visible keyboard focus: ' + selector)
   }
   const click = selector => evaluate(`${element(selector)}?.click()`)
   const fill = (selector, value) => evaluate(`(() => {
     const field = ${element(selector)}
     const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
     Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)})
     field.dispatchEvent(new Event('input', { bubbles: true }))
   })()`)
   const field = label => `[aria-label="${label}"]`
   const cases = {
     providers: async () => {
       const search = field('Filter providers')
       await until(`Boolean(${element(search)}?.closest('[data-settings-search-highlight]'))`)
       await focus(search)
       const reveal = await evaluate(`(() => {
         const panel = ${element(search)}.closest('[data-settings-search-highlight]')
         return panel && { outline: getComputedStyle(panel).outlineStyle, focusInside: panel.matches(':focus-within') }
       })()`)
       assert.deepEqual(reveal, { outline: 'none', focusInside: true })
       await fill(search, 'codex')
       await until(`document.querySelector('[data-provider-id="codex"]')?.checkVisibility()`)
       await click(field('Select Codex for comparison'))
       await focus(search)
       const gap = await evaluate(`(() => {
         const select = ${element(field('Provider Host'))}
         const refresh = ${element(field('Refresh Provider capabilities'))}
         const toolbar = getComputedStyle(select.closest('.provider-comparison__toolbar'))
         const host = select.getBoundingClientRect(), action = refresh.getBoundingClientRect()
         const sameRow = host.top < action.bottom && action.top < host.bottom
         return { viewport: innerWidth, sameRow, hostWidth: host.width,
           actual: sameRow ? (toolbar.direction === 'rtl' ? host.left - action.right : action.left - host.right) : action.top - host.bottom,
           required: parseFloat(sameRow ? toolbar.columnGap : toolbar.rowGap) }
       })()`)
       receipt.providerToolbarGaps.push(gap)
     },
     executor: async () => {
       await until("Boolean([...document.querySelectorAll('.settings-pane-toolbar button')].find(button => button.textContent.trim() === 'Add executor'))")
       await evaluate("[...document.querySelectorAll('.settings-pane-toolbar button')].find(button => button.textContent.trim() === 'Add executor').click()")
       await focus('[data-executor-provider]')
       await fill(field('Executor arguments'), '--model "review model"')
     },
     host: async () => {
       await until("Boolean(document.querySelector('.host-edit-disclosure summary'))")
       await click('.host-edit-disclosure summary')
       await focus('.host-edit-grid input[type="number"]')
       assert.equal(await evaluate('document.activeElement.value'), '2222')
     },
     incoming: async () => {
       const address = field('Private Tailcat address')
       await focus(address)
       await evaluate("document.querySelector('.host-tailcat-preparation').scrollIntoView({ block: 'start' })")
       assert.equal(await evaluate(`(() => { const r = ${element(address)}.getBoundingClientRect();
         const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return at === ${element(address)} })()`), true)
       assert.equal(await evaluate('document.activeElement.type'), 'password')
       assert.equal(await evaluate('document.activeElement.readOnly'), true)
     },
     mesh: async () => {
       const code = field('Paste a connection code')
       await focus(code)
       await fill(code, 'incomplete-review-code')
       await click('.mesh-peer-pairing button')
       await until(`${element(code)}?.getAttribute('aria-invalid') === 'true'`)
       await focus(code)
     },
     node: async () => {
       await focus('[name="allowedPaths"]')
       await evaluate(`(() => {
         const publish = document.querySelector('[data-settings-field="publishing"]')
         const scroll = publish.closest('.settings-content__scroll')
         scroll.scrollTop += publish.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 8
       })()`)
       assert.ok(await evaluate("document.activeElement.value.includes('review')"))
       assert.ok(await evaluate(`(() => {
         const heading = document.querySelector('[data-settings-field="publishing"] h3')
         return heading.getBoundingClientRect().top >= heading.closest('.settings-content__scroll').getBoundingClientRect().top
       })()`), 'The whole Node publication heading is visible')
     },
     remote: async () => {
       const agent = field('Agent runs on')
       await focus(agent)
       const outline = await evaluate(`(() => {
         const style = getComputedStyle(${element(agent)})
         return { width: style.outlineWidth, offset: style.outlineOffset }
       })()`)
       assert.deepEqual(outline, { width: '1px', offset: '-1px' })
     }
   }
   for (const name of requestedCases.length ? requestedCases : Object.keys(cases)) {
     const prepare = cases[name]
     assert.equal(typeof prepare, 'function', 'Known Runtime Settings input capture case')
     for (const [width, theme] of [[1280, 'dark'], [520, 'light']]) {
       window.setContentSize(width, 900)
       await window.loadURL(url + '?scenario=settings-inputs&case=' + name)
       await evaluate(`meshFixture.theme(${JSON.stringify(theme)})`)
       await prepare()
       assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'No horizontal page overflow')
       assert.equal(await evaluate(`document.documentElement.dataset.appearance === ${JSON.stringify(theme)}`), true)
       await frame('inputs-' + name + '-' + theme + '-' + width)
     }
   }
   for (const gap of receipt.providerToolbarGaps) {
     assert.ok(gap.actual >= gap.required && gap.required > 0,
       'The Host control and Refresh preserve the Provider toolbar gap: ' + JSON.stringify(gap))
   }
   receipt.passed = true
   return
 }
 if (scenario === '--device-workflow') {
   const until = async test => { for (let i=0;i<120;i++) { if (await evaluate(test)) return; await delay(50) }; throw Error(test) }
   const field = name => `document.querySelector('[aria-label="${name}"]')`
   await window.loadURL(url+'?scenario=initial')
   await until("document.querySelector('.mesh-home-actions')?.textContent.includes('Use another device')")
   await frame('device-tasks')
   await evaluate("document.querySelector('.mesh-home-actions button:last-child').click()")
   await until(`Boolean(${field('Device access link')})`)
   await frame('use-another-device')
   await evaluate("document.querySelector('.mesh-editor-navigation button').click()")
   await until("Boolean(document.querySelector('.mesh-home-actions button'))")
   await evaluate("document.querySelector('.mesh-home-actions button').click()")
   await until(`Boolean(${field('Gateway connection code')})`)
   await evaluate(`(()=>{const e=${field('Gateway connection code')};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,meshFixture.workflowCode);e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
   await until("document.querySelector('.mesh-peer-preview')?.textContent.includes('gateway.example')")
   await frame('join-preview')
   window.setContentSize(550,900);await evaluate('meshFixture.theme("light")')
   await evaluate("document.querySelector('.mesh-join-form').scrollIntoView({block:'center'})");await frame('join-preview-narrow')
   window.setContentSize(1280,980);await window.loadURL(url+'?scenario=workflow-gateway');await openGateway()
   await until(`Boolean(${field('Device to manage')})`)
   await evaluate(`(()=>{const e=${field('Device to manage')};e.value=e.options[1].value;e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
   await until("document.querySelector('.mesh-network-heading h3')?.textContent.includes('Office gateway')")
   await frame('managed-gateway')
   await until(`Boolean(${field('Mesh device public keys')})`)
   await evaluate("document.querySelector('.mesh-device-access').open=true;document.querySelector('.mesh-device-access').scrollIntoView({block:'center'})")
   await frame('endpoint-approval')
   await evaluate("meshFixture.endpoint();document.querySelector('.mesh-network-heading button').click();document.querySelector('.mesh-access-links').open=true")
   await until("!document.querySelector('[data-settings-field=mesh-link]>button')?.disabled")
   await evaluate("document.querySelector('[data-settings-field=mesh-link]>button').click()")
   await until(`Boolean(${field('Mesh access link')})`)
   await evaluate("document.querySelector('.mesh-link-result').scrollIntoView({block:'center'})")
   await frame('gateway-access-link')
   receipt.passed=true;return
 }
 if (scenario === '--runtime-identity') {
  await window.loadURL(url+'?scenario=runtime-identity');await openGateway()
  for(let i=0;i<200;i++){if(await evaluate('Boolean(document.querySelector("[data-mesh-settings] .primary-button"))'))break;await delay(30)}
  assert.match(await evaluate('document.querySelector("[data-mesh-settings] .primary-button")?.textContent'),/Restore from backup/u)
  await frame('runtime-identity-dark')
  window.setContentSize(520,900);await evaluate('meshFixture.theme("light")');await frame('runtime-identity-narrow-light')
  await evaluate('document.querySelector("[data-mesh-settings] .primary-button").click()')
  for(let i=0;i<200;i++){if(await evaluate('Boolean(document.querySelector("[aria-label=\\"Mesh network\\"]"))'))break;await delay(30)}
  assert.match(await evaluate('document.querySelector("[data-mesh-settings]")?.textContent'),/Connect to a gateway/u)
  window.setContentSize(1280,980);await window.loadURL(url+'?scenario=runtime-identity-blocked');await openGateway()
  for(let i=0;i<200;i++){if(await evaluate('document.querySelector("[data-mesh-settings] .primary-button")?.textContent==="Check again"'))break;await delay(30)}
  assert.equal(await evaluate('document.querySelector("[data-mesh-settings] .primary-button")?.textContent'),'Check again')
  await frame('runtime-identity-blocked-dark')
  window.setContentSize(520,900);await evaluate('meshFixture.theme("light");document.querySelector("[data-mesh-settings] details").open = true');await frame('runtime-identity-blocked-narrow-light')
  receipt.passed=true
  return
 }
 const topologyGeometry=()=>evaluate(`(()=>{const canvas=document.querySelector('.mesh-explorer__canvas');if(!canvas)return null;const bounds=canvas.getBoundingClientRect(),nodes=Array.from(canvas.querySelectorAll('.mesh-explorer-node')).map(node=>{const rect=node.getBoundingClientRect();return{text:node.textContent,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,effectiveFontSize:parseFloat(getComputedStyle(node.querySelector('strong')).fontSize)*rect.width/188}}),own=nodes.find(node=>node.text.includes('THIS CORE'));return{canvas:{left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom},nodes,own,arrangeVisible:Boolean(Array.from(document.querySelectorAll('button')).find(button=>button.getAttribute('aria-label')==='Rearrange observed topology')?.getBoundingClientRect().width)}})()`)
 const assertTopologyFits=geometry=>{assert.ok(geometry?.own,'the original This Core node exists in the real topology');assert.equal(geometry.nodes.length,3,'the controlled topology keeps every observed peer');for(const node of geometry.nodes)assert.ok(node.left>=geometry.canvas.left-1&&node.right<=geometry.canvas.right+1&&node.top>=geometry.canvas.top-1&&node.bottom<=geometry.canvas.bottom+1,node.text+' remains inside the responsive canvas');assert.ok(geometry.own.effectiveFontSize>=10,'responsive fitting retains at least 10px effective node label text');assert.ok(geometry.arrangeVisible,'Arrange remains available beside the fitted topology')}
 for(let i=0;i<250;i++){if(await evaluate('Boolean(document.querySelector(".mesh-paths-pane"))'))break;await delay(40)}
 await frame('overview-dark')
 await evaluate('meshFixture.theme("light")');await frame('overview-light')
 window.setContentSize(520,900);await evaluate('meshFixture.theme("dark")');await frame('overview-narrow-dark')
 receipt.narrowTopology=await topologyGeometry();assertTopologyFits(receipt.narrowTopology)
 window.setContentSize(1280,980);await openGateway()
 for(let i=0;i<250;i++){if(await evaluate('Boolean(document.querySelector("[aria-label=\\"Mesh network\\"]"))'))break;await delay(40)}
 assert.equal(await evaluate('Boolean(document.querySelector("[data-mesh-settings]"))'),true,'actual Settings Mesh editor mounted')
 await frame('wide-dark')
 await evaluate('meshFixture.theme("light")');await frame('wide-light')
 window.setContentSize(520,900);await evaluate('meshFixture.theme("dark")');await frame('narrow-dark')
 const saveFlowGeometry=()=>evaluate(`(()=>{const view=document.querySelector('[data-mesh-view=network]'),peer=document.querySelector('[aria-label="Mesh peer codes"]').getBoundingClientRect(),field=document.querySelector('.mesh-gateway-fields').getBoundingClientRect(),barElement=document.querySelector('[data-mesh-settings] > .settings-pane-actions'),bar=barElement.getBoundingClientRect(),viewport=view.getBoundingClientRect(),button=barElement.querySelector('button'),buttonRect=button.getBoundingClientRect(),hit=document.elementFromPoint(buttonRect.left+buttonRect.width/2,buttonRect.top+buttonRect.height/2);return{position:getComputedStyle(barElement).position,paddingBottom:parseFloat(getComputedStyle(view).paddingBottom),scrollTop:view.scrollTop,scrollHeight:view.scrollHeight,clientHeight:view.clientHeight,peer:{top:peer.top,bottom:peer.bottom},fieldBottom:field.bottom,saveBarTop:bar.top,saveBarBottom:bar.bottom,viewTop:viewport.top,viewBottom:viewport.bottom,overlapsPeerCodes:peer.left<bar.right&&peer.right>bar.left&&peer.top<bar.bottom&&peer.bottom>bar.top,saveActionReachable:Boolean(hit&&button.contains(hit)),feedback:barElement.querySelector('[role=status],[role=alert]')?.textContent}})()`)
 receipt.narrowInitialFlow=await saveFlowGeometry();assert.equal(receipt.narrowInitialFlow.position,'static','the Mesh save bar participates in normal document flow');assert.equal(receipt.narrowInitialFlow.overlapsPeerCodes,false,'the 520px first screen never covers peer codes with its save bar');assert.ok(receipt.narrowInitialFlow.paddingBottom<=17,'the former sticky-bar bottom reservation is removed')
 await evaluate('(()=>{const view=document.querySelector("[data-mesh-view=network]");view.scrollTop=(view.scrollHeight-view.clientHeight)*.55})()');await frame('narrow-middle-fields');receipt.narrowMiddleFlow=await saveFlowGeometry();assert.equal(receipt.narrowMiddleFlow.overlapsPeerCodes,false,'the 520px middle scroll position keeps peer codes clear of save feedback')
 await evaluate('(()=>{const view=document.querySelector("[data-mesh-view=network]");view.scrollTop=view.scrollHeight})()');await paint();receipt.narrowClearance=await saveFlowGeometry();assert.ok(receipt.narrowClearance.fieldBottom<=receipt.narrowClearance.saveBarTop+1,'the last Mesh field precedes the in-flow save bar at 520px');assert.ok(receipt.narrowClearance.saveBarTop>=receipt.narrowClearance.viewTop-1&&receipt.narrowClearance.saveBarBottom<=receipt.narrowClearance.viewBottom+1,'the complete save service window is reachable at the bottom');assert.equal(receipt.narrowClearance.saveActionReachable,true,'the real Save Mesh settings button is hit-testable');assert.ok(receipt.narrowClearance.feedback,'save feedback remains available in the in-flow service window');await frame('narrow-lower-fields')
 window.setContentSize(1280,980);await evaluate('meshFixture.failure();document.querySelector(".mesh-network-heading button").click();document.querySelector("[data-mesh-view=network]").scrollTop=0');await paint()
 receipt.failureWindow=await evaluate(`(()=>{const view=document.querySelector('[data-mesh-view=network]').getBoundingClientRect(),statusElement=document.querySelector('.mesh-network-status'),status=statusElement.getBoundingClientRect(),issueElement=statusElement.querySelector('.settings-inline-error'),issue=issueElement.getBoundingClientRect();return{text:statusElement.textContent,statusTop:status.top,statusBottom:status.bottom,issueTop:issue.top,issueBottom:issue.bottom,viewTop:view.top,viewBottom:view.bottom}})()`);assert.match(receipt.failureWindow.text,/Mesh apply unavailable/,'failed apply is stated without disguising it as a healthy apply');assert.match(receipt.failureWindow.text,/previous listener remains active/,'the original healthy listener remains explicitly available');assert.match(receipt.failureWindow.text,/Listening on 127\.0\.0\.1:8444/,'the active listener address stays beside the failure');assert.ok(receipt.failureWindow.statusTop>=receipt.failureWindow.viewTop&&receipt.failureWindow.issueBottom<=receipt.failureWindow.viewBottom,'failure issue and Mesh listening facts share the captured service window');await frame('failed-new-listener')
 window.webContents.debugger.attach('1.3'); const point=await evaluate('(()=>{const r=document.querySelector("[data-mesh-view=network]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()'); await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaY:2400,deltaX:0});await paint();assert.ok(await evaluate('document.querySelector("[data-mesh-view=network]").scrollTop>0'),'actual native wheel scrolls the Mesh network fields');await frame('lower-fields')
 await evaluate('document.querySelector(".mesh-access-links").open=true;meshFixture.endpoint();document.querySelector(".mesh-network-heading button").click()');await paint();await evaluate('document.querySelector("[data-settings-field=mesh-link]").scrollIntoView({block:"end"})');await frame('original-host-endpoint')
 await evaluate(`(()=>{const e=document.querySelector('[aria-label="Original Mesh endpoint offer"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,JSON.stringify(meshFixture.originalOffer));e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await paint();await evaluate('document.querySelector("[data-settings-field=mesh-link]>button").click()');await paint();await evaluate('document.querySelector(".mesh-link-result details").open=true;document.querySelector(".mesh-link-result").scrollIntoView({block:"center"})');await frame('original-link-identity')
 await evaluate(`document.querySelector(".mesh-editor-navigation button").click();document.querySelector('[data-settings-target="hosts:mesh-devices"]').click()`);await frame('saved-connections')
 await evaluate('meshFixture.localOnly()');await paint();receipt.singleHost=await evaluate(`(()=>{const pane=document.querySelector('[data-mesh-view=connections]');return{scope:pane.querySelector('.remote-management__scope')?.textContent,local:Boolean(pane.querySelector('[data-host-disclosure=local]')),remote:Boolean(pane.querySelector('[data-host-disclosure=studio]')),view:pane.querySelector('[data-resource-view]')?.getAttribute('data-remote-mode')}})()`);assert.equal(receipt.singleHost.scope,'1host0 remote','the real Connections scope uses singular Host wording and zero remotes');assert.equal(receipt.singleHost.local,true,'the only local Host remains visible');assert.equal(receipt.singleHost.remote,false,'no remote Host leaks into the local-only scene');assert.equal(receipt.singleHost.view,'topology','the local-only scene is the real Connections topology');await frame('local-only-connections')
 await evaluate('meshFixture.allHosts()');await paint()
 await evaluate('document.querySelector("[data-host-disclosure=local] [data-host-panel=connection]").click();document.querySelector("[data-settings-field=incoming]").scrollIntoView({block:"center"})');await frame('local-incoming')
 receipt.localIncoming=await evaluate('Array.from(document.querySelectorAll("[data-settings-field=incoming]")).filter(element=>!element.closest("[hidden],[inert]")).map(element=>element.closest("[data-settings-host]")?.getAttribute("data-settings-host"))')
 assert.deepEqual(receipt.localIncoming,['local'],'the local Host owns the only visible Incoming editor')
 await evaluate('document.querySelector("[data-host-disclosure=studio] [data-host-panel=connection]").click()');await frame('remote-connection')
 assert.equal(await evaluate('Boolean(document.querySelector("[data-resource-editor=studio] [data-settings-field=incoming]"))'),false,'a remote Host never inherits the local Incoming editor')
 receipt.connectionOwnership=await evaluate('({local:document.querySelector("[data-resource-editor=local]")?.getAttribute("data-host-view"),remote:document.querySelector("[data-resource-editor=studio]")?.getAttribute("data-host-view")})')
 for (const scenario of ['initial','unavailable','settings-error']) {
  window.setContentSize(1280,980);await window.loadURL(url+'?scenario='+scenario);await openGateway()
  const selector=scenario==='initial'?'[aria-label="Mesh network"]':'.mesh-availability details';for(let i=0;i<200;i++){if(await evaluate('Boolean(document.querySelector('+JSON.stringify(selector)+'))'))break;await delay(30)}
  await frame(scenario+'-dark')
  if(scenario!=='settings-error') {
   await evaluate('meshFixture.theme("light")');await frame(scenario+'-light')
   window.setContentSize(520,900);await frame(scenario+'-narrow-light')
   await evaluate('meshFixture.theme("dark")');await frame(scenario+'-narrow-dark')
  }
 }
 receipt.overflow=await evaluate('Array.from(document.querySelectorAll("[data-mesh-settings] input,[data-mesh-settings] textarea")).map(e=>({label:e.getAttribute("aria-label"),width:e.getBoundingClientRect().width}))')
 receipt.passed=true
}catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}finally{await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'capture.json'),JSON.stringify(receipt,null,2));window?.destroy();app.exit(receipt.passed?0:1)}})
