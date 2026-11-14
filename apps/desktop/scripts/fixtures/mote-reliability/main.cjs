const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const [html, privateRoot, phase, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, phase, pid: process.pid, frames: [], input: [], errors: [] }
const watch = process.env.MOTE_WATCH_CAPTURE === '1'
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1180, height: 820, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.errors.push(String(message)) })
    await win.loadFile(html, { query: { phase: 'initialization-' + phase, ...(process.env.MOTE_HEARTBEAT_ICON === '1' ? { 'heartbeat-icon': '1' } : {}), ...(process.env.MOTE_HEARTBEAT_SURFACE === '1' ? { 'heartbeat-surface': '1' } : {}), ...(process.env.MOTE_MAIN_RECOVERY_ESCAPE === '1' ? { 'main-recovery-escape':'1' } : {}), ...(process.env.MOTE_MAIN_POLICY_SERVICE === '1' ? {'main-policy-service':'1'} : {}) } })
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => {
      const end = Date.now() + 15000
      do { if (await read('Boolean(' + expression + ')')) return; await pause(30) } while (Date.now() < end)
      throw Error('App did not settle: ' + expression + '; ' + JSON.stringify(await read('({setup:window.sharedFrameSetup,body:document.body.textContent.slice(-1200)})')))
    }
    await until('window.moteReliability?.ready && document.querySelector("[data-mote-page]")')
    win.showInactive(); win.webContents.debugger.attach('1.3')
    const input = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true }); await pause(300)
    result.baseline = await read('window.moteReliability.facts()')
    const counts = calls => Object.fromEntries(['stop', 'launchAgent', 'launchTerminal', 'write', 'submitPrompt'].map(operation => [operation, calls.filter(call => call.operation === operation).length]))
    const button = (label, scope = 'document') => `[...${scope}.querySelectorAll('button,[role="tab"]')].filter(e=>!e.closest('[hidden],[inert]')&&e.getClientRects().length).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)})`
    const click = async (expression, settle = 180) => {
      const point = await read(`(()=>{const e=${expression};if(!e)throw Error('Missing control: '+${JSON.stringify(expression)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||!e.contains(hit))throw Error('Control is not reachable: '+${JSON.stringify(expression)}+' '+JSON.stringify({x,y,hit:hit?.className,width:innerWidth,height:innerHeight}));return{x,y}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      result.input.push({ kind: 'click', expression }); if (settle) await pause(settle)
    }
    const escape = async () => { for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await pause(160) }
    const capture = async (name, settle = 160) => {
      if (settle) await pause(settle)
      const facts = await read('window.moteReliability.facts()')
      assert.ok(facts.tabs['original-initialization-tab'], 'Original Tab retained')
      assert.equal(facts.session.control.run.runId, result.baseline.session.control.run.runId, 'Original Run retained')
      assert.deepEqual(counts(facts.calls), counts(result.baseline.calls), 'Status and configuration add no lifecycle/input requests')
      const file = phase + '-' + name + '.png'
      await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push({ name, file, page: facts.profilePage, theme: facts.theme, dimensions: win.getContentSize(), variant: facts.variant })
    }
    const profile = async () => { await click(button('Profile', 'document.querySelector(".mote-space-frame__header")')); await until('document.querySelector("[data-mote-page=profile]")') }
    const refresh = async () => { await click(button('Refresh actual schedule', 'document.querySelector(".mote-quick-mode")')) }
    if (process.env.MOTE_HEARTBEAT_ICON === '1') {
      const cues = 'document.querySelectorAll(\'.mote-heartbeat-entry [data-icon-animation="feedback"], .mote-space-frame__header .mote-heartbeat-lamp__signal [data-icon-animation="feedback"]\')'
      const sprite = 'document.getElementById("agentmux-icon-object.heartbeat")'
      assert.equal(await read(`${sprite}.querySelectorAll('[data-semantic-icon-part="heartbeat-pendulum"]').length`), 2)
      const launcher = 'document.querySelector(".pmo-teams-topic-compact-launcher__surface")'
      await until(`${launcher}?.querySelector('[data-space-silhouette="low-poly"]')`)
      const fractions = await read(`(() => { const root = ${launcher}; const avatar = root.querySelector('.mote-silhouette-art').getBoundingClientRect(); const badge = root.querySelector('.mote-heartbeat-entry'); const outline = badge.getBoundingClientRect(); const online = root.querySelector('.pmo-teams-topic-compact-launcher__status').getBoundingClientRect();
        return { noBacking: getComputedStyle(badge).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(badge).borderTopWidth === '0px', aboveAvatar: outline.top < avatar.top, rightOfCenter: outline.left > avatar.left + avatar.width / 2, separateFromOnline: outline.bottom < online.top } })()`)
      assert.deepEqual(fractions, { noBacking: true, aboveAvatar: true, rightOfCenter: true, separateFromOnline: true })
      for (const [theme, width, facts, state, icon] of [
        ['dark', 1180, 'active', 'active', 'object.heartbeat'],
        ['light', 420, 'active', 'active', 'object.heartbeat'],
        ['light', 1180, 'manual', 'paused', 'status.paused'],
        ['dark', 1180, 'paused', 'attention', 'status.warning'],
      ]) {
        win.setContentSize(width, width > 600 ? 820 : 740)
        await read(`window.moteInit.theme(${JSON.stringify(theme)});window.moteReliability.variant(${JSON.stringify(facts)})`)
        await profile(); await refresh()
        await click(button('Discussion', 'document.querySelector(".mote-space-frame__header")'))
        const mark = `[data-mote-care="${state}"] svg[data-semantic-icon="${icon}"]`
        for (const [surface, size] of [['.mote-heartbeat-entry', 13], ['.mote-space-frame__header .mote-heartbeat-lamp', 14]])
          await until(`document.querySelector(${JSON.stringify(surface + mark)})?.getBoundingClientRect().width === ${size}`)
        assert.equal(await read(`${cues}.length`), 0)
        await capture('heartbeat-icon-' + state + '-' + theme)
      }
      win.setContentSize(680, 740)
      await read('window.moteReliability.variant("active")'); await profile(); await refresh()
      await click(button('Discussion', 'document.querySelector(".mote-space-frame__header")'))
      await until('document.querySelector(".mote-space-frame__header .mote-heartbeat-lamp[data-mote-care=active]")')
      const beats = []
      win.webContents.debugger.on('message', (_event, method, packet) => {
        if (method === 'Animation.animationStarted' && packet.animation.name === 'semantic-icon-heartbeat-once') beats.push(packet.animation)
      })
      await input('Animation.enable')
      await capture('heartbeat-motion-rest')
      await input('Animation.setPlaybackRate', { playbackRate: 0.1 })
      await read('window.moteReliability.advanceHeartbeatIcon()')
      await until(`${cues}.length === 2`)
      assert.equal(beats.length, 4, 'Both parts of each original pendulum move')
      assert.ok(beats.every(beat => beat.source.iterations === 1 && beat.source.duration === 220), 'One finite authored motion')
      const animations = beats.map(beat => beat.id)
      await input('Animation.setPaused', { animations, paused: true })
      await input('Animation.seekAnimations', { animations, currentTime: 99 })
      await capture('heartbeat-motion-crest')
      await input('Animation.setPlaybackRate', { playbackRate: 1 })
      await input('Animation.setPaused', { animations, paused: false })
      await capture('heartbeat-motion-settled', 280)
      await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await read(`window.previousHeartbeatCue = ${cues}[0]; window.moteReliability.advanceHeartbeatIcon()`)
      await until(`${cues}.length === 2 && ${cues}[0] !== window.previousHeartbeatCue`)
      assert.equal(await read(`getComputedStyle(${cues}[0]).getPropertyValue('--icon-feedback-heartbeat').trim()`), 'none')
      await capture('heartbeat-motion-reduced')
      assert.equal(beats.length, 4, 'Reduced motion does not start a new drawing animation')
      result.heartbeatMotion = { carriers: await read(`${cues}.length`), movingParts: beats.length, durationMs: beats[0].source.duration, iterations: beats[0].source.iterations, reducedMotionStarted: 0 }
      result.passed = true; return
    }
    const checkedRecovery = async () => {
      result.checkedLegacyRecovery = []
      for (const [theme, width, height] of [['dark', 1180, 820], ['dark', 420, 740], ['light', 1180, 820], ['light', 420, 740]]) {
        win.setContentSize(width, height); await read(`window.moteInit.theme(${JSON.stringify(theme)});window.moteReliability.variant("legacy-without-key")`)
        await profile(); await refresh(); await click('document.querySelector(".mote-space-frame__header .mote-heartbeat-lamp")')
        await until('document.querySelector(".mote-quick-mode-dialog [data-mote-maintenance-status=paused]")')
        await click(button('Check original delivery', 'document.querySelector(".mote-quick-mode-dialog")'))
        await until(`[...document.querySelectorAll('.mote-quick-mode-dialog button')].some(e=>e.textContent==='Resume future checks')`)
        const reachable = await read(`(()=>{const e=${button('Resume future checks', 'document.querySelector(".mote-quick-mode-dialog")')},r=e.getBoundingClientRect(),body=e.closest('.mote-quick-mode-dialog__body').getBoundingClientRect(),footer=document.querySelector('.mote-quick-mode-dialog__footer').getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {details:e.closest('details')!==null,inViewport:r.y>=body.y&&r.bottom<=Math.min(body.bottom,footer.y)&&r.x>=0&&r.right<=innerWidth,hit:e.contains(document.elementFromPoint(x,y)),text:e.closest('[role="status"]')?.textContent}})()`)
        assert.equal(reachable.details, false); assert.equal(reachable.inViewport, true, 'Explicit future recovery is in the first screen'); assert.equal(reachable.hit, true)
        assert.ok(reachable.text.includes('earlier delivery remains unknown'))
        result.checkedLegacyRecovery.push({ theme, width, ...reachable })
        await capture('legacy-checked-recovery-' + theme + '-' + (width > 600 ? 'wide' : 'narrow')); await escape()
      }
      win.setContentSize(1180, 820); await read('window.moteInit.theme("dark")')
    }
    if (process.env.MOTE_MAIN_POLICY_SERVICE === '1') {
      await until('window.moteRecoveryEscape?.ready')
      const showMain = async () => {
        const discussion = button('Discussion', 'document.querySelector(".mote-space-frame__header")')
        if (await read('Boolean('+discussion+')')) await click(discussion)
        const openMain = button('打开当前主对话')
        if (await read('Boolean('+openMain+')')) await click(openMain)
        await until(`[...document.querySelectorAll('[data-mote-main-service]')].some(e=>!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length)`)
      }
      result.presentation=[]
      for (const [name,theme,width,policy,mode,split] of [
        ['unconfigured-dark-split','dark',920,'unconfigured','unavailable',true],
        ['automatic-light-split','light',920,'automatic','unavailable',true],
        ['keep-current-light-wide','light',1180,'keep-current','unavailable',false],
        ['unknown-dark-narrow','dark',420,'unconfigured','unknown',false]
      ]) {
        win.setContentSize(width,width>600?820:740)
        await read(`window.moteInit.theme(${JSON.stringify(theme)});window.moteRecoveryEscape.variant(${JSON.stringify(mode)});window.moteRecoveryEscape.policy(${JSON.stringify(policy)},${split})`)
        await showMain()
        result.baseline=await read('window.moteReliability.facts()')
        await pause(180)
        const facts=await read(`(()=>{const e=[...document.querySelectorAll('[data-mote-main-service]')].find(e=>!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length);const r=e.getBoundingClientRect(),reader=e.closest('[data-mote-workface]').querySelector('.activity-feed');return {text:e.textContent,rect:r.toJSON(),readerRect:reader?.getBoundingClientRect().toJSON(),buttons:[...e.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent,rect:r.toJSON(),hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}}),genericOutside:reader?.querySelectorAll('[data-original-session-actions]').length}})()`)
        result.presentation.push({name,policy,mode,split,...facts})
        await capture(name)
        assert.ok(facts.rect.width>0 && facts.rect.right<=width)
        assert.equal(facts.genericOutside,0)
        assert.ok(facts.buttons.every(value=>value.hit))
        if(split)assert.ok(facts.rect.width<540,'Actual narrow Main Region beside real tools and rail')
      }
      await click('document.querySelector(".mote-conversation__reading-tools summary")')
      await capture('unknown-original-details-dark-narrow')
      win.setContentSize(1180,820)
      await read('window.moteInit.theme("dark");window.moteRecoveryEscape.variant("unavailable");window.moteRecoveryEscape.policy("automatic",false)')
      result.baseline=await read('window.moteReliability.facts()')
      await read('window.moteRecoveryEscape.floating()')
      await until('document.querySelector(".pmo-teams-topic-floating__body [data-mote-main-service]")')
      await capture('automatic-dark-floating')
      result.passed=true;return
    }
    if (process.env.MOTE_MAIN_RECOVERY_ESCAPE === '1') {
      await until('window.moteRecoveryEscape?.ready')
      const showMain = async () => {
        const discussion = button('Discussion', 'document.querySelector(".mote-space-frame__header")')
        if (await read('Boolean('+discussion+')')) await click(discussion)
        const openMain = button('打开当前主对话')
        if (await read('Boolean('+openMain+')')) await click(openMain)
        await until(`[...document.querySelectorAll('[data-mote-main-recovery]')].some(e=>!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length)`)
      }
      if (phase === 'seed') {
        result.draftWitness = {agent:'Original Agent draft '+randomUUID(),launcher:'Original Mote draft '+randomUUID(),query:'Original unconfirmed question '+randomUUID(),mote:'Original Mote composer draft '+randomUUID()}
        await read('window.moteReliability.editDrafts('+JSON.stringify(result.draftWitness)+')')
        await read('window.moteRecoveryEscape.retainOriginal('+JSON.stringify(result.draftWitness.query)+','+JSON.stringify(result.draftWitness.mote)+')')
      } else {
        const seed=JSON.parse(await fs.readFile(path.join(evidence,'seed.json'),'utf8'))
        result.draftWitness=seed.draftWitness
        result.restored=await read('window.moteReliability.facts()')
        assert.deepEqual(result.restored.inputAtEntry.agentDrafts,seed.original.agentDrafts)
        assert.deepEqual(result.restored.inputAtEntry.drafts,seed.original.drafts)
        assert.deepEqual(result.restored.inputAtEntry.mainRequests,seed.original.mainRequests)
        assert.deepEqual(result.restored.mainRequests,seed.original.mainRequests)
        assert.deepEqual(result.restored.fixtureWrites,[])
        assert.deepEqual(result.restored.tabs,seed.original.tabs)
        assert.deepEqual(result.restored.layouts,seed.original.layouts)
        assert.deepEqual(result.restored.selection,seed.original.selection)
        assert.deepEqual(result.restored.session.control,seed.original.session.control)
        result.draftRecovery={originalNonempty:true,hydratedBeforeFixture:true,restoreFixtureWrites:0,exactOriginalRequest:true,exactWorkface:true}
      }
      await showMain()
      await until(`[...document.querySelectorAll('[aria-label="Message Agent"]')].some(e=>!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length&&e.textContent.includes(${JSON.stringify(result.draftWitness.mote)}))`)
      result.originalMoteDraftVisible = true
      const scenes = process.env.MOTE_MAIN_RECOVERY_PERSIST_ONLY === '1' ? [['dark',1180,'unavailable']] : [['dark',1180,'unavailable'],['light',420,'unavailable'],['light',1180,'unknown'],['dark',420,'unknown']]
      for (const [theme,width,mode] of scenes) {
        win.setContentSize(width,width>600?820:740)
        await read('window.moteInit.theme('+JSON.stringify(theme)+');window.moteRecoveryEscape.variant('+JSON.stringify(mode)+')')
        await pause(180)
        const reach=await read(`(()=>{const e=[...document.querySelectorAll('[data-mote-main-recovery]')].find(e=>!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length);if(!e)throw Error('Missing visible exact recovery');const actions=[...e.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{text:b.textContent,rect:r.toJSON(),visible:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&b.contains(hit)}});return{text:e.textContent,actions}})()`)
        assert.ok(reach.actions.length>=2&&reach.actions.every(action=>action.visible),'Recovery choices are actually reachable')
        result.reachability??=[];result.reachability.push({theme,width,mode,...reach})
        await capture('main-'+mode+'-'+theme+'-'+(width>600?'wide':'narrow'))
      }
      await read('window.moteRecoveryEscape.variant("unavailable")');win.setContentSize(1180,820)
      const end=Date.now()+15000
      do {result.persistedInputs=await read('window.moteReliability.persistedInputs()');result.original=await read('window.moteReliability.facts()');if(JSON.stringify(result.persistedInputs)===JSON.stringify({drafts:result.original.drafts,agentDrafts:result.original.agentDrafts}))break;await pause(30)}while(Date.now()<end)
      assert.deepEqual(result.persistedInputs,{drafts:result.original.drafts,agentDrafts:result.original.agentDrafts})
      assert.equal(Object.values(result.original.mainRequests).find(value=>value.operationId==='original-unknown-main-start').deferredInput.prompt,result.draftWitness.query)
      if(phase==='restore'){const seed=JSON.parse(await fs.readFile(path.join(evidence,'seed.json'),'utf8'));assert.deepEqual(result.original.mainRequests,seed.original.mainRequests);assert.deepEqual(result.original.session.control,seed.original.session.control)}
      result.passed=true;return
    }
    if (process.env.MOTE_HEARTBEAT_SURFACE === '1') {
      await until('window.moteHeartbeatSurface?.ready')
      if (process.env.MOTE_HEARTBEAT_SURFACE_DETAIL_ONLY === '1') {
        const dialog = 'document.querySelector(".mote-quick-mode-dialog")'
        const reveal = async expression => {
          await read(`(${expression}).scrollIntoView({block:'center',inline:'nearest'})`); await pause(120)
          const target = await read(`(()=>{const e=${expression},r=e.getBoundingClientRect(),body=e.closest('.mote-quick-mode-dialog__body').getBoundingClientRect(),footer=document.querySelector('.mote-quick-mode-dialog__footer').getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {text:e.textContent,rect:r.toJSON(),body:body.toJSON(),footer:footer.toJSON(),complete:r.top>=body.top&&r.bottom<=Math.min(body.bottom,footer.top)&&r.left>=0&&r.right<=innerWidth,hit:e.contains(document.elementFromPoint(x,y))}})()`)
          assert.equal(target.complete,true,'Target is fully in the actual Dialog viewport');assert.equal(target.hit,true,'Target is not occluded');return target
        }
        await read('window.moteInit.theme("dark");window.moteHeartbeatSurface.variant("quiet")'); await profile(); await refresh()
        await click(button('Configure heartbeat','document.querySelector(".mote-quick-mode")'))
        await until('document.querySelector(".mote-quick-mode-dialog .mote-heartbeat__report")')
        await click('document.querySelector(".mote-quick-mode-dialog .mote-heartbeat__report summary")')
        result.ideaTarget=await reveal(button('Open Idea',dialog));await capture('report-idea-target-visible')
        await click('document.querySelector(".mote-quick-mode-dialog .mote-heartbeat__details summary")')
        await click(button('Use updated guidance',dialog));await until('window.moteHeartbeatSurface.pending()')
        result.adoptionTargets=[]
        for(const [width,height,name] of [[1180,820,'wide'],[420,740,'narrow']]){win.setContentSize(width,height);result.adoptionTargets.push(await reveal(button('Check original adoption',dialog)));await capture('original-adoption-target-visible-'+name)}
        result.passed=true;return
      }
      if (phase === 'restore') {
        const seed = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8'))
        result.restored = await read('window.moteReliability.facts()')
        assert.deepEqual(result.restored.inputAtEntry.drafts, seed.original.drafts, 'Original pending request and raw drafts hydrate before fixture input')
        assert.deepEqual(result.restored.inputAtEntry.agentDrafts, seed.original.agentDrafts)
        assert.deepEqual(result.restored.fixtureWrites, [])
        for (const field of ['tabs', 'layouts', 'selection']) assert.deepEqual(result.restored[field], seed.original[field], 'Original workface: ' + field)
        result.focusScope = { seed: seed.original.focus, restored: result.restored.focus, globalAgentFocus: 'not-qualified-by-this-draft-fixture' }
        assert.deepEqual(result.restored.session.control, seed.original.session.control)
        await profile(); await click(button('Configure heartbeat', 'document.querySelector(".mote-quick-mode")'))
        await until('document.querySelector(".mote-quick-mode-dialog")?.textContent.includes("Check original adoption")')
        const pending = await read('window.moteHeartbeatSurface.pending()')
        assert.deepEqual(pending, seed.pending, 'Frozen complete input restored from original durable owner')
        const prior = await read('window.moteHeartbeatSurface.saves.length')
        assert.equal(prior, 0, 'Restore sends no adoption')
        await click(button('Check original adoption', 'document.querySelector(".mote-quick-mode-dialog")'))
        await until('window.moteHeartbeatSurface.saves.length===1')
        assert.deepEqual(await read('window.moteHeartbeatSurface.saves[0]'), seed.pending[1].moteQuick.pending.input)
        await capture('restored-original-adoption')
        result.persistedInputs = await read('window.moteReliability.persistedInputs()')
        result.draftRecovery = { originalNonempty: true, hydratedBeforeFixture: true, restoreFixtureWrites: 0, exactPendingRequest: true, explicitSameOperation: true, exactWorkface: true }
        result.passed = true; return
      }
      for (const [theme, width, height] of [['dark',1180,820],['dark',420,740],['light',1180,820],['light',420,740]]) {
        win.setContentSize(width,height); await read(`window.moteInit.theme(${JSON.stringify(theme)});window.moteHeartbeatSurface.variant('quiet')`)
        await profile(); await refresh()
        await until('document.querySelector(".mote-heartbeat__report-summary")')
        await capture('care-report-' + theme + '-' + (width > 600 ? 'wide' : 'narrow'))
        await click(button('Configure heartbeat', 'document.querySelector(".mote-quick-mode")'))
        await until('document.querySelector(".mote-quick-mode-dialog")')
        await capture('care-settings-' + theme + '-' + (width > 600 ? 'wide' : 'narrow')); await escape()
      }
      win.setContentSize(420,740); await input('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion',value:'reduce' }] })
      await read('window.moteHeartbeatSurface.variant("failed")'); await refresh(); await capture('care-failed-reduced-motion')
      win.setContentSize(1180,820); await read('window.moteInit.theme("dark");window.moteHeartbeatSurface.variant("quiet")'); await refresh()
      await click(button('Configure heartbeat','document.querySelector(".mote-quick-mode")'))
      const details = 'document.querySelector(".mote-quick-mode-dialog .mote-heartbeat__details summary")'
      await click('document.querySelector(".mote-quick-mode-dialog .mote-heartbeat__report summary")'); await capture('care-report-idea-expanded')
      await click(details)
      await click(button('Use updated guidance','document.querySelector(".mote-quick-mode-dialog")'))
      await until('window.moteHeartbeatSurface.pending()')
      const interval = `document.querySelector('[aria-label="Heartbeat interval (minutes)"]')`
      await click(interval)
      await read('(' + interval + ').select()')
      await input('Input.insertText', { text:'47' })
      await until('window.moteHeartbeatSurface.pending()?.[1].moteQuick.minutes==="47"')
      await read('document.querySelector(".mote-quick-mode-dialog__body").scrollTo(0,0)')
      await capture('care-original-adoption-unconfirmed')
      win.setContentSize(420,740); await capture('care-original-adoption-unconfirmed-narrow'); win.setContentSize(1180,820)
      result.pending = await read('window.moteHeartbeatSurface.pending()')
      await escape()
      result.draftWitness = { agent: 'Original pending input draft ' + randomUUID(), launcher: 'Original Launcher draft ' + randomUUID() }
      await read('window.moteReliability.editDrafts(' + JSON.stringify(result.draftWitness) + ')')
      await until('JSON.stringify(window.moteHeartbeatSurface.pending())===' + JSON.stringify(JSON.stringify(result.pending)))
      const end = Date.now()+15000
      do { result.persistedInputs=await read('window.moteReliability.persistedInputs()'); result.original=await read('window.moteReliability.facts()'); if(JSON.stringify(result.persistedInputs)===JSON.stringify({drafts:result.original.drafts,agentDrafts:result.original.agentDrafts}))break; await pause(30) } while(Date.now()<end)
      assert.deepEqual(result.persistedInputs,{drafts:result.original.drafts,agentDrafts:result.original.agentDrafts})
      assert.ok(result.original.drafts[result.pending[0]].moteQuick.pending.input.operationId)
      result.passed=true; return
    }
    if (process.env.MOTE_RECOVERY_VISUAL_ONLY === '1') { await checkedRecovery(); result.passed = true; return }
    if (phase === 'restore') {
      const seeded = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')), seed = seeded.original
      result.restored = await read('window.moteReliability.facts()')
      assert.ok(Object.keys(seed.drafts).length > 0 && Object.values(seed.drafts).some(value => value.prompt?.trim()), 'Seed contains a nonempty original Launcher draft')
      assert.ok(Object.keys(seed.agentDrafts).length > 0 && seed.agentDrafts[seed.session.id]?.trim(), 'Seed contains a nonempty original Agent draft')
      assert.equal(seed.drafts['private-mote-reliability-original-draft'].prompt, seeded.draftWitness.launcher)
      assert.equal(seed.agentDrafts[seed.session.id], seeded.draftWitness.agent)
      assert.deepEqual(result.restored.inputAtEntry.drafts, seed.drafts, 'Launcher input is hydrated before fixture writes')
      assert.deepEqual(result.restored.inputAtEntry.agentDrafts, seed.agentDrafts, 'Agent input is hydrated before fixture writes')
      assert.deepEqual(result.restored.fixtureWrites, [], 'The restore fixture never reseeds a draft or workface')
      assert.deepEqual(result.restored.drafts, seed.drafts, 'Original durable drafts retained in independent process')
      assert.deepEqual(result.restored.agentDrafts, seed.agentDrafts, 'Original Agent draft retained in independent process')
      assert.deepEqual(result.restored.tabs['original-initialization-tab'], seed.tabs['original-initialization-tab'], 'Original durable workface identity retained')
      assert.deepEqual(result.restored.inputAtEntry.tab, seed.tabs['original-initialization-tab'], 'Original Tab exists before fixture projection')
      assert.deepEqual(result.restored.layouts, seed.layouts, 'Original layouts retained')
      assert.deepEqual(result.restored.selection, seed.selection, 'Original selection retained')
      assert.deepEqual(result.restored.focus, seed.focus, 'Original focus retained')
      assert.deepEqual(result.restored.session.control, seed.session.control, 'Original Session and Run retained')
      result.persistedInputs = await read('window.moteReliability.persistedInputs()')
      assert.deepEqual(result.persistedInputs, seeded.persistedInputs, 'The original persisted inputs survive the independent process')
      result.draftRecovery = { originalNonempty: true, hydratedBeforeFixture: true, restoreFixtureWrites: 0, exactPersistedInputs: true, exactWorkface: true }
      if (watch) {
        await click(button('Discussion', 'document.querySelector(".mote-space-frame__header")'))
        await until(`[...document.querySelectorAll('[aria-label="Message Agent"]')].some(e=>!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length&&e.textContent.includes(${JSON.stringify(seeded.draftWitness.agent)}))`)
        result.draftRecovery.originalComposerVisible = true
        await capture('restored-original-main-draft')
      }
      await profile(); await capture('restored-heartbeat-dark-wide')
      if (watch) {
        await until('window.moteReliability.careFacts().notifications.data?.items.some(item=>item.subject.kind==="zone")')
        result.careRestored = await read('window.moteReliability.careFacts()')
        const rows = result.careRestored.notifications.data.items.filter(item => item.subject.kind === 'zone')
        assert.equal(rows.length, 1); assert.equal(rows[0].unread, false, 'Original episode stays read across the independent process')
        assert.equal(result.careRestored.lamp, 'attention', 'Reading a reminder never clears the original pause')
        assert.deepEqual(result.careRestored.receipts, seeded.careRead.receipts, 'Original notification read receipts were hydrated')
        await click('document.querySelector(".global-system-notices__trigger")'); await capture('restored-care-read-current')
      }
      result.passed = true; return
    }
    for (const [theme, width, height] of [['dark', 1180, 820], ['dark', 420, 740], ['light', 1180, 820], ['light', 420, 740]]) {
      win.setContentSize(width, height); await read(`window.moteInit.theme(${JSON.stringify(theme)})`); await pause(180)
      await profile(); await read('window.moteReliability.variant("paused")'); await refresh()
      await capture('paused-profile-' + theme + '-' + (width > 600 ? 'wide' : 'narrow'))
      if (watch) {
        await click(button('Discussion', 'document.querySelector(".mote-space-frame__header")'))
        await capture('care-attention-discussion-' + theme + '-' + (width > 600 ? 'wide' : 'narrow'))
        await click('document.querySelector(".mote-space-frame__header .mote-heartbeat-lamp")', 25)
      } else await click(button('Configure heartbeat'), 25)
      await until('document.querySelector(".mote-quick-mode-dialog [data-mote-maintenance-status=paused]")')
      if (theme === 'dark' && width === 1180) await capture('heartbeat-opening-intermediate', 0)
      await capture('heartbeat-dialog-' + theme + '-' + (width > 600 ? 'wide' : 'narrow'))
      await escape()
    }
    win.setContentSize(1180, 820); await read('window.moteInit.theme("dark");window.moteReliability.variant("active")'); await profile(); await refresh()
    await capture('accepted-profile-dark-wide')
    await read('window.moteReliability.variant("unbound")'); await refresh(); await capture('unbound-profile-dark-wide')
    await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    win.setContentSize(420, 740); await click(button('Configure heartbeat')); await capture('unbound-reduced-motion-dark-narrow'); await escape()
    await read('window.moteReliability.startup()'); await click(button('Discussion', 'document.querySelector(".mote-space-frame__header")'))
    await until(`document.querySelector('[aria-label="Mote startup"]')`)
    await capture('startup-guidance-dark-narrow')
    win.setContentSize(1180, 820); await read('window.moteInit.theme("light")'); await capture('startup-guidance-light-wide')
    if (watch) {
      await profile(); await read('window.moteInit.theme("dark");window.moteReliability.variant("manual")'); await refresh(); await capture('care-manual-dark-wide')
      await read('window.moteReliability.variant("legacy")'); await refresh(); await capture('care-legacy-dark-wide')
      if (process.env.MOTE_RECOVERY_CAPTURE === '1') {
        await checkedRecovery(); await profile()
      }
      await read('window.moteReliability.variant("paused")'); await refresh()
      await read('window.moteReliability.variant("unavailable")'); await refresh(); await capture('care-observation-unavailable-dark-wide')
      await read('window.moteReliability.variant("paused")'); await refresh()
      await until('window.moteReliability.careFacts().notifications.data?.items.some(item=>item.subject.kind==="zone")')
      await click('document.querySelector(".global-system-notices__trigger")'); await capture('care-unread-notification-dark-wide')
      await click('document.querySelector(".notification-item[data-notice-id^=\\"mote-heartbeat:\\"] .notification-item__read")')
      await until('window.moteReliability.careFacts().notifications.data.items.filter(item=>item.subject.kind==="zone").length===1&&window.moteReliability.careFacts().notifications.data.items.filter(item=>item.subject.kind==="zone").every(item=>!item.unread)')
      result.careRead = await read('window.moteReliability.careFacts()')
      assert.equal(result.careRead.lamp, 'attention', 'Read receipt does not settle the pause')
      assert.equal(result.careRead.notifications.data.items.filter(item => item.subject.kind === 'zone').length, 1, 'The read pause remains in Current')
      await capture('care-read-still-paused-dark-wide')
      await click(button('Inspect original heartbeat')); await until('document.querySelector(".mote-quick-mode-dialog")'); await capture('care-notification-original-inspection')
      await escape()
      const careDeadline = Date.now() + 15000
      do {
        result.carePersisted = await read('window.moteReliability.persistedCare()')
        if (JSON.stringify(result.carePersisted) === JSON.stringify(result.careRead.receipts)) break
        await pause(30)
      } while (Date.now() < careDeadline)
      assert.deepEqual(result.carePersisted, result.careRead.receipts)
      await click(button('Discussion', 'document.querySelector(".mote-space-frame__header")'))
    }
    result.draftWitness = { agent: 'Original Agent draft · ' + randomUUID() + ' · 原输入跨进程保留。', launcher: 'Original Launcher draft · ' + randomUUID() + '\n原草稿不可重新播种。' }
    const editors = `[...document.querySelectorAll('[aria-label="Message Agent"]')].filter(e=>!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getClientRects().length)`
    await until(editors + '.length===1')
    await click('(' + editors + ')[0]')
    await until('window.moteReliability.facts().focus.pmo?.sessionId===window.moteReliability.facts().session.id')
    await read(`(()=>{const e=(${editors})[0],range=document.createRange();range.selectNodeContents(e);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()`)
    await input('Input.insertText', { text: result.draftWitness.agent })
    await until('window.moteReliability.facts().agentDrafts[window.moteReliability.facts().session.id]===' + JSON.stringify(result.draftWitness.agent))
    await read('window.moteReliability.editDrafts(' + JSON.stringify(result.draftWitness) + ')')
    const deadline = Date.now() + 15000
    do {
      result.persistedInputs = await read('window.moteReliability.persistedInputs()')
      const facts = await read('window.moteReliability.facts()')
      if (result.persistedInputs?.agentDrafts?.[facts.session.id] === result.draftWitness.agent &&
          result.persistedInputs?.drafts?.['private-mote-reliability-original-draft']?.prompt === result.draftWitness.launcher) break
      await pause(30)
    } while (Date.now() < deadline)
    result.original = await read('window.moteReliability.facts()')
    assert.deepEqual(result.persistedInputs, { drafts: result.original.drafts, agentDrafts: result.original.agentDrafts }, 'Nonempty exact draft witnesses reached original persistent input storage')
    assert.equal(result.original.agentDrafts[result.original.session.id], result.draftWitness.agent)
    assert.equal(result.original.drafts['private-mote-reliability-original-draft'].prompt, result.draftWitness.launcher)
    await until('window.sharedFrameProof.persistence().spatial?.graph.tabs.some(tab=>tab.tabId==="original-initialization-tab")')
    result.persisted = await read('window.sharedFrameProof.persistence()'); result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack }; try {
    result.failedFacts = await win.webContents.executeJavaScript('window.moteReliability?.facts()')
    result.failedLayout = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.mote-space-frame,.mote-workface,.mote-details-panel,.mote-quick-mode,.mote-quick-mode-dialog,[data-space-content-presentation]')].map(e=>({class:e.className,hidden:e.hidden,rect:e.getBoundingClientRect().toJSON(),style:{display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,opacity:getComputedStyle(e).opacity},ancestors:(()=>{const parents=[];for(let p=e.parentElement;p;p=p.parentElement)parents.push(p);return parents})().map(p=>({class:p.className,rect:p.getBoundingClientRect().toJSON(),overflow:getComputedStyle(p).overflow,display:getComputedStyle(p).display}))}))`)
  } catch {} }
  finally {
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) { win.webContents.session.flushStorageData(); win.destroy() }
    app.exit(result.passed ? 0 : 1)
  }
})
