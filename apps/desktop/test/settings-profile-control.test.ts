import { expect, it } from 'vitest'
import { configOwnerFixture } from './helpers/config-owner-fixture.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { applyConfigEdit } from '../src/shared/config-edit.js'
import { DEFAULT_USER_PROFILE, profileAgentContext } from '../src/shared/user-profile.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { parseSettingsCommand } from '../../../packages/core/src/settings-cli.js'

const principal = { transport: 'unix', principal: { kind: 'user', id: 'profile-test' } } as const

it('real CLI parsing and public RPC consume all profile fields through the durable Main owner', async () => {
  const f = await configOwnerFixture()
  const rpc = new AgentMuxRpcService({ execute: async request => {
    if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Wrong owner')
    return executeSettingsControl(request, f.owner)
  } })
  const initial = await rpc.call('settings.inspect', { target: 'profile' }, principal)
  expect(initial.entries).toEqual(Object.entries(DEFAULT_USER_PROFILE).map(([key, value]) => ({
    key: 'profile.' + key, kind: typeof value, value, default: value
  })))
  const before = await f.bytes()
  for (const [key, value] of Object.entries(DEFAULT_USER_PROFILE)) await rpc.call('settings.set', { key: 'profile.' + key, value: String(value) }, principal)
  expect(await f.bytes()).toBe(before)
  const about = 'Build developer tools. Be direct, show evidence, and keep my work intact.'
  for (const [key, value] of [['profile.displayName', 'Alex'], ['profile.about', about], ['profile.shareWithAgents', 'true'], ['profile.avatar', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==']]) {
    const command = await parseSettingsCommand(['set', key!, value!])
    expect(command.method).toBe('settings.set')
    const result = await rpc.call('settings.set', { key: String(command.params.key), value: String(command.params.value) }, principal)
    expect(result.entry.key).toBe(key)
    expect((await f.disk()).profile).toEqual(f.owner.current.profile)
  }
  expect(f.publish).toHaveBeenCalledTimes(4)
  expect(f.owner.current.profile?.displayName).toBe('Alex')
  expect(profileAgentContext(f.owner.current.profile)).toContain(about)
  expect(f.owner.current.hosts).toEqual((await f.disk()).hosts)
  const saved = await f.bytes()
  for (const [key, value] of [['profile.displayName', 'x'.repeat(81)], ['profile.about', 'x'.repeat(2001)], ['profile.avatar', 'https://avatar.invalid/image.svg'], ['profile.shareWithAgents', 'yes']]) {
    await expect(rpc.call('settings.set', { key: key!, value: value! }, principal)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(await f.bytes()).toBe(saved)
  }
  f.save.mockRejectedValueOnce(new Error('disk full'))
  await expect(rpc.call('settings.set', { key: 'profile.about', value: 'Not committed' }, principal)).rejects.toThrow('disk full')
  expect(await f.bytes()).toBe(saved)
  expect(f.owner.current.profile?.about).toBe(about)
})

it('optional first profile edits merge unrelated authored fields and reject same-field conflicts', async () => {
  const f = await configOwnerFixture()
  const before = f.owner.current
  const live = { ...before, profile: { ...DEFAULT_USER_PROFILE, about: 'CLI background' } }
  const expected = { ...before, profile: { ...DEFAULT_USER_PROFILE } }
  const after = { ...before, profile: { ...DEFAULT_USER_PROFILE, displayName: 'Alex' } }
  expect(applyConfigEdit(live, expected, after).profile).toEqual({ ...DEFAULT_USER_PROFILE, about: 'CLI background', displayName: 'Alex' })
  expect(() => applyConfigEdit({ ...live, profile: { ...live.profile, displayName: 'Sam' } }, expected, after)).toThrow('profile.displayName')
  expect(f.owner.current.profile).toBeUndefined()
})

it('sharing is explicit, text-only, and never creates fake context from an empty profile', () => {
  expect(profileAgentContext()).toBeUndefined()
  expect(profileAgentContext({ displayName: 'Alex', shareWithAgents: false })).toBeUndefined()
  expect(profileAgentContext({ shareWithAgents: true, displayName: '  ', about: '\n' })).toBeUndefined()
  const context = profileAgentContext({ displayName: 'Alex', about: 'One\nTwo', shareWithAgents: true, avatar: 'not-model-input' })
  expect(context).toContain('Preferred name: Alex')
  expect(context).toContain('One\nTwo')
  expect(context).not.toContain('not-model-input')
})
