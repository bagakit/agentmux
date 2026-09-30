const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, ownerBundle, privateRoot, evidence, phase, asset, cli] = process.argv.slice(2)
for (const key of ['home','userData','sessionData']) { const p=path.join(privateRoot,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p) }
const raw = { phase, frames:[], actions:[], nativeEvents:[], windowEvents:[], leaseEvents:[], errors:[], qualified:false,
  boundary:'Actual mounted App, Settings and TerminalView / native input / isolated product preload and registered Toolkit IPC; Metrics DTO port and original preview Session transport controlled. No official CLI/nativeRun or live-user claim.' }
let win, stop=()=>{}, current, snapshot, serial=0, delay=0, toolkit, sampler, runtime, metrics, controlServer, detachRuntime
const leases = new Map()
const facts = () => ({active:toolkit?.current.consumerCount??leases.size,events:raw.leaseEvents.slice()})
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
  try {
    const {ConfigOwner,ConfigStore,registerToolkitIpc,ToolkitOwner,RuntimeController,ProcessResourceSampler,createResourceMetricsPort,AgentMuxMemoryAgentSessionStore,AgentMuxControlServer}=await import(pathToFileURL(ownerBundle).href)
    const configStore = new ConfigStore(path.join(privateRoot,'userData','config.json'))
    const initialConfigExists = fs.existsSync(configStore.filePath)
    current = await configStore.get()
    const owner = new ConfigOwner({read:()=>current,save:next=>configStore.save(next),publish:saved=>{current=saved;win?.webContents.send('proof:config:changed',saved)}})
    ipcMain.handle('proof:setup',async(_event,preview)=>{
      if(phase==='control'||phase==='placement'||phase==='buttons') { assert.equal(initialConfigExists,false,'首次私有Config来源为空');await owner.update(()=>({...preview,
        workspaces:[...preview.workspaces,...current.workspaces.filter(workspace=>!preview.workspaces.some(item=>item.id===workspace.id))],
        appearance:{...preview.appearance,appAppearance:'dark'},toolkit:{performance:{enabled:true,statusBar:'label'}},
        composerShortcuts:[{id:'original',keyword:'original',label:'Original authored prompt',body:'Original saved body remains exact.'}]})) }
      else assert.equal(fs.existsSync(configStore.filePath),true,'Restart复用真实durable Config，不seed')
      return {phase}
    })
    ipcMain.handle('proof:config:get',()=>owner.current)
    ipcMain.handle('proof:config:save',(_event,next,expected)=>owner.edit(expected,next))
    ipcMain.handle('proof:flush',()=>win.webContents.session.flushStorageData())
    ipcMain.handle('proof:facts',facts)
    ipcMain.handle('proof:snapshot',(_event,value)=>{snapshot=value;for(const lease of leases.values())lease.push(snapshot);return true})
    const scriptText=fs.readFileSync(asset,'utf8'),scriptSHA=createHash('sha256').update(scriptText).digest('hex')
    if(phase!=='joined')stop=registerToolkitIpc({
      async execute(request) {
        if(request.operation==='toolkit.script')return {operation:request.operation,script:{toolId:'performance',path:asset,sha256:scriptSHA,text:scriptText}}
        if(request.operation==='toolkit.get')return {operation:request.operation,snapshot}
        throw Error('UI不应调用manual run/stop/list: '+request.operation)
      },
      async subscribe(_id,push,_end,signal) {
        const id=++serial;let closed=false
        const dispose=()=>{if(!closed){closed=true;leases.delete(id);raw.leaseEvents.push({event:'disposed',id,at:Date.now()})}}
        signal.addEventListener('abort',dispose,{once:true})
        raw.leaseEvents.push({event:'entered',id,at:Date.now()});leases.set(id,{push})
        if(delay)await pause(delay)
        push(snapshot);raw.leaseEvents.push({event:'returned',id,at:Date.now()})
        return {dispose}
      }
    },(channel,handler)=>ipcMain.handle(channel,handler))
    win=new BrowserWindow({width:1480,height:900,show:false,webPreferences:{preload:process.env.AGENTMUX_PERFORMANCE_PRODUCT_PRELOAD,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:true}})
    for(const event of ['show','hide','minimize','restore','focus','blur','ready-to-show'])
      win.on(event,()=>raw.windowEvents.push({event,at:Date.now(),phase:raw.windowPhase??'mounted',visible:win.isVisible(),minimized:win.isMinimized()}))
    if(phase==='joined'){
      fs.mkdirSync(process.env.AGENTMUX_RUNTIME_DIRECTORY,{recursive:true})
      sampler=new ProcessResourceSampler()
      runtime=new RuntimeController(new AgentMuxMemoryAgentSessionStore(),undefined,sampler)
      runtime.commit(await runtime.prepare({...current,hosts:current.hosts.filter(host=>host.kind==='local')}))
      detachRuntime=runtime.attach(win.webContents)
      sampler.setObservationSources({observeRuntime:()=>runtime.resourceUsageObservation(),
        processOwners:()=>({rendererPids:[win.webContents.getOSProcessId()].filter(pid=>pid>0),browserPids:[]}),
        mainOwners:()=>({...runtime.resourceOwnerCounts(),fileWatchers:0,browserViews:0,releasedBrowserViews:0})})
      metrics=createResourceMetricsPort({sampler,currentWindow:()=>win.isDestroyed()?null:{windowId:win.id,webContentsId:win.webContents.id,generation:runtime.rendererGeneration(win.webContents)}})
      toolkit=new ToolkitOwner({openRunPort:()=>runtime.toolkitRunPort(),enabled:()=>true,launch:()=>({
        runner:process.execPath,cli,script:asset,cwd:app.getPath('userData'),env:{ELECTRON_RUN_AS_NODE:'1'}})})
      const stopIpc=registerToolkitIpc(toolkit,(channel,handler)=>ipcMain.handle(channel,handler))
      controlServer=new AgentMuxControlServer({execute:async()=>{throw Error('私有Toolkit场景不准入其他Control写操作')},metrics,toolkit})
      await controlServer.start()
      stop=async()=>{stopIpc();await toolkit.dispose();await controlServer.stop();metrics.dispose();detachRuntime();await runtime.dispose()}
    }
    win.webContents.on('console-message',(_event,_level,message)=>raw.errors.push(message))
    win.webContents.on('preload-error',(_event,_p,error)=>raw.errors.push(String(error)))
    await win.loadFile(html);win.showInactive();win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    const read=expression=>win.webContents.executeJavaScript(expression)
    const q=selector=>'document.querySelector('+JSON.stringify(selector)+')'
    const until=async expression=>{const deadline=Date.now()+8000;do{if(await read(expression))return;await pause(20)}while(Date.now()<deadline);throw Error('Actual Renderer未收敛: '+expression)}
    const settle=async()=>{await read('document.fonts.ready');await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await pause(180)}
    const point=async expression=>read('(()=>{const n='+expression+';if(!n?.isConnected||!n.checkVisibility())throw Error("原connected可见控制缺失");const r=n.getBoundingClientRect();for(const f of [.5,.15,.85]){const x=r.x+r.width*.5,y=r.y+r.height*f;if(n.contains(document.elementFromPoint(x,y)))return{x,y,label:n.getAttribute("aria-label")||n.textContent.trim()}}throw Error("原pointer目标不可达: "+n.className)})()')
    const click=async expression=>{let p;try{p=await point(expression)}catch{await read('('+expression+').scrollIntoView({block:"nearest"})');await settle();p=await point(expression)}
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});raw.actions.push({type:'click',...p});await settle()}
    const hover=async()=>{const p=await point(q('.performance-trigger'));win.webContents.sendInputEvent({type:'mouseMove',x:p.x,y:p.y});raw.actions.push({type:'hover',...p});await until('!!document.querySelector(".performance-popover")');await settle()}
    const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode});await settle()}
    const close=async()=>{await click(q('[data-performance-close]'));await until('!document.querySelector(".performance-popover")');assert.equal(leases.size,0,'Close释放真实registeredIPC此lease')}
    const scene=async(width,theme)=>{win.setContentSize(width,900);await read('window.performanceScene.theme('+JSON.stringify(theme)+')');await until('innerWidth==='+width+'&&document.documentElement.dataset.appearance==='+JSON.stringify(theme));await settle()}
    const buttonSelector='.surface-navigation button,.window-status-bar__utilities > button,.window-status-bar__toolkits .performance-trigger'
    const buttonStyles=async()=>read('('+function(selector){
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d')
      const alpha=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return context.getImageData(0,0,1,1).data[3]/255}
      const rules=[];const walk=list=>{for(const rule of list){if(rule.selectorText)rules.push(rule);else if(rule.cssRules)walk(rule.cssRules)}}
      for(const sheet of document.styleSheets)walk(sheet.cssRules)
      return [...document.querySelectorAll(selector)].map(node=>{
        const style=getComputedStyle(node),glyph=node.querySelector(':scope > svg'),glyphStyle=glyph&&getComputedStyle(glyph)
        return {label:node.getAttribute('aria-label'),connected:node.isConnected&&node.checkVisibility(),bounds:node.getBoundingClientRect().toJSON(),
          current:node.getAttribute('aria-current'),expanded:node.getAttribute('aria-expanded'),hover:node.matches(':hover'),focus:node.matches(':focus-visible'),
          background:style.backgroundColor,alpha:alpha(style.backgroundColor),outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth),outlineAlpha:alpha(style.outlineColor),outlineOffset:parseFloat(style.outlineOffset),
          color:style.color,radius:style.borderRadius,transitionProperty:style.transitionProperty,transitionDuration:style.transitionDuration,animationDuration:style.animationDuration,
          transform:style.transform,filter:style.filter,backdropFilter:style.backdropFilter,boxShadow:style.boxShadow,runningAnimations:node.getAnimations().filter(a=>a.playState==='running').length,
          glyph:glyph&&{width:glyph.getBoundingClientRect().width,height:glyph.getBoundingClientRect().height,strokeWidth:glyphStyle.strokeWidth,transform:glyphStyle.transform},
          statusGlyphs:[...node.querySelectorAll('[data-focus-count] svg')].map(svg=>({width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height,strokeWidth:getComputedStyle(svg).strokeWidth})),
          owningRules:rules.filter(rule=>node.matches(rule.selectorText)&&(/surface-navigation button|window-status-bar__utility-button|performance-trigger/.test(rule.selectorText))).map(rule=>({selector:rule.selectorText,background:rule.style.background,outline:rule.style.outline}))}
      })
    }.toString()+')('+JSON.stringify(buttonSelector)+')')
    const focusStyle=async()=>{
      const styles=await buttonStyles(),focused=styles.filter(button=>button.focus)
      assert.equal(focused.length,1,'原生键盘焦点准确落到七常规入口之一')
      const button=focused[0]
      assert.ok(button.connected&&button.owningRules.length>0,'实际焦点owning CSSOM与connected按钮非空')
      assert.ok(button.outlineStyle==='solid'&&button.outlineWidth>=1&&button.outlineAlpha>0&&button.outlineOffset>=-button.bounds.height/2,'键盘焦点有完整可见轮廓')
      raw.buttonFocus.push(button);return button
    }
    const captureButtons=async(file,description)=>{
      await settle();const styles=await buttonStyles();assert.equal(styles.length,7,'实际七个普通按钮采样非空')
      const png=(await win.webContents.capturePage()).toPNG();fs.writeFileSync(path.join(evidence,file),png)
      raw.frames.push({file,sha256:createHash('sha256').update(png).digest('hex'),description,buttonStyles:styles,width:await read('innerWidth'),theme:await read('document.documentElement.dataset.appearance')})
    }
    const capture=async(file,description)=>{
      await settle()
      const geometry=await read('(()=>{const p=document.querySelector(".performance-popover"),s=document.querySelector(".window-status-bar"),t=document.querySelector(".performance-trigger"),r=p?.getBoundingClientRect(),rect=q=>document.querySelector(q)?.getBoundingClientRect().toJSON();return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth,panel:r?.toJSON(),footer:s?.getBoundingClientRect().toJSON(),trigger:t?.getBoundingClientRect().toJSON(),settings:rect(".surface-navigation [aria-label=Settings]"),keyboard:rect("[aria-label=\\"Keyboard shortcuts\\"]"),navigation:rect(".surface-navigation__surfaces"),text:p?.textContent,role:p?.getAttribute("role"),focus:document.activeElement?.getAttribute("aria-label"),animationCount:p?[...p.querySelectorAll("*"),p].flatMap(n=>n.getAnimations()).filter(a=>a.playState==="running").length:0}})()')
      assert.equal(geometry.overflow,0,'实际App无横溢');assert.equal(geometry.role,'dialog')
      assert.ok(geometry.panel.width>0&&geometry.panel.x>=0&&geometry.panel.right<=geometry.width+1,'原浮窗位于实际viewport')
      assert.ok(geometry.panel.top>=0&&geometry.panel.bottom<=geometry.footer.top+1,'实际浮窗不遮状态栏入口')
      assert.ok(geometry.navigation.right<=geometry.settings.left&&geometry.settings.right<=geometry.keyboard.left&&geometry.keyboard.right<=geometry.trigger.left&&geometry.trigger.right<=geometry.footer.right,'实际Settings在左、Toolkit为右端工具位')
      const png=(await win.webContents.capturePage()).toPNG();fs.writeFileSync(path.join(evidence,file),png);raw.frames.push({file,sha256:createHash('sha256').update(png).digest('hex'),description,geometry})
    }
    await until('window.performanceScene?.ready&&!!document.querySelector(".performance-trigger")&&!!document.querySelector(".xterm-helper-textarea")')
    await settle()
    const surface=await read('window.performanceScene.surface()')
    raw.initialSurface=surface
    assert.ok(Object.keys(surface.tabs).length>0&&Object.keys(surface.layouts).length>0&&surface.sessions.length>0,'原工作面非空')
    if(phase==='joined') {
      const before=JSON.parse(fs.readFileSync(path.join(evidence,'control-render.json'))).surface
      assert.deepEqual(surface,before,'Joined真实tool执行仍保原durable工作面')
      assert.equal(toolkit.current.consumerCount,0,'真实Toolkit关闭无观察')
      await click(q('.performance-trigger'))
      await until('document.querySelector(".performance-status")?.textContent.includes("Observing")')
      const deadline=Date.now()+15000
      while(toolkit.current.sequence<2&&Date.now()<deadline)await pause(50)
      assert.ok(toolkit.current.sequence>=2,'真实官方script/compiled CLI/Core/ctxmux至少两帧')
      const initial=toolkit.current
      assert.ok(initial.run?.runId&&initial.observation?.app.data&&initial.observation.scope.mainPid===process.pid,'真实registered Main与官方观察identity非空')
      const privateCore=runtime.hosts.get('local').client
      const run=(await privateCore.listRuns()).find(run=>run.runId===initial.run.runId)
      assert.equal(run.state,'running');assert.ok(run.pid>0,'真实Core RawRun进程非空')
      const controller=new AbortController(),observer=[]
      const other=await toolkit.subscribe('performance',value=>observer.push(value),()=>{},controller.signal)
      assert.equal(toolkit.current.consumerCount,2,'另一真实消费者正控')
      await capture('1480-dark-joined-official.png','Actual registered Toolkit owner → official asset → compiled public CLI → private Core/ctxmux → real Renderer result')
      await click(q('[data-performance-observation-toggle]'))
      assert.equal(toolkit.current.consumerCount,1,'UI Pause只释放自己的lease')
      const sequence=toolkit.current.sequence
      const continuing=Date.now()+6000;while(toolkit.current.sequence===sequence&&Date.now()<continuing)await pause(50)
      assert.ok(toolkit.current.sequence>sequence,'另一watch保持真实官方执行与新帧')
      assert.equal(toolkit.current.run.runId,initial.run.runId,'Pause不更换真实工具Run')
      await click(q('[data-performance-observation-toggle]'));assert.equal(toolkit.current.consumerCount,2)
      await click(q('.performance-actions > button:first-child'))
      await until('!!document.querySelector("[aria-label=\\"Official Performance script source\\"]")')
      assert.equal(toolkit.current.consumerCount,1,'Script释放UI消费并保另一watch')
      assert.equal(await read('document.querySelector("[aria-label=\\"Official Performance script source\\"]").value'),scriptText,'真实owner发布script精确资产')
      await click(q('[data-performance-close]'))
      other.dispose();controller.abort();await toolkit.dispose()
      const retired=Date.now()+10000
      while((await privateCore.listRuns()).some(item=>item.runId===run.runId)&&Date.now()<retired)await pause(20)
      assert.deepEqual(await privateCore.listRuns(),[],'完整公开cleanup真实owned RawRun回收')
      assert.equal(toolkit.current.consumerCount,0)
      assert.deepEqual(await read('window.performanceScene.surface()'),surface,'真实tool操作保原工作面/Session/draft')
      raw.joined={officialExecution:true,runId:run.runId,pid:run.pid,sequence:initial.sequence,continuedSequence:toolkit.current.sequence,
        asset,assetSHA:scriptSHA,cli,cliSHA:createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),native:privateCore.runtimeIdentity(),
        otherConsumerFrames:observer.length,allOwnedRunsRemoved:true,boundary:'真实Toolkit注册Main/原sampler/官方脚本/公开CLI/Core/私有ctxmux与actual Renderer。Main其余功能未重造；原Terminal是明确preview transport，非用户现场FPS或NativeAgent输入资格。'}
      raw.surface=surface
    } else if(phase==='restart') {
      const before=JSON.parse(fs.readFileSync(path.join(evidence,'control-render.json'))).surface
      assert.deepEqual(surface,before,'普通私有进程restart保原Tab/Region/layout/draft/Session exact')
      assert.ok((await read('window.performanceScene.attachments')).length>0,'Restart原TerminalView自动实际reattach previewRun正控')
      assert.equal(leases.size,0,'Restart关闭布局不建立Performance观察')
      raw.surface=surface;raw.restart={exactSurface:true,attachmentCount:await read('window.performanceScene.attachments.length')}
    } else {
      assert.equal(leases.size,0,'icon/label关闭不观察')
      assert.equal(await read('document.querySelectorAll(".window-status-bar [aria-label=Settings]").length'),1,'实际App唯一Settings入口')
      assert.equal(await read('document.querySelector(".window-status-bar__right [aria-label=Settings]")'),null,'右侧不保留Settings副本')
      if(phase==='buttons') {
        raw.buttonFocus=[];raw.buttonStates=[]
        const styles=await buttonStyles();assert.equal(styles.length,7,'actual App七入口自身非空正控')
        assert.ok(styles.every(button=>button.connected&&button.bounds.width>0&&button.glyph&&button.owningRules.length>0),'七connected实际按钮/glyph/CSSOM非空')
        const selected=styles.filter(button=>button.current==='page');assert.equal(selected.length,1,'四工作面唯一真实current')
        assert.ok(selected[0].alpha>0,'真实状态面与 idle 不同')
        for(const button of styles){
          assert.equal(button.glyph.width,14);assert.equal(button.glyph.height,14);assert.equal(parseFloat(button.glyph.strokeWidth),1.7)
          assert.equal(button.radius,'4px');assert.equal(button.transform,'none');assert.equal(button.glyph.transform,'none');assert.equal(button.filter,'none');assert.equal(button.backdropFilter,'none')
          assert.equal(button.runningAnimations,0,'普通按钮idle无持续动画')
          assert.ok(button.statusGlyphs.length===0||button.statusGlyphs.every(glyph=>glyph.width===11&&glyph.height===11&&parseFloat(glyph.strokeWidth)===2),'Focus原11px状态glyph保留')
          if(!button.current&&button.expanded!=='true')assert.equal(button.alpha,0,'普通按钮idle透明')
        }
        raw.buttonStates.push({state:'idle',styles})
        if(process.env.AGENTMUX_PERFORMANCE_BUTTON_MUTANT==='focus'){
          await click(q('.performance-trigger'));await key('Escape')
          // 真实Tab经过合法通知邻接，只在本轮七入口检查owning focus。
          for(let i=0;i<8;i++){
            win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});await settle()
            if(await read('document.activeElement.matches('+JSON.stringify(buttonSelector)+')')){await focusStyle();break}
          }
        }
      }
      raw.statusbarGeometry=[]
      for(const width of [1480,640,320]) {
        await scene(width,'dark')
        let anchor, navigationAnchor, rightAnchor
        for(const variant of ['label','icon','disabled']) {
          await read('window.performanceScene.preferences('+JSON.stringify(variant!=='disabled')+','+JSON.stringify(variant==='icon'?'icon':'label')+')');await settle()
          const geometry=await read('(()=>{const s=document.querySelector(".surface-navigation [aria-label=Settings]"),t=document.querySelector(".performance-trigger"),n=document.querySelector(".surface-navigation__surfaces"),k=document.querySelector("[data-shortcut-help-open]"),u=document.querySelector(".window-status-bar__utilities");return{width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,settings:s?.getBoundingClientRect().toJSON(),navigation:n.getBoundingClientRect().toJSON(),navigationButtons:[...n.querySelectorAll("button")].map(b=>({label:b.getAttribute("aria-label"),bounds:b.getBoundingClientRect().toJSON()})),utilities:u.getBoundingClientRect().toJSON(),keyboard:k.getBoundingClientRect().toJSON(),trigger:t?.getBoundingClientRect().toJSON(),label:t?.getAttribute("aria-label"),text:t?.textContent,spanWidth:t?.querySelector("span")?.getBoundingClientRect().width,settingsConnected:!!s?.isConnected&&s.checkVisibility(),settingsCount:document.querySelectorAll(".window-status-bar [aria-label=Settings]").length,settingsAfterGroup:s?.previousElementSibling===n,settingsAriaCurrent:s?.hasAttribute("aria-current"),rightSettings:!!document.querySelector(".window-status-bar__right [aria-label=Settings]"),rightToolkit:!t||!!t.closest(".window-status-bar__right .window-status-bar__toolkits")}})()')
          assert.equal(geometry.overflow,0);assert.equal(geometry.settingsCount,1);assert.equal(geometry.settingsConnected,true);assert.equal(geometry.settingsAfterGroup,true);assert.equal(geometry.settingsAriaCurrent,false);assert.equal(geometry.rightSettings,false);assert.equal(geometry.rightToolkit,true)
          assert.equal(geometry.navigationButtons.length,4,'原Work surfaces四按钮不混入Settings')
          for(const bounds of [geometry.settings,geometry.keyboard,geometry.navigation,...geometry.navigationButtons.map(b=>b.bounds),...(geometry.trigger?[geometry.trigger]:[])])assert.ok(bounds.width>0&&bounds.height>0&&bounds.x>=0&&bounds.right<=width,'实际connected控件正面积且在viewport')
          assert.ok(geometry.navigation.right<=geometry.settings.left&&geometry.settings.right<=geometry.keyboard.left,'左功能导航/Settings与右工具区不交叠')
          if(anchor){assert.deepEqual(geometry.settings,anchor,'icon/label/disabled不移动左Settings');assert.deepEqual(geometry.navigationButtons,navigationAnchor,'工具宽度不移动原功能导航');assert.equal(geometry.utilities.right,rightAnchor,'右工具组锚稳定')}
          else {anchor=geometry.settings;navigationAnchor=geometry.navigationButtons;rightAnchor=geometry.utilities.right}
          await point(q('.surface-navigation [aria-label="Settings"]'));await point(q('[data-shortcut-help-open]'))
          if(variant==='disabled')assert.equal(geometry.trigger,undefined,'关闭配置移除Toolkit入口')
          else {assert.equal(geometry.label,'Performance');assert.ok(geometry.keyboard.right<=geometry.trigger.left&&geometry.trigger.right<=geometry.utilities.right);await point(q('.performance-trigger'))
            if(variant==='label'){assert.equal(geometry.text,'Performance');assert.ok(geometry.spanWidth>=20,'窄窗label保可见文字与完整accessible name')}
            else {assert.equal(geometry.text,'');if(phase==='buttons')assert.ok(geometry.trigger.width<=geometry.keyboard.width+4,'icon-only Performance无独有40px空槽')}}
          raw.statusbarGeometry.push({variant,...geometry})
        }
      }
      assert.equal(raw.statusbarGeometry.length,9,'三宽三显示配置非空九组')
      await read('window.performanceScene.preferences(true,"label")');await scene(1480,'dark')
      const requiredTargets=await read('[...document.querySelectorAll(".surface-navigation button,.window-status-bar__utilities button")].filter(n=>n.isConnected&&n.checkVisibility()).map(n=>n.getAttribute("aria-label"))')
      assert.equal(requiredTargets.length,7,'实际四功能加Settings/Keyboard/Performance七入口');assert.ok(requiredTargets.every(Boolean),'每个原入口具名')
      const keyboardTargets=await read('[...document.querySelectorAll(".surface-navigation button,.window-status-bar__right button")].filter(n=>n.isConnected&&n.checkVisibility()).map(n=>n.getAttribute("aria-label"))')
      assert.ok(keyboardTargets.length>=7&&requiredTargets.every(label=>keyboardTargets.includes(label)),'原七入口都在真实Footer焦点序列中，保现System notifications邻接')
      raw.statusbarKeyboard=[]
      for(const width of [1480,640,320]) {
        await scene(width,'dark');await click(q('.performance-trigger'));await key('Escape')
        assert.equal(await read('document.activeElement===document.querySelector(".performance-trigger")'),true,'显式浮窗Escape真实回入口')
        const reached=new Set(['Performance']),nativeTab=[]
        for(const expected of keyboardTargets.slice(0,-1).reverse()) {
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});await settle()
          const focus=await read('document.activeElement.getAttribute("aria-label")');assert.equal(focus,expected,'原生ShiftTab准确到connected可见邻接控件');nativeTab.push({direction:'backward',focus});reached.add(focus)
          if(phase==='buttons'&&requiredTargets.includes(focus))await focusStyle()
        }
        for(const expected of keyboardTargets.slice(1)) {await key('Tab');const focus=await read('document.activeElement.getAttribute("aria-label")');assert.equal(focus,expected,'原生Tab准确到connected可见邻接控件');nativeTab.push({direction:'forward',focus});reached.add(focus);if(phase==='buttons'&&requiredTargets.includes(focus))await focusStyle()}
        assert.deepEqual([...reached].sort(),[...keyboardTargets].sort(),'原生Tab/ShiftTab可达两组全部入口')
        raw.statusbarKeyboard.push({width,requiredTargets,targets:keyboardTargets,reached:[...reached],nativeTab})
      }
      if(phase==='placement'||phase==='buttons') {
        raw.qualificationScope=phase==='buttons'?'statusbar-buttons-only':'settings-left-placement-only'
        raw.boundary='仅本次左右归属/实际Footer/七原生控件与Settings开合、原工作面保持；不签full hidden/restart/joined/T004。'
        await scene(1480,'dark')
        const mainSurface=await read('window.performanceScene.mainSurface()')
        await read('window.originalPlacementTerminal=document.querySelector(".xterm-helper-textarea")')
        await click(q('.surface-navigation [aria-label="Settings"]'))
        await until('document.querySelector(".settings-page")?.dataset.settingsPage==="overview"')
        assert.equal(await read('window.performanceScene.mainSurface()'),mainSurface,'Settings打开不改变原mainSurface')
        assert.equal(await read('document.querySelector(".surface-navigation [aria-label=Settings]").getAttribute("aria-expanded")'),'true')
        if(phase==='buttons'){
          const styles=await buttonStyles(),settings=styles.find(button=>button.label==='Settings')
          assert.ok(settings.expanded==='true'&&!settings.current&&settings.alpha>0,'Settings真实expanded驱动反馈面，无第五current')
          raw.buttonStates.push({state:'settings-expanded',styles});await captureButtons('1480-dark-settings-expanded.png','Left Settings expanded / real low emphasis state')
        }
        await click(q('.surface-navigation [aria-label="Settings"]'))
        await until('!document.querySelector(".settings-page")')
        await click(q('.surface-navigation [aria-label="Settings"]'));await key('Escape')
        await until('!document.querySelector(".settings-page")')
        assert.equal(await read('window.performanceScene.mainSurface()'),mainSurface,'Settings再次点击及Escape保原mainSurface')
        assert.equal(await read('window.originalPlacementTerminal===document.querySelector(".xterm-helper-textarea")&&window.originalPlacementTerminal.isConnected'),true,'Settings开合保原xterm输入节点')
        if(phase==='buttons'){
          const move=async expression=>{const p=await point(expression);win.webContents.sendInputEvent({type:'mouseMove',x:p.x,y:p.y});await settle();return p}
          const labels=(await buttonStyles()).map(button=>button.label),boundsBefore=(await buttonStyles()).map(button=>({label:button.label,bounds:button.bounds}))
          raw.buttonPointer=[]
          for(const label of labels){
            const selector='.window-status-bar button[aria-label='+JSON.stringify(label)+']',expression=q(selector),p=await move(expression)
            if(label==='Performance')await until('!!document.querySelector(".performance-popover")')
            const style=(await buttonStyles()).find(button=>button.label===label)
            assert.equal(style.hover,true,'trusted pointer真实悬停原入口')
            assert.ok(style.alpha>0,'hover或真实current/expanded有有限反馈')
            if(!style.current&&style.expanded!=='true')assert.ok(style.alpha<0.09,'hover比current/expanded反馈更轻')
            win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});await settle()
            assert.deepEqual((await buttonStyles()).map(button=>({label:button.label,bounds:button.bounds})),boundsBefore,'hover/press不改变七入口bounds')
            assert.equal((await buttonStyles()).find(button=>button.label===label).boxShadow,'none','七普通按钮按压无旧inset阴影')
            const outside={x:p.x,y:p.y-30};win.webContents.sendInputEvent({type:'mouseMove',...outside});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...outside});await settle()
            raw.buttonPointer.push({label,hover:style,pressedBoundsStable:true})
            if(label==='Performance'&&await read('!!document.querySelector(".performance-popover")'))await close()
          }
          await click(q('.xterm-helper-textarea'));const originalFocus=await read('document.activeElement===window.originalPlacementTerminal')
          assert.equal(originalFocus,true,'实际Terminal输入焦点正控')
          await hover();assert.equal(await read('document.activeElement===window.originalPlacementTerminal'),true,'Performance hover不抢原输入')
          const expanded=(await buttonStyles()).find(button=>button.label==='Performance');assert.equal(expanded.expanded,'true');assert.ok(expanded.alpha>0,'Performance真实expanded反馈面')
          raw.buttonStates.push({state:'performance-hover-expanded',styles:await buttonStyles()});await close()
          await click(q('.surface-navigation__surfaces [aria-current="page"]'));assert.equal(await read('window.performanceScene.mainSurface()'),mainSurface,'当前Space可信click保原工作面')
          for(const width of [1480,320]){
            await scene(width,'dark');await move(q('[data-shortcut-help-open]'));await captureButtons(width+'-dark-keyboard-hover.png','Light Keyboard hover / full App')
            await click(q('.performance-trigger'));await key('Escape')
            do{win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});await settle()}while(!await read('document.activeElement.matches('+JSON.stringify(buttonSelector)+')'))
            await focusStyle();await captureButtons(width+'-dark-native-focus.png','Real native Tab focus / complete visible outline')
          }
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await settle()
          assert.equal(await read('matchMedia("(prefers-reduced-motion: reduce)").matches'),true,'实际媒体偏好reduce正控')
          const reduced=await buttonStyles();assert.equal(reduced.length,7)
          for(const button of reduced){assert.ok(button.transitionDuration.split(',').every(value=>parseFloat(value)===0),'reduce下实际全部transition duration为零');assert.ok(button.animationDuration.split(',').every(value=>parseFloat(value)===0),'reduce下实际全部animation duration为零')}
          raw.buttonReduced={matchMedia:true,styles:reduced}
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});await settle();assert.equal(await read('matchMedia("(prefers-reduced-motion: reduce)").matches'),false)
        }
        for(const [width,theme,file] of [[1480,'dark','1480-dark-placement.png'],[1480,'light','1480-light-placement.png'],[640,'dark','640-dark-placement.png'],[320,'dark','320-dark-placement.png'],[320,'light','320-light-placement.png']]) {
          await scene(width,theme);await click(q('.performance-trigger'));await capture(file,'Settings left / Toolkit right / complete actual App Footer');await close()
        }
        raw.surface=await read('window.performanceScene.surface()');assert.deepEqual(raw.surface,surface,'有限placement开合保原Tab/Region/Session/layout/focus/draft snapshot')
        raw.settings={unique:true,left:true,rightDuplicate:false,openClose:true,escape:true,sameMainSurface:mainSurface,sameTerminalInputNode:true}
        assert.equal(leases.size,0,'本次placement关闭无自己的观察lease')
        if(phase==='buttons'){raw.boundary='T005七普通按钮有限状态/几何/原生焦点/reduce/原工作面保持；不签T002/fullT004/hidden/restart/joined/用户FPS';assert.equal(raw.buttonPointer.length,7)}
      } else {
      await scene(1480,'dark')
      // Fresh点击：不得只通过先hover再click规避hidden元素无法接焦点。
      await click(q('.performance-trigger'))
      await until('document.activeElement===document.querySelector("[data-performance-close]")')
      assert.equal(leases.size,1,'实际App观察consumer非空')
      const tabbed=[]
      for(let i=0;i<10;i++){await key('Tab');tabbed.push(await read('({tag:document.activeElement.tagName,text:document.activeElement.textContent,within:document.querySelector(".performance-popover").contains(document.activeElement)})'));if(tabbed.at(-1).text?.trim()==='View script')break}
      assert.ok(tabbed.length>0&&tabbed.some(item=>item.tag==='BUTTON'&&item.text.trim()==='View script'&&item.within),'原生Tab实际进入浮窗操作')
      await key('Tab');await key('Tab')
      assert.equal(await read('document.activeElement===document.querySelector(".performance-actions > button:last-child")'),true,'原生Tab到真实Configure')
      await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});await settle()
      assert.equal(await read('document.activeElement===document.querySelector("[data-performance-observation-toggle]")'),true,'原生ShiftTab回真实Pause')
      raw.nativeTab=tabbed
      await capture('1480-dark-app.png','actual App dark / fresh explicit entry / native Tab')
      await close();await scene(1480,'light');await click(q('.performance-trigger'));await capture('1480-light-app.png','actual App light / overview')
      await close();await scene(320,'dark');await click(q('.performance-trigger'));await capture('320-dark-app.png','actual App narrow / complete header and actions')
      await close();await scene(320,'light');await click(q('.performance-trigger'));await capture('320-light-app.png','actual App narrow light / complete header and actions')
      await close();await scene(1480,'dark')
      // 原TerminalView及其原subscribeTerminalInput/terminalInputSender收到可信Escape字节。
      await click(q('.xterm-screen'));await until('document.activeElement.matches(".xterm-helper-textarea")')
      await read('window.originalTerminalInput=document.activeElement')
      const beforeWrites=await read('window.performanceScene.writes.length')
      await hover()
      const panelPoint=await point(q('[data-performance-observation-toggle]'));win.webContents.sendInputEvent({type:'mouseMove',x:panelPoint.x,y:panelPoint.y});await settle()
      assert.equal(await read('!!document.querySelector(".performance-popover")'),true,'真实指针从入口移至浮窗保持预览')
      assert.equal(await read('document.activeElement===window.originalTerminalInput'),true,'Hover不抢原Terminal焦点')
      await key('Escape')
      assert.equal(await read('!!document.querySelector(".performance-popover")'),false)
      const terminalWrites=await read('window.performanceScene.writes.slice('+beforeWrites+')')
      assert.ok(terminalWrites.some(item=>item.control.run.runId==='run-codex'&&item.data==='\u001b'&&item.source==='user'),'Passive hover Escape reaches original Terminal input handler exactly')
      assert.equal(await read('document.activeElement===window.originalTerminalInput&&window.originalTerminalInput.isConnected'),true)
      raw.terminalEscape={writes:terminalWrites,sameNode:true}
      // Settings已有dirty Prompt，hover不改node/value/selection，IME实际输入及Escape归最上层。
      await click(q('.window-status-bar [aria-label="Settings"]'));await click(q('nav [data-settings-target="prompts"]'))
      const editor=q('[data-prompt-editor] textarea')
      await click(editor)
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65,commands:['selectAll']})
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65})
      const draft='  中文组字\nexact original draft  '
      await win.webContents.debugger.sendCommand('Input.insertText',{text:draft});await settle()
      await read('window.originalPrompt=document.activeElement;window.promptSelection=[document.activeElement.selectionStart,document.activeElement.selectionEnd]')
      await hover()
      assert.equal(await read('document.activeElement===window.originalPrompt'),true,'Hover keeps actual Settings input focus')
      await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'中',selectionStart:0,selectionEnd:1})
      await key('Escape')
      assert.equal(await read('!!document.querySelector(".performance-popover")'),true,'真实IME组字Escape仍归原输入')
      await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await settle()
      await key('Escape')
      assert.equal(await read('!!document.querySelector(".performance-popover")'),false,'组字后Escape关闭Tool')
      assert.equal(await read('document.querySelector("[data-prompt-editor] textarea")===window.originalPrompt&&window.originalPrompt.isConnected&&document.activeElement===window.originalPrompt'),true,'Tool Escape保持原Settings同节点与焦点')
      assert.equal(await read('window.originalPrompt.value'),draft,'Tool Escape保exact authored draft')
      raw.prompt={value:await read('window.originalPrompt.value'),sameNode:true,selection:await read('[window.originalPrompt.selectionStart,window.originalPrompt.selectionEnd]'),originalSelection:await read('window.promptSelection')}
      await click(q('.performance-trigger'))
      await click(q('[data-settings-target="runs"]'))
      await click(q('.performance-contributor summary'));await capture('1480-dark-runs.png','actual App Runs / compound identity / selected history')
      await scene(320,'dark');await capture('320-dark-run-details.png','actual narrow Run / complete long identity in expanded details')
      await scene(1480,'dark')
      await click(q('.performance-show-all'));await capture('1480-dark-all-runs.png','actual App all Runs / tool exact context / scroll body')
      await click(q('[data-settings-target="runtime"]'));await capture('1480-dark-runtime.png','Runtime facts / independent source time / no fabricated CPU')
      await click(q('[data-settings-target="app"]'))
      await click(q('.performance-disclosure summary'));await capture('1480-dark-owner-details.png','Actual bounded resource owners / nullable counts and individual source times')
      await click(q('.performance-disclosure summary'))
      await read('(()=>{const s=structuredClone(window.performanceScene.snapshot);s.observedAt+=30000;s.observation.observedAt+=30000;s.observation.app.state="stale";s.observation.app.reason="Application readings could not be refreshed.";return window.performanceScene.publish(s)})()')
      await scene(940,'light')
      await capture('940-light-stale.png','Source stale with its real lastSuccessAt / independent age')
      await scene(1480,'dark')
      await read('(()=>{const s=structuredClone(window.performanceScene.snapshot);s.observedAt+=35000;s.observation.observedAt+=35000;s.observation.app={data:null,observedAt:null,lastSuccessAt:null,state:"unavailable",reason:"Application process readings are unavailable."};return window.performanceScene.publish(s)})()')
      await capture('1480-dark-unknown.png','Unavailable App source / no fabricated zero / other source details retained')
      await click(q('[data-performance-observation-toggle]'));assert.equal(leases.size,0,'Pause释放此consumer');await capture('1480-dark-paused.png','Pause only here / latest reading kept')
      await click(q('[data-performance-observation-toggle]'));assert.equal(leases.size,1)
      // private realwindow.hide：不改getter、不fake visibilityevent、不固定动画clock。
      raw.windowPhase='hide-requested'
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false})
      win.minimize();win.hide()
      raw.visibilityBeforeWait={visible:win.isVisible(),minimized:win.isMinimized(),page:await read('({hidden:document.hidden,visibilityState:document.visibilityState})')}
      await until('document.hidden===true');await pause(100)
      raw.windowPhase='hidden-checkpoint'
      const nativeBeforeHiddenRead={visible:win.isVisible(),minimized:win.isMinimized()}
      const hiddenPage=await read('({hidden:document.hidden,visibilityState:document.visibilityState,popoverPresent:!!document.querySelector(".performance-popover")})')
      const nativeAfterHiddenRead={visible:win.isVisible(),minimized:win.isMinimized()}
      raw.hidden={at:Date.now(),documentHidden:hiddenPage.hidden,visibilityState:hiddenPage.visibilityState,
        leases:leases.size,popoverPresent:hiddenPage.popoverPresent,nativeBeforeHiddenRead,nativeAfterHiddenRead}
      assert.equal(nativeBeforeHiddenRead.visible,false,'显式恢复前原生窗口保持隐藏，真实page读取前')
      assert.equal(nativeAfterHiddenRead.visible,false,'显式恢复前原生窗口保持隐藏，真实page读取后')
      assert.equal(hiddenPage.hidden,true,'显式恢复前真实页面仍为hidden')
      assert.equal(hiddenPage.visibilityState,'hidden','显式恢复前真实visibilityState仍为hidden')
      assert.equal(raw.hidden.leases,0,'True hidden释放真实此UI lease')
      assert.equal(hiddenPage.popoverPresent,false,'True hidden原浮窗DOM离场')
      raw.windowPhase='explicit-show-after-hidden'
      raw.actions.push({type:'explicit-show-after-hidden',at:Date.now()})
      win.restore();win.showInactive();await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await until('document.hidden===false&&!!document.querySelector(".performance-popover")');await settle()
      const nativeBeforeShownRead={visible:win.isVisible(),minimized:win.isMinimized()}
      const shownPage=await read('({hidden:document.hidden,visibilityState:document.visibilityState,popoverPresent:!!document.querySelector(".performance-popover")})')
      const nativeAfterShownRead={visible:win.isVisible(),minimized:win.isMinimized()}
      raw.shown={at:Date.now(),documentHidden:shownPage.hidden,visibilityState:shownPage.visibilityState,
        leases:leases.size,popoverPresent:shownPage.popoverPresent,nativeBeforeShownRead,nativeAfterShownRead}
      assert.equal(nativeBeforeShownRead.visible,true,'显式恢复后原生窗口可见，真实page读取前')
      assert.equal(nativeAfterShownRead.visible,true,'显式恢复后原生窗口可见，真实page读取后')
      assert.equal(shownPage.hidden,false,'显式恢复后真实页面可见')
      assert.equal(shownPage.visibilityState,'visible','显式恢复后真实visibilityState可见')
      assert.equal(shownPage.popoverPresent,true,'显式恢复后浮窗真实恢复')
      assert.equal(raw.shown.leases,1,'Show restores one owned observation')
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
      await pause(500)
      assert.equal(await read('[...document.querySelector(".performance-popover").querySelectorAll("*")].flatMap(n=>n.getAnimations()).filter(a=>a.playState==="running").length'),0,'Reduced浮窗无持续animation')
      raw.reduced={running:0}
      await click(q('.performance-actions > button:first-child'));await until('!!document.querySelector("[aria-label=\\"Official Performance script source\\"]")')
      assert.equal(leases.size,0,'只读script页不保持数字观察');assert.equal(await read('document.querySelector("[aria-label=\\"Official Performance script source\\"]").readOnly'),true)
      assert.equal(await read('document.querySelector("[aria-label=\\"Official Performance script source\\"]").value'),scriptText,'真正published官方script精确只读')
      await capture('1480-dark-script.png','Actual published asset path / SHA / readonly source')
      await click(q('[aria-label="Back to Performance"]'))
      await click(q('.performance-actions > button:last-child'))
      assert.equal(await read('document.querySelector(".settings-page").dataset.settingsPage'),'toolkit','实际Configure归唯一Toolkit Settings')
      assert.equal(leases.size,0)
      raw.surface=await read('window.performanceScene.surface()');assert.deepEqual(raw.surface,surface,'所有tool操作保原工作面/healthy Session/draft')
      raw.script={path:asset,sha256:scriptSHA}
      }
    }
    raw.nativeEvents=await read('window.performanceScene.events')
    assert.ok(raw.nativeEvents.some(event=>event.isTrusted&&event.key==='Tab')||phase==='restart'||phase==='joined','原生事件非空正控')
    await read('window.dispatchEvent(new Event("beforeunload"))');await win.webContents.session.flushStorageData()
    raw.qualified=true
  } catch(error) {raw.failure={name:error.name,message:error.message,stack:error.stack}}
  finally {
    raw.finalLeases=toolkit?.current.consumerCount??leases.size
    try{await stop()}catch(error){raw.qualified=false;raw.disposalFailure=String(error)}
    raw.afterDisposalLeases=toolkit?.current.consumerCount??leases.size
    fs.writeFileSync(path.join(evidence,phase+'-render.json'),JSON.stringify(raw,null,2)+'\n')
    win?.close();raw.qualified?app.quit():app.exit(1)
  }
})
