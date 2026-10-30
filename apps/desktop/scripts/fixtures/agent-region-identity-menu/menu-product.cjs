const assert = require('node:assert/strict')

module.exports = async function agentMenuProof({win,evaluate,waitFor,visible,painted,click,key,point,seed,capture,result,surface,more,menu,open,close,measurement,selection}) {
  const item = (root, label) => `([...${root}.querySelectorAll('[role="menuitem"]')].find(node=>(node.getAttribute('aria-label')??node.textContent).trim()===${JSON.stringify(label)}))`
  async function submenu(label, input='keyboard', root=menu) {
    const trigger=item(root,label)
    if(input==='hover') await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...await point(trigger),buttons:0})
    else { await evaluate(`${trigger}.focus()`); await key('ArrowRight','ArrowRight',39) }
    const child=`document.getElementById(${trigger}.getAttribute('aria-controls'))`
    await waitFor(visible(child));await painted()
    return child
  }
  async function frame(name) {
    await painted()
    const png=await capture(name)
    result.frames.push({file:name+'.png',png,width:await evaluate('innerWidth'),state:name})
  }
  async function pointerTransfer(child,label,root=menu){
    const from=await point(item(root,label)),to=await point(child)
    const entry=await evaluate(`(()=>{const r=${child}.getBoundingClientRect();return{x:Math.max(r.left+8,Math.min(r.right-8,${from.x})),y:Math.max(r.top+8,Math.min(r.bottom-8,${from.y}))}})()`)
    const observed={label,from,entry,to};result.pointerTransfers??=[];result.pointerTransfers.push(observed)
    const move=async(a,b)=>{for(const fraction of [.2,.4,.6,.8,1])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction,buttons:0})}
    // Establish the actual pointer origin before leaving the trigger. Cross its
    // nearest child edge first, rather than sweeping diagonally over other rows.
    await move(from,from);await evaluate('new Promise(done=>setTimeout(done,200))')
    observed.originHit=await evaluate(`${item(root,label)}.contains(document.elementFromPoint(${from.x},${from.y}))`)
    assert.equal(observed.originHit,true,'Pointer begins at the actual parent disclosure: '+label)
    await move(from,entry);await move(entry,to);await evaluate('new Promise(done=>setTimeout(done,350))')
    observed.childHit=await evaluate(`${child}?.contains(document.elementFromPoint(${to.x},${to.y}))??false`)
    assert.equal(await evaluate(visible(child)),true,'The original submenu stays open when the pointer enters it: '+label)
    assert.equal(observed.childHit,true,'Pointer actually enters the original submenu: '+label)
    await move(to,entry);await move(entry,from);await evaluate('new Promise(done=>setTimeout(done,350))')
    assert.equal(await evaluate(visible(menu)),true,'Pointer return keeps the original root menu: '+label)
    assert.equal(await evaluate(`${item(root,label)}.contains(document.elementFromPoint(${from.x},${from.y}))`),true,'Pointer actually returns to the parent disclosure: '+label)
    // Pointer navigation has returned focus to the parent. Re-enter through the
    // real keyboard route before the caller tests ArrowLeft from the child.
    await key('ArrowRight','ArrowRight',39)
    assert.equal(await evaluate(`${child}.contains(document.activeElement)`),true,'Keyboard re-enters the same submenu after pointer return: '+label)
  }
  async function bounded(root) {
    const rect=await evaluate(`(()=>{const e=${root},r=e.getBoundingClientRect(),s=getComputedStyle(e),wrapper=e.closest('[data-radix-popper-content-wrapper]'),child=e.querySelector('[role="status"]');return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,menuWidth:r.width,menuHeight:r.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,style:{boxSizing:s.boxSizing,width:s.width,maxWidth:s.maxWidth,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight},popper:wrapper?.getBoundingClientRect().toJSON(),child:child?{scrollWidth:child.scrollWidth,clientWidth:child.clientWidth,text:child.textContent}:null}})()`)
    assert.ok(rect.left>=0&&rect.right<=rect.width&&rect.top>=0&&rect.bottom<=rect.height,'Menu stays inside the actual viewport: '+JSON.stringify(rect))
    assert.ok(rect.scrollWidth<=rect.clientWidth,'Menu content has no horizontal overflow')
  }
  async function rhythm() {
    const observed=await evaluate(`(()=>{
      const root=${menu},identity=root.querySelector('.agent-region-menu__identity'),summary=identity?.querySelector('.agent-region-menu__summary'),links=identity?.querySelector('[aria-label="Copy link"]')
      const rect=e=>e?.getBoundingClientRect().toJSON(),style=identity&&getComputedStyle(identity)
      const ordinary=root.querySelector('.tab-context-menu__item:not(.workbench-menu-row__item) > svg')
      return{identity:rect(identity),summary:rect(summary),links:rect(links),padding:style?parseFloat(style.paddingTop)+parseFloat(style.paddingBottom):0,
        ordinary:rect(ordinary),labels:[...root.querySelectorAll('.workbench-menu-row__label')].filter(e=>!identity?.contains(e)).map(rect),
        buttons:links?[...links.querySelectorAll('[role="menuitem"]')].map(rect):[],hiddenLabel:links?.querySelector('.workbench-menu-row__label')!==null}
    })()`)
    assert.ok(observed.identity&&observed.summary&&observed.links,'The actual Agent identity and sharing controls are nonempty')
    assert.ok(observed.identity.height<=Math.max(observed.summary.height,observed.links.height)+observed.padding+1,'Agent identity and copy actions share one compact header')
    assert.ok(observed.links.left>=observed.summary.right-1,'Copy actions remain beside the original identity')
    assert.equal(observed.hiddenLabel,false,'Header sharing keeps no separate caption row')
    assert.equal(observed.buttons.length,2,'The exact original Agent and Region sharing actions are both present')
    for(const button of observed.buttons)assert.ok(button.width>=28&&button.height>=28,'Sharing retains its original complete hitbox')
    assert.ok(observed.ordinary&&observed.labels.length>=2,'Ordinary items and original labelled tool rows are nonempty')
    for(const label of observed.labels)assert.ok(Math.abs(label.left-observed.ordinary.left)<1,'Tool labels align with the ordinary menu icon column')
    result.menuRhythms??=[];result.menuRhythms.push(observed)
  }
  for(const appearance of ['dark','light']) {
    for(const width of [640,320]) {
      await evaluate(`identityMenu.appearance(${JSON.stringify(appearance)})`)
      await seed(width)
      await evaluate("identityMenu.menuSource('confirmed')")
      const before=await measurement(true)
      await open('hover')
      assert.deepEqual(await measurement(true),before,'Disclosure preserves the real terminal instance, grid and geometry')
      const labels=await evaluate(`[...${menu}.querySelectorAll('[role="menuitem"]')].map(node=>(node.getAttribute('aria-label')??node.textContent).trim())`)
      assert.deepEqual(labels.slice(0,2),['Copy Agent Link','Copy Region Link'],'Sharing actions are first in the Agent menu')
      assert.ok(labels.includes('Connections')&&labels.includes('Maintenance'),'System extensions have named root disclosures')
      assert.ok(!labels.includes('Check native source')&&!labels.includes('Refresh observation'),'Low-frequency maintenance does not flatten into the root')
      assert.ok(labels.includes('Split Right')&&labels.includes('Split Down'),'Layout commands remain at the menu root')
      assert.ok(labels.includes('Copy Agent Link')&&labels.includes('Copy Region Link')&&labels.includes('Session details'),'Links and complete identity remain discoverable')
      const copyRow=`${menu}.querySelector('.workbench-menu-row[aria-label="Copy link"]')`
      assert.deepEqual(await evaluate(`[...${copyRow}.querySelectorAll('[role="menuitem"]')].map(node=>node.getAttribute('aria-label'))`),['Copy Agent Link','Copy Region Link'],'Copy links share one compact root row')
      assert.equal(await evaluate(`${item(menu,'Copy Region Link')}.closest('[role="menu"]')===${menu}`),true,'Copy has no nested disclosure')
      assert.equal(await evaluate(`${menu}.textContent.includes('Host ID:')`),false,'Raw diagnostics do not dominate the root menu')
      await bounded(menu);await rhythm();await frame(`${width}-${appearance}-menu`)
      const pointerCopy=item(menu,'Copy Agent Link')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...await point(pointerCopy),buttons:0})
      await waitFor(visible(`document.querySelector('.workbench-layout-menu__tooltip')`))
      assert.equal(await evaluate(`document.querySelector('.workbench-layout-menu__tooltip').textContent`),'Copy Agent Link','Header copy has a real complete pointer explanation')
      if(appearance==='dark'&&width===640)await frame('copy-agent-hint')
      await close(false);await open('keyboard')
      const agentLink=item(menu,'Copy Agent Link'),regionLink=item(menu,'Copy Region Link')
      await evaluate(`${agentLink}.focus()`)
      await waitFor(visible(`document.querySelector('.workbench-layout-menu__tooltip')`))
      assert.equal(await evaluate(`document.querySelector('.workbench-layout-menu__tooltip').textContent`),'Copy Agent Link','Header copy has a real complete keyboard explanation')
      await key('ArrowRight','ArrowRight',39)
      assert.equal(await evaluate(`document.activeElement===${regionLink}`),true,'Right moves to the next compact copy action')
      await waitFor(`document.querySelector('.workbench-layout-menu__tooltip')?.textContent==='Copy Region Link'`)
      if(appearance==='dark'&&width===320)await frame('copy-region-hint')
      await key('ArrowLeft','ArrowLeft',37)
      assert.equal(await evaluate(`document.activeElement===${agentLink}`),true,'Left returns to the original compact copy action')
      const maintenance=await submenu('Maintenance')
      const maintenanceLabels=await evaluate(`[...${maintenance}.querySelectorAll('[role="menuitem"]')].map(node=>(node.getAttribute('aria-label')??node.textContent).trim())`)
      assert.ok(maintenanceLabels.includes('Check native source')&&maintenanceLabels.includes('Refresh observation'),'Maintenance preserves source checking and observation refresh')
      await bounded(maintenance)
      if(appearance==='dark'&&width===320){await pointerTransfer(maintenance,'Maintenance');await frame('320-dark-maintenance')}
      await key('ArrowLeft','ArrowLeft',37);await waitFor(`!${maintenance}`)
      if(appearance==='dark'&&width===320){
        const connections=await submenu('Connections')
        const connectionLabels=await evaluate(`[...${connections}.querySelectorAll('[role="menuitem"]')].map(node=>(node.getAttribute('aria-label')??node.textContent).trim())`)
        assert.ok(connectionLabels.includes('Connect group…')&&connectionLabels.includes('Automatic sync settings'),'Connections preserves its original actions')
        const label=await evaluate(`${connections}.querySelector('[data-connector-menu-group]').getAttribute('aria-label')`)
        await pointerTransfer(connections,'Connections')
        await bounded(connections);await frame('320-dark-connections')
        const notice=await submenu(`${label} service notice`,'keyboard',connections)
        const text=await evaluate(`${notice}.querySelector('[role="status"]').textContent.trim()`)
        assert.ok(text.length>0,'The complete service notice remains keyboard-readable')
        assert.equal(await evaluate(`${menu}.textContent.includes(${JSON.stringify(text)})`),false,'The root keeps long service details behind their named notice')
        await frame('320-dark-service-notice');await bounded(notice)
        await key('ArrowLeft','ArrowLeft',37);await waitFor(`!${notice}`)
        await key('ArrowLeft','ArrowLeft',37);await waitFor(`!${connections}`)
      }
      const details=await submenu('Session details')
      assert.equal(await evaluate(`${details}.textContent.includes('Host ID:')&&${details}.textContent.includes('Directory:')`),true,'Full bound execution identity is readable on demand')
      assert.equal(await evaluate(`Boolean(${details}.querySelector('[data-native-source-check]'))`),false,'Source checking has moved out of details')
      assert.equal(await evaluate(`${details}.textContent.includes('Refresh observation')`),false,'Observation refresh has moved out of details')
      if(appearance==='dark'&&width===320)await pointerTransfer(details,'Session details')
      await bounded(details);await frame(`${width}-${appearance}-details`)
      await key('ArrowLeft','ArrowLeft',37);await waitFor(`!${details}`)
      await close()
      assert.equal(await evaluate(`document.activeElement===${more}`),true,'Keyboard returns to the original trigger')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...await point(`${surface}.querySelector('.agent-region-header__name')`),button:'right',clickCount:1})
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...await point(`${surface}.querySelector('.agent-region-header__name')`),button:'right',clickCount:1})
      await waitFor(visible(menu));await painted()
      assert.equal(await evaluate(`${menu}.dataset.menuEntry`),'context','Right-click uses the same Agent menu body')
      assert.deepEqual(await evaluate(`[...${menu}.querySelectorAll('[role="menuitem"]')].map(node=>(node.getAttribute('aria-label')??node.textContent).trim())`),labels,'Both invoking gestures expose the same actions')
      await bounded(menu);await frame(`${width}-${appearance}-context`)
      await key('Escape','Escape',27);await waitFor(`!${menu}`)
      assert.deepEqual(await measurement(true),before,'Menu dismissal preserves the original terminal')
      const terminalState=await evaluate('identityMenu.terminalContext()')
      assert.equal(terminalState.buffer,'alternate','The real xterm uses the full-screen buffer')
      assert.equal(terminalState.mouseTrackingMode,'any','The real xterm reports mouse tracking')
      await painted()
      const terminalBefore=await measurement(true),inputBefore=await evaluate('identityMenu.facts().menuInputs')
      const body=`${surface}.querySelector('.xterm-screen')`
      const bodyPoint=await evaluate(`(()=>{const e=${body},r=e.getBoundingClientRect(),x=r.left+Math.min(20,r.width/2),y=r.top+Math.min(8,r.height/2);return{x,y,hit:e.contains(document.elementFromPoint(x,y))}})()`)
      assert.equal(bodyPoint.hit,true,'The original terminal screen is actually hit')
      for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:bodyPoint.x,y:bodyPoint.y,button:'right',clickCount:1})
      await waitFor(visible(menu));await painted()
      // A program which requested mouse reporting may receive the original
      // physical right-button frames. Menu disclosure itself must add no input.
      const inputAtOpen=await evaluate('identityMenu.facts().menuInputs')
      assert.deepEqual(inputAtOpen.slice(0,inputBefore.length),inputBefore,'Opening the menu preserves prior input facts')
      assert.equal(await evaluate(`Boolean(${menu}.querySelector('[data-terminal-menu-tools]'))`),true,'Terminal body contributes its original Text and Output tools')
      for(const label of ['Copy','Paste','Select all','Find','Copy visible output','Copy all output','Scroll to bottom','Clear terminal','Copy Agent Link','Split Right'])
        assert.equal(await evaluate(`Boolean(${item(menu,label)})`),true,'Terminal context preserves the original action: '+label)
      assert.equal(await evaluate(`Boolean(${menu}.querySelector('[role="note"]'))`),false,'Long terminal explanations stay out of the root menu')
      await bounded(menu);await rhythm();await frame(`${width}-${appearance}-terminal-context`)
      if(appearance==='dark'&&width===320){
        const terminalInfo=await submenu('Terminal info')
        const explanations=await evaluate(`[...${terminalInfo}.querySelectorAll('[role="note"]')].map(node=>node.textContent)`)
        assert.equal(explanations.length,2,'Both original terminal explanations remain readable')
        assert.ok(explanations.some(text=>text.includes('drag'))&&explanations.some(text=>text.includes('no terminal scrollback')),'Mouse selection and full-screen history retain their complete reasons')
        await bounded(terminalInfo);await frame('320-dark-terminal-info')
        await key('ArrowLeft','ArrowLeft',37);await waitFor(`!${terminalInfo}`)
        assert.equal(await evaluate(`document.activeElement===${item(menu,'Terminal info')}`),true,'Terminal information returns to its original disclosure')
      }
      await key('Escape','Escape',27);await waitFor(`!${menu}`);await painted()
      assert.deepEqual(await measurement(true),terminalBefore,'Terminal context and information preserve the original instance, grid and geometry')
      assert.deepEqual(await evaluate('identityMenu.facts().menuInputs'),inputAtOpen,'Terminal menu disclosure and information never submit input')
      result.terminalContexts??=[];result.terminalContexts.push({width,appearance,terminalState,inputBefore,inputAtOpen,inputAfter:await evaluate('identityMenu.facts().menuInputs')})
    }
  }
  await seed(320)
  await evaluate("identityMenu.menuSource('changed')")
  await open('keyboard');await frame('source-changed-menu')
  const sourceDetails=await submenu('Session details')
  assert.equal(await evaluate(`${surface}.querySelector('[data-native-source-marker]').textContent`),'Source changed')
  assert.equal(await evaluate(`${sourceDetails}.textContent.includes('Authoritative current candidate differs')`),true)
  await click(item(sourceDetails,'Review source change…'));await painted();await frame('source-changed-review')
  assert.equal(await evaluate(`document.activeElement===${sourceDetails}`),true,'Review keeps focus in the original details menu')
  await key('ArrowDown','ArrowDown',40)
  assert.equal(await evaluate(`document.activeElement===${item(sourceDetails,'Confirm this native source')}`),true,'Keyboard can enter the new confirmation rows')
  await click(item(sourceDetails,'Cancel source change'))
  assert.equal(await evaluate(`document.activeElement===${sourceDetails}`),true,'Cancellation keeps focus in the original details menu')
  await key('ArrowLeft','ArrowLeft',37);await close()
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:641,height:420,deviceScaleFactor:1,mobile:false})
  await open('keyboard');await bounded(menu);await frame('short-menu')
  const details=await submenu('Session details');await bounded(details);await frame('short-details')
  await key('ArrowLeft','ArrowLeft',37);await close()
  for(const input of ['mouse','touch','keyboard']) await selection('Copy Region Link',320,input)
  await selection('Split',320)
  await selection('Move to New Tab',320)
  assert.equal(result.selections.length,5,'Real actions retain the original Region while its neighbor is active')
}
