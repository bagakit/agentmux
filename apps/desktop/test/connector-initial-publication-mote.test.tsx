// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'

let f: Awaited<ReturnType<typeof moteBotUi>>
afterEach(async () => { await f?.close() })
async function ready(check: () => void) { await vi.waitFor(async () => { await f.settle(); check() }, { timeout: 8000 }) }
it('the mounted Mote creation consent publishes its exact first bot version without unrelated publication dependencies', async () => {
  f = await moteBotUi()
  const base = f.registration.getMockImplementation()!, requests: Array<{ path: string; body: any }> = [], APP = 'cli_mote_1', VERSION = 'first-mote-version'
  let submitted = false
  f.registration.mockImplementation(async (url, init = {}) => {
    const target = new URL(String(url)), path = target.pathname
    if (path.includes('/app_version/') || path.includes('/publish/') || path.includes('/robot/') || path.includes('/event/') || path.includes('/callback/') || path.includes('/scope/')) {
      requests.push({ path, body: JSON.parse(String(init.body ?? '{}')) })
      const data = path === '/developers/v1/robot/' + APP ? { enable: true }
        : path === '/developers/v1/event/' + APP ? { eventMode: 4, appEventDetails: [{ items: [{ id: 'im.message.receive_v1' }] }] }
        : path === '/developers/v1/callback/' + APP ? { callbackMode: 4, callbacks: ['card.action.trigger'] }
        : path === '/developers/v1/scope/all/' + APP ? { scopes: ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only', 'application:application:self_manage'].map((name, index) => ({ name, id: index + 1, scopeType: [2] })) }
        : path === '/developers/v1/scope/applied/' + APP ? { scopes: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, scopeIdentityType: 2 })) }
        : path === '/developers/v1/event/all/' + APP ? { events: [{ items: [{ id: 'im.message.receive_v1', supportIdentityTypes: [2] }] }] }
        : path === '/developers/v1/app_version/list/' + APP ? { versions: [] }
        : path === '/developers/v1/app_version/detail/' + APP + '/' + VERSION ? { appVersion: '1.0.0', versionStatus: submitted ? 1 : 4 }
        : path === '/developers/v1/app_version/create/' + APP ? { versionId: VERSION }
        : path === '/developers/v1/publish/commit/' + APP + '/' + VERSION ? (submitted = true, { urlConflict: false, avatar: 'original-avatar', isOk: true })
        : null
      if (data) return Response.json({ code: 0, data })
      return new Response('Unrelated publication source is unavailable', { status: 502 })
    }
    return base(url, init)
  })
  await f.open()
  expect(f.creationCount).toBe(0)
  expect(requests).toEqual([])
  await f.click('Sign in & continue')
  await ready(() => expect(document.querySelector('[data-mote-enrollment-action="confirm-account"]')).not.toBeNull())
  expect(f.creationCount).toBe(0)
  await f.click('Confirm this account')
  expect(f.creationCount).toBe(0)
  expect(requests).toEqual([])
  const parentInput = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as any
  expect(parentInput).toMatchObject({ source: { target: f.target() }, initialPublication: { version: '1.0.0', notes: 'Enable AMUX conversations.' } })
  await f.click('Create, configure & publish')
  await ready(() => expect(document.body.textContent).toContain('Waiting for platform approval'))
  const parent = (await f.client.call('space.mote.connection.inspect', { operationId: parentInput.operationId })).operation!
  expect(parent.enrollment?.initialSetup?.progress).toMatchObject({ stage: 'publication-status', state: 'approval-required', versionId: VERSION })
  const publication = requests.filter(request => request.path.includes('/app_version/') || request.path.includes('/publish/'))
  expect(publication.map(request => request.path)).toEqual(['/developers/v1/app_version/list/' + APP, '/developers/v1/app_version/create/' + APP, '/developers/v1/app_version/detail/' + APP + '/' + VERSION, '/developers/v1/publish/commit/' + APP + '/' + VERSION, '/developers/v1/app_version/detail/' + APP + '/' + VERSION])
  expect(publication.find(request => request.path.includes('/create/'))!.body).toEqual({ appVersion: '1.0.0', changeLog: 'Enable AMUX conversations.', pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot', visibleSuggest: { departments: [], members: ['mote-user-1'], groups: [], isAll: 0 }, blackVisibleSuggest: { departments: [], members: [], groups: [], isAll: 0 } })
  expect(publication.find(request => request.path.includes('/commit/'))!.body).toEqual({ clientId: APP })
  expect(f.beginCount).toBe(1); expect(f.creationCount).toBe(1)
  await f.click('Check saved progress')
  const after = (await f.client.call('space.mote.connection.inspect', { operationId: parentInput.operationId })).operation!
  expect(after.operationId).toBe(parent.operationId)
  expect(after.defaultSave?.params).toEqual(parent.defaultSave?.params)
  expect(after.defaultSave?.observedReceipt).toMatchObject({ operationId: parent.defaultSave!.params.operationId, status: 'saved' })
  expect(requests.filter(request => request.path.includes('/create/') || request.path.includes('/commit/'))).toEqual(publication.filter(request => request.path.includes('/create/') || request.path.includes('/commit/')))
  expect(document.body.textContent).toContain('Waiting for platform approval')
}, 30_000)
