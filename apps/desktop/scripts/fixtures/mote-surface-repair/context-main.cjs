const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(evidence, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], actions: [], errors: [] }
app.whenReady().then(async () => {
  let window
  try {
    Menu.setApplicationMenu(null)
    window = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await window.loadFile(html, { query: { workspacePath: path.join(evidence, 'workspace', 'scratch'), contextProof: '1', calendarNavigation: process.argv.includes('--calendar-navigation') ? '1' : '' } })
    const read = async script => {
      try { return await window.webContents.executeJavaScript(script) }
      catch (error) { throw new Error('Renderer failed at ' + script.slice(0, 240), {cause:error}) }
    }
    const wait = async script => { for (let i = 0; i < 100; i++) { if (await read(script)) return; await pause(30) } throw Error('Timed out: ' + script) }
    await wait('!!window.moteQuick')
    const click = async selector => {
      const hit = `(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`
      await wait(hit)
      const point = await read(hit)
      for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
      result.actions.push({ action: 'trusted-click', selector, point }); await pause(120)
    }
    const facts = () => read(`(()=>{const p=document.querySelector('[data-pmo-teams-topic-floating]'),s=p.querySelector('.mote-context-status'),i=p.querySelector('[contenteditable=true]'),d=s?.querySelector('[popover=hint]');const r=p.getBoundingClientRect();return {source:moteQuick.facts(),status:s?.textContent,summary:s?.querySelector('.service-disclosure__trigger')?.textContent,detailsOpen:!!d?.matches(':popover-open'),input:i?{text:i.textContent,inert:!!i.closest('[inert]'),bounds:JSON.parse(JSON.stringify(i.getBoundingClientRect()))}:null,panel:{x:r.x,y:r.y,width:r.width,height:r.height},bodyBanners:[...p.querySelectorAll('.workbench-restore-notice.mote-context-notice')].map(n=>n.textContent)}})()`)
    const capture = async name => {
      await pause(100); const observed = await facts()
      assert.ok(observed.panel.width > 100 && observed.panel.height > 100)
      assert.equal(observed.bodyBanners.length, 0, 'Preparation/location is not a stacked body banner')
      await fs.writeFile(path.join(evidence, name + '.png'), (await window.webContents.capturePage()).toPNG())
      result.images.push(name + '.png'); result.actions.push({ action: 'capture', name, observed })
    }
    if (process.argv.includes('--calendar-navigation')) {
      const panel = '[data-pmo-teams-topic-floating]'
      const calendarTab = panel + ' [role="tab"][data-surface-mode="calendar"]'
      const discussionTab = panel + ' [role="tab"][data-surface-mode="discussion"]'
      const calendar = panel + ' [aria-label="Mote calendar"]'
      const active = selector => `document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().height > 0`
      window.webContents.debugger.attach('1.3')
      window.webContents.focus()
      window.setContentSize(1340,900)
      const switcher = '.mote-main-slot [aria-label="切换对话"]'
      await wait(active(switcher))
      const header = await read(`(()=>{
        const box=selector=>document.querySelector(selector).getBoundingClientRect().toJSON()
        return {tabs:box('[aria-label="Mote pages"]'), switcher:box('${switcher}')}
      })()`)
      assert.ok(header.tabs.right <= header.switcher.left+1,'Space tabs do not cover the original conversation switcher')
      await read('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
      window.webContents.invalidate()
      await pause(120)
      await fs.writeFile(path.join(evidence,'space-original-discussion-dark.png'),(await window.webContents.capturePage()).toPNG())
      result.images.push('space-original-discussion-dark.png')
      result.actions.push({action:'space-original-navigation',header})
      await read("moteQuick.contextScenario('normal')")
      await wait(active(discussionTab))
      const original = (await facts()).source
      for (const compact of [false, true]) {
        const suffix = compact ? 'compact-light' : 'wide-dark'
        window.setContentSize(compact ? 510 : 1340, compact ? 780 : 900)
        await read(`moteQuick.theme(${compact});moteQuick.floatSize(${compact ? 470 : 920},${compact ? 640 : 700})`)
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: compact ? 'reduce' : 'no-preference' }] })
        await wait(active(discussionTab))
        await click(discussionTab)
        await wait(`document.querySelector(${JSON.stringify(discussionTab)}).getAttribute('aria-selected')==='true'`)
        await capture('floating-discussion-' + suffix)
        for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({ type, keyCode: 'Right' })
        await wait(`document.activeElement===document.querySelector(${JSON.stringify(calendarTab)}) && document.activeElement.getAttribute('aria-selected')==='true'`)
        const animation = `document.querySelector('${panel} .mote-page-bar .liquid-selection').getAnimations()[0]`
        if (!compact) {
          await read(`(()=>{const move=${animation};if(!move)throw Error('Missing page selection movement');move.pause();move.currentTime=move.effect.getTiming().duration*0.34})()`)
          await capture('floating-calendar-selection-in-motion')
          await read(`(${animation}).play()`)
        } else assert.equal(await read(`!!(${animation})`),false,'Reduced motion selects immediately')
        await wait(active(calendar))
        await wait(active(panel + ' [data-calendar-schedule-id=follow-up]'))
        const geometry = await read(`(()=>{
          const panel=document.querySelector('${panel}'), cal=document.querySelector('${calendar}'), content=cal.getBoundingClientRect(), bar=panel.querySelector('.mote-page-bar').getBoundingClientRect(), bounds=panel.getBoundingClientRect()
          return {calendar:content.toJSON(),bar:bar.toJSON(),panel:bounds.toJSON(),visibleComposer:[...panel.querySelectorAll('.composer,[contenteditable=true]')].some(e=>e.getBoundingClientRect().height>0&&!e.closest('[hidden],[inert]')),reduced:matchMedia('(prefers-reduced-motion: reduce)').matches}
        })()`)
        assert.equal(geometry.visibleComposer,false,'The floating calendar takes the place of the conversation')
        assert.equal(geometry.reduced,compact)
        assert.ok(geometry.calendar.width >= geometry.bar.width-8 && geometry.calendar.height > geometry.panel.height*.6,'The floating calendar must occupy its reading area')
        result.actions.push({ action: 'keyboard-page', suffix, geometry })
        await capture('floating-calendar-' + suffix)
        await click(discussionTab)
        await wait(`! (${active(calendar)}) && document.querySelector(${JSON.stringify(discussionTab)}).getAttribute('aria-selected')==='true'`)
        const restored = (await facts()).source
        for (const field of ['tabs','layouts','sessions','drafts']) assert.deepEqual(restored[field],original[field],field+' retained after Calendar')
      }
      await capture('floating-returned')
      assert.deepEqual(result.errors, [])
      result.passed = true
      return
    }
    for (const narrow of [false, true]) {
      const suffix = narrow ? 'narrow' : 'wide'
      window.setContentSize(narrow ? 520 : 1000, 800)
      await read(`(async()=>{await moteQuick.contextScenario('normal');moteQuick.theme(${narrow});moteQuick.floatSize(${narrow ? 480 : 720},520)})()`)
      await wait("!!document.querySelector('[data-pmo-teams-topic-floating]:popover-open [contenteditable=true]')")
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.action==='prepare'&&o.state==='confirmed')")
      assert.equal((await facts()).summary, undefined)
      await capture('context-normal-' + suffix)
      await read("moteQuick.contextScenario('prepare-failure')")
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.failure?.step==='ensure-mote')")
      assert.equal((await facts()).input.inert, false)
      await capture('context-preparation-' + suffix)
      await click('.mote-context-status .service-disclosure__trigger')
      await wait("!!document.querySelector('.mote-context-status [popover=hint]:popover-open')")
      await capture('context-preparation-details-' + suffix)
      const original = (await facts()).source
      await read('moteQuick.contextPending()'); await click('.mote-context-status [data-mote-context-retry]')
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.state==='pending'&&o.failure?.step==='ensure-mote')")
      assert.equal((await facts()).input.inert, false)
      await capture('context-retry-pending-' + suffix)
      await read('moteQuick.contextConfirm()')
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.state==='confirmed'&&o.failure===null)")
      const confirmed = (await facts()).source
      for (const name of ['tabs', 'layouts', 'sessions', 'drafts']) assert.deepEqual(confirmed[name], original[name], name + ' must survive the real Retry control')
      await read("moteQuick.contextScenario('read-failure')")
      await wait("Object.values(moteQuick.facts().contextOperations).some(o=>o.failure?.step==='read-discussion')")
      assert.equal((await facts()).input.inert, false)
      assert.equal((await facts()).source.calls.filter(call => call.operation === 'error').length, 0, 'The original discussion failure has one visible owner')
      await capture('context-read-failure-' + suffix)
      await click('.mote-context-status .service-disclosure__trigger')
      await wait("!!document.querySelector('.mote-context-status [popover=hint]:popover-open')")
      await capture('context-read-failure-details-' + suffix)
      await read("moteQuick.contextScenario('parent-available')")
      await wait("moteQuick.facts().projection.issueKind==='parent-available'")
      assert.equal((await facts()).input.inert, false)
      await capture('context-original-parent-' + suffix)
      await read("moteQuick.contextScenario('location-choice')")
      await wait("moteQuick.facts().projection.issueKind==='choice'")
      await capture('context-location-choice-' + suffix)
      await click('.mote-context-status .service-disclosure__trigger')
      await wait("!!document.querySelector('.mote-context-status [popover=hint]:popover-open')")
      await capture('context-location-details-' + suffix)
      await click('.mote-context-status__locations button')
      await wait("moteQuick.facts().projection.issue===null&&!!document.querySelector('[data-pmo-teams-topic-floating] [contenteditable=true]')")
      await capture('context-location-selected-' + suffix)
      assert.equal((await facts()).source.floating.targetTabId, 'original-discussion')
    }
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack }
    if(window){result.error.view=await window.webContents.executeJavaScript(`({panels:[...document.querySelectorAll('[popover]:popover-open')].map(n=>({id:n.id,label:n.getAttribute('aria-label')})),content:document.querySelector('[data-pmo-teams-topic-floating]')?.innerText?.slice(0,1000)})`).catch(()=>null);await fs.writeFile(path.join(evidence,'failed.png'),(await window.webContents.capturePage()).toPNG())}
  }
  finally {
    await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    window?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
