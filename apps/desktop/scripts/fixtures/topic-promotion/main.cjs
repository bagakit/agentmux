const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, temporary, evidence, scenario] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user-data')); app.setPath('sessionData', path.join(temporary, 'session-data'))
const report = { passed: false, pid: process.pid, frames: [], console: [], assertions: [] }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1200, height: 760, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) report.console.push(String(message).slice(0, 1200)) })
  const read = code => win.webContents.executeJavaScript(code)
  const until = async (label, code) => { const deadline = Date.now() + 12000; do { if (await read(code)) return; await new Promise(done => setTimeout(done, 40)) } while (Date.now() < deadline); throw Error('Scene not ready: ' + label) }
  const paint = () => read('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  const click = async selector => {
    const point = await read(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node)throw Error('Missing actual control: ' + ${JSON.stringify(selector)}); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
    assert.ok(point.x > 0 && point.y > 0)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mousePressed', ...point, button:'left', clickCount:1 })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseReleased', ...point, button:'left', clickCount:1 })
    await paint()
  }
  const clickText = async (selector, text) => {
    await read(`(() => {document.querySelectorAll('[data-promotion-click]').forEach(node=>node.removeAttribute('data-promotion-click')); const node=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.textContent.trim()===${JSON.stringify(text)} || node.getAttribute('aria-label')===${JSON.stringify(text)}); if(!node)throw Error('Missing actual text action: ' + ${JSON.stringify(text)}); node.setAttribute('data-promotion-click','')})()`)
    await click('[data-promotion-click]')
  }
  const capture = async (file, label) => {
    await paint(); await new Promise(done => setTimeout(done, 200))
    const geometry = await read(`(() => {const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return{width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,dialog:rect(document.querySelector('.topic-promotion-dialog')),notice:rect(document.querySelector('.topic-promotion-notice')),buttons:[...document.querySelectorAll('.topic-promotion-dialog button')].map(node=>({text:node.textContent,disabled:node.disabled,...rect(node)}))}})()`)
    assert.ok(geometry.documentWidth <= geometry.width + 1, 'No horizontal document overflow')
    if (geometry.dialog) { assert.ok(geometry.dialog.x >= -1 && geometry.dialog.right <= geometry.width + 1, 'Dialog fits the viewport width'); assert.ok(geometry.dialog.y >= -1 && geometry.dialog.bottom <= geometry.height + 1, 'Dialog fits the viewport height') }
    await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
    report.frames.push({ file, label, geometry })
  }
  const stable = async label => { const facts=await read('topicPromotionProbe.facts()'); for(const key of ['tabs','layouts','drafts','selection']) assert.deepEqual(facts[key], report.before[key], label + ' preserves original ' + key); return facts }
  const openPromotion = async title => {
    await click('[aria-label=' + JSON.stringify('Actions for ' + title) + ']')
    await until('Topic action menu', '[...document.querySelectorAll("[role=menuitem]")].some(node=>node.textContent.trim()==="晋升为 Mote")')
    await clickText('[role=menuitem]', '晋升为 Mote')
    await until('promotion dialog', 'document.querySelector(".topic-promotion-dialog")!==null')
    await until('promotion inspection', '![...document.querySelectorAll(".topic-promotion-dialog button")].some(node=>node.textContent.includes("读取")||node.textContent.includes("查看中"))')
  }
  const motionSample = () => read('(' + (() => {
    const energy = document.querySelector('.topic-promotion__energy')
    return { at: performance.now(), phase: document.querySelector('.topic-promotion-dialog')?.dataset.phase,
      energyDisplay: energy ? getComputedStyle(energy).display : null,
      effects: [...document.querySelectorAll('.topic-promotion__halo,.topic-promotion__particle')].map(node => {
        const s=getComputedStyle(node),r=node.getBoundingClientRect()
        return {className:node.className,transform:s.transform,opacity:s.opacity,display:s.display,x:r.x,y:r.y,width:r.width,height:r.height}
      }), activeAnimations: document.querySelector('.topic-promotion-dialog')?.getAnimations({subtree:true}).filter(item=>item.playState==='running').length ?? 0 }
  }).toString() + ')()')
  const noticeFact = topicId => read('(' + (topicId => {
    const notices=[...document.querySelectorAll('.topic-promotion-notice')]
    const notice=notices.find(node=>node.dataset.topicId===topicId),previous=notice?.previousElementSibling
    return {count:notices.length,topicId:notice?.dataset.topicId??null,categorySpaceId:notice?.dataset.categorySpaceId??null,
      listCategorySpaceId:notice?.closest('.workspace-topic-list')?.dataset.categorySpaceId??null,
      previousTopicId:previous?.querySelector('.workspace-topic-entry')?.dataset.topicId??null,
      adjacentItem:previous?.classList.contains('workspace-topic-item')??false,text:notice?.textContent??null}
  }).toString() + ')('+JSON.stringify(topicId)+')')
  const checkNotice = async topicId => {
    const notice = await noticeFact(topicId), category = await read('topicPromotionProbe.category')
    assert.equal(notice.count,1,'Completion is local to one exact Topic')
    assert.equal(notice.topicId,topicId); assert.equal(notice.previousTopicId,topicId)
    assert.equal(notice.adjacentItem,true,'Completion feedback is immediately beside its original Topic item')
    assert.equal(notice.categorySpaceId,category.spaceId); assert.equal(notice.listCategorySpaceId,category.spaceId)
    assert.match(notice.text,/已晋升为 Mote/)
    return notice
  }
  const unchanged = (before, after, label) => {
    for(const key of ['tabs','layouts','drafts','selection','notifications']) assert.deepEqual(after[key],before[key],label+' preserves '+key)
  }
  const motionScenario = async () => {
    await read('topicPromotionProbe.next("complete");topicPromotionProbe.hold()')
    await openPromotion('示例项目 数据运维')
    await clickText('.topic-promotion-dialog button','晋升为 Mote')
    await until('actual held write','document.querySelector(".topic-promotion-dialog")?.dataset.phase==="writing"')
    assert.equal((await noticeFact('view:quality-0')).count,0,'No success before the completion receipt')
    // Observe a real continuing wait after the one-time image transition has settled.
    // These fixture observation waits never delay product completion.
    await new Promise(done=>setTimeout(done,1100))
    report.motionTimeline=[]
    for(const theme of ['dark','light']) {
      await read('topicPromotionProbe.theme('+JSON.stringify(theme)+')')
      const samples=[]
      for(let i=0;i<3;i++) {
        samples.push(await motionSample())
        await capture('promotion-motion-'+theme+'-'+i+'.png',theme+'：持续等待的第 '+(i+1)+' 帧，原 Agent 与人格图像保留')
        if(i<2)await new Promise(done=>setTimeout(done,350))
      }
      assert.ok(samples.every(sample=>sample.phase==='writing'&&sample.energyDisplay!=='none'&&sample.effects.length>=7),'Production waiting effect remains visible')
      const changed=samples.slice(1).some(sample=>sample.effects.some((effect,index)=> {
        const earlier=samples[0].effects[index]
        return effect.transform!==earlier.transform||effect.opacity!==earlier.opacity||effect.x!==earlier.x||effect.y!==earlier.y
      }))
      report.motionTimeline.push({theme,samples})
      assert.equal(changed,true,'Waiting motion changes visible geometry or opacity after the initial transition')
    }
    unchanged(report.before,await read('topicPromotionProbe.facts()'),'Held operation')
    await click('.topic-promotion__cancel')
    await until('dismissed held view','!document.querySelector(".topic-promotion-dialog")')
    const other=await read('topicPromotionProbe.otherCategory'),category=await read('topicPromotionProbe.category')
    await click('[data-space-nav="topic-category:'+other.categoryId+'"]')
    await until('another original category selected','topicPromotionProbe.facts().selection?.spaceId===topicPromotionProbe.otherCategory.spaceId')
    const later=await read('topicPromotionProbe.facts()')
    await read('topicPromotionProbe.release()')
    await until('original write completed','topicPromotionProbe.facts().operations.some(item=>item.topicId==="view:quality-0"&&item.state==="complete")')
    await paint()
    unchanged(later,await read('topicPromotionProbe.facts()'),'Late original completion')
    assert.equal((await noticeFact('view:quality-0')).count,0,'Original-group completion is not broadcast into the later group')
    assert.equal(await read('document.querySelector(".topic-promotion__energy")===null && document.querySelector(".topic-promotion__activity")===null'),true,'Writing visuals end when the view closes')
    await capture('promotion-complete-other-group-light.png','在另一个组完成：保留后来选择，不把原组提示广播到这里')
    await click('[data-space-nav="topic-category:'+category.categoryId+'"]')
    await until('original category restored','topicPromotionProbe.facts().selection?.spaceId===topicPromotionProbe.category.spaceId && document.querySelectorAll(".workspace-topic-entry").length===3')
    report.originalGroupNotice=await checkNotice('view:quality-0')
    await capture('promotion-complete-original-group-light.png','返回原 Topic 组：提示紧邻准确的晋升条目')
    await read('topicPromotionProbe.theme("dark")')
    await capture('promotion-complete-original-group-dark.png','深色：同一条目旁的完成反馈')
    const beforeDismiss=await read('topicPromotionProbe.facts()')
    await click('[aria-label="关闭晋升提示"]')
    await paint()
    unchanged(beforeDismiss,await read('topicPromotionProbe.facts()'),'Dismissing completion')
    assert.equal((await noticeFact('view:quality-0')).count,0)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await read('topicPromotionProbe.theme("light");topicPromotionProbe.narrow();topicPromotionProbe.hold()')
    win.setContentSize(560,760)
    const beforeReduced=await read('topicPromotionProbe.facts()')
    await openPromotion('产品发现与用户访谈：记录新方向里的每一次进展与重要决定')
    await clickText('.topic-promotion-dialog button','晋升为 Mote')
    await until('reduced-motion held write','document.querySelector(".topic-promotion-dialog")?.dataset.phase==="writing"')
    await paint()
    const reducedBefore=await motionSample()
    await capture('promotion-motion-reduced-narrow-light.png','减少动态效果：长名字与静态等待说明在窄窗口保持清楚')
    await new Promise(done=>setTimeout(done,350))
    const reducedAfter=await motionSample()
    assert.equal(reducedBefore.energyDisplay,'none');assert.equal(reducedAfter.energyDisplay,'none')
    assert.equal(reducedBefore.activeAnimations,0);assert.equal(reducedAfter.activeAnimations,0)
    assert.deepEqual(reducedAfter.effects,reducedBefore.effects,'Reduced-motion waiting remains static')
    report.reducedMotion={before:reducedBefore,after:reducedAfter}
    assert.equal((await noticeFact('view:quality-1')).count,0)
    await read('topicPromotionProbe.release()')
    await paint()
    assert.equal(await read('document.querySelector(".topic-promotion-dialog")===null'),true,'Completion does not wait for an animation timer')
    report.reducedNotice=await checkNotice('view:quality-1')
    unchanged(beforeReduced,await read('topicPromotionProbe.facts()'),'Reduced-motion completion')
    await capture('promotion-complete-reduced-narrow-light.png','减少动态效果：准确完成后立即回原组，同条目提示')
    await click('[aria-label="关闭晋升提示"]')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]})
    win.setContentSize(1200,760)
    await read('topicPromotionProbe.theme("dark")')
    const beforeFast=await read('topicPromotionProbe.facts()')
    await openPromotion('每周项目复盘')
    await read('topicPromotionProbe.holdRefresh()')
    await clickText('.topic-promotion-dialog button','晋升为 Mote')
    // No held response: the click helper gives exactly two native paint frames.
    assert.equal(await read('document.querySelector(".topic-promotion-dialog")===null'),true,'Immediate completion is not delayed to play waiting motion')
    assert.ok((await read('topicPromotionProbe.facts()')).refreshWaits>0,'Original projection refresh is actually held after the completion receipt')
    report.fastNotice=await checkNotice('view:quality-2')
    unchanged(beforeFast,await read('topicPromotionProbe.facts()'),'Immediate completion')
    await capture('promotion-complete-fast-dark.png','即时完成：不为播放动效延迟，原条目仍有局部落定反馈')
    await read('topicPromotionProbe.releaseRefresh()')
    report.after=await read('topicPromotionProbe.facts()')
    assert.deepEqual(report.after.controls,[])
    report.assertions.push('Continuing wait changes actual effect geometry/opacity; reduced motion stays static',
      'Completion stays beside exact original Topic in its source category; later selection and notifications remain untouched',
      'Fast responses complete on normal rendering without a presentation delay, even while the later projection refresh is held')
  }
  await win.loadFile(html); win.webContents.debugger.attach('1.3')
  await until('original App Topics directory', 'window.topicPromotionProbe?.ready && document.querySelectorAll(".workspace-topic-entry").length===3')
  await until('original workface', 'document.querySelector(".editor-pane")?.textContent.includes("每天从具体的问题开始")')
  report.before = await read('topicPromotionProbe.facts()')
  if(scenario==='motion') { await motionScenario();report.passed=true;return }
  await click('[aria-label="Actions for 示例项目 数据运维"]')
  await until('original Topic actions menu opened', 'document.querySelectorAll("[role=menuitem]").length>0')
  assert.equal(await read('[...document.querySelectorAll("[role=menuitem]")].some(node=>node.textContent.trim()==="晋升为 Mote")'),true,'Production Topic menu exposes the promotion action')
  await capture('promotion-menu-dark.png', 'Topic 的原菜单中提供晋升动作')
  await clickText('[role=menuitem]', '晋升为 Mote')
  await until('light confirmation', 'document.querySelector(".topic-promotion-dialog")!==null && [...document.querySelectorAll(".topic-promotion-dialog button")].some(node=>node.textContent.trim()==="晋升为 Mote"&&!node.disabled)')
  assert.equal(await read('document.querySelectorAll(".topic-promotion-dialog input,.topic-promotion-dialog select,.topic-promotion-dialog textarea").length'), 0, 'No team, role or identity configuration form')
  await capture('promotion-confirm-dark.png', '深色：保留原名字，一句连续性说明与单一晋升动作')
  await read('topicPromotionProbe.theme("light")')
  await capture('promotion-confirm-light.png', '浅色：同一确认与原工作面')
  await read('topicPromotionProbe.narrow()'); win.setContentSize(560,760)
  await capture('promotion-confirm-narrow-light.png', '窄窗口：确认、插图与按钮保持可读')
  await click('.topic-promotion__cancel')
  await until('cancel returns to work', '!document.querySelector(".topic-promotion-dialog")')
  const cancelled=await stable('Cancellation'); assert.equal(cancelled.calls.filter(call=>call.method==='topic.promote.apply').length,0)
  report.assertions.push('Cancellation writes nothing and retains original work/draft')
  win.setContentSize(1200,760); await read('topicPromotionProbe.theme("dark")')
  await openPromotion('示例项目 数据运维')
  await clickText('.topic-promotion-dialog button', '晋升为 Mote')
  await until('partial original operation', '[...document.querySelectorAll(".topic-promotion-dialog button")].some(node=>node.textContent.trim()==="继续晋升")')
  await capture('promotion-partial-dark.png', '部分完成：保留同一操作，原工作可用，局部继续入口')
  await stable('Partial result')
  await click('.topic-promotion__cancel')
  await until('partial dialog closed', '!document.querySelector(".topic-promotion-dialog")')
  await click('.workspace-topic-entry[data-topic-id="view:quality-0"]')
  await until('original Topic remains accessible after partial', 'topicPromotionProbe.facts().selection?.topicId==="view:quality-0"')
  await openPromotion('示例项目 数据运维')
  await until('same partial operation rediscovered', '[...document.querySelectorAll(".topic-promotion-dialog button")].some(node=>node.textContent.trim()==="继续晋升")')
  await read('topicPromotionProbe.hold()')
  await clickText('.topic-promotion-dialog button', '继续晋升')
  await until('original operation is writing', 'document.querySelector(".topic-promotion-dialog")?.dataset.phase==="writing"')
  await capture('promotion-writing-dark.png', '提交中：同一批 Agent 和资料延续为长期伙伴')
  await read('topicPromotionProbe.release()')
  await until('confirmed completion', '!document.querySelector(".topic-promotion-dialog") && document.querySelector(".topic-promotion-notice")?.textContent.includes("已晋升为 Mote")')
  await capture('promotion-complete-dark.png', '确认完成：回到原工作面，原分类保留同对象入口')
  const completed=await stable('Promotion completion'), applies=completed.calls.filter(call=>call.method==='topic.promote.apply')
  assert.equal(applies.length,2); assert.equal(applies[0].params.operationId,applies[1].params.operationId,'Continue retains the original operation')
  assert.equal(completed.topicCount,3,'Original classified entry remains visible')
  assert.equal(completed.operations[0].state,'complete'); assert.deepEqual(completed.controls,[])
  report.assertions.push('Partial result continues with one original operation and preserves original classified entry/work/draft')
  await read('topicPromotionProbe.theme("light")')
  await capture('promotion-complete-light.png', '浅色：完成反馈克制，不要求进入新的管理页')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] })
  win.setContentSize(560,760); await read('topicPromotionProbe.theme("dark")')
  await openPromotion('产品发现与用户访谈：记录新方向里的每一次进展与重要决定')
  await capture('promotion-reduced-motion-narrow-dark.png', '窄深色：减少动态效果时仍有完整确认和反馈')
  assert.equal(await read('matchMedia("(prefers-reduced-motion: reduce)").matches'),true)
  report.motion = await read('[...document.querySelectorAll(".topic-promotion-dialog *")].filter(node=>{const s=getComputedStyle(node);return s.animationName!=="none"&&s.animationDuration!=="0s"}).map(node=>({className:node.className,animation:getComputedStyle(node).animationName,duration:getComputedStyle(node).animationDuration}))')
  await click('.topic-promotion__cancel')
  report.after=await stable('Final cancellation'); assert.deepEqual(report.after.controls,[])
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'no-preference'}] })
  win.setContentSize(1200,760)
  await openPromotion('每周项目复盘')
  await read('topicPromotionProbe.hold()')
  await clickText('.topic-promotion-dialog button', '晋升为 Mote')
  await until('async write', 'document.querySelector(".topic-promotion-dialog")?.dataset.phase==="writing"')
  await click('.topic-promotion__cancel')
  await until('closed in-flight dialog', '!document.querySelector(".topic-promotion-dialog")')
  await click('.workspace-topic-entry[data-topic-id="view:quality-1"]')
  await until('later Topic selection', 'topicPromotionProbe.facts().selection?.topicId==="view:quality-1"')
  const later = await read('topicPromotionProbe.facts()')
  await read('topicPromotionProbe.release()')
  await until('closed operation completes', 'topicPromotionProbe.facts().operations.some(item=>item.topicId==="view:quality-2"&&item.state==="complete")')
  await paint()
  const afterLate = await read('topicPromotionProbe.facts()')
  for(const key of ['selection','tabs','layouts','drafts']) assert.deepEqual(afterLate[key],later[key],'Late completion preserves later '+key)
  assert.equal(await read('document.querySelector(".topic-promotion-dialog")===null'),true)
  assert.deepEqual(afterLate.controls,[])
  report.assertions.push('Dismissing an in-flight view and navigating elsewhere retains the later selection, workfaces and draft')
  report.afterLate=afterLate
  await read('topicPromotionProbe.showDirectory()')
  await until('promoted Mote directory entry', 'document.querySelector(".space-mote-row[data-space-nav=\'topic:view:quality-0\']")!==null')
  await click('.space-mote-row[data-space-nav="topic:view:quality-0"]')
  await until('original Mote workface', 'document.querySelector(".mote-space-frame")!==null || document.querySelector(".mote-details")!==null')
  await clickText('button', 'Ideas')
  await until('knowledge disclosure in existing Ideas', 'document.querySelector(".mote-ideas__knowledge summary")!==null')
  await click('.mote-ideas__knowledge summary')
  await until('original knowledge entry', 'document.querySelector(".mote-ideas__knowledge")?.textContent.includes("任务延迟的排查顺序")')
  await capture('promotion-mote-knowledge-dark.png', '主动从 Mote 入口进入 Ideas：原知识与来源仍可直接使用')
  await read('topicPromotionProbe.theme("light")')
  await capture('promotion-mote-knowledge-light.png', '浅色：Mote 的原 Ideas 中展开知识，不新增管理页面')
  report.knowledge = await read('topicPromotionProbe.facts()')
  assert.ok(report.knowledge.calls.some(call=>call.method==='topic.knowledge.ls'&&call.params.topicId==='view:quality-0'))
  assert.deepEqual(report.knowledge.controls,[])
  report.passed=true
} catch(error) { report.failure={name:error.name,message:error.message,stack:error.stack}; if(win&&!win.isDestroyed()) await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(report,null,2)); if(win&&!win.isDestroyed())win.destroy();app.exit(report.passed?0:1) } })
