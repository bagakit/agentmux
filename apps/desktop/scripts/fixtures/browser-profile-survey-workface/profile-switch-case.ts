import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { session, type BrowserWindow, type WebContentsView } from 'electron'
import { browserProfilePartition } from '../../../src/main/browser-profile-store'
import { admissionGeometry } from './admission-geometry'
import { nativeInput, nativeUntil } from './native-input'
import { persistentTask } from './persistent-task'
import type { ProfileSwitchPorts } from './profile-switch-ports'

type Context = {
  phase: string; directory: string; window: BrowserWindow; core: any; receipt: any; ports: ProfileSwitchPorts
  taskWorkspaceId: string; legacyWorkspaceId: string; pageUrl: string
  evaluate(expression: string): Promise<any>
  result(args: string[], input?: string): Promise<any>
  cli(args:string[],input?:string):Promise<any>
  readWorkbenchState(): Promise<string | null>
}
const environment = '[aria-label="Survey environment"]'
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
const pageRow = (browserId: string) => `[data-survey-page-browser-id="${browserId}"]`
const region = (regionId: string) => `[data-workbench-region-id="${regionId}"]`
const named = (id: string) => ({ kind: 'profile', profileId: id })

/** Dedicated T002 business flow; it does not execute admission/settings as a substitute. */
export async function profileSwitchCase(ctx: Context) {
  const { phase, directory, window, ports, receipt, result, evaluate, core, pageUrl } = ctx
  const origins = JSON.parse(process.env.AGENTMUX_PROFILE_SURVEY_ORIGINS!)
  receipt.profileSwitch = { completed: false, cases: [], input: [], frames: [] }
  const proof = receipt.profileSwitch
  const input = nativeInput(window.webContents, proof.input)
  const facts = () => evaluate('profileSurveyNative.read()')
  const mark = (kind: string, value: any = {}) => {
    proof.cases.push({ kind, passed: true, ...value })
    process.stdout.write(`Profile Survey ${phase}: ${kind} passed\n`)
  }
  const nativeCalls = () => ports.calls.filter(call => ['browser:create', 'browser:switchProfile', 'browser:navigate', 'browser:close', 'browser:setDefaultProfile'].includes(call.channel)).length
  const memberList = () => result(['space', 'survey-list'])
  const showSurvey = async () => { await input.click('.surface-navigation__utilities button:first-child'); assert.equal((await facts()).mainSurface, 'survey') }
  const choose = async (value: string, keepFocus?: boolean) => {
    await input.select(environment, value, keepFocus)
    const expected = value === 'default' ? { kind: 'default' } : named(value.slice('profile:'.length))
    await nativeUntil(async () => JSON.stringify((await facts()).surveyProfileView) === JSON.stringify(expected), 'the original Profile view preference')
    const publicView=await result(['space','ls','--presentation'])
    proof.publicViewReads??=[]
    proof.publicViewReads.push({expected,survey:publicView.catalog.survey??null,presentation:publicView.presentation??null})
    assert.ok(publicView.catalog.survey,'The real public catalog must include the original live Survey preference owner')
    assert.deepEqual(publicView.catalog.survey.profileView, expected, 'Public presentation reads the original Profile view')
  }
  const owner = async (browserId: string) => nativeUntil(async () => {
    for (const tab of Object.values((await facts()).tabs) as any[]) for (const surface of Object.values(tab.regions) as any[]) {
      if (surface.kind === 'browser' && surface.browserId === browserId) return { tab, surface, reference: { regionId: surface.regionId, browserId } }
    }
    return null
  }, 'the original Main Browser attached to its exact Region')
  const native = async (browserId: string, profileId: string, url?: string): Promise<WebContentsView> => nativeUntil(() => {
    const correlated = ports.original(browserId)
    const candidates = correlated && !correlated.webContents.isDestroyed() ? [correlated]
      : window.contentView.children.filter((view: any) => view.webContents && !view.webContents.isDestroyed() && url && view.webContents.getURL() === url && view.webContents.session === session.fromPartition(browserProfilePartition(profileId))) as WebContentsView[]
    assert.ok(candidates.length <= 1, 'An unconfirmed native correlation cannot select a convenient duplicate')
    const view = candidates[0]
    if (!view || view.webContents.isDestroyed() || url && view.webContents.getURL() !== url || view.webContents.isLoading()) return null
    assert.equal(view.webContents.session, session.fromPartition(browserProfilePartition(profileId)))
    assert.ok(view.webContents.session.storagePath?.startsWith(directory), 'Only the original private persistent Session is used')
    return view
  }, 'actual original native Browser ' + browserId)
  const activateTask = async (reference: any) => {
    const response=await ctx.cli(['space','focus','--region',reference.regionId,'--input','target'])
    assert.equal(response.value.ok,true,'The original navigation must have an actual result')
    const outcome=response.value.result
    assert.ok(['applied','unchanged'].includes(outcome.navigation.state),'Original focus must confirm its applied or already-current exact selection');assert.equal(outcome.navigation.selection.space.regionId,reference.regionId)
    assert.equal(outcome.presentation.state,'main-visible');assert.equal(outcome.presentation.regionId,reference.regionId)
    if(response.code!==0){assert.equal(response.code,1);assert.equal(outcome.partial,true,'Only an original partial result may have a nonzero success exit')}
    proof.focusFacts??=[]
    proof.focusFacts.push({operationId:response.value.operationId,code:response.code,regionId:reference.regionId,presentation:outcome.presentation.state,input:outcome.input.outcome,partial:outcome.partial})
    await pause(100)
  }
  const activatePage = async (reference: any) => {
    await input.click(pageRow(reference.browserId) + ' .survey-item')
    await nativeUntil(() => evaluate(`document.querySelector('${region(reference.regionId)}')?.checkVisibility()`), 'actual stored exact page activation')
  }
  const navigate = async (reference: any, url: string) => {
    const scope = region(reference.regionId)
    await input.fill(scope + ' .browser-toolbar input', url)
    await input.key('Enter', 'Enter', 13)
    await nativeUntil(async () => (await owner(reference.browserId)).surface.url === url, 'original navigation receipt in the exact Browser')
  }
  const identity = async (view: WebContentsView) => view.webContents.executeJavaScript(`fetch(${JSON.stringify(origins.identityUrl)},{cache:'no-store',credentials:'include'}).then(r=>r.json())`)
  const login = async (created: any, user: string, suffix: string) => {
    const reference = { regionId: created.region.regionId, browserId: created.region.browserId }
    await activateTask(reference)
    const view = await native(reference.browserId, created.region.profileId, origins.loginUrl + suffix)
    await nativeUntil(()=>view.getVisible()&&view.getBounds().width>0&&view.getBounds().height>0,'the actual task native page presentation before sign-in')
    const site = nativeInput(view.webContents, proof.input)
    await site.fill('[aria-label="Account"]', user); await site.click('button[type="submit"]')
    await nativeUntil(() => !view.webContents.isLoading() && view.webContents.getURL() === pageUrl, 'real form POST, Set-Cookie and redirect')
    assert.deepEqual(await identity(view), { user })
    return view
  }
  const capture = async (label: string, mode: string, width: number, height: number) => {
    await evaluate(`profileSurveyNative.appearance(${JSON.stringify(mode)})`); window.setSize(width, height); await pause(220)
    const file = `${phase}-profile-switch-${mode}-${label}.png`
    await writeFile(join(directory, file), (await window.capturePage()).toPNG())
    proof.frames.push({ file, width, height }); receipt.frames.push({ file })
  }
  const serviceGeometry = async (reference: any, view: WebContentsView) => {
    const geometry=await nativeUntil(async()=>{
      const dom=await evaluate(`(()=>{
        const id=${JSON.stringify(reference)},rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
        const regions=[...document.querySelectorAll('[data-workbench-region-id]')].filter(e=>e.dataset.workbenchRegionId===id.regionId&&e.checkVisibility());
        const root=regions[0],toolbar=root?.querySelector('.browser-toolbar'),service=root?.querySelector('.browser-profile-service'),stage=root?.querySelector('[data-native-browser-stage="'+id.browserId+'"]'),notice=root?.querySelector('[data-survey-profile-registration="'+id.browserId+'"]');
        const chip=toolbar?.querySelector('.browser-profile-chip'),address=toolbar?.querySelector('[aria-label="Browser address"]');
        if(!toolbar||!service||!stage||!notice?.checkVisibility()||!chip||!address)return null;
        return{regions:regions.length,toolbar:rect(toolbar),service:rect(service),notice:rect(notice),nativeStage:rect(stage),chip:rect(chip),address:rect(address),toolbarScrollWidth:toolbar.scrollWidth};
      })()`)
      if(!dom)return null
      const actual={contentsId:view.webContents.id,visible:view.getVisible(),bounds:view.getBounds()}
      proof.lastServiceGeometry={...dom,native:actual}
      return actual.visible&&(['x','y','width','height'] as const).every(dimension=>Math.abs(actual.bounds[dimension]-dom.nativeStage[dimension])<=2)?{...dom,native:actual}:null
    },'the same visible Browser service row and original native bounds have committed')
    assert.equal(geometry.regions,1,'The service window belongs to one visible original Region')
    assert.ok(geometry.service.height>0&&geometry.notice.height>0,'The original registration notice consumes a readable service row')
    assert.ok(geometry.service.y>=geometry.toolbar.bottom-2,'Registration recovery stays below the original toolbar')
    assert.ok(geometry.nativeStage.y>=geometry.service.bottom-2,'The native page stays below the actual service row')
    assert.ok(geometry.toolbarScrollWidth<=geometry.toolbar.width+2,'Registration recovery does not make the toolbar overflow')
    for(const control of ['chip','address'])assert.ok(geometry[control].width>0&&geometry[control].x>=geometry.toolbar.x-2&&geometry[control].right<=geometry.toolbar.right+2,'The original '+control+' remains inside its toolbar')
    assert.ok(geometry.chip.right<=geometry.address.x+2,'The original Profile and address controls do not overlap')
    return geometry
  }
  const addReference = async (reference: any) => {
    const current = await memberList()
    if (current.pageReferences.some((page: any) => page.regionId === reference.regionId && page.browserId === reference.browserId)) return
    const changed = await result(['space', 'survey-list', '--input', '-'], JSON.stringify({ collection: { pageReferences: [...current.pageReferences, reference], expectedPageReferences: current.pageReferences } }))
    assert.equal(changed.outcome, 'changed')
  }
  const switchViaChip = async (reference: any, profileId: string) => {
    await activateTask(reference)
    await input.click(region(reference.regionId) + ' .browser-profile-chip')
    await input.click(`.browser-profile-switcher [data-profile-id="${profileId}"]`)
  }
  const createOrdinary = async (expectedProfileId: string) => {
    const before = await memberList(), count = ports.calls.filter(call => call.channel === 'browser:create').length
    await input.click('[aria-label="New webpage"]')
    const call = await nativeUntil(() => ports.calls.filter(call => call.channel === 'browser:create')[count]?.returned ? ports.calls.filter(call => call.channel === 'browser:create')[count] : null, 'actual ordinary Survey creation Main reply')
    assert.equal(call.returned.profileId, expectedProfileId)
    const attached = await owner(call.returned.id)
    await nativeUntil(async () => (await memberList()).pageReferences.some((page: any) => page.browserId === call.returned.id && page.regionId === attached.surface.regionId), 'ordinary page exact membership')
    const after = await memberList()
    assert.equal(after.pageReferences.length, before.pageReferences.length + 1, 'An ordinary page has one exact entrance')
    assert.deepEqual(after.collectedZoneIds, before.collectedZoneIds, 'Ordinary page scaffolding is not a second whole-research entrance')
    return { call, reference: attached.reference, profileId: attached.surface.profileId }
  }
  if (phase === 'first') {
    window.setSize(1600,1000)
    await evaluate(`profileSurveyNative.prepareTask(${JSON.stringify(ctx.taskWorkspaceId)})`)
    const seeded = await facts(), launcher = Object.values(seeded.tabs).flatMap((tab: any) => Object.values(tab.regions)).find((surface: any) => surface.kind === 'launcher' && surface.workspaceId === ctx.taskWorkspaceId) as any
    assert.ok(launcher)
    assert.equal((await result(['browser', 'profile', 'ls'])).profiles.filter((profile: any) => !profile.isDefault).length, 0)
    const taskDefault = await result(['browser', 'open', '--url', origins.loginUrl + '?task-default', '--right-of', launcher.regionId])
    assert.equal(taskDefault.survey.outcome, 'not-requested')
    const taskDefaultView = await login(taskDefault, 'default-person', '?task-default')
    await navigate(taskDefault.region, pageUrl + '?task-default'); await native(taskDefault.region.browserId, taskDefault.region.profileId, pageUrl + '?task-default')
    await showSurvey(); await choose('default')
    assert.ok(await evaluate(`document.querySelector('.survey-profile-picker [role="status"]')?.checkVisibility()`), 'A genuine unread directory is visible without taking away default browsing')
    const defaultPage = await createOrdinary(taskDefault.region.profileId)
    assert.equal(defaultPage.call.requestedProfileId, null, 'The default choice goes to original Main without inventing a Profile ID')
    await navigate(defaultPage.reference, pageUrl + '?survey-default')
    const surveyDefaultView = await native(defaultPage.reference.browserId, defaultPage.profileId, pageUrl + '?survey-default')
    assert.equal(surveyDefaultView.webContents.session, taskDefaultView.webContents.session, 'Survey and task default share the original persistent native Session')
    assert.deepEqual(await identity(surveyDefaultView), { user: 'default-person' })
    assert.equal((await memberList()).pageReferences.some((page: any) => page.browserId === taskDefault.region.browserId), false)
    for (const mode of ['dark', 'light']) await capture('directory-unconfirmed', mode, 740, 840)
    window.setSize(1600,1000)
    ports.directoryFault(false); await input.click('[aria-label="Refresh Survey environments"]')
    await nativeUntil(() => evaluate(`!document.querySelector('.survey-profile-picker [aria-label="Refresh Survey environments"]')`), 'original committed directory refresh')
    mark('default-no-custom-shared-native-sign-in', { task: taskDefault.region, survey: defaultPage.reference })

    await evaluate(`profileSurveyNative.prepareLegacyWorkspace(${JSON.stringify(ctx.legacyWorkspaceId)})`)
    const graph = await result(['space', 'ls', '--presentation']), legacyZone = graph.catalog.zones.find((zone: any) => zone.workspaceId === ctx.legacyWorkspaceId)
    assert.ok(legacyZone)
    const file = await result(['file', 'open', '--path', 'original.txt', '--zone', legacyZone.zoneId])
    const actor = await result(['agent', 'open', '--executor', 'proof', '--execution-workspace', ctx.legacyWorkspaceId, '--zone', legacyZone.zoneId, '--tab', file.placement.tabId, '--region', file.placement.regionId, '--split', 'right'])
    const createProfile = async (operationId: string) => {
      const { creation } = await result(['browser', 'profile', 'create', '--label', 'Same environment name', '--operation-id', operationId])
      assert.equal(creation.durability, 'confirmed')
      assert.equal(creation.current.state, 'present')
      const profile = (await result(['browser', 'profile', 'ls'])).profiles.find((profile: any) => profile.id === creation.current.createdId)
      assert.ok(profile, 'The original Profile must appear in its directory')
      return profile
    }
    const a = await createProfile('create-profile-a')
    const b = await createProfile('create-profile-b')
    assert.notEqual(a.id, b.id)
    const pageA = await result(['browser', 'open', '--url', origins.loginUrl + '?profile-A', '--profile', a.id, '--right-of', file.placement.regionId])
    const pageB = await result(['browser', 'open', '--url', origins.loginUrl + '?profile-B', '--profile', b.id, '--right-of', file.placement.regionId])
    const viewA = await login(pageA, 'person-A', '?profile-A'); await navigate(pageA.region, pageUrl + '?profile-A')
    const viewB = await login(pageB, 'person-B', '?profile-B'); await navigate(pageB.region, pageUrl + '?profile-B')
    const siteB = nativeInput(viewB.webContents, proof.input); await siteB.fill('[aria-label="Page draft"]', 'Keep the original B page input')
    const current = await memberList()
    await result(['space', 'survey-list', '--input', '-'], JSON.stringify({ collection: { zoneIds: [...current.collectedZoneIds, legacyZone.zoneId], expectedZoneIds: current.collectedZoneIds } }))
    await showSurvey(); await choose('profile:' + b.id); await activatePage(pageB.survey.reference)
    const beforeFilter = nativeCalls(), bContentsId = viewB.webContents.id
    await choose('profile:' + a.id, true)
    assert.equal((await facts()).surveySelection, null, 'A view with only the current B page returns to the original start, without picking an A page')
    assert.equal(viewB.webContents.isDestroyed(), false); assert.equal(viewB.webContents.id, bContentsId)
    assert.equal(await viewB.webContents.executeJavaScript(`document.querySelector(${JSON.stringify('[aria-label="Page draft"]')})?.value`), 'Keep the original B page input', 'Filtering keeps the original B document input')
    assert.deepEqual(await identity(viewB), { user: 'person-B' })
    assert.equal(nativeCalls(), beforeFilter, 'The environment picker changes no native binding, address, default, creation or lifetime')
    await input.click(environment)
    await nativeUntil(() => evaluate(`document.querySelector('.survey-profile-picker__menu [role="listbox"]')?.checkVisibility()`), 'open Profile listbox after filtering')
    assert.ok(await evaluate(`[...document.querySelectorAll('.survey-profile-picker__menu .selection-field__footer button')].some(button => button.textContent === 'Manage environments…' && button.checkVisibility())`))
    await capture('picker-open', 'dark', 740, 840)
    await capture('picker-open', 'light', 1280, 900)
    await input.key('Escape', 'Escape', 27)
    mark('profile-picker-remains-mounted-with-page-input', { a: pageA.survey.reference, b: pageB.survey.reference })
    await activatePage(pageA.survey.reference); assert.deepEqual(await identity(viewA), { user: 'person-A' })
    for (const target of [a.id, b.id]) {
      await choose('profile:' + target)
      assert.ok(await evaluate(`[...document.querySelectorAll('[data-survey-zone-id]')].some(e=>e.dataset.surveyZoneId===${JSON.stringify(legacyZone.zoneId)}&&e.checkVisibility())`), 'The same complete mixed research remains present in both environments')
      await input.click(`[data-survey-tab-id="${file.placement.tabId}"]`)
      await nativeUntil(async()=> (await facts()).surveySelection?.zoneId===legacyZone.zoneId,'the same original complete research activation')
      const expectedRegions=[file.placement.regionId,actor.to.regionId,pageA.region.regionId,pageB.region.regionId]
      const shown=await nativeUntil(async()=>{
        const visible=await evaluate(`[...document.querySelectorAll('.global-survey-surface .survey-page-content [data-workbench-region-id]')].filter(e=>e.checkVisibility()&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).map(e=>e.dataset.workbenchRegionId)`)
        return expectedRegions.every(id=>visible.includes(id))?visible:null
      },'the complete original mixed Tab presentation')
      assert.deepEqual([...new Set(shown)].sort(),expectedRegions.sort(),'Profile views preserve the complete original research, including the other Profile and non-Browser siblings')
    }
    assert.equal(core.agentSession(actor.agent.agentSessionId).run.runId, actor.agent.runId)
    mark('filter-preserves-original-page-and-complete-research', { a: pageA.region, b: pageB.region, legacyZoneId: legacyZone.zoneId })

    await choose('profile:' + a.id); await activatePage(pageA.survey.reference)
    ports.hold('browser:create'); await input.click('[aria-label="New webpage"]')
    const heldCreation = await nativeUntil(() => ports.held(), 'original A creation owner reply held')
    assert.equal(heldCreation.requestedProfileId, a.id); assert.equal(heldCreation.returned.profileId, a.id)
    await choose('profile:' + b.id); ports.release()
    const late = await owner(heldCreation.returned.id)
    await nativeUntil(async () => (await memberList()).pageReferences.some((page: any) => page.browserId === late.reference.browserId), 'same late A page registration')
    assert.deepEqual((await facts()).surveyProfileView, named(b.id)); assert.equal((await facts()).surveySelection, null)
    mark('frozen-A-preparation-keeps-later-B-choice', { reference: late.reference })
    await choose('profile:' + a.id); await activatePage(late.reference); await navigate(late.reference, pageUrl + '?late-A')

    ports.nextCreateMetadataFault()
    const beforeRetryCreate = ports.calls.filter(call => call.channel === 'browser:create').length
    await input.click('[aria-label="New webpage"]')
    const partialCall = await nativeUntil(() => ports.calls.filter(call => call.channel === 'browser:create')[beforeRetryCreate]?.returned ? ports.calls.filter(call => call.channel === 'browser:create')[beforeRetryCreate] : null, 'original A native creation before metadata failure')
    const partial = await owner(partialCall.returned.id)
    await nativeUntil(() => evaluate(`document.querySelector('.survey-error button')?.checkVisibility()`), 'retained preparation metadata recovery control')
    assert.equal(partialCall.returned.profileId, a.id)
    assert.ok(receipt.profileSwitchPreferenceFailures?.some((failure:any)=>failure.browserId===partialCall.returned.id),'The original exact preference writer fault actually executed')
    for(const mode of ['dark','light'])await capture('creation-metadata-unconfirmed',mode,740,840)
    window.setSize(1600,1000)
    await choose('profile:' + b.id); ports.metadataFault(null)
    const preparationRetryNativeCalls=nativeCalls()
    await input.click('.survey-error button','Retry Survey registration')
    await nativeUntil(() => evaluate(`document.querySelector('[aria-label="New webpage"]')?.disabled===false`), 'the original metadata retry has settled')
    assert.equal(await evaluate(`Boolean(document.querySelector('.survey-error'))`),false,'Preparation metadata Retry repairs the original frozen A entry while the later view is B')
    assert.equal(ports.calls.filter(call => call.channel === 'browser:create').length, beforeRetryCreate + 1, 'Retry never creates a second native page')
    assert.equal(nativeCalls(),preparationRetryNativeCalls,'Preparation metadata Retry dispatches no native mutation')
    assert.deepEqual((await facts()).surveyProfileView, named(b.id))
    assert.equal((await owner(partial.reference.browserId)).surface.profileId, a.id)
    mark('preparation-metadata-retry-never-reopens-or-retargets', { reference: partial.reference })

    await choose('profile:' + a.id); await activatePage(partial.reference); await navigate(partial.reference, pageUrl + '?retry-A')

    const metadataPage = await result(['browser', 'open', '--url', pageUrl + '?metadata-binding', '--right-of', taskDefault.region.regionId])
    assert.equal((await memberList()).pageReferences.some((page: any) => page.browserId === metadataPage.region.browserId), false)
    await result(['space', 'promote', '--region', metadataPage.region.regionId])
    ports.metadataFault(metadataPage.region.browserId)
    const switchBefore = ports.calls.filter(call => call.channel === 'browser:switchProfile').length
    await switchViaChip(metadataPage.region, b.id)
    const bindingCall = await nativeUntil(() => ports.calls.filter(call => call.channel === 'browser:switchProfile')[switchBefore]?.returned ? ports.calls.filter(call => call.channel === 'browser:switchProfile')[switchBefore] : null, 'original Main B binding receipt')
    assert.equal(bindingCall.returned.id, metadataPage.region.browserId); assert.equal(bindingCall.returned.profileId, b.id)
    const boundB = await native(metadataPage.region.browserId, b.id, pageUrl + '?metadata-binding')
    assert.deepEqual(await identity(boundB), { user: 'person-B' })
    await nativeUntil(() => evaluate(`document.querySelector('[data-survey-profile-registration="${metadataPage.region.browserId}"] button')?.checkVisibility()`), 'separate metadata recovery after confirmed native binding')
    assert.ok(receipt.profileSwitchPreferenceFailures?.some((failure:any)=>failure.browserId===metadataPage.region.browserId),'Confirmed binding reaches the original weak preference failure')
    for (const mode of ['dark', 'light']) {
      await capture('binding-metadata-unconfirmed', mode, 1100, 850)
      proof.frames.at(-1).geometry=await serviceGeometry(metadataPage.region,boundB)
    }
    await showSurvey(); await choose('profile:' + a.id)
    ports.metadataFault(null)
    await activateTask(metadataPage.region)
    const bindingRepairNativeCalls=nativeCalls()
    await input.click(`[data-survey-profile-registration="${metadataPage.region.browserId}"] button`)
    await nativeUntil(() => evaluate(`!document.querySelector('[data-survey-profile-registration="${metadataPage.region.browserId}"]')`), 'original metadata repair acknowledgment')
    assert.equal(ports.calls.filter(call => call.channel === 'browser:switchProfile').length, switchBefore + 1, 'Metadata Retry never dispatches a native switch')
    assert.equal(nativeCalls(),bindingRepairNativeCalls,'Confirmed-binding metadata repair dispatches no native mutation')
    assert.equal((await owner(metadataPage.region.browserId)).surface.profileId, b.id)
    assert.deepEqual((await facts()).surveyProfileView, named(a.id), 'A later filter cannot retarget the original confirmed B binding')
    assert.equal((await memberList()).pageReferences.filter((page: any) => page.browserId === metadataPage.region.browserId).length, 1)
    const savedAfterRepair = JSON.parse((await ctx.readWorkbenchState())!)
    assert.ok(savedAfterRepair.state.surveyPageReferences.some((page: any) => page.browserId === metadataPage.region.browserId), 'Metadata Retry reaches the original durable preference writer')
    mark('confirmed-native-binding-metadata-retry-no-replay', { reference: metadataPage.region, returned: bindingCall.returned })

    ports.holdUpdates(metadataPage.region.browserId)
    ports.hold('browser:switchProfile',metadataPage.region.browserId)
    await switchViaChip(metadataPage.region,a.id)
    const lost=await nativeUntil(()=>ports.held(),'the original successful A binding before its lost ACK')
    assert.equal(lost.returned.profileId,a.id)
    await nativeUntil(()=>ports.heldUpdateCount(a.id)>0,'the original Main target binding update held for late delivery')
    assert.equal((await owner(metadataPage.region.browserId)).surface.profileId,b.id,'The controlled late update has not changed the original Renderer binding')
    ports.release(true)
    await nativeUntil(()=>ports.calls[lost.index]?.state==='ack-lost','the exact original ACK loss')
    await nativeUntil(()=>evaluate(`(()=>{const e=document.querySelector('${region(metadataPage.region.regionId)} .browser-profile-chip');return e&&!e.hasAttribute('data-pending')})()`),'the original missing ACK has reached the Chip before the late update')
    proof.ackFirstBeforeUpdated={profileId:(await owner(metadataPage.region.browserId)).surface.profileId,heldUpdates:ports.heldUpdateCount(),dom:await evaluate(`(()=>{const e=[...document.querySelectorAll('${region(metadataPage.region.regionId)}')].find(e=>e.checkVisibility());return{chip:e?.querySelector('.browser-profile-chip')?.outerHTML,notice:e?.querySelector('.browser-profile-service')?.textContent,failure:e?.querySelector('.browser-profile-chip__failure')?.textContent}})()`)}
    assert.equal(proof.ackFirstBeforeUpdated.profileId,b.id,'The original ACK failure is processed before the target binding is observed')
    ports.releaseUpdates()
    const observedLost=await nativeUntil(async()=>{const current=await owner(metadataPage.region.browserId);return current.surface.mode==='normal'&&current.surface.profileId===a.id&&current.surface.navigationId===lost.returned.navigationId?current.surface:null},'the late original Main update confirms the same target after the missing ACK')
    proof.originalBindingObservedAfterLostAck={browserId:observedLost.browserId,profileId:observedLost.profileId,navigationId:observedLost.navigationId}
    try {
      await nativeUntil(()=>evaluate(`[...document.querySelectorAll('[data-survey-profile-registration="${metadataPage.region.browserId}"] button')].some(e=>e.checkVisibility()&&e.textContent.trim()==='Retry Survey registration')`),'unknown binding keeps its metadata-only recovery control')
    } catch(error) {
      proof.lostAckRecoveryDOM=await evaluate(`(()=>{const e=[...document.querySelectorAll('${region(metadataPage.region.regionId)}')].find(e=>e.checkVisibility());return{regionVisible:Boolean(e),chip:e?.querySelector('.browser-profile-chip')?.outerHTML,services:[...document.querySelectorAll('.browser-profile-service')].map(e=>({visible:e.checkVisibility(),text:e.textContent,html:e.innerHTML}))}})()`)
      throw error
    }
    const lostNative=await native(metadataPage.region.browserId,a.id,pageUrl+'?metadata-binding')
    for(const mode of ['dark','light']){
      await capture('switch-reply-unconfirmed',mode,1100,850)
      proof.frames.at(-1).geometry=await serviceGeometry(metadataPage.region,lostNative)
    }
    const afterLost=ports.calls.filter(call=>call.channel==='browser:switchProfile').length
    await showSurvey();await choose('profile:'+b.id);await activateTask(metadataPage.region)
    const lostRepairNativeCalls=nativeCalls()
    await input.click(`[data-survey-profile-registration="${metadataPage.region.browserId}"] button`)
    await nativeUntil(()=>evaluate(`!document.querySelector('[data-survey-profile-registration="${metadataPage.region.browserId}"]')`),'metadata-only recovery after the lost original ACK')
    assert.equal(ports.calls.filter(call=>call.channel==='browser:switchProfile').length,afterLost,'A lost successful Main ACK is never replayed by metadata Retry')
    assert.equal(nativeCalls(),lostRepairNativeCalls,'Lost-ACK metadata repair dispatches no native mutation')
    const afterLostNative=await native(metadataPage.region.browserId,a.id,pageUrl+'?metadata-binding')
    assert.deepEqual(await identity(afterLostNative),{user:'person-A'})
    assert.deepEqual((await facts()).surveyProfileView,named(b.id))
    mark('successful-Main-lost-ACK-metadata-retry-zero-second-switch',{reference:metadataPage.region,originalMainCall:lost.index})

    const withdrawnPage = await result(['browser', 'open', '--url', pageUrl + '?membership-binding', '--right-of', taskDefault.region.regionId])
    const withdrawnReference = { regionId: withdrawnPage.region.regionId, browserId: withdrawnPage.region.browserId }
    await addReference(withdrawnReference)
    ports.hold('browser:switchProfile', withdrawnReference.browserId)
    await switchViaChip(withdrawnReference, b.id)
    const pendingBinding = await nativeUntil(() => ports.held(), 'original B binding reply held before membership withdrawal')
    assert.equal(pendingBinding.returned.profileId, b.id)
    await showSurvey(); await choose('profile:' + b.id)
    const withdrawPage = async () => {
      await input.click(pageRow(withdrawnReference.browserId) + ' .survey-item', undefined, 'right')
      await input.click('.survey-item-menu [role="menuitem"]', 'Remove page from Survey')
    }
    await withdrawPage()
    await nativeUntil(async () => !(await memberList()).pageReferences.some((page: any) => page.browserId === withdrawnReference.browserId), 'first explicit membership withdrawal')
    await addReference(withdrawnReference)
    await withdrawPage()
    await nativeUntil(async () => !(await memberList()).pageReferences.some((page: any) => page.browserId === withdrawnReference.browserId), 'later add/remove with an equal final membership set')
    ports.release()
    await nativeUntil(() => !evaluatePending(ports, pendingBinding.index), 'the same binding reply released')
    await activateTask(withdrawnReference)
    await nativeUntil(()=>evaluate(`(()=>{const e=document.querySelector('${region(withdrawnReference.regionId)} .browser-profile-chip');return e&&!e.hasAttribute('data-pending')})()`),'the original binding UI has settled')
    assert.equal((await memberList()).pageReferences.some((page: any) => page.browserId === withdrawnReference.browserId), false, 'Late binding cannot resurrect a withdrawn reference after ABA')
    assert.ok(await evaluate(`document.querySelector('[data-survey-profile-registration="${withdrawnReference.browserId}"]')?.checkVisibility()`),'The later membership intent remains visible beside the original binding')
    assert.equal((await owner(withdrawnReference.browserId)).surface.profileId, b.id)
    mark('binding-membership-generation-ABA-keeps-later-withdrawal', { reference: withdrawnReference })

    await addReference(withdrawnReference)
    ports.hold('browser:switchProfile', withdrawnReference.browserId)
    await switchViaChip(withdrawnReference, a.id)
    const closingBinding = await nativeUntil(() => ports.held(), 'original A binding reply held before Close')
    const closingNative = await native(withdrawnReference.browserId, a.id, pageUrl + '?membership-binding')
    const closingContents=closingNative.webContents,closingContentsId=closingContents.id
    await input.click(region(withdrawnReference.regionId) + ' [aria-label="Close split"]')
    const closeReceipt = await nativeUntil(() => receipt.workbenchCloseCalls?.find((call: any) => {
      const operation = call.result.value?.operation
      return call.method === 'space.close.apply' && call.result.ok && operation?.outcome === 'applied' &&
        operation.diskDurability === 'confirmed' && operation.plan.target.regionId === withdrawnReference.regionId &&
        operation.resources.some((resource: any) => resource.outcome === 'acknowledged' && resource.receipt?.kind === 'browser-closed' &&
          resource.receipt.browserId === withdrawnReference.browserId)
    }), 'exact original workbench Close receipt during pending binding')
    proof.closeOperationId = closeReceipt.result.value.operation.operationId
    proof.closedNative={browserId:withdrawnReference.browserId,contentsId:closingContentsId,destroyed:closingContents.isDestroyed()}
    assert.equal(closingContents.isDestroyed(), true,'The exact original native WebContents is physically destroyed by the acknowledged Close')
    ports.release(); await nativeUntil(() => !evaluatePending(ports, closingBinding.index), 'original closed binding reply released')
    await nativeUntil(async () => !Object.values((await facts()).tabs).some((tab: any) => tab.regions[withdrawnReference.regionId]), 'Close keeps the exact Region absent')
    await evaluate('profileSurveyNative.checkpoint()')
    await nativeUntil(async () => !(await result(['browser', 'targets'])).targets.some((target: any) => target.id === withdrawnReference.browserId), 'no live/cold recreation after original Core deletion acknowledgment')
    assert.equal((await memberList()).pageReferences.some((page: any) => page.browserId === withdrawnReference.browserId), false,
      'The acknowledged original Close removes its Survey reference without letting a late binding recreate it')
    mark('pending-binding-close-never-recreates-original', { reference: withdrawnReference })

    await showSurvey(); await choose('profile:' + a.id)
    const privateBefore = await memberList(), privateCount = ports.calls.filter(call => call.channel === 'browser:create').length
    await input.click('[aria-label="New browser options"]'); await input.click('[role="menuitem"]', 'New private page')
    const privateCall = await nativeUntil(() => ports.calls.filter(call => call.channel === 'browser:create')[privateCount]?.returned ? ports.calls.filter(call => call.channel === 'browser:create')[privateCount] : null, 'original private Survey creation')
    assert.equal(privateCall.mode, 'private'); assert.equal(privateCall.requestedProfileId, null)
    const privateOwner = await owner(privateCall.returned.id)
    await nativeUntil(async () => (await memberList()).pageReferences.some((page: any) => page.browserId === privateCall.returned.id), 'original private page entry remains usable')
    assert.equal((await memberList()).pageReferences.length, privateBefore.pageReferences.length + 1)
    assert.deepEqual((await memberList()).collectedZoneIds, privateBefore.collectedZoneIds)
    const privateNative = ports.original(privateCall.returned.id)
    assert.ok(privateNative); assert.equal(privateNative.webContents.session.isPersistent(), false)
    assert.equal(privateOwner.surface.mode, 'private'); assert.equal(privateOwner.surface.profileId, null)
    mark('private-entry-stays-private-and-single', { reference: privateOwner.reference })

    await choose('profile:' + a.id); await activatePage(pageA.survey.reference)
    for (const mode of ['dark', 'light']) for (const [label, width, height] of [['normal', 1280, 900], ['narrow', 740, 840], ['short', 1000, 620]] as const) {
      await capture(label, mode, width, height)
      proof.frames.at(-1).geometry = await admissionGeometry(window, evaluate, pageA, pageUrl + '?profile-A', value => { proof.lastGeometry = value })
    }
    await writeFile(join(directory, 'first-profile-switch-native-A.png'), (await viewA.webContents.capturePage()).toPNG())
    assert.equal(ports.calls.filter(call => call.channel === 'browser:setDefaultProfile').length, 0, 'A view or ordinary creation never changes the global default')
    assert.ok((await evaluate('globalThis.profileSurveySelectEvents')).some((event: any) => event.trusted), 'The real keyboard selector emitted trusted changes')
    for(const [id,draft] of Object.entries(seeded.launcherDrafts))assert.deepEqual((await facts()).launcherDrafts[id],draft,'Profile work preserves every original application draft')
    await evaluate('profileSurveyNative.checkpoint()')
    const final = await facts()
    receipt.savedIdentity = { profiles: { a, b, defaultId: taskDefault.region.profileId }, taskDefault: taskDefault.region, defaultPage, pageA, pageB,
      metadataPage: metadataPage.region, partial: partial.reference, late: late.reference, closed: withdrawnReference, privatePage: privateOwner.reference,
      actor: actor.agent, legacyZoneId: legacyZone.zoneId, launcherDrafts: final.launcherDrafts,
      taskTabs: Object.fromEntries(Object.values(final.tabs).filter((tab: any) => tab.workspaceId === ctx.taskWorkspaceId || tab.workspaceId === ctx.legacyWorkspaceId).map((tab: any) => [tab.id, persistentTask(tab)])),
      pageReferences: (await memberList()).pageReferences, profileView: final.surveyProfileView,
      storagePaths: { default: taskDefaultView.webContents.session.storagePath, a: viewA.webContents.session.storagePath, b: viewB.webContents.session.storagePath } }
    await writeFile(join(directory, 'profile-switch-retained.json'), JSON.stringify(receipt.savedIdentity))
  } else {
    const prior = JSON.parse(await readFile(join(directory, 'profile-switch-retained.json'), 'utf8'))
    const cold = await facts()
    assert.deepEqual(cold.surveyProfileView, prior.profileView, 'Second PID preserves the same view preference')
    assert.deepEqual(cold.launcherDrafts, prior.launcherDrafts)
    for (const [id, tab] of Object.entries(prior.taskTabs)) assert.deepEqual(persistentTask(cold.tabs[id]), tab)
    assert.equal(core.agentSession(prior.actor.agentSessionId).run.runId, prior.actor.runId)
    assert.deepEqual((await memberList()).pageReferences, prior.pageReferences, 'Cold hydration does not re-register or discard original references')
    assert.equal(Object.values(cold.tabs).some((tab: any) => tab.regions[prior.closed.regionId]), false)
    assert.equal((await result(['browser', 'targets'])).targets.some((target: any) => target.id === prior.closed.browserId), false)
    await showSurvey(); await choose('profile:' + prior.profiles.a.id); await activatePage(prior.pageA.survey.reference)
    const a = await native(prior.pageA.region.browserId, prior.profiles.a.id, pageUrl + '?profile-A')
    assert.deepEqual(await identity(a), { user: 'person-A' }); assert.equal(a.webContents.session.storagePath, prior.storagePaths.a)
    await choose('profile:' + prior.profiles.b.id); await activatePage(prior.pageB.survey.reference)
    const b = await native(prior.pageB.region.browserId, prior.profiles.b.id, pageUrl + '?profile-B')
    assert.deepEqual(await identity(b), { user: 'person-B' }); assert.equal(b.webContents.session.storagePath, prior.storagePaths.b)
    await choose('default'); await activatePage(prior.defaultPage.reference)
    const shared = await native(prior.defaultPage.reference.browserId, prior.profiles.defaultId, pageUrl + '?survey-default')
    await activateTask(prior.taskDefault)
    const task = await native(prior.taskDefault.browserId, prior.profiles.defaultId, pageUrl + '?task-default')
    assert.equal(shared.webContents.session, task.webContents.session); assert.equal(task.webContents.session.storagePath, prior.storagePaths.default)
    assert.deepEqual(await identity(shared), { user: 'default-person' }); assert.deepEqual(await identity(task), { user: 'default-person' })
    await showSurvey(); await choose('profile:' + prior.profiles.a.id); await activatePage(prior.pageA.survey.reference)
    const recoveredA=await native(prior.pageA.region.browserId,prior.profiles.a.id,pageUrl+'?profile-A')
    await nativeUntil(()=>recoveredA.getVisible()&&recoveredA.getBounds().width>0&&recoveredA.getBounds().height>0,'the restored original native page is actually visible in its Survey Region')
    proof.recoveredGeometry=await admissionGeometry(window,evaluate,prior.pageA,pageUrl+'?profile-A',value=>{proof.lastGeometry=value})
    assert.equal(proof.recoveredGeometry.native.visible,true,'The second PID presents the original native Browser in its full exact Region')
    receipt.recoveredIdentity = prior
    mark('second-PID-original-view-references-partitions-and-real-sign-in')
  }
  const required = phase === 'first' ? ['default-no-custom-shared-native-sign-in', 'filter-preserves-original-page-and-complete-research',
    'frozen-A-preparation-keeps-later-B-choice', 'preparation-metadata-retry-never-reopens-or-retargets',
    'confirmed-native-binding-metadata-retry-no-replay', 'binding-membership-generation-ABA-keeps-later-withdrawal',
    'successful-Main-lost-ACK-metadata-retry-zero-second-switch',
    'pending-binding-close-never-recreates-original', 'private-entry-stays-private-and-single'] : ['second-PID-original-view-references-partitions-and-real-sign-in']
  assert.ok(required.every(kind => proof.cases.some((entry: any) => entry.kind === kind && entry.passed)), 'Every dedicated T002 stage must actually complete')
  if (phase === 'first') {
    const scenes = ['directory-unconfirmed', 'picker-open', 'creation-metadata-unconfirmed', 'binding-metadata-unconfirmed',
      'switch-reply-unconfirmed', 'normal', 'narrow', 'short']
    const expected = ['dark', 'light'].flatMap(theme => scenes.map(scene => `first-profile-switch-${theme}-${scene}.png`))
    assert.deepEqual(proof.frames.map((frame: { file: string }) => frame.file).sort(), expected.sort(),
      'Each original profile workface and its recovery scenarios must be captured in both themes')
  }
  proof.completed = true
  receipt.cases.push({ kind: 'profile-switch-dedicated-oracle', phase, passed: true })
}

function evaluatePending(ports: ProfileSwitchPorts, index: number) { return ports.calls[index]?.state === 'owner-returned-ack-held' }
