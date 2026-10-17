import { afterEach, expect, it, vi } from 'vitest'
import { feishuRoomsHttp } from './fixtures/feishu-rooms.js'
import { feishuConfig } from './fixtures/feishu.js'

afterEach(() => vi.restoreAllMocks())
const app = feishuConfig.application.appId, credential = 'synthetic-reader-credential'
function fixture(overrides: { app?: unknown; version?: unknown; bot?: unknown } = {}) {
  return feishuRoomsHttp(async request => {
    if (request.url?.endsWith('/bot/v3/info')) return overrides.bot ?? { code: 0, bot: { open_id: 'native-bot', app_name: 'Online name', avatar_url: 'https://images.example.invalid/online.png' } }
    if (request.url?.includes('/app_versions/')) return overrides.version ?? { code: 0, data: { app_version: { app_id: app, version_id: 'online-version', description: 'Actual online description', status: 1 } } }
    return overrides.app ?? { code: 0, data: { app: { app_id: app, description: 'Unpublished metadata', online_version_id: 'online-version', unaudit_version_id: 'pending-version' } } }
  })
}
it('retains the independent SDK online reader and exposes no retired upload or PATCH writer', async () => {
  const f = fixture(), profile = f.adapter.profile
  for (const method of ['prepareUpload', 'upload', 'preparePatch', 'patch']) expect(profile).not.toHaveProperty(method)
  expect(await profile.get(feishuConfig, 3, credential)).toMatchObject({ state: 'observed', botId: 'native-bot', onlineVersionId: 'online-version' })
  expect(f.calls.every(request => request.method === 'GET')).toBe(true)
  expect(f.calls.some(request => request.url?.includes('/publish') || request.url?.includes('/app_avatar/'))).toBe(false)
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
  {app:{code:0,data:{app:{app_id:app,description:'Not online'}}}}
])('does not promote missing or wrong native identity/version into online description: %j',async bad=>{
  const f=fixture(bad),o=await f.adapter.profile.get(feishuConfig,1,credential)
  expect(o.profile?.name).toBe('Online name');expect(o.profile).not.toHaveProperty('description');expect(o.version).toBeNull()
})
