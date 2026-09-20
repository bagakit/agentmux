import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { builtInAgentProviderLabel } from '@agentmux/core/provider-id'
import { activate } from './desktop.mjs'

const nodes = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
const pane = resource => `[data-settings-pane="${resource === 'executors' ? 'agents' : 'prompts'}"]:not([hidden])`
const executor = id => `document.getElementById(${JSON.stringify(`executor-settings-${id}`)})`
const prompt = keyword => `${nodes(`${pane('prompts')} .prompt-settings-card`)}.find(e=>e.querySelector('input')?.value===${JSON.stringify(keyword)})`
const field = (card, name, tag = 'input') => `Array.from((${card}).querySelectorAll('label')).find(e=>e.querySelector(':scope > span')?.textContent.trim().startsWith(${JSON.stringify(name)}))?.querySelector(${JSON.stringify(tag)})`
const button = (resource, text) => `${nodes(`${pane(resource)} button`)}.filter(e=>e.textContent.trim()===${JSON.stringify(text)})`

async function press(cdp, key, code, windowsVirtualKeyCode) {
  await cdp.call('Input.dispatchKeyEvent', {type:'keyDown',key,code,windowsVirtualKeyCode})
  await cdp.call('Input.dispatchKeyEvent', {type:'keyUp',key,code,windowsVirtualKeyCode})
}

/** A native mouse focus and native select/delete followed by literal text insertion, not per-key typing. */
export async function replaceText(cdp, expression, text) {
  const point = await cdp.evaluate(`(() => { const e=${expression}; if(!e || !e.getClientRects().length)throw new Error('Missing visible resource field'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  assert.equal(await cdp.evaluate(`document.activeElement===(${expression})`), true)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
  await press(cdp, 'Backspace', 'Backspace', 8)
  assert.equal(await cdp.evaluate(`(${expression}).value`), '')
  if (text) await cdp.call('Input.insertText', { text })
  assert.equal(await cdp.evaluate(`(${expression}).value`), text)
}
async function select(cdp, expression, value) {
  const options = await cdp.evaluate(`(() => { const e=${expression}; if(!e?.getClientRects().length || e.disabled)throw new Error('Missing enabled actual resource select'); e.scrollIntoView({block:'nearest'}); return Array.from(e.options).filter(o=>!o.disabled&&!o.closest('optgroup')?.disabled).map(o=>({value:o.value,label:o.label.trim()})) })()`)
  assert.ok(options.length>0,'Actual enabled Select options must be nonempty')
  const wanted=options.find(option=>option.value===value);assert.ok(wanted,'Exact enabled actual option must exist')
  const match=/^([A-Za-z]+)(?:\s|$)/.exec(wanted.label);assert.ok(match,'Actual option must have an ASCII first-word prefix')
  const prefix=match[1].toLowerCase();assert.ok(prefix.length>0)
  assert.deepEqual(options.filter(option=>option.label.toLowerCase().startsWith(prefix)),[wanted],'The actual option prefix must be unique')
  assert.equal(await cdp.evaluate(`(() => { const e=${expression}; e.focus(); return document.activeElement===e })()`),true)
  for(const character of prefix) {
    const parameters={key:character,code:'Key'+character.toUpperCase(),windowsVirtualKeyCode:character.toUpperCase().charCodeAt(0),modifiers:0,text:character,unmodifiedText:character,autoRepeat:false,location:0}
    await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',...parameters})
    const {text,unmodifiedText,autoRepeat,...up}=parameters
    await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',...up})
  }
  assert.equal(await cdp.evaluate(`(${expression}).value`),value,'Trusted actual Select must commit the exact value')
}

export function resourceProof({ probe, desktopRoot, resource, configPath, waitFor, section, phase }) {
  const { split, quote } = createRequire(join(desktopRoot, 'package.json'))('shlex')
  const facts = { invalid: [], conflicts: [], cleared: [], bidirectional: {}, fields: [] }
  const count = () => probe.cdp.evaluate('window.__settingsResourcesProof.configEvents.length')
  const state = kind => probe.cdp.evaluate(`(() => { const p=document.querySelector(${JSON.stringify(pane(kind))}); if(!p)throw new Error('Resource pane absent'); const b=p.querySelector('.settings-pane-actions button');return {alert:p.querySelector('[role="alert"]')?.textContent??'',saveText:b?.textContent.trim(),saveDisabled:b?.disabled,status:p.querySelector('.settings-save-feedback')?.textContent,empty:p.querySelector('.agent-catalog__empty')?.textContent??'',cards:p.querySelectorAll('.agent-settings-card').length} })()`)
  const show = async kind => { await section(probe, kind === 'executors' ? 'Agents' : 'Prompts', kind === 'executors' ? 'agents' : 'prompts') }
  const open = async card => {
    await waitFor('actual nonempty named resource card',()=>probe.cdp.evaluate(`Boolean(${card})`))
    if (!await probe.cdp.evaluate(`(${card}).open`)) await activate(probe.cdp, `[(${card}).querySelector(':scope > summary')]`)
  }
  const launch = async card => {
    await open(card)
    if (!await probe.cdp.evaluate(`(${card}).querySelector('.settings-launch-config').open`)) await activate(probe.cdp, `[(${card}).querySelector('.settings-launch-config > summary')]`)
  }
  const save = async kind => {
    await activate(probe.cdp, button(kind, `Save ${kind}`))
    await waitFor(`settled ${kind} Save receipt`, async () => {
      const current = await state(kind)
      return current.saveText === `Save ${kind}` && current.saveDisabled === true && current.alert === '' && current.status.includes('Changes saved')
    })
  }
  const readExecutor = async id => {
    await show('executors'); const card = executor(id); await launch(card)
    const raw = await probe.cdp.evaluate(`(() => {const c=${card}, labels=Array.from(c.querySelectorAll('label'));const f=(name,tag='input')=>labels.find(e=>e.querySelector(':scope > span')?.textContent.trim().startsWith(name))?.querySelector(tag);return {label:f('Name').value,provider:c.querySelector('.settings-executor-identity dd')?.textContent,command:f('Command').value,args:f('Arguments','textarea').value,env:f('Environment','textarea').value,guide:c.querySelector('.agent-guide-toggle input').checked,tint:c.querySelector('input[type="color"]').value,badge:c.querySelector('.agent-avatar-settings__row select').value,resetDisabled:c.querySelector('.agent-avatar-settings__row button').disabled} })()`)
    return { ...raw, args: split(raw.args), envRaw: raw.env, env: JSON.parse(raw.env), state: await state('executors') }
  }
  const readPrompt = async keyword => {
    await show('prompts'); const card = prompt(keyword); await open(card)
    return probe.cdp.evaluate(`(() => {const c=${card}; return {keyword:${field(card,'Keyword')}.value,label:${field(card,'Name')}.value,providerId:${field(card,'Agent','select')}.value,body:${field(card,'Prompt','textarea')}.value} })()`)
  }
  const assertCleanExecutor = async (id, expected) => {
    await waitFor('clean Executor projection of actual Main fact', async () => {
      const actual = await readExecutor(id)
      return actual.label === expected.label && actual.command === expected.command && JSON.stringify(actual.args) === JSON.stringify(expected.args) && JSON.stringify(actual.env) === JSON.stringify(expected.env) && actual.guide === expected.injectAgentMuxGuide && actual.state.saveDisabled === true && actual.state.saveText === 'Save executors' && !actual.state.alert
    })
    const actual = await readExecutor(id)
    assert.equal(actual.provider,builtInAgentProviderLabel(expected.providerId),'Provider identity is visible on the actual card')
    assert.deepEqual(actual.args, expected.args); assert.deepEqual(actual.env, expected.env)
    if (expected.avatar?.tint) assert.equal(actual.tint, expected.avatar.tint)
    if (expected.avatar?.badge) assert.equal(actual.badge, expected.avatar.badge)
    return actual
  }
  const assertCleanPrompt = async expected => {
    await waitFor('clean Prompt projection of actual Main fact', async () => {
      const actual = await readPrompt(expected.keyword), current = await state('prompts')
      return actual.label === expected.label && actual.body === expected.body && actual.providerId === (expected.providerId ?? '') && current.saveDisabled === true && current.saveText === 'Save prompts' && !current.alert
    })
    const actual = await readPrompt(expected.keyword)
    assert.deepEqual(actual, { ...expected, providerId: expected.providerId ?? '' })
    return actual
  }
  const unchanged = async (label, operation, code) => {
    const bytes = await readFile(configPath), publications = await count()
    const receipt = await operation()
    assert.equal(receipt.error.code, code, label)
    assert.deepEqual(await readFile(configPath), bytes, `${label}: actual durable bytes unchanged`)
    assert.equal(await count(), publications, `${label}: no publication`)
    facts.invalid.push({ label, code, configUnchanged: true, publicationsUnchanged: true })
  }
  const resetDraft = async kind => {
    const settings = nodes('.window-status-bar button[aria-label="Settings"]')
    await activate(probe.cdp, settings); await activate(probe.cdp, settings); await show(kind)
  }

  return { facts, state, readExecutor, readPrompt, assertCleanExecutor, assertCleanPrompt, async exercise() {
    phase('nonempty-resource-owner')
    const executors = await resource('executors','list'), prompts = await resource('prompts','list')
    assert.deepEqual(executors.items.map(item=>item.id).sort(), ['probe','spare'])
    assert.deepEqual(prompts.items.map(item=>item.id).sort(), ['prompt-a','prompt-b'])
    await show('executors'); assert.equal((await state('executors')).cards, 2)
    await show('prompts'); assert.equal((await state('prompts')).cards, 2)
    facts.initial = { executors: executors.items, prompts: prompts.items }

    phase('actual-effective-avatar-reset')
    const absentAvatar=(await resource('executors','get','spare')).item.value
    assert.equal(Object.hasOwn(absentAvatar,'avatar'),false,'CLI DTO reports authored data, not effective legacy decoration')
    await show('executors');await open(executor('spare'))
    const legacyUi=await readExecutor('spare')
    assert.equal(legacyUi.tint,'#654321');assert.equal(legacyUi.badge,'spark');assert.equal(legacyUi.resetDisabled,false)
    await activate(probe.cdp,`${nodes('#executor-settings-spare button')}.filter(e=>e.getAttribute('aria-label')==='Reset Spare executor avatar')`)
    await save('executors')
    const resetValue=(await resource('executors','get','spare')).item.value
    assert.deepEqual(resetValue,{...absentAvatar,avatar:{}})
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')).executors.spare.avatar,{})
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')).appearance.agentAvatars.spare,{tint:'#654321',badge:'spark'})
    const effectiveResetUi=await readExecutor('spare');assert.equal(effectiveResetUi.resetDisabled,true);assert.equal(effectiveResetUi.state.saveDisabled,true);assert.equal(effectiveResetUi.state.alert,'')
    facts.effectiveAvatarReset={before:absentAvatar,legacyUi,committed:resetValue,ui:effectiveResetUi,legacyPreserved:true}

    phase('referenced-executor-owner-rejection')
    const kept = (await resource('executors','get','probe')).item.value
    await unchanged('retained healthy Session blocks Executor deletion', () => resource('executors','remove','probe',{expected:kept},1), 'SETTING_RESOURCE_IN_USE')
    assert.deepEqual((await resource('executors','get','probe')).item.value, kept)
    const referencedUiBytes=await readFile(configPath),referencedUiPublications=await count()
    await show('executors'); await open(executor('probe'))
    await activate(probe.cdp, `${nodes('#executor-settings-probe button')}.filter(e=>e.textContent.trim()==='Delete executor')`)
    await activate(probe.cdp, button('executors','Save executors'))
    await waitFor('referenced UI deletion reports named template', async()=> {const current=await state('executors');return current.saveText==='Save executors' && !current.saveDisabled && current.alert.includes('probe')})
    assert.deepEqual((await resource('executors','get','probe')).item.value, kept)
    assert.equal((await state('executors')).cards,1,'Rejected delete draft is retained')
    assert.deepEqual(await readFile(configPath),referencedUiBytes);assert.equal(await count(),referencedUiPublications)
    facts.referencedUi = {...await state('executors'),configUnchanged:true,publicationsUnchanged:true}
    await resetDraft('executors'); assert.equal((await state('executors')).cards,2)

    phase('literal-resource-fields')
    const ownEnv = Object.fromEntries([['__proto__','owned literal prototype key'],['constructor','owned literal constructor'],['MULTILINE','  first\n$HOME `literal` $(literal) \\\nlast  '],['EMPTY','']])
    const literalArgs = ['--help','', '  spaces  ', '$HOME', '$(not-a-command)', '`literal`', 'line one\nline two', 'quote"slash\\']
    let spare = (await resource('executors','get','spare')).item.value
    const fields = {label:'Literal executor', command:'  literal command $HOME  ', args:literalArgs, env:ownEnv, injectAgentMuxGuide:true, avatar:{tint:'#123456',badge:'bolt'}}
    for (const [name,value] of Object.entries(fields)) {
      const previous = spare[name], result = await resource('executors','update','spare',{changes:{[name]:value},expected:{[name]:previous ?? {}}})
      assert.equal(result.changed,true); spare={...spare,[name]:value}; assert.deepEqual(result.item.value,spare)
      assert.deepEqual((await resource('executors','get','spare')).item.value,spare)
      assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')).executors.spare,spare)
      facts.fields.push({resource:'executors',field:name,literal:true})
    }
    assert.equal(Object.hasOwn(spare.env,'__proto__'),true); assert.equal(Object.hasOwn(spare.env,'constructor'),true)
    await resource('executors','update','spare',{changes:{command:'/bin/cat'},expected:{command:spare.command}});spare={...spare,command:'/bin/cat'}
    facts.bidirectional.executorCliToUi = await assertCleanExecutor('spare',spare)
    for (const [name,value] of [['args',[]],['env',{}],['avatar',{}]]) {
      const result=await resource('executors','update','spare',{changes:{[name]:value},expected:{[name]:spare[name]}})
      spare={...spare,[name]:value};assert.deepEqual(result.item.value,spare);facts.cleared.push({resource:'executors',field:name,value})
    }
    const resetBytes=await readFile(configPath),resetEvents=await count()
    assert.equal((await resource('executors','update','spare',{changes:{avatar:{}}})).changed,false)
    assert.deepEqual(await readFile(configPath),resetBytes);assert.equal(await count(),resetEvents)
    const resetUi=await assertCleanExecutor('spare',spare)
    assert.equal(resetUi.resetDisabled,true)
    assert.equal(JSON.parse(await readFile(configPath,'utf8')).appearance.agentAvatars.spare.tint,'#654321','Explicit empty avatar wins without deleting legacy appearance')
    facts.avatarReset={value:{},ui:resetUi,legacyPreserved:true}

    phase('invalid-resource-nochange')
    for(const [name,value] of [['label',''],['command',''],['args','--help'],['env',{INVALID:14}],['injectAgentMuxGuide','true'],['avatar',{tint:'invalid'}]]) {
      await unchanged(`invalid Executor ${name}`,()=>resource('executors','update','spare',{changes:{[name]:value}},1),'INVALID_SETTING_VALUE')
    }
    await unchanged('Executor Provider binding immutable',()=>resource('executors','update','spare',{changes:{providerId:'claude'}},1),'SETTING_IDENTITY_IMMUTABLE')
    await unchanged('duplicate add never replaces',()=>resource('executors','add','spare',spare,1),'SETTING_RESOURCE_EXISTS')
    await unchanged('unknown update never adds',()=>resource('executors','update','absent',{changes:{label:'No upsert'}},1),'SETTING_RESOURCE_NOT_FOUND')
    const added={label:'Disposable',providerId:'claude',command:'/bin/cat',args:[],env:{},injectAgentMuxGuide:false}
    assert.deepEqual((await resource('executors','add','disposable',added)).item.value,added)
    await unchanged('remove compares complete snapshot',()=>resource('executors','remove','disposable',{expected:{...added,label:'stale'}},1),'CONFIG_CONFLICT')
    assert.equal((await resource('executors','remove','disposable',{expected:added})).removed,true)
    await unchanged('unknown remove remains explicit',()=>resource('executors','remove','disposable',undefined,1),'SETTING_RESOURCE_NOT_FOUND')
    // This valid own record id must never become Object.prototype.constructor during deletion.
    const constructorValue={...added,label:'Own constructor identity'}
    assert.deepEqual((await resource('executors','add','constructor',constructorValue)).item,{id:'constructor',value:constructorValue})
    assert.deepEqual((await resource('executors','get','constructor')).item.value,constructorValue)
    assert.equal((await resource('executors','remove','constructor',{expected:constructorValue})).removed,true)
    facts.ownIdentity={id:'constructor',addedAndRead:true,removed:true}

    phase('trusted-executor-editor')
    await show('executors');const card=executor('spare');await launch(card)
    await replaceText(probe.cdp,field(card,'Name'),'UI executor literal')
    await replaceText(probe.cdp,field(card,'Arguments','textarea'),literalArgs.map(quote).join('\n'))
    const envText=JSON.stringify(ownEnv,null,2)
    await replaceText(probe.cdp,field(card,'Environment','textarea'),envText)
    assert.equal((await readExecutor('spare')).envRaw,envText)
    await save('executors')
    spare=(await resource('executors','get','spare')).item.value
    assert.equal(spare.label,'UI executor literal');assert.deepEqual(spare.args,literalArgs);assert.deepEqual(spare.env,ownEnv)
    assert.equal(Object.hasOwn(spare.env,'__proto__'),true);assert.equal(Object.hasOwn(spare.env,'constructor'),true)
    facts.bidirectional.executorUiToCli=spare
    // Name-only save must preserve the authored own-key environment, not silently reparse/drop it.
    await replaceText(probe.cdp,field(card,'Name'),'Name-only environment preserved');await save('executors')
    spare=(await resource('executors','get','spare')).item.value;assert.deepEqual(spare.env,ownEnv)
    await replaceText(probe.cdp,field(card,'Environment','textarea'),'{"INVALID": 14}')
    const invalidBytes=await readFile(configPath),invalidEvents=await count()
    await activate(probe.cdp,button('executors','Save executors'))
    await waitFor('invalid environment raw draft kept',async()=>{const current=await state('executors');return current.saveText==='Save executors' && !current.saveDisabled && current.alert.includes('Environment')})
    assert.equal((await readExecutor('spare')).envRaw,'{"INVALID": 14}');assert.deepEqual(await readFile(configPath),invalidBytes);assert.equal(await count(),invalidEvents)
    facts.invalidEnvUi={raw:(await readExecutor('spare')).envRaw,ui:await state('executors'),bytesUnchanged:true}
    await resetDraft('executors')

    phase('executor-whole-environment-conflict')
    await launch(card)
    const localEnv=Object.fromEntries([...Object.entries(ownEnv),['LOCAL','locally authored addition']])
    const externalEnv=Object.fromEntries([...Object.entries(ownEnv),['EXTERNAL','externally authored addition']])
    const localEnvText=JSON.stringify(localEnv,null,2)
    await replaceText(probe.cdp,field(card,'Environment','textarea'),localEnvText)
    await resource('executors','update','spare',{changes:{env:externalEnv},expected:{env:ownEnv}})
    assert.equal((await readExecutor('spare')).envRaw,localEnvText,'Dirty raw JSON does not follow an external env replacement')
    const envConflictBytes=await readFile(configPath),envConflictCount=await count()
    await activate(probe.cdp,button('executors','Save executors'))
    await waitFor('Environment is compared as one authored launch field',async()=>{const current=await state('executors');return current.saveText==='Save executors' && !current.saveDisabled && current.alert.includes('env')})
    assert.equal((await readExecutor('spare')).envRaw,localEnvText)
    assert.deepEqual((await resource('executors','get','spare')).item.value.env,externalEnv)
    assert.deepEqual(await readFile(configPath),envConflictBytes);assert.equal(await count(),envConflictCount)
    facts.conflicts.push({resource:'executors',field:'env',raw:localEnvText,ui:await state('executors'),configUnchanged:true,publicationsUnchanged:true})
    await resetDraft('executors')
    await resource('executors','update','spare',{changes:{env:ownEnv},expected:{env:externalEnv}})
    spare=(await resource('executors','get','spare')).item.value

    phase('executor-authored-conflict')
    await launch(card);await replaceText(probe.cdp,field(card,'Name'),'Locally authored Executor')
    await resource('executors','update','spare',{changes:{label:'Externally committed Executor'},expected:{label:spare.label}})
    await waitFor('dirty Executor observes external publication',async()=>JSON.parse(await readFile(configPath,'utf8')).executors.spare.label==='Externally committed Executor')
    assert.equal((await readExecutor('spare')).label,'Locally authored Executor')
    const conflictBytes=await readFile(configPath),conflictCount=await count()
    await activate(probe.cdp,button('executors','Save executors'))
    await waitFor('Executor original authored baseline rejects stale Save',async()=>{const current=await state('executors');return current.saveText==='Save executors' && !current.saveDisabled && current.alert.includes('label')})
    assert.equal((await readExecutor('spare')).label,'Locally authored Executor');assert.deepEqual(await readFile(configPath),conflictBytes);assert.equal(await count(),conflictCount)
    facts.conflicts.push({resource:'executors',ui:await readExecutor('spare'),configUnchanged:true})
    await resetDraft('executors');await launch(card)
    spare=(await resource('executors','get','spare')).item.value
    await replaceText(probe.cdp,field(card,'Name'),'Disjoint Executor draft')
    await resource('executors','update','spare',{changes:{command:'/usr/bin/env'},expected:{command:spare.command}})
    await waitFor('disjoint Executor clean command follows external fact',async()=>(await readExecutor('spare')).command==='/usr/bin/env')
    assert.equal((await readExecutor('spare')).label,'Disjoint Executor draft');await save('executors')
    spare=(await resource('executors','get','spare')).item.value;assert.equal(spare.label,'Disjoint Executor draft');assert.equal(spare.command,'/usr/bin/env');assert.deepEqual(spare.env,ownEnv)
    facts.disjointExecutor=spare

    phase('literal-prompt-fields')
    let a=(await resource('prompts','get','prompt-a')).item.value
    const body='  literal $HOME $(not-run) `not-run`\nsecond line\\ends  \n'
    for (const [name,value] of Object.entries({keyword:'literal-a',label:'Literal prompt',body,providerId:'additional-provider'})) {
      const result=await resource('prompts','update','prompt-a',{changes:{[name]:value},expected:{[name]:a[name] ?? null}})
      a={...a,[name]:value};assert.deepEqual(result.item.value,a);facts.fields.push({resource:'prompts',field:name,literal:true})
    }
    facts.bidirectional.promptCliToUi=await assertCleanPrompt(a)
    const unbound=await resource('prompts','update','prompt-a',{changes:{providerId:null},expected:{providerId:'additional-provider'}})
    delete a.providerId;assert.deepEqual(unbound.item.value,a);assert.equal(Object.hasOwn(unbound.item.value,'providerId'),false)
    await assertCleanPrompt(a)
    const nochangeBytes=await readFile(configPath),nochangeCount=await count()
    assert.equal((await resource('prompts','update','prompt-a',{changes:{providerId:null},expected:{providerId:null}})).changed,false)
    assert.deepEqual(await readFile(configPath),nochangeBytes);assert.equal(await count(),nochangeCount)
    await unchanged('Prompt duplicate keyword',()=>resource('prompts','update','prompt-a',{changes:{keyword:'proof-b'}},1),'INVALID_SETTING_VALUE')
    await unchanged('Prompt blank body',()=>resource('prompts','update','prompt-a',{changes:{body:'   '}},1),'INVALID_SETTING_VALUE')
    await unchanged('Prompt nested unknown field',()=>resource('prompts','update','prompt-a',{changes:{unknown:'value'}},1),'INVALID_SETTING_VALUE')
    const defaultPrompt={keyword:'  derived-label  ',label:'   ',body:'  Exact default-label body\n  '}
    const defaulted=await resource('prompts','add','default-label',defaultPrompt)
    assert.deepEqual(defaulted.item.value,{keyword:'derived-label',label:'derived-label',body:defaultPrompt.body})
    await resource('prompts','remove','default-label',{expected:defaulted.item.value})
    facts.promptNormalization={input:defaultPrompt,committed:defaulted.item.value}
    const literalId='--help', literalPrompt={keyword:'literal-help',label:'Literal help data',body:'  --help\n$HOME  '}
    assert.deepEqual((await resource('prompts','add',literalId,literalPrompt)).item,{id:literalId,value:literalPrompt})
    assert.deepEqual((await resource('prompts','get',literalId)).item.value,literalPrompt)
    assert.equal((await resource('prompts','remove',literalId,{expected:literalPrompt})).removed,true)

    phase('trusted-prompt-editor')
    await show('prompts');let pc=prompt(a.keyword);await open(pc)
    await replaceText(probe.cdp,field(pc,'Name'),'UI literal prompt')
    await replaceText(probe.cdp,field(pc,'Prompt','textarea'),'  UI $HOME\n$(literal) `literal`  \n')
    await select(probe.cdp,field(pc,'Agent','select'),'codex');await save('prompts')
    a=(await resource('prompts','get','prompt-a')).item.value
    assert.equal(a.label,'UI literal prompt');assert.equal(a.body,'  UI $HOME\n$(literal) `literal`  \n');assert.equal(a.providerId,'codex')
    facts.bidirectional.promptUiToCli=a
    await select(probe.cdp,field(pc,'Agent','select'),'');await save('prompts')
    a=(await resource('prompts','get','prompt-a')).item.value;assert.equal(Object.hasOwn(a,'providerId'),false)
    await replaceText(probe.cdp,field(pc,'Name'),'Local Prompt draft')
    await resource('prompts','update','prompt-a',{changes:{label:'External Prompt commit'},expected:{label:a.label}})
    await waitFor('Prompt external event',async()=>JSON.parse(await readFile(configPath,'utf8')).composerShortcuts.find(item=>item.id==='prompt-a').label==='External Prompt commit')
    assert.equal((await readPrompt(a.keyword)).label,'Local Prompt draft')
    const promptConflictBytes=await readFile(configPath),promptConflictCount=await count()
    await activate(probe.cdp,button('prompts','Save prompts'))
    await waitFor('Prompt stale authored baseline names conflict',async()=>{const current=await state('prompts');return current.saveText==='Save prompts' && !current.saveDisabled && current.alert.includes('label')})
    assert.equal((await readPrompt(a.keyword)).label,'Local Prompt draft');assert.deepEqual(await readFile(configPath),promptConflictBytes);assert.equal(await count(),promptConflictCount)
    facts.conflicts.push({resource:'prompts',ui:await readPrompt(a.keyword),state:await state('prompts'),configUnchanged:true})
    await resetDraft('prompts');pc=prompt(a.keyword);await open(pc)
    a=(await resource('prompts','get','prompt-a')).item.value
    await replaceText(probe.cdp,field(pc,'Name'),'Disjoint Prompt draft')
    await resource('prompts','update','prompt-a',{changes:{body:'  External disjoint body\n  '},expected:{body:a.body}})
    await waitFor('Prompt disjoint body follows external fact',async()=>(await readPrompt(a.keyword)).body==='  External disjoint body\n  ')
    assert.equal((await readPrompt(a.keyword)).label,'Disjoint Prompt draft');await save('prompts')
    a=(await resource('prompts','get','prompt-a')).item.value;assert.equal(a.label,'Disjoint Prompt draft');assert.equal(a.body,'  External disjoint body\n  ')
    facts.disjointPrompt=a

    phase('last-prompt-empty-durable')
    for(const item of (await resource('prompts','list')).items)await resource('prompts','remove',item.id,{expected:item.value})
    assert.deepEqual((await resource('prompts','list')).items,[])
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')).composerShortcuts,[])
    await waitFor('actual clean empty Prompt UI',async()=>{const current=await state('prompts');return current.cards===0 && current.empty.includes('No prompts') && current.saveText==='Save prompts' && current.saveDisabled===true})
    facts.emptyPrompts=await state('prompts')
    facts.restartExecutors=(await resource('executors','list')).items
    assert.equal(facts.restartExecutors.length,2)
    return facts
  }, async verifyRestart(next) {
    // Recreate only read helpers for the new actual Renderer. No seed, write, manual flush or draft reset.
    const restored=resourceProof({probe:next,desktopRoot,resource,configPath,waitFor,section,phase})
    assert.deepEqual((await resource('executors','list')).items,facts.restartExecutors)
    for(const item of facts.restartExecutors)await restored.assertCleanExecutor(item.id,item.value)
    await section(next,'Prompts','prompts')
    assert.deepEqual((await resource('prompts','list')).items,[])
    const empty=await restored.state('prompts');assert.equal(empty.cards,0);assert.ok(empty.empty.includes('No prompts'));assert.equal(empty.saveDisabled,true);assert.equal(empty.saveText,'Save prompts')
    assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')).composerShortcuts,[])
    facts.restored={executors:facts.restartExecutors,prompts:[],ui:empty}
  } }
}
