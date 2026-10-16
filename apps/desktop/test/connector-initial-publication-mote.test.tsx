// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { moteBotUi } from './fixtures/mote-bot-ui'

let f: Awaited<ReturnType<typeof moteBotUi>>
afterEach(async () => { await f?.close() })
async function ready(check: () => void) { await vi.waitFor(async () => { await f.settle(); check() }, { timeout: 8000 }) }
async function click(selector: string) {
  let button!: HTMLButtonElement
  await ready(() => { button = document.querySelector(selector)!; expect(button, selector).not.toBeNull(); expect(button.disabled, selector).toBe(false) })
  for (let parent = button.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement && !parent.open) await act(async () => parent!.querySelector<HTMLElement>('summary')!.click())
  await act(async () => button.click())
}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[aria-label="' + label + '"]')!
  expect(input, label).not.toBeNull()
  await act(async () => {
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}

it('the original mounted Mote creation continues into explicit first bot version creation and exact submission without unrelated publication dependencies', async () => {
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
        : path === '/developers/v1/scope/all/' + APP ? { scopes: ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only'].map((name, index) => ({ name, id: index + 1, scopeType: [2] })) }
        : path === '/developers/v1/scope/applied/' + APP ? { scopes: Array.from({ length: 7 }, (_, index) => ({ id: index + 1, scopeIdentityType: 2 })) }
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
  await f.open(); await f.click('Create a bot for this Mote')
  await ready(() => expect(document.querySelector('[data-mote-enrollment-action="confirm-account"]')).not.toBeNull())
  await f.click('Confirm this account'); await f.click('Create this bot')
  await ready(() => expect(document.body.textContent).toContain('Original save confirmed'))
  const parentInput = f.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as any
  const parent = (await f.client.call('space.mote.connection.inspect', { operationId: parentInput.operationId })).operation!
  await f.click('Continue bot setup')
  const origin = f.navigation.openMoteConnector.mock.calls[0]![0]
  await f.render(0, true, { section: 'chat-connections', moteConnectorOrigin: origin })
  await click('[data-management-confirm]')
  await click('[data-guided-primary]')
  await ready(() => expect(document.querySelector('[data-management-publication]')).not.toBeNull())
  expect(f.connectionCalls.mock.calls.find(([method]) => method === 'connection.setup.begin')![1]).toMatchObject({ source: { kind: 'enrollment', operationId: parent.enrollment!.operationId } })
  await click('[data-publication-review]')
  await ready(() => expect(document.querySelector('[aria-label="desktop application entry"]')).not.toBeNull())
  await fill('Publication version', '1.0.0'); await fill('Publication release notes', 'Let the original creator use this bot.')
  await fill('Publication audience', 'creator-only'); await fill('desktop application entry', 'bot'); await fill('mobile application entry', 'bot')
  await click('[data-publication-review]'); await click('[data-publication-confirm]')
  await click('[data-publication-review-created]'); await click('[data-publication-confirm]')
  await ready(() => expect(document.querySelector('[data-guided-primary]')?.textContent).toBe('Check version status'))
  const publication = requests.filter(request => request.path.includes('/app_version/') || request.path.includes('/publish/'))
  expect(publication.map(request => request.path)).toEqual(['/developers/v1/app_version/list/' + APP, '/developers/v1/app_version/list/' + APP, '/developers/v1/app_version/create/' + APP, '/developers/v1/app_version/detail/' + APP + '/' + VERSION, '/developers/v1/publish/commit/' + APP + '/' + VERSION])
  expect(publication.find(request => request.path.includes('/create/'))!.body).toMatchObject({ pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot', visibleSuggest: { members: ['mote-user-1'] } })
  expect(f.beginCount).toBe(1); expect(f.creationCount).toBe(1)
  const after = (await f.client.call('space.mote.connection.inspect', { operationId: parentInput.operationId })).operation!
  expect(after.defaultSave).toEqual(parent.defaultSave)
  expect(document.body.textContent).toContain('Submission accepted')
}, 30_000)
