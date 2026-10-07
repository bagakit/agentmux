import { afterEach, expect, it, vi } from 'vitest'
import { feishuRoomsHttp } from './fixtures/feishu-rooms.js'
import { feishuConfig } from './fixtures/feishu.js'
import { profilePng, profileDataUrl, originalI18n } from './fixtures/connection-profile.js'

afterEach(()=>vi.restoreAllMocks())
const app=feishuConfig.application.appId,credential='private-fixture-credential'
function fixture(overrides:{app?:unknown;version?:unknown;bot?:unknown;patch?:unknown;upload?:unknown}={}) {
  return feishuRoomsHttp(async r=>{
    if(r.url?.endsWith('/bot/v3/info'))return overrides.bot??{code:0,bot:{open_id:'native-bot',app_name:'Online name',avatar_url:'https://images.example.invalid/online.png'}}
    if(r.url?.endsWith('/app_avatar/upload'))return overrides.upload??{code:0,data:{url:'https://images.example.invalid/upload.png'}}
    if(r.method==='PATCH')return overrides.patch??{code:0,data:{}}
    if(r.url?.includes('/app_versions/'))return overrides.version??{code:0,data:{app_version:{app_id:app,version_id:'online-version',description:'Actual online description',status:1}}}
    return overrides.app??{code:0,data:{app:{app_id:app,description:'Unpublished metadata',online_version_id:'online-version',unaudit_version_id:'pending-version',i18n:structuredClone(originalI18n)}}}
  })
}
it('uploads exact original PNG bytes through the original SDK and accepts empty base PATCH success without publishing',async()=>{
  const f=fixture(),profile=f.adapter.profile
  const upload=await profile.prepareUpload(feishuConfig,profileDataUrl)
  expect(await profile.upload(feishuConfig,upload,credential)).toEqual({state:'confirmed',avatarUrl:'https://images.example.invalid/upload.png'})
  expect(f.calls[0]!.data!.avatar).toEqual(profilePng)
  expect(f.calls[0]!.url).toBe('https://open.feishu.cn/open-apis/application/v7/app_avatar/upload')
  const patch=await profile.preparePatch(feishuConfig,{name:'Desired',description:'Description'},'https://images.example.invalid/upload.png',credential)
  expect(patch.language).toBe('zh_cn')
  expect(await profile.patch(feishuConfig,patch,credential)).toEqual({state:'confirmed'})
  expect(f.calls.at(-1)).toMatchObject({url:'https://open.feishu.cn/open-apis/application/v7/applications/'+app+'/base',method:'PATCH',data:{i18ns:[originalI18n[0],{i18n_key:'zh_cn',name:'Desired',description:'Description'}],avatar_url:'https://images.example.invalid/upload.png'}})
  expect(f.calls.some(r=>r.url?.includes('/publish'))).toBe(false)
})
it.each([[210005,'creation-origin-unsupported'],[210021,'creation-origin-unsupported'],[210007,'permission-required'],[210010,'application-under-review'],[210011,'platform-rejected'],[210003,'effect-unconfirmed']])('reports exact native rejection %s without treating origin absence as a gate',async(code,reason)=>{
  const f=fixture({patch:{code}}),p=f.adapter.profile
  const wire=await p.preparePatch(feishuConfig,{},'https://images.example.invalid/original.png',credential)
  expect(await p.patch(feishuConfig,wire,credential)).toEqual({state:code===210003?'unknown':'refused',reason})
  expect(f.calls).toHaveLength(1)
})
it('keeps avatar-only updates independent of metadata read permission, while protecting multilingual fields',async()=>{
  const f=fixture({app:{code:210007}}),p=f.adapter.profile
  await expect(p.preparePatch(feishuConfig,{name:'Name'},undefined,credential)).rejects.toMatchObject({reason:'permission-required'})
  const before=f.calls.length,wire=await p.preparePatch(feishuConfig,{},'https://images.example.invalid/original.png',credential)
  expect(await p.patch(feishuConfig,wire,credential)).toEqual({state:'confirmed'})
  expect(f.calls.slice(before).map(r=>r.method)).toEqual(['PATCH'])
})
it('does not overwrite an observed newer multilingual baseline or claim a platform CAS',async()=>{
  const f=fixture(),p=f.adapter.profile,wire=await p.preparePatch(feishuConfig,{name:'Name'},undefined,credential)
  f.request.mockImplementation(async r=>r.url?.includes('/auth/v3/')?{code:0,tenant_access_token:'fixture-access',expire:3600}:{code:0,data:{app:{app_id:app,i18n:[...originalI18n,{i18n_key:'ja_jp',name:'New concurrent language'}]}}})
  expect(await p.patch(feishuConfig,wire,credential)).toEqual({state:'not-dispatched',reason:'source-unconfirmed'})
  expect(f.request.mock.calls.some(([r])=>r.method==='PATCH')).toBe(false)
})
it('reads description only from the exact app online version and keeps top-level metadata separate',async()=>{
  const f=fixture(),o=await f.adapter.profile.get(feishuConfig,3,credential)
  expect(o).toMatchObject({connectionRevision:3,language:'zh_cn',profile:{name:'Online name',description:'Actual online description'},metadata:{description:'Unpublished metadata'},onlineVersionId:'online-version',reviewingVersionId:'pending-version',version:{versionId:'online-version',status:'approved'}})
  expect(f.calls.map(r=>r.url)).toContain('https://open.feishu.cn/open-apis/application/v6/applications/'+app+'/app_versions/online-version')
})
it.each([
  {app:{code:0,data:{app:{app_id:'foreign-app',description:'Wrong app',online_version_id:'online-version'}}}},
  {version:{code:0,data:{app_version:{app_id:'foreign-app',version_id:'online-version',description:'Wrong app version',status:1}}}},
  {version:{code:0,data:{app_version:{app_id:app,version_id:'different-version',description:'Wrong version',status:1}}}},
  {version:{code:0,data:{app_version:{app_id:app,version_id:'online-version',description:'Malformed version',status:'1'}}}},
  {version:{code:210007}},
  {app:{code:0,data:{app:{app_id:app,description:'Not online',i18n:originalI18n}}}}
])('does not promote missing or wrong native identity/version into online description: %j',async bad=>{
  const f=fixture(bad),o=await f.adapter.profile.get(feishuConfig,1,credential)
  expect(o.profile?.name).toBe('Online name');expect(o.profile).not.toHaveProperty('description');expect(o.version).toBeNull()
})
it.each([{code:'0',data:{}},{data:{}},{code:0,data:[]}])('does not accept malformed base receipts: %j',async response=>{
  const f=fixture({patch:response}),p=f.adapter.profile,wire=await p.preparePatch(feishuConfig,{},'https://images.example.invalid/original.png',credential)
  const effect=await p.patch(feishuConfig,wire,credential)
  if((response as {code?:unknown}).code===0)expect(effect.state).toBe('unknown');else expect(effect.state).toBe('unknown')
})
it('rejects wrong frozen application and propagates caller lifetime to SDK without replaying an aborted effect',async()=>{
  const f=fixture(),p=f.adapter.profile,controller=new AbortController()
  const wire=await p.preparePatch(feishuConfig,{},'https://images.example.invalid/original.png',credential)
  expect(await p.patch({...feishuConfig,application:{...feishuConfig.application,appId:'foreign-app'}},wire,credential)).toEqual({state:'not-dispatched',reason:'source-unconfirmed'})
  expect(f.calls).toHaveLength(0)
  controller.abort();expect((await p.patch(feishuConfig,wire,credential,controller.signal)).state).toBe('not-dispatched');expect(f.calls).toHaveLength(0)
  const active=new AbortController();await p.patch(feishuConfig,wire,credential,active.signal);expect(f.calls[0]!.signal).toBe(active.signal)
})
