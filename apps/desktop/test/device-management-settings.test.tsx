const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMuxRpcParams, AgentMuxRpcResult, TrustedDevice } from '@agentmux/core'
import { DeviceAuthority } from '../../host/src/device-authority.js'
import { DeviceManagementSettings } from '../src/renderer/src/components/settings/DeviceManagementSettings'

const hostId = 'issuer-original'
const device: TrustedDevice = { deviceId: 'device-approved-full-identity', name: 'iPhone 已授权', createdAt: 1 }
const pending: AgentMuxRpcResult<'device.ls'>['requests'][number] = {
  device: { deviceId: 'device-pending-full-identity', name: 'iPhone 待确认', createdAt: 2 },
  confirmationCode: '123456', expiresAt: Date.now() + 60_000 }
const original: AgentMuxRpcResult<'device.ls'> = { hostId, devices: [device], requests: [pending],
  privateAccess: { state: 'unconfigured', message: 'No private access manifest was selected.' } }
let root: Root, container: HTMLDivElement
const { api, copy } = vi.hoisted(() => ({
  api: { ls: vi.fn(), link: vi.fn(), invite: vi.fn(), approve: vi.fn(), reject: vi.fn(), revoke: vi.fn() }, copy: vi.fn()
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { deviceManagement: api, ui: { writeClipboardText: copy } } }))
const render = async (active = true) => { await act(async () => root.render(<DeviceManagementSettings active={active} />)) }
function button(label: string) {
  const value = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  expect(value, `Actual visible device action ${label}`).toBeDefined(); return value!
}
async function click(label: string) { await act(async () => button(label).click()) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  for (const method of Object.values(api)) method.mockReset()
  api.ls.mockResolvedValue(structuredClone(original)); copy.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Actual Desktop device management settings leaf', () => {
  it('reads only while active and presents the actual issuer, complete device identity, code and whole-Mac permission', async () => {
    await render(false); expect(api.ls).not.toHaveBeenCalled(); expect(container.textContent).toBe('')
    await render(); expect(api.ls).toHaveBeenCalledWith({})
    expect(container.textContent).toContain(hostId); expect(container.textContent).toContain(device.deviceId)
    expect(container.textContent).toContain(pending.device.deviceId); expect(container.textContent).toContain('123456')
    expect(container.textContent).toContain('操作本 Mac 的 Agent')
    expect(container.textContent).toContain(new Date(pending.expiresAt).toLocaleString())
  })

  it('retains the original device list when a reload fails and refreshes without any mutation', async () => {
    await render(); api.ls.mockRejectedValueOnce(new Error('Host read unconfirmed'))
    await click('刷新设备状态')
    expect(container.textContent).toContain(device.deviceId); expect(container.textContent).toContain(pending.device.deviceId)
    expect(container.textContent).toContain('原结果保留')
    expect(api.approve).not.toHaveBeenCalled(); expect(api.revoke).not.toHaveBeenCalled(); expect(api.invite).not.toHaveBeenCalled()
  })

  it('sends the exact original request/code once and leaves real Mac confirmation to the public method', async () => {
    await render(); const waiting = deferred<unknown>(); api.approve.mockReturnValue(waiting.promise)
    await click(`批准 ${pending.device.name}`)
    expect(api.approve).toHaveBeenCalledOnce()
    expect(api.approve).toHaveBeenCalledWith({ deviceId: pending.device.deviceId, confirmationCode: pending.confirmationCode })
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(true)
    await click(`批准 ${pending.device.name}`); expect(api.approve).toHaveBeenCalledOnce()
    api.ls.mockResolvedValue({ ...original, devices: [device, pending.device], requests: [] })
    await act(async () => waiting.resolve({ hostId, device: pending.device }))
    expect(container.textContent).toContain('Mac 已确认批准'); expect(container.textContent).not.toContain('等待本机确认')
    expect(JSON.stringify(api.approve.mock.calls)).not.toMatch(/principal|confirmed|user/)
  })

  it('reads real Authority public devices and rejects/revokes only the selected full identity without any Run stop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-device-settings-'))
    try {
      const authority = await DeviceAuthority.open(join(directory, 'devices.json'))
      async function approved(name: string): Promise<TrustedDevice> {
        const invitation = authority.invite(), request = authority.begin(authority.hostId, invitation.invitation, name)
        return await authority.approve(request.deviceId, request.confirmationCode)
      }
      const selected = await approved('iPhone 原公开设备'), other = await approved('Android 原公开设备')
      const invitation = authority.invite(), waiting = authority.begin(authority.hostId, invitation.invitation, 'iPhone 原待批准设备')
      expect(selected.revokedAt).toBeUndefined()
      expect(Object.hasOwn(selected, 'revokedAt')).toBe(false)
      const selectedReader = authority.observe(selected), otherReader = authority.observe(other)
      api.ls.mockImplementation(async (): Promise<AgentMuxRpcResult<'device.ls'>> => ({
        hostId: authority.hostId, devices: authority.devices(), requests: authority.requests(), privateAccess: original.privateAccess
      }))
      api.reject.mockImplementation(async ({ deviceId }: AgentMuxRpcParams<'device.reject'>): Promise<AgentMuxRpcResult<'device.reject'>> => {
        authority.reject(deviceId); return { hostId: authority.hostId, deviceId, state: 'denied' }
      })
      api.revoke.mockImplementation(async ({ deviceId }: AgentMuxRpcParams<'device.revoke'>): Promise<AgentMuxRpcResult<'device.revoke'>> => ({
        hostId: authority.hostId, device: await authority.revoke(deviceId)
      }))
      await render()
      expect(container.textContent).toContain('2 已授权')
      expect(container.textContent).toContain(authority.hostId)
      expect(container.textContent).toContain(selected.deviceId)
      expect(button(`撤销 ${selected.name}`).disabled).toBe(false)
      await click(`拒绝 ${authority.requests()[0]!.device.name}`)
      expect(api.reject).toHaveBeenCalledWith({ deviceId: waiting.deviceId })
      await click(`撤销 ${selected.name}`)
      expect(api.revoke).toHaveBeenCalledOnce()
      expect(api.revoke).toHaveBeenCalledWith({ deviceId: selected.deviceId })
      await act(async () => { await vi.waitFor(() => expect(api.ls).toHaveBeenCalledTimes(3)) })
      expect(authority.devices().find(value => value.deviceId === selected.deviceId)?.revokedAt).toBeTypeOf('number')
      expect(authority.devices().find(value => value.deviceId === other.deviceId)?.revokedAt).toBeUndefined()
      expect([selectedReader.signal.aborted, otherReader.signal.aborted]).toEqual([true, false])
      expect(container.textContent).toContain('1 已授权')
      expect(container.textContent).toContain('其他设备和原 Agent 会话保持')
      expect([...container.querySelectorAll('button')].some(node => node.textContent?.trim() === `撤销 ${selected.name}`)).toBe(false)
      expect(button(`撤销 ${other.name}`).disabled).toBe(false)
      selectedReader.dispose(); otherReader.dispose()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('generates and copies a connection link once and retains it only in the active UI', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    await render(); api.link.mockResolvedValue({ hostId, url: 'https://192.168.1.20:7443/#connect=short-once-invitation', expiresAt: Date.now() + 60_000 })
    await click('生成并复制连接链接')
    expect(api.link).toHaveBeenCalledWith({}); expect(copy).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLInputElement>('[aria-label="手机连接链接"]')?.value).toBe('https://192.168.1.20:7443/#connect=short-once-invitation')
    await click('复制链接'); expect(copy).toHaveBeenCalledWith('https://192.168.1.20:7443/#connect=short-once-invitation')
    expect(write).not.toHaveBeenCalled()
    await render(false); await render()
    expect(container.querySelector('[aria-label="手机连接链接"]')).toBeNull()
    api.link.mockResolvedValue({ hostId, url: 'https://192.168.1.20:7443/#connect=expired-invitation', expiresAt: 1 })
    await click('生成并复制连接链接'); await click('复制链接')
    expect(copy).toHaveBeenCalledTimes(3); expect(container.textContent).toContain('链接已过期')
  })

  it('does not retry a lost mutation reply and requires an original fact read before a new explicit operation', async () => {
    await render(); api.approve.mockRejectedValue(new Error('reply lost after request'))
    await click(`批准 ${pending.device.name}`)
    expect(container.textContent).toContain('结果尚未确认，未自动重做')
    expect(api.approve).toHaveBeenCalledOnce(); expect(api.ls).toHaveBeenCalledOnce()
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(true)
    await click(`批准 ${pending.device.name}`); expect(api.approve).toHaveBeenCalledOnce()
    await click('刷新设备状态')
    expect(api.ls).toHaveBeenCalledTimes(2); expect(api.approve).toHaveBeenCalledOnce()
    expect(container.textContent).toContain(device.deviceId)
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(false)
  })

  it('keeps an unknown reply fenced across hiding and reopening while the original request is pending', async () => {
    await render()
    let reject!: (value: unknown) => void
    api.approve.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no }))
    await click(`批准 ${pending.device.name}`)
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(true)
    await render(false)
    await render(true)
    // This read precedes the outstanding operation's unknown reply.
    expect(api.ls).toHaveBeenCalledTimes(2)
    await act(async () => reject(new Error('reply unknown after pending operation')))
    expect(api.approve).toHaveBeenCalledOnce()
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(true)
    expect(container.textContent).toContain('结果尚未确认')
    await click(`批准 ${pending.device.name}`)
    expect(api.approve).toHaveBeenCalledOnce()
    await click('刷新设备状态')
    expect(api.ls).toHaveBeenCalledTimes(3)
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(false)
    expect(api.approve).toHaveBeenCalledOnce()
  })

  it('retains a completed hidden operation and reads its facts only when the settings reopen', async () => {
    await render()
    const waiting = deferred<unknown>()
    api.approve.mockReturnValueOnce(waiting.promise)
    await click(`批准 ${pending.device.name}`)
    await render(false)
    await act(async () => waiting.resolve({ hostId, device: pending.device }))
    expect(api.ls).toHaveBeenCalledOnce()
    expect(api.approve).toHaveBeenCalledOnce()
    expect(container.textContent).toBe('')
    api.ls.mockResolvedValue({ ...original, devices: [device, pending.device], requests: [] })
    await render(true)
    expect(api.ls).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Mac 已确认批准')
    expect(container.textContent).not.toContain('等待本机确认')
    expect(button('生成并复制连接链接').disabled).toBe(false)
    expect(api.approve).toHaveBeenCalledOnce()
  })

  it('keeps an unconfirmed mutation blocked when an earlier-started device read returns late', async () => {
    await render()
    const earlierRead = deferred<AgentMuxRpcResult<'device.ls'>>()
    api.ls.mockReturnValueOnce(earlierRead.promise)
    await click('刷新设备状态')
    api.approve.mockRejectedValueOnce(new Error('reply lost after actual approval request'))
    await click(`批准 ${pending.device.name}`)
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(true)
    expect(api.ls).toHaveBeenCalledTimes(2)
    expect(api.approve).toHaveBeenCalledOnce()
    await act(async () => earlierRead.resolve(structuredClone(original)))
    expect(container.textContent).toContain('结果尚未确认，未自动重做')
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(true)
    await click('刷新设备状态')
    expect(api.ls).toHaveBeenCalledTimes(3)
    expect(api.approve).toHaveBeenCalledOnce()
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(false)
  })
})


describe('Mac private access facts', () => {
  const listening: AgentMuxRpcResult<'device.ls'>['privateAccess'] = {
    state: 'listening', message: 'The original HTTPS listener is active.', origin: 'https://192.168.2.40:1443',
    issuerHostId: hostId, certificateFingerprint: Array(32).fill('A2').join(':'), expiresAt: Date.now() + 86_400_000,
    configurationPath: (_hygiene_fixturePath("Users/original") + " Mac/agentmux-private-access.json"),
    assetIssue: 'The original mobile build directory cannot be read.'
  }

  it('private access presents actual origin, leaf expiry and separate page availability without inventing trust', async () => {
    api.ls.mockResolvedValue({ ...original, privateAccess: listening })
    await render()
    expect(container.querySelector<HTMLInputElement>('[aria-label="Mac 的 HTTPS 地址"]')?.value).toBe(listening.origin)
    expect(container.textContent).toContain(listening.certificateFingerprint)
    expect(container.textContent).toContain(new Date(listening.expiresAt).toLocaleString())
    expect(container.textContent).toContain('服务器叶证书')
    expect(container.textContent).toContain('不是签发根证书指纹')
    expect(container.textContent).toContain('手机系统信任和设备授权仍需分别确认')
    expect(container.textContent).toContain('HTTPS 已监听，手机页面尚不可用')
    expect(container.textContent).toContain(listening.assetIssue)
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(false)
    await click('复制 HTTPS 地址')
    expect(copy).toHaveBeenCalledWith(listening.origin)
    expect(api.invite).not.toHaveBeenCalled(); expect(api.approve).not.toHaveBeenCalled(); expect(api.revoke).not.toHaveBeenCalled()
  })

  it('private access preserves original devices during unavailable and unconfigured facts and shows only actual manifest source', async () => {
    const unavailable: AgentMuxRpcResult<'device.ls'>['privateAccess'] = {
      state: 'unavailable', message: 'Original manifest cannot be read; original bytes retained.',
      configurationPath: (_hygiene_fixturePath("Users/original") + " Mac/bad ' $(printf unsafe) manifest.json")
    }
    api.ls.mockResolvedValue({ ...original, privateAccess: unavailable })
    await render()
    expect(container.textContent).toContain('手机入口不可用')
    expect(container.textContent).toContain(unavailable.message)
    expect(container.textContent).toContain(unavailable.configurationPath)
    expect(container.textContent).toContain('下次明确启动')
    expect(container.textContent).toContain('证书准备入口尚未确认')
    expect(container.textContent).toContain(device.deviceId)
    expect(button(`撤销 ${device.name}`).disabled).toBe(false)
    expect(container.querySelector('[aria-label="Mac 的 HTTPS 地址"]')).toBeNull()
    expect([...container.querySelectorAll('button')].some(node => node.textContent === '复制证书准备模板')).toBe(false)
    await click('复制 manifest 启动参数')
    expect(copy).toHaveBeenCalledWith(("--private-access '" + _hygiene_fixturePath("Users/original") + " Mac/bad '\\'' $(printf unsafe) manifest.json'"))
    api.ls.mockResolvedValueOnce(structuredClone(original)); await click('刷新设备状态')
    expect(container.textContent).toContain('尚未配置手机入口')
    expect(container.textContent).toContain('启动 manifest 来源未提供')
    expect(container.textContent).not.toContain(unavailable.configurationPath)
    expect(copy).toHaveBeenCalledOnce(); expect(api.invite).not.toHaveBeenCalled(); expect(api.approve).not.toHaveBeenCalled()
  })

  it('private access copies a strictly quoted template whose real shell argv preserves paths and disables command substitution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-private-template-'))
    try {
      const executable = join(directory, "node ' $(printf unsafe) `printf unsafe` executable")
      const entry = join(directory, "prepare ' $(printf unsafe) `printf unsafe` entry.mjs")
      await symlink(process.execPath, executable)
      await writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
      for (const electronRunAsNode of [false, true]) {
        api.ls.mockResolvedValueOnce({ ...original, privateAccess: { ...listening,
          certificatePreparation: { executable, entry, electronRunAsNode } } })
        if (api.ls.mock.calls.length) await click('刷新设备状态'); else await render()
        expect(container.textContent).toContain('请先替换模板中的私网 IP 和证书目录绝对路径')
        expect(container.querySelector<HTMLTextAreaElement>('[aria-label="证书准备命令模板"]')?.readOnly).toBe(true)
        expect([...container.querySelectorAll('button')].some(node => /执行|激活|重启/.test(node.textContent ?? ''))).toBe(false)
        await click('复制证书准备模板')
        const command = copy.mock.lastCall![0] as string
        expect(command.startsWith('ELECTRON_RUN_AS_NODE=1 ')).toBe(electronRunAsNode)
        const actual = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
        expect(actual.status, actual.stderr).toBe(0)
        expect(JSON.parse(actual.stdout)).toEqual(['<私网 IP，请替换>', '<证书目录绝对路径，请替换>'])
        expect(api.invite).not.toHaveBeenCalled(); expect(api.approve).not.toHaveBeenCalled(); expect(api.revoke).not.toHaveBeenCalled()
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('private access retains last known origin after read failure, marks it unconfirmed and preserves it when copying fails', async () => {
    api.ls.mockResolvedValue({ ...original, privateAccess: listening }); await render()
    api.ls.mockRejectedValueOnce(new Error('original listener read unavailable')); await click('刷新设备状态')
    expect(container.textContent).toContain('当前接入状态未重新核实')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Mac 的 HTTPS 地址"]')?.value).toBe(listening.origin)
    copy.mockRejectedValueOnce(new Error('clipboard temporarily unavailable')); await click('复制 HTTPS 地址')
    expect(container.textContent).toContain('尚未复制，原接入事实保留')
    expect(container.textContent).toContain(device.deviceId)
    expect(container.querySelector<HTMLInputElement>('[aria-label="Mac 的 HTTPS 地址"]')?.value).toBe(listening.origin)
    api.ls.mockResolvedValueOnce({ ...original, privateAccess: listening }); await click('刷新设备状态')
    expect(container.textContent).not.toContain('当前接入状态未重新核实')
    expect(api.invite).not.toHaveBeenCalled(); expect(api.approve).not.toHaveBeenCalled(); expect(api.revoke).not.toHaveBeenCalled()
  })

  it('private access keeps mutation unknown fenced when a pre-mutation status read arrives late', async () => {
    api.ls.mockResolvedValue({ ...original, privateAccess: listening }); await render()
    const earlier = deferred<AgentMuxRpcResult<'device.ls'>>()
    api.ls.mockReturnValueOnce(earlier.promise); await click('刷新设备状态')
    api.approve.mockRejectedValueOnce(new Error('reply lost')); await click(`批准 ${pending.device.name}`)
    await act(async () => earlier.resolve({ ...original, privateAccess: { ...listening, origin: 'https://192.168.2.99:2443' } }))
    expect(container.querySelector<HTMLInputElement>('[aria-label="Mac 的 HTTPS 地址"]')?.value).toBe(listening.origin)
    expect(button(`批准 ${pending.device.name}`).disabled).toBe(true)
    expect(api.approve).toHaveBeenCalledOnce()
  })
})
