import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activate, click } from './desktop.mjs'

const nodes = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
const pane = '[data-settings-pane="browser"]:not([hidden])'
const checkbox = `${pane} input[type="checkbox"]`
const button = `${nodes(`${pane} .settings-pane-actions button`)}`
const nativeFixture = 'globalThis.__settingsBrowserNativeProof'

/** Drives real bundled UI and Main. Native remembered answers below are owned fixture
 * facts delivered through the registered callback, never proof of a human grant. */
export function browserSettingsProof({ probe, desktopRoot, root, command, configPath, waitFor, section, saved, phase }) {
  const facts = { scalar: {}, exactKeys: [], invalid: [], nativeFixtureAnswers: true }
  const state = (target = probe) => target.cdp.evaluate(`(() => {
    const root=document.querySelector(${JSON.stringify(pane)}); if(!root)throw new Error('Browser pane absent');
    return {enabled:root.querySelector('input[type="checkbox"]').checked,
      saveDisabled:root.querySelector('.settings-pane-actions button').disabled,
      status:root.querySelector('.settings-save-feedback')?.textContent??'',
      errors:Array.from(root.querySelectorAll('[role="alert"]')).map(e=>e.textContent),
      links:Array.from(root.querySelectorAll('.app-link-scheme-list li')).map(e=>({scheme:e.querySelector('code').textContent.slice(0,-1),choice:e.querySelector('.app-link-scheme-choice').textContent,forget:e.querySelector('button').textContent}))}
  })()`)
  const read = async () => JSON.parse(await readFile(configPath, 'utf8'))
  const publications = () => probe.cdp.evaluate('window.__settingsCliProof.configEvents.length')
  const preserved = config => ({ executors:config.executors, composerShortcuts:config.composerShortcuts,
    hosts:config.hosts, workspaces:config.workspaces, appearance:config.appearance,
    notifications:config.notifications, projectRailDensity:config.projectRailDensity, copyPathsAsAbsolute:config.copyPathsAsAbsolute,
    toolbar:config.browser.toolbar })
  const links = async () => {
    const response = await command(['settings','browser','links','list'])
    assert.equal(response.operation,'settings.browser.links.list'); assert.ok(Array.isArray(response.result.entries))
    assert.equal(new Set(response.result.entries.map(entry=>entry.scheme)).size,response.result.entries.length)
    return response.result.entries
  }
  const forget = async (args, scheme, changed = true, input) => {
    const response = await command(['settings','browser','links','forget',...args],0,input)
    assert.equal(response.operation,'settings.browser.links.forget')
    assert.deepEqual(response.result,{scheme,changed}); return response
  }
  const toggle = async () => { await click(probe.cdp,checkbox) }
  const save = async () => { await activate(probe.cdp,button); await saved(probe) }
  const show = (target = probe) => section(target,'Browser','browser')
  const scalar = async value => {
    const result = await command(['settings','set','browser.agentAutomation',String(value)])
    assert.deepEqual(result.result.entry,{key:'browser.agentAutomation',kind:'boolean',value,default:false})
    return result
  }
  const forgetButton = scheme => `${nodes(`${pane} .app-link-scheme-list li`)}.filter(e=>e.querySelector('code').textContent===${JSON.stringify(scheme+':')}).map(e=>e.querySelector('button'))`
  const settledForget = () => waitFor('actual Forget settled', async () => !(await state()).links.some(link=>link.forget==='Forgetting…'))
  const mainPath = join(desktopRoot,'out/main/index.js')
  let mainLines
  async function breakpoint(anchor) {
    mainLines ??= (await readFile(mainPath,'utf8')).split('\n')
    const found=mainLines.flatMap((line,index)=>line.includes(anchor)?[index]:[])
    assert.equal(found.length,1,`One actual compiled Main boundary: ${anchor}`)
    return await probe.main.call('Debugger.setBreakpointByUrl',{url:pathToFileURL(mainPath).href,lineNumber:found[0]})
  }
  async function pausedAt(point) {
    const paused=await waitFor('exact owned Main pause',()=>probe.main.pauses.shift())
    assert.ok(paused.hitBreakpoints?.includes(point.breakpointId)); return paused
  }
  async function release(point) {
    await probe.main.call('Debugger.removeBreakpoint',{breakpointId:point.breakpointId})
    await probe.main.call('Debugger.resume')
  }
  async function captureRegisteredNativeWriter() {
    const point=await breakpoint('if (request.operation === "settings.get" || request.operation === "settings.set")')
    const pending=command(['settings','get','browser.agentAutomation'])
    try {
      const paused=await pausedAt(point)
      const captured=await probe.main.call('Debugger.evaluateOnCallFrame',{callFrameId:paused.callFrames[0].callFrameId,
        expression:`(() => {
          const runtime=args.runtime,contents=args.window.webContents;
          const fixture=${nativeFixture}={remember:(scheme,choice)=>browsers.appLinks.rememberScheme(scheme,choice)};
          fixture.holdSave=()=>{
            const original=runtime.prepare;
            const held=new Promise(resolve=>{fixture.releaseSave=resolve});fixture.saveEntered=false;
            runtime.prepare=async(...input)=>{runtime.prepare=original;fixture.saveEntered=true;await held;return original.apply(runtime,input)};
          };
          fixture.holdPublication=()=>{
            const original=contents.send;fixture.delivery=undefined;
            contents.send=(channel,...input)=>{
              if(channel===CONFIG_CHANGED_CHANNEL){contents.send=original;fixture.delivery=()=>original.call(contents,channel,...input);return}
              return original.call(contents,channel,...input);
            };
          };
          fixture.releasePublication=()=>{if(!fixture.delivery)throw new Error('Missing owned publication');fixture.delivery();fixture.delivery=undefined};
          return typeof fixture.remember;
        })()`,returnByValue:true})
      assert.equal(captured.exceptionDetails,undefined); assert.equal(captured.result.value,'function')
    } finally { await release(point) }
    await pending
  }
  async function beginNativeAnswer(scheme,choice) {
    await probe.main.call('Runtime.evaluate',{expression:`${nativeFixture}.pending=${nativeFixture}.remember(${JSON.stringify(scheme)},${JSON.stringify(choice)});true`,awaitPromise:false,returnByValue:true})
  }
  async function finishNativeAnswer() { await probe.main.evaluate(`${nativeFixture}.pending`) }
  async function remember(scheme,choice) {
    await beginNativeAnswer(scheme,choice);await finishNativeAnswer()
    await waitFor('native fixture publication received',async()=> (await read()).browser.appLinkSchemes?.[scheme]===choice &&
      (await probe.cdp.evaluate('window.__settingsCliProof.configEvents.at(-1)?.schemes'))?.[scheme]===choice)
  }
  async function unchanged(label,args,code) {
    const bytes=await readFile(configPath),count=await publications()
    const response=await command(args,1);assert.equal(response.error.code,code)
    assert.deepEqual(await readFile(configPath),bytes);assert.equal(await publications(),count)
    facts.invalid.push({label,code,bytesUnchanged:true,publicationsUnchanged:true})
  }

  async function exercise() {
    phase('browser-effective-scalar-and-matching-draft')
    await show()
    await probe.cdp.evaluate(`(() => {
      window.__settingsBrowserTrusted=[];
      for(const type of ['click','input','change'])document.addEventListener(type,event=>{
        if(event.target?.closest?.(${JSON.stringify(pane)}))window.__settingsBrowserTrusted.push({type,trusted:event.isTrusted,tag:event.target.tagName})
      });return true
    })()`)
    const initial=await read(),neighboring=preserved(initial),initialAnswers=initial.browser.appLinkSchemes
    const metadata=(await command(['settings','get'])).result.entries
    assert.equal(metadata.length,14);assert.equal(new Set(metadata.map(entry=>entry.key)).size,14)
    assert.deepEqual(metadata.find(entry=>entry.key==='browser.agentAutomation'),{key:'browser.agentAutomation',kind:'boolean',value:false,default:false})
    assert.ok(Object.keys(initialAnswers).length>1);assert.deepEqual(await links(),Object.entries(initialAnswers).map(([scheme,choice])=>({scheme,choice})))
    assert.equal(Object.hasOwn(initialAnswers,'__proto__'),true);assert.equal(initialAnswers.__proto__,'deny')
    const bytes=await readFile(configPath),count=await publications();await scalar(false)
    assert.deepEqual(await readFile(configPath),bytes);assert.equal(await publications(),count)
    assert.equal((await state()).enabled,false);await toggle();assert.equal((await state()).saveDisabled,false)
    await scalar(true);await waitFor('matching external Browser true is visible',async()=> (await state()).enabled===true && await publications()===count+1)
    assert.equal((await state()).saveDisabled,false,'Matching external fact keeps original dirty intent')
    const sameBytes=await readFile(configPath),sameCount=await publications();await save()
    assert.deepEqual(await readFile(configPath),sameBytes);assert.equal(await publications(),sameCount)
    assert.deepEqual((await read()).browser.appLinkSchemes,initialAnswers,'Enable does not create a native choice or approval')
    facts.scalar.matchingExternal={dirtyRetained:true,explicitSaveNochange:true,rememberedAnswersUnchanged:true}
    await scalar(false);await waitFor('clean Browser false',async()=>!(await state()).enabled && (await state()).saveDisabled)

    phase('browser-pending-later-input')
    await captureRegisteredNativeWriter()
    await remember('__proto__','allow')
    assert.equal(Object.hasOwn((await read()).browser.appLinkSchemes,'__proto__'),true)
    await waitFor('own answer appears in current UI',async()=> (await state()).links.find(link=>link.scheme==='__proto__')?.choice==='Opens in your system')
    await activate(probe.cdp,forgetButton('__proto__'));await settledForget()
    assert.equal(Object.hasOwn((await read()).browser.appLinkSchemes,'__proto__'),false)
    assert.equal((await read()).browser.appLinkSchemes['proof-neighbor'],'allow')
    await remember('__proto__','deny')
    facts.ownKey={loadedOriginal:true,scalarNeighborPreserved:true,nativeUpdated:true,currentUiDisplayed:true,uiForgetExact:true,neighborPreserved:true,nativeRestored:true}
    await probe.main.evaluate(`${nativeFixture}.holdSave()`)
    await toggle();await activate(probe.cdp,button)
    try {
      await waitFor('actual owner entered held Runtime preparation',()=>probe.main.evaluate(`${nativeFixture}.saveEntered`))
      assert.equal((await read()).browser.agentAutomation,false,'Persistence is held while the actual Renderer remains interactive')
      await toggle();assert.equal((await state()).enabled,false)
    } finally { await probe.main.evaluate(`${nativeFixture}.releaseSave()`) }
    await waitFor('submitted save settles without replacing later input',async()=>{const current=await state();return current.status==='Unsaved changes' && !current.enabled && !current.saveDisabled})
    assert.equal((await read()).browser.agentAutomation,true);await save();assert.equal((await read()).browser.agentAutomation,false)
    facts.scalar.pendingLaterInput={laterFalseRetained:true,dirty:true,explicitSecondSave:false}

    phase('browser-persistence-error-preserves-draft')
    await toggle();const failedBytes=await readFile(configPath),failedCount=await publications()
    const previous=`${configPath}.prev`,backup=join(root,'browser-previous-config-backup')
    await rename(previous,backup);await mkdir(previous)
    try {
      await activate(probe.cdp,button);await waitFor('Browser durable failure shown inline',async()=> (await state()).errors.length>0)
      assert.equal((await state()).enabled,true);assert.equal((await state()).saveDisabled,false)
      assert.deepEqual(await readFile(configPath),failedBytes);assert.equal(await publications(),failedCount)
    } finally { await rmdir(previous);await rename(backup,previous) }
    await save();assert.equal((await read()).browser.agentAutomation,true)
    facts.scalar.failedSave={draftRetained:true,bytesUnchanged:true,publicationUnchanged:true,explicitRetry:true}
    for(const value of ['TRUE','1','allow'])await unchanged(`invalid Browser bool ${value}`,['settings','set','browser.agentAutomation',value],'INVALID_SETTING_VALUE')
    await unchanged('no native allow setter',['settings','set','browser.appLinkSchemes.proof-alpha','allow'],'UNSUPPORTED_SETTING')

    phase('browser-native-fixture-captured-ui-answer')
    await probe.main.evaluate(`${nativeFixture}.holdPublication()`)
    await beginNativeAnswer('proof-alpha','allow');await finishNativeAnswer()
    try {
      assert.equal((await read()).browser.appLinkSchemes['proof-alpha'],'allow')
      assert.equal((await state()).links.find(link=>link.scheme==='proof-alpha').choice,'Never opened')
      await activate(probe.cdp,forgetButton('proof-alpha'));await settledForget()
    } finally { await probe.main.evaluate(`${nativeFixture}.releasePublication()`) }
    assert.equal((await read()).browser.appLinkSchemes['proof-alpha'],'allow')
    assert.ok((await state()).errors.some(error=>error.includes('proof-alpha')))
    assert.equal((await read()).browser.appLinkSchemes['proof-neighbor'],'allow')
    facts.uiStaleForget={displayed:'deny',current:'allow',conflict:true,newAnswerPreserved:true,neighborPreserved:true}

    phase('browser-cli-processing-time-answer')
    await remember('proof-alpha','deny')
    await probe.main.evaluate(`${nativeFixture}.holdSave()`);let pending
    try {
      await beginNativeAnswer('proof-alpha','allow')
      await waitFor('actual native writer entered owner preparation',()=>probe.main.evaluate(`${nativeFixture}.saveEntered`))
      pending=forget(['proof-alpha'],'proof-alpha')
      const readable=await command(['settings','get','browser.agentAutomation'])
      assert.equal(readable.result.entries[0].value,true,'Readonly settings continue while the short owner write is held')
    } finally { await probe.main.evaluate(`${nativeFixture}.releaseSave()`) }
    await finishNativeAnswer();await pending;await settledForget()
    assert.equal(Object.hasOwn((await read()).browser.appLinkSchemes,'proof-alpha'),false)
    assert.equal((await read()).browser.appLinkSchemes['proof-neighbor'],'allow')
    facts.cliCurrentForget={nativeBefore:'deny',processingTime:'allow',deletedCurrent:true,neighborPreserved:true}

    phase('browser-exact-stored-keys-through-built-cli')
    const exact=(await links()).filter(entry=>entry.scheme!=='proof-neighbor');assert.ok(exact.length>0)
    assert.ok(exact.some(entry=>entry.scheme.includes('\u0000')))
    assert.ok(exact.some(entry=>entry.scheme==='__proto__'));assert.ok(exact.some(entry=>entry.scheme==='constructor'))
    for(const {scheme} of exact) {
      if(scheme.includes('\u0000')) {
        const input=join(root,'exact-browser-forget.json');await writeFile(input,JSON.stringify({scheme}))
        await forget(['--input',input],scheme)
        await remember(scheme,'deny')
        // One maintained CLI execution helper supplies stdin; no shell argv can carry NUL.
        await forget(['--input','-'],scheme,true,JSON.stringify({scheme}))
      } else await forget([scheme],scheme)
      const nochangeBytes=await readFile(configPath),nochangeCount=await publications()
      if(scheme.includes('\u0000')) {
        const input=join(root,'exact-browser-forget.json');await forget(['--input',input],scheme,false)
      } else await forget([scheme],scheme,false)
      assert.deepEqual(await readFile(configPath),nochangeBytes);assert.equal(await publications(),nochangeCount)
      assert.equal((await read()).browser.appLinkSchemes['proof-neighbor'],'allow')
      facts.exactKeys.push({scheme,deletedExactly:true,repeatedNochange:true,neighborPreserved:true})
    }
    assert.deepEqual(await links(),[{scheme:'proof-neighbor',choice:'allow'}])
    await waitFor('only the remembered neighbor remains visible',async()=>{const current=await state();return current.links.length===1&&current.links[0].scheme==='proof-neighbor'})
    await activate(probe.cdp,forgetButton('proof-neighbor'));await settledForget()
    assert.deepEqual(await links(),[]);assert.deepEqual((await state()).links,[])
    assert.deepEqual(preserved(await read()),neighboring,'Browser writes preserve all other Settings domains')
    facts.trustedEvents=await probe.cdp.evaluate('window.__settingsBrowserTrusted')
    assert.ok(facts.trustedEvents.length>0);assert.ok(facts.trustedEvents.every(event=>event.trusted===true))
    const completed=await read()
    assert.equal(completed.browser.agentAutomation,true);assert.deepEqual(completed.browser.appLinkSchemes,{})
    facts.final={agentAutomation:completed.browser.agentAutomation,appLinkSchemes:completed.browser.appLinkSchemes,neighboringDomainsUnchanged:true}
  }
  async function verifyRestart(target) {
    await show(target);assert.equal((await state(target)).enabled,true);assert.equal((await state(target)).saveDisabled,true)
    assert.deepEqual((await state(target)).links,[]);assert.deepEqual(await links(),[])
    facts.restart={automation:true,rememberedAnswersEmpty:true,currentUiClean:true}
  }
  async function verifyNoView() {
    assert.deepEqual(await links(),[]);await scalar(false);await forget(['proof-neighbor'],'proof-neighbor',false)
    facts.noView={automation:false,list:[],absentForgetNochange:true}
  }
  async function verifyOffline() {
    const bytes=await readFile(configPath)
    for(const args of [['settings','set','browser.agentAutomation','true'],['settings','browser','links','forget','proof-neighbor']]) {
      const response=await command(args,1);assert.equal(response.error.code,'CONTROL_UNAVAILABLE')
      assert.deepEqual(await readFile(configPath),bytes)
    }
    facts.offline={noLocalWrite:true}
  }
  return { facts,exercise,verifyRestart,verifyNoView,verifyOffline }
}
