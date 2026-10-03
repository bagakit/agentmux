import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceWorkfaceStore, DEVICE_WORKFACE_KEY, emptyDeviceWorkface, getDeviceWorkface, type DeviceWorkface } from '../src/recovery/device-workface'
import { MobileRecoveryPanel } from '../src/recovery/MobileRecoveryPanel'
import { MobileApp } from '../src/MobileApp'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, editor, fixture, mount, mounted } from './conversation-fixture'

const key = JSON.stringify(['draft', 'session-original'])
function original(): DeviceWorkface {
  return { ...emptyDeviceWorkface(), selectedSessionId: 'session-original', hostUrl: 'https://192.168.1.20:4321',
    host: { origin: 'https://192.168.1.20:4321', hostId: 'host-original' },
    conversation: { version: 1 as const, drafts: [[key, '原草稿']] as Array<[string, string]>,
      attempts: [[key, { operationId: 'intent-original', runId: 'run-original', draft: '原草稿', phase: 'sending' as const }]],
      responses: [] } }
}
function storage(seed?: string) {
  let raw: string | null = seed ?? null
  const getItem = vi.fn(() => raw), setItem = vi.fn((key: string, bytes: string) => { expect(key).toBe(DEVICE_WORKFACE_KEY); raw = bytes })
  return { getItem, setItem, raw: () => raw }
}
beforeEach(() => { localStorage.clear(); getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})
describe('one durable mobile workface owner', () => {
  it('atomically preserves navigation, Host identity, draft and the original unknown guard across a new owner', () => {
    const disk = storage(), owner = new DeviceWorkfaceStore(() => disk)
    owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: 'https://192.168.1.20:4321', panel: 'terminal' })
    owner.confirmHost({ origin: 'https://192.168.1.20:4321', hostId: 'host-original' })
    const drafts = createLocalDrafts(() => disk)
    drafts.drafts.set(key, '原草稿')
    drafts.attempts.set(key, { operationId: 'intent-original', runId: 'run-original', draft: '原草稿', phase: 'sending', message: 'pending' })
    drafts.save()
    expect(drafts.notice).toBeNull()
    const restored = new DeviceWorkfaceStore(() => disk).snapshot()
    expect(restored.issue).toBeNull()
    expect(restored.record).toEqual({ ...original(), panel: 'terminal' })
    expect(createLocalDrafts(() => disk).attempts.get(key)).toEqual({ operationId: 'intent-original', runId: 'run-original',
      draft: '原草稿', phase: 'unknown', message: '重启后的原输入回执未知；草稿保留，不会重新投递，请刷新核对原会话。' })
    expect(disk.setItem.mock.calls.map(call => call[0])).toEqual([DEVICE_WORKFACE_KEY, DEVICE_WORKFACE_KEY, DEVICE_WORKFACE_KEY])
  })
  it('retains durable bytes on a failed write and exports the current temporary workface for preservation', () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk), before = disk.raw()
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    expect(() => owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: original().hostUrl, panel: 'terminal' })).toThrow('quota')
    expect(disk.raw()).toBe(before)
    expect(owner.snapshot().record.panel).toBe('terminal')
    const exported = owner.parseBackup(owner.exportBackup())
    expect(exported).toEqual({ ...original(), panel: 'terminal' })
  })
  it('preserves unreadable original bytes and stages temporary drafts until the explicit full-record recovery', () => {
    const disk = storage('{original-unreadable'), owner = getDeviceWorkface(() => disk), drafts = createLocalDrafts(() => disk)
    expect(owner.snapshot().issue).toContain('原记录尚未覆盖')
    drafts.drafts.set(key, '坏记录旁继续编辑的草稿'); drafts.save()
    expect(disk.raw()).toBe('{original-unreadable'); expect(disk.setItem).not.toHaveBeenCalled()
    owner.replaceUnreadableWithCurrent({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
    expect(new DeviceWorkfaceStore(() => disk).snapshot().record.conversation.drafts).toEqual([[key, '坏记录旁继续编辑的草稿']])
    expect(disk.setItem).toHaveBeenCalledOnce()
  })
  it('rejects incomplete, duplicate and secret-bearing imports before any write or adoption', () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk), before = disk.raw()
    const invalid = [
      { schema: 'agentmux.mobile-workface.v1', workface: { ...original(), host: { ...original().host, credential: 'never-import' } } },
      { schema: 'agentmux.mobile-workface.v1', workface: { ...original(), conversation: { version: 1, drafts: [[key, 'a'], [key, 'b']], attempts: [], responses: [] } } },
      { schema: 'agentmux.mobile-workface.v1', workface: { version: 1, selectedSessionId: 'session-original' } }
    ]
    expect(invalid).toHaveLength(3)
    for (const input of invalid) expect(() => owner.parseBackup(JSON.stringify(input))).toThrow()
    expect(disk.raw()).toBe(before); expect(owner.snapshot().record).toEqual(original()); expect(disk.setItem).not.toHaveBeenCalled()
  })
  it('adopts a complete import only after the single durable write succeeds', () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk), before = disk.raw()
    const imported = { ...emptyDeviceWorkface(), selectedSessionId: 'imported-session', panel: 'terminal' as const }
    disk.setItem.mockImplementationOnce(() => { throw new Error('device storage unavailable') })
    expect(() => owner.replaceBackup(imported)).toThrow('device storage unavailable')
    expect(disk.raw()).toBe(before); expect(owner.snapshot().record).toEqual(original())
    owner.replaceBackup(imported)
    expect(new DeviceWorkfaceStore(() => disk).snapshot().record).toEqual(imported)
    expect(disk.setItem).toHaveBeenCalledTimes(2)
  })
  it('rejects another Host and accepts the original Host at a changed address without erasing input', () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk), before = disk.raw()
    expect(() => owner.confirmHost({ origin: original().hostUrl, hostId: 'replacement-host' })).toThrow('原 Host 身份不同')
    expect(owner.snapshot().record).toEqual(original()); expect(disk.raw()).toBe(before); expect(disk.setItem).not.toHaveBeenCalled()
    owner.confirmHost({ origin: 'https://192.168.1.21:4321', hostId: 'host-original' })
    expect(owner.snapshot().record).toEqual({ ...original(), host: { origin: 'https://192.168.1.21:4321', hostId: 'host-original' } })
  })
  it('restores the actual app offline after a preserved-file import and never resends the original unknown input', async () => {
    const owner = getDeviceWorkface(), backup = owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: original() }))
    localStorage.clear(); owner.replaceBackup(backup)
    const f = fixture(), view = await mount(<MobileApp client={f.client} connection={{ state: 'disconnected', message: '原 Mac 尚未核实' }} platform={createBrowserPlatform()} />)
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(editor(view.element).textContent).toBe('原草稿')
    expect(view.element.textContent).toContain('重启后的原输入回执未知')
    expect(button(view.element, 'Send').disabled).toBe(true); expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!)).toEqual(original())
  })
  it('exports from the actual recovery action without including an authorization secret', async () => {
    getDeviceWorkface().replaceBackup(original() as ReturnType<DeviceWorkfaceStore['snapshot']>['record'])
    const exportFile = vi.fn().mockResolvedValue(undefined), restored = vi.fn()
    const view = await mount(<MobileRecoveryPanel exportFile={exportFile} onRestored={restored} />)
    await click(button(view.element, '导出工作面文件'))
    expect(exportFile).toHaveBeenCalledOnce()
    const [name, bytes] = exportFile.mock.calls[0]!
    expect(name).toBe('agentmux-workface.json')
    expect(getDeviceWorkface().parseBackup(bytes)).toEqual(original())
    expect(view.element.textContent).toContain('请确认文件已保留'); expect(restored).not.toHaveBeenCalled()
    expect(Object.keys(JSON.parse(bytes))).toEqual(['schema', 'workface'])
    expect(Object.keys(JSON.parse(bytes).workface)).toEqual(['version', 'selectedSessionId', 'hostUrl', 'panel', 'host', 'conversation'])
  })
  it('validates the actual file selection and adopts it only through the explicit recovery action', async () => {
    const owner = getDeviceWorkface(), before = localStorage.getItem(DEVICE_WORKFACE_KEY), restored = vi.fn()
    const view = await mount(<MobileRecoveryPanel onRestored={restored} />)
    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input).not.toBeNull()
    const file = new File([JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: original() })], 'original.json', { type: 'application/json' })
    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(view.element.textContent).toContain('尚未替换当前工作面')
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before); expect(restored).not.toHaveBeenCalled()
    await click(button(view.element, '恢复这份工作面'))
    expect(owner.snapshot().record).toEqual(original()); expect(restored).toHaveBeenCalledOnce()
  })
  it('connects the recovery controls to the actual app connection dialog', async () => {
    const overlay = document.createElement('div'); document.body.appendChild(overlay)
    const view = await mount(<MobileApp client={null} connection={{ state: 'unavailable', message: '原 Mac 未连接' }}
      platform={createBrowserPlatform({ overlayContainer: () => overlay })} />)
    await click(button(view.element, '连接你的 Mac'))
    expect(button(overlay, '导出工作面文件').disabled).toBe(false)
    expect(button(overlay, '选择工作面文件').disabled).toBe(false)
    expect(overlay.querySelector('input[type="file"]')).not.toBeNull()
    expect(overlay.textContent).toContain('恢复后仍需核对原 Mac 和设备授权')
  })
  it('exports the actual temporary app Session selection beside an unreadable original record without writing it', async () => {
    localStorage.setItem(DEVICE_WORKFACE_KEY, '{keep-original-bytes')
    localStorage.setItem('agentmux-mobile-home', 'focus')
    const f = fixture()
    f.client.forwardRpc = vi.fn().mockImplementation(async () => ({ catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [],
      agentPresentation: [{ agentSessionId: 'session-original', name: 'Original Agent', project: '', group: 'working', state: 'working', detail: '', providerId: 'codex' }] } }))
    const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原 Mac 已连接' }} platform={createBrowserPlatform()} />)
    await click(view.element.querySelector<HTMLButtonElement>('.mobile-session-list button')!)
    await view.render(<MobileApp client={null} connection={{ state: 'disconnected', message: '原 Mac 暂不可达' }} platform={createBrowserPlatform()} />)
    expect(view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
    expect(getDeviceWorkface().parseBackup(getDeviceWorkface().exportBackup()).selectedSessionId).toBe('session-original')
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe('{keep-original-bytes')
  })
  it('retains staged drafts when a failed initial read recovers to an empty durable store', () => {
    const disk = storage(), access = () => disk
    disk.getItem.mockImplementation(() => { throw new Error('storage blocked') })
    const owner = getDeviceWorkface(access), drafts = createLocalDrafts(access)
    drafts.drafts.set(key, '读取失败旁编辑'); drafts.save()
    disk.getItem.mockImplementation(() => null)
    expect(owner.snapshot().record.conversation.drafts).toEqual([[key, '读取失败旁编辑']])
    expect(owner.parseBackup(owner.exportBackup()).conversation.drafts).toEqual([[key, '读取失败旁编辑']])
    expect(owner.snapshot().issue).toContain('当前临时工作面仍保留')
    expect(disk.setItem).not.toHaveBeenCalled()
  })
  it('reuses the same owner while the storage accessor itself is unavailable and after it becomes readable', () => {
    const disk = storage(); let blocked = true
    const access = () => { if (blocked) throw new Error('device storage denied'); return disk }
    const drafts = createLocalDrafts(access), owner = getDeviceWorkface(access)
    drafts.drafts.set(key, '系统存储不可读时的草稿'); drafts.save()
    expect(getDeviceWorkface(access)).toBe(owner)
    expect(owner.parseBackup(getDeviceWorkface(access).exportBackup()).conversation.drafts).toEqual([[key, '系统存储不可读时的草稿']])
    blocked = false
    expect(getDeviceWorkface(access)).toBe(owner)
    expect(owner.snapshot().record.conversation.drafts).toEqual([[key, '系统存储不可读时的草稿']])
    expect(disk.raw()).toBeNull(); expect(disk.setItem).not.toHaveBeenCalled()
  })
  it('hydrates the same temporary draft and unknown guard when a production reader is recreated during a storage issue', () => {
    const disk = storage(), access = () => disk
    disk.getItem.mockImplementation(() => { throw new Error('storage unavailable') })
    const first = createLocalDrafts(access)
    first.drafts.set(key, '临时原草稿')
    first.attempts.set(key, { operationId: 'original-unknown', runId: 'original-run', draft: '临时原草稿', phase: 'unknown', message: 'unknown' })
    first.save()
    const next = createLocalDrafts(access)
    expect(next.canSave).toBe(false); expect(next.notice).toContain('未确认输入仍保留')
    expect(next.drafts.get(key)).toBe('临时原草稿')
    expect(next.attempts.get(key)).toEqual({ operationId: 'original-unknown', runId: 'original-run', draft: '临时原草稿', phase: 'unknown',
      message: '重启后的原输入回执未知；草稿保留，不会重新投递，请刷新核对原会话。' })
    next.drafts.set(key, '继续编辑的草稿'); next.save()
    expect(getDeviceWorkface(access).snapshot().record.conversation.attempts).toEqual([[key, {
      operationId: 'original-unknown', runId: 'original-run', draft: '临时原草稿', phase: 'unknown' }]])
    expect(disk.setItem).not.toHaveBeenCalled(); expect(disk.raw()).toBeNull()
  })
})
