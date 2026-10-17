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
    const rect=await evaluate(`(()=>{const e=${root},r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}})()`)
    assert.ok(rect.left>=0&&rect.right<=rect.width&&rect.top>=0&&rect.bottom<=rect.height,'Menu stays inside the actual viewport')
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
      assert.ok(labels.includes('Split and layout'),'Layout commands stay behind their named submenu')
      assert.ok(labels.includes('Copy link')&&labels.includes('Session details'),'Links and complete identity remain discoverable')
      assert.ok(!labels.some(label=>label.startsWith('Split ' )&&label!=='Split and layout'),'Root does not expose anonymous layout commands')
      assert.equal(await evaluate(`${menu}.textContent.includes('Host ID:')`),false,'Raw diagnostics do not dominate the root menu')
      await bounded(menu);await frame(`${width}-${appearance}-menu`)
      const layout=await submenu('Split and layout','hover')
      await bounded(layout);await frame(`${width}-${appearance}-layout`)
      // Enter the child through the real mouse path; hover disclosure retains the editor's focus.
      const split=item(layout,'Split Right')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...await point(split),buttons:0})
      assert.equal(await evaluate(visible(layout)),true,'Pointer can cross from trigger to the actual layout controls')
      await close(false);await open('keyboard');await submenu('Split and layout')
      await evaluate(`${split}.focus()`);await key('ArrowLeft','ArrowLeft',37)
      // The leftmost action returns to its parent along the original Radix boundary.
      await evaluate(`${item(layout,'Split Left')}.focus()`);await key('ArrowLeft','ArrowLeft',37)
      await waitFor(`!${layout}`)
      const details=await submenu('Session details')
      assert.equal(await evaluate(`${details}.textContent.includes('Host ID:')&&${details}.textContent.includes('Directory:')`),true,'Full bound execution identity is readable on demand')
      await bounded(details);await frame(`${width}-${appearance}-details`)
      await key('ArrowLeft','ArrowLeft',37);await waitFor(`!${details}`)
      const links=await submenu('Copy link')
      assert.deepEqual(await evaluate(`[...${links}.querySelectorAll('[role="menuitem"]')].map(node=>node.textContent.trim())`),['Copy Agent Link','Copy Region Link'])
      await bounded(links)
      await key('ArrowLeft','ArrowLeft',37);await waitFor(`!${links}`)
      await close()
      assert.equal(await evaluate(`document.activeElement===${more}`),true,'Keyboard returns to the original trigger')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...await point(`${surface}.querySelector('.agent-region-header__name')`),button:'right',clickCount:1})
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...await point(`${surface}.querySelector('.agent-region-header__name')`),button:'right',clickCount:1})
      await waitFor(visible(menu));await painted()
      assert.equal(await evaluate(`${menu}.dataset.menuEntry`),'context','Right-click uses the same Agent menu body')
      assert.deepEqual(await evaluate(`[...${menu}.querySelectorAll('[role="menuitem"]')].map(node=>(node.getAttribute('aria-label')??node.textContent).trim())`),labels,'Both invoking gestures expose the same actions')
      await bounded(menu);await frame(`${width}-${appearance}-context`)
      await key('Escape','Escape',27);await waitFor(`!${menu}`)
      assert.deepEqual(await measurement(true),before,'Submenu dismissal preserves the original terminal')
    }
  }
  await seed(320)
  await evaluate("identityMenu.menuSource('changed')")
  await open('keyboard');await frame('source-changed-menu')
  const sourceDetails=await submenu('Session details')
  assert.equal(await evaluate(`${surface}.querySelector('[data-native-source-marker]').textContent`),'Source changed')
  assert.equal(await evaluate(`${sourceDetails}.textContent.includes('Authoritative current candidate differs')`),true)
  await click(item(sourceDetails,'Review source change…'));await painted();await frame('source-changed-review')
  await click(item(sourceDetails,'Cancel source change'));await key('ArrowLeft','ArrowLeft',37);await close()
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:641,height:420,deviceScaleFactor:1,mobile:false})
  await open('keyboard');await bounded(menu);await frame('short-menu')
  const details=await submenu('Session details');await bounded(details);await frame('short-details')
  await key('ArrowLeft','ArrowLeft',37);await close()
  for(const input of ['mouse','touch','keyboard']) await selection('Copy Region Link',320,input)
  await selection('Split',320)
  await selection('Move to New Tab',320)
  assert.equal(result.selections.length,5,'Real actions retain the original Region while its neighbor is active')
}
