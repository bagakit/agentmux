const assert = require('node:assert/strict')

// Full production Workbench/Launcher, with explicit controlled external API DTOs.
// This scene never registers a project or creates an Agent.
module.exports = async ({ evaluate, wait, paint, viewport, click, escape, frame, wheelAt, receipt, debugger: cdp }) => {
  const region = '#fixture-workbench [data-workbench-region-id="launchpad-input"]'
  const surface = region + ' .launch-surface'
  const facts = () => evaluate(`({draft:launchpad.facts().agentDrafts['launchpad-input'],calls:launchpad.facts().calls})`)
  const scene = async ({ width = 1180, height = 850, theme = 'dark', split = false, failure = false, long = true } = {}) => {
    await escape(); await viewport(width, height)
    await evaluate(`launchpad.scene({split:${split},ratio:.38,theme:${JSON.stringify(theme)}});spaceLauncher.theme(${JSON.stringify(theme)});spaceLauncher.sourceArrangement(${long},true,${failure})`)
    await wait(`document.querySelector(${JSON.stringify(region + ' [data-executor-id="configured-agent"][aria-pressed="true"]')}) !== null`)
    await evaluate(`document.querySelector(${JSON.stringify(surface)}).scrollTop=0`); await paint()
  }
  const insideRegion = async selector => {
    const bounds = await evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(selector)}),r=p.getBoundingClientRect(),b=document.querySelector(${JSON.stringify(region)}).getBoundingClientRect();return{panel:r.toJSON(),region:b.toJSON(),scrollWidth:p.scrollWidth,clientWidth:p.clientWidth,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight}})()`)
    assert.ok(bounds.panel.left >= bounds.region.left + 10 && bounds.panel.right <= bounds.region.right - 10, 'Overlay stays in its original Region')
    assert.ok(bounds.panel.top >= Math.max(0,bounds.region.top) + 10 && bounds.panel.bottom <= Math.min(await evaluate('innerHeight'),bounds.region.bottom) - 10, 'Overlay height stays in its original Region')
    assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, 'Long fields wrap without horizontal scrolling')
    return bounds
  }
  for (const [name, width, height, theme, split] of [
    ['workflow-wide-dark',1180,850,'dark',false], ['workflow-wide-light',1180,850,'light',false],
    ['workflow-split-dark',1000,760,'dark',true], ['workflow-narrow-dark',460,760,'dark',false], ['workflow-narrow-light',460,760,'light',false],
    ['workflow-short-dark',460,430,'dark',false],
  ]) {
    await scene({width,height,theme,split})
    const geometry = await evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(surface)}),f=s.querySelector('.launch-surface__footer'),m=f.querySelector('.launcher-mote__actions'),n=m.querySelector('.launcher-mote__name'),a=f.querySelector('.launcher-primary-actions'),c=s.querySelector('.launcher-compatibility');return{width:s.clientWidth,scrollWidth:s.scrollWidth,path:s.querySelector('.launcher-environment__path').getBoundingClientRect().toJSON(),device:s.querySelector('.launcher-work-arrangement__trigger').getBoundingClientRect().toJSON(),footer:f.getBoundingClientRect().toJSON(),mote:m.getBoundingClientRect().toJSON(),primary:a.getBoundingClientRect().toJSON(),nameVisible:getComputedStyle(n).display!=='none',nameClientWidth:n.clientWidth,nameScrollWidth:n.scrollWidth,buttonHeight:a.querySelector('.launcher-launch-button').getBoundingClientRect().height,compatibilityAfterActions:Boolean(f.compareDocumentPosition(c)&Node.DOCUMENT_POSITION_FOLLOWING)}})()`)
    receipt.checks.push({name:name+'-header-preflight',path:geometry.path,device:geometry.device})
    assert.ok(geometry.scrollWidth <= geometry.width + 1, 'Complete Launcher has no horizontal overflow')
    assert.ok(geometry.path.right <= geometry.device.left || geometry.path.bottom <= geometry.device.top || geometry.path.top >= geometry.device.bottom, 'Project path and selected Agent device never overlap')
    assert.ok(geometry.mote.right <= geometry.primary.left || geometry.mote.bottom <= geometry.primary.top, 'Parallel action groups do not overlap')
    assert.ok(geometry.mote.right <= geometry.footer.right + 1 && geometry.primary.right <= geometry.footer.right + 1 && geometry.primary.left >= geometry.footer.left - 1, 'Complete action groups stay inside the footer')
    assert.equal(geometry.nameVisible,true,'The selected Mote target remains visible in short Regions')
    assert.ok(geometry.nameScrollWidth <= geometry.nameClientWidth, 'The selected short Mote name remains completely readable')
    assert.ok(geometry.buttonHeight >= 35,'Launch retains its ordinary hit target')
    assert.equal(geometry.compatibilityAfterActions,true,'Routine compatibility reading follows the task and actions')
    receipt.checks.push({name,geometry,facts:await facts()}); await frame(name)
    if (name === 'workflow-short-dark') {
      await wheelAt(surface,1000)
      const scroll = await evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(surface)}),b=s.querySelector('.launcher-launch-button').getBoundingClientRect(),r=s.getBoundingClientRect();return{scrollTop:s.scrollTop,buttonVisible:b.top>=r.top&&b.bottom<=r.bottom}})()`)
      assert.ok(scroll.scrollTop > 0 && scroll.buttonVisible, 'Native wheel reaches the complete launch actions in a short Region')
      receipt.checks.push({name:'short-native-scroll',scroll}); await frame('workflow-short-actions')
    }
  }
  await scene({width:1000,height:760,split:true})
  const original = await facts()
  await evaluate(`(()=>{window.launcherPointerTrace=[];for(const type of ['pointerdown','pointerup','click','focusin'])document.addEventListener(type,event=>{if(event.target.closest?.('[aria-label="Agent location"],.launcher-work-arrangement__dialog'))window.launcherPointerTrace.push({type,target:event.target.tagName,dialog:Boolean(document.querySelector('.launcher-work-arrangement__dialog')),expanded:document.querySelector('[aria-label="Agent location"]')?.getAttribute('aria-expanded')})},true)})()`)
  await evaluate(`document.querySelector(${JSON.stringify(region + ' [aria-label="Agent location"]')}).scrollIntoView({block:'nearest'})`); await paint()
  const pressPoint = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(region + ' [aria-label="Agent location"]')}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  await cdp.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...pressPoint,button:'left',clickCount:1})
  await paint()
  assert.equal(await evaluate('Boolean(document.querySelector("[role=tooltip] .agent-work-detail"))'),false,'A pointer press does not disclose a keyboard tooltip')
  await cdp.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...pressPoint,button:'left',clickCount:1}); await paint()
  receipt.checks.push({name:'location-pointer-sequence',events:await evaluate('window.launcherPointerTrace')})
  assert.deepEqual((await evaluate('window.launcherPointerTrace')).filter(event => event.type !== 'focusin').map(event => event.type),['pointerdown','pointerup','click'],'The original native pointer press reaches release and click')
  await wait('Boolean(document.querySelector(".launcher-work-arrangement__dialog"))')
  await wait('document.querySelector(".launcher-work-arrangement__dialog").style.visibility === "visible"')
  const locationBounds = await insideRegion('.launcher-work-arrangement__dialog')
  await frame('workflow-location-split')
  await escape(); await scene({long:false})
  await click(region + ' [aria-label="Agent location"]'); await wait('document.querySelector(".launcher-work-arrangement__dialog")?.style.visibility === "visible"')
  await click('.launcher-work-arrangement__dialog [aria-label="Agent runs on"]')
  await wait('Boolean(document.querySelector(".selection-field__menu"))')
  assert.doesNotMatch(await evaluate('document.querySelector(".selection-field__menu").textContent'),/Reading this project device/,'The confirmed project device is not presented as still reading')
  await frame('workflow-device-choices')
  await escape(); await escape()
  assert.deepEqual(await facts(),original,'Opening and cancelling location preserves the exact task and performs no launch')
  receipt.checks.push({name:'location-region-and-cancel',bounds:locationBounds})
  await scene({width:1000,height:760,split:true})
  const tab = async backwards => {
    for (const type of ['keyDown','keyUp']) await cdp.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:backwards?8:0})
    await paint()
  }
  await evaluate(`document.querySelector(${JSON.stringify(region + ' [aria-label="Agent location"]')}).focus()`)
  await tab(true)
  await wait('document.activeElement?.classList.contains("launcher-environment__device") && Boolean(document.querySelector("[role=tooltip]"))')
  await frame('workflow-keyboard-project-details'); await escape()
  await tab(false)
  await wait('document.activeElement?.getAttribute("aria-label") === "Agent location" && Boolean(document.querySelector("[role=tooltip] .agent-work-detail"))')
  await frame('workflow-keyboard-agent-details')
  await click(region + ' [aria-label="Agent location"]')
  await wait('Boolean(document.querySelector(".launcher-work-arrangement__dialog"))'); await escape()
  receipt.checks.push({name:'keyboard-details-and-open-tooltip-pointer',facts:await facts()})
  await click(region + ' [aria-label="Launch options"]'); await wait('document.querySelector(".launch-refine__panel")?.style.visibility === "visible"')
  const optionsBounds = await insideRegion('.launch-refine__panel')
  assert.match(await evaluate('document.querySelector(".launch-refine__panel").textContent'),/original-saved-value/)
  await frame('workflow-options-split')
  await click('.launch-refine__panel [aria-label="Reasoning effort"]'); await wait('Boolean(document.querySelector(".selection-field__menu"))')
  await frame('workflow-option-choices'); await escape()
  assert.equal(await evaluate('Boolean(document.querySelector(".launch-refine__panel"))'),true,'Escape from a choice returns to its launch Options')
  await escape()
  assert.deepEqual(await facts(),original,'Reading options preserves the exact unsent task and has no launch effects')
  receipt.checks.push({name:'options-region-and-read',bounds:optionsBounds})
  await scene({width:460,height:430})
  await click(region + ' [aria-label="Agent location"]'); await wait('document.querySelector(".launcher-work-arrangement__dialog")?.style.visibility === "visible"')
  await wheelAt('.launcher-work-arrangement__dialog',1000)
  const dialogScroll = await evaluate(`(()=>{const p=document.querySelector('.launcher-work-arrangement__dialog'),b=p.querySelector('footer').getBoundingClientRect(),r=p.getBoundingClientRect();return{scrollTop:p.scrollTop,actionsVisible:b.top>=r.top&&b.bottom<=r.bottom}})()`)
  assert.ok(dialogScroll.actionsVisible,'Location Apply and Cancel remain reachable through native scrolling')
  receipt.checks.push({name:'short-location-native-scroll',dialogScroll}); await frame('workflow-short-location-actions'); await escape()
  await scene({width:460,height:760,theme:'light',failure:true})
  await wait(`document.querySelector(${JSON.stringify(region + ' .launcher-source-contract')})?.textContent.includes('could not confirm')`)
  await frame('workflow-observation-failed')
  assert.match((await facts()).draft,/keep this unsent task/)
  await cdp.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await click(region + ' [aria-label="Launch options"]'); await wait('document.querySelector(".launch-refine__panel")?.style.visibility === "visible"')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".launch-refine__panel")).animationDuration'),'0s','Reduced motion keeps usable controls without entrance motion')
  await escape()
  receipt.checks.push({name:'reduced-motion-and-failed-observer',facts:await facts()})
}
