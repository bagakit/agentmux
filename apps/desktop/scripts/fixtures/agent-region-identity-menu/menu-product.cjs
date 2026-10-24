const assert = require('node:assert/strict')

module.exports = async function agentMenuProof({win,evaluate,waitFor,visible,painted,click,key,point,seed,capture,result,surface,more,menu,open,close,measurement,selection}) {
  const item = (root, label) => `([...${root}.querySelectorAll('[role="menuitem"]')].find(node=>(node.getAttribute('aria-label')??node.textContent).trim()===${JSON.stringify(label)}))`
  async function submenu(label, input='keyboard') {
    const trigger=item(menu,label)
    if(input==='hover') await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...await point(trigger),buttons:0})
    else { await evaluate(`${trigger}.focus()`); await key('ArrowRight','ArrowRight',39) }
    const child=`document.getElementById(${trigger}.getAttribute('aria-controls'))`
    await waitFor(visible(child));await painted()
    return child
  }
  async function frame(name) {
    const png=await capture(name)
    result.frames.push({file:name+'.png',png})
  }
  async function bounded(root) {
    const rect=await evaluate(`(()=>{const e=${root},r=e.getBoundingClientRect(),s=getComputedStyle(e),wrapper=e.closest('[data-radix-popper-content-wrapper]'),child=e.querySelector('[role="status"]');return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,menuWidth:r.width,menuHeight:r.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,style:{boxSizing:s.boxSizing,width:s.width,maxWidth:s.maxWidth,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight},popper:wrapper?.getBoundingClientRect().toJSON(),child:child?{scrollWidth:child.scrollWidth,clientWidth:child.clientWidth,text:child.textContent}:null}})()`)
    assert.ok(rect.left>=0&&rect.right<=rect.width&&rect.top>=0&&rect.bottom<=rect.height,'Menu stays inside the actual viewport: '+JSON.stringify(rect))
    assert.ok(rect.scrollWidth<=rect.clientWidth,'Menu content has no horizontal overflow')
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
      assert.ok(labels.includes('Check native source')&&labels.includes('Refresh observation'),'Maintenance actions are directly reachable at root')
      assert.ok(labels.includes('Split Right')&&labels.includes('Split Down'),'Layout commands remain at the menu root')
      assert.ok(labels.includes('Copy Agent Link')&&labels.includes('Copy Region Link')&&labels.includes('Session details'),'Links and complete identity remain discoverable')
      const copyRow=`${menu}.querySelector('.workbench-menu-row[aria-label="Copy link"]')`
      assert.deepEqual(await evaluate(`[...${copyRow}.querySelectorAll('[role="menuitem"]')].map(node=>node.getAttribute('aria-label'))`),['Copy Agent Link','Copy Region Link'],'Copy links share one compact root row')
      assert.equal(await evaluate(`${item(menu,'Copy Region Link')}.closest('[role="menu"]')===${menu}`),true,'Copy has no nested disclosure')
      assert.equal(await evaluate(`${menu}.textContent.includes('Host ID:')`),false,'Raw diagnostics do not dominate the root menu')
      await bounded(menu);await frame(`${width}-${appearance}-menu`)
      await close(false);await open('keyboard')
      const agentLink=item(menu,'Copy Agent Link'),regionLink=item(menu,'Copy Region Link')
      await evaluate(`${agentLink}.focus()`);await key('ArrowRight','ArrowRight',39)
      assert.equal(await evaluate(`document.activeElement===${regionLink}`),true,'Right moves to the next compact copy action')
      await key('ArrowLeft','ArrowLeft',37)
      assert.equal(await evaluate(`document.activeElement===${agentLink}`),true,'Left returns to the original compact copy action')
      if(appearance==='dark'&&width===320){
        const label=await evaluate(`${menu}.querySelector('[data-connector-menu-group]').getAttribute('aria-label')`)
        const notice=await submenu(`${label} service notice`)
        const text=await evaluate(`${notice}.querySelector('[role="status"]').textContent.trim()`)
        assert.ok(text.length>0,'The complete service notice remains keyboard-readable')
        assert.equal(await evaluate(`${menu}.textContent.includes(${JSON.stringify(text)})`),false,'The root keeps long service details behind their named notice')
        await frame('320-dark-service-notice');await bounded(notice)
        await key('ArrowLeft','ArrowLeft',37);await waitFor(`!${notice}`)
      }
      const details=await submenu('Session details')
      assert.equal(await evaluate(`${details}.textContent.includes('Host ID:')&&${details}.textContent.includes('Directory:')`),true,'Full bound execution identity is readable on demand')
      assert.equal(await evaluate(`Boolean(${details}.querySelector('[data-native-source-check]'))`),false,'Source checking has moved out of details')
      assert.equal(await evaluate(`${details}.textContent.includes('Refresh observation')`),false,'Observation refresh has moved out of details')
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
