import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceWorkfaceStore, DEVICE_WORKFACE_KEY, emptyDeviceWorkface, getDeviceWorkface, type DeviceWorkface } from '../src/recovery/device-workface'
import { MobileRecoveryPanel } from '../src/recovery/MobileRecoveryPanel'
import { MobileApp } from '../src/MobileApp'
import { createLocalDrafts } from '../src/conversation/local-drafts'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, editor, fixture, mount, mounted } from './conversation-fixture'
import { retainObjectReference } from '../src/recovery/presentation-route'
import { parseAgentMuxControlReceipt } from '../../../packages/core/src/control-codec'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'

const key = JSON.stringify(['draft', 'session-original'])
function original(): DeviceWorkface {
  return { ...emptyDeviceWorkface(), selectedSessionId: 'session-original', hostUrl: 'https://192.168.1.20:4321',
    host: { origin: 'https://192.168.1.20:4321', hostId: 'host-original' },
    conversation: { version: 1 as const, drafts: [[key, '原草稿']] as Array<[string, string]>,
      attempts: [[key, { operationId: 'intent-original', runId: 'run-original', draft: '原草稿', phase: 'sending' as const }]],
      responses: [] } }
}
function domain(value: DeviceWorkface): Omit<DeviceWorkface, 'recordId'> { const { recordId: _, ...rest } = value; return rest }
function storage(seed?: string) {
  let raw: string | null = seed ?? null
  const getItem = vi.fn(() => raw), setItem = vi.fn((key: string, bytes: string) => { expect(key).toBe(DEVICE_WORKFACE_KEY); raw = bytes })
  return { getItem, setItem, raw: () => raw }
}
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})
describe('one durable mobile workface owner', () => {
  it.each(['space', 'survey'] as const)('preserves Core spatial ID references from actual mounted %s through backup and a new owner without replaying unknown input', async primary => {
    const ids = { spaceId: 'space:目录/' + '原'.repeat(300), zoneId: 'zone:目录/' + '区'.repeat(300),
      tabId: 'tab:原目录/' + '层/'.repeat(180), regionId: 'region:file:' + '目录/'.repeat(120) + 'original.md' }
    const catalog: AgentMuxSpaceCatalog = {
      spaces: [{ spaceId: 'first-space', kind: 'folder', name: '首个无关空间', hostId: 'host-original', directoryPath: fixturePath("other"), projectId: null },
        { spaceId: ids.spaceId, kind: 'folder', name: '长 ID 原空间', hostId: 'host-original', directoryPath: fixturePath("workspace"), projectId: null }],
      zones: [{ zoneId: 'first-zone', workspaceId: 'first-workspace', hostId: 'host-original', directoryPath: fixturePath("other"), kind: 'directory', branch: null },
        { zoneId: ids.zoneId, workspaceId: 'original-workspace', hostId: 'host-original', directoryPath: fixturePath("workspace"), kind: 'directory', branch: null }],
      tabs: [{ tabId: ids.tabId, zoneId: ids.zoneId, workspaceId: 'original-workspace', name: '长 ID 原 Tab', regionIds: ['first-region', ids.regionId] }],
      regions: [{ regionId: 'first-region', tabId: ids.tabId, kind: 'file', agentSessionId: null, runId: null, execution: null,
        file: { workspaceId: 'original-workspace', path: 'first.md', zoneRelativePath: 'first.md' } },
        { regionId: ids.regionId, tabId: ids.tabId, kind: 'file', agentSessionId: null, runId: null, execution: null,
          file: { workspaceId: 'original-workspace', path: 'original.md', zoneRelativePath: 'original.md' } }],
      bindings: [{ spaceId: ids.spaceId, zoneId: ids.zoneId }],
      locations: ['first-region', ids.regionId].map(regionId => ({ spaceId: ids.spaceId, zoneId: ids.zoneId,
        workspaceId: 'original-workspace', displayWorkspaceId: 'original-display', groupId: 'original-group', tabId: ids.tabId, regionId })),
      survey: { items: [{ zoneId: 'first-zone', name: '首个无关研究' }, { zoneId: ids.zoneId, name: '长 ID 原研究' }],
        selection: { zoneId: ids.zoneId, selection: [{ tabId: ids.tabId, regionId: 'first-region' }], active: { tabId: ids.tabId, regionId: 'first-region' } } }
    }
    const receipt = parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'long-content-catalog', ok: true, operation: 'space.ls', result: { catalog } })
    if (!receipt.ok || receipt.operation !== 'space.ls') throw new Error('Public original catalog was not accepted')
    expect(receipt.result).toEqual({ catalog })
    const frozenInput = '原未知输入\r\n完整正文 🦊\t末行', laterDraft = '后来未发送草稿\r\n原末行 🦊'
    const seeded = original()
    seeded.conversation = { ...seeded.conversation, drafts: [[key, laterDraft]], attempts: [[key, {
      operationId: 'intent-original', runId: 'run-original', draft: frozenInput, phase: 'unknown', inputRequested: true,
      originalRuntimeId: 'runtime-original', originalHostId: 'host-original', explicit: true,
      request: { condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: 'original-predecessor' },
        execution: 'default', explicit: true, runtimeId: 'runtime-original' }
    }]] }
    await getDeviceWorkface().replaceBackup(seeded)
    const f = fixture(), rpc = vi.fn().mockImplementation(async (method: string, params: any) => {
      if (method === 'space.ls') return receipt.result
      if (method === 'app.snapshot') return { sessions: [], agents: [], projects: [], executors: [], unavailable: [],
        workspaces: [{ workspaceId: 'original-workspace', hostId: 'host-original', path: fixturePath("workspace") }] }
      if (method === 'file.read') {
        expect(params).toEqual({ zoneId: ids.zoneId, path: 'original.md',
          expectedResource: { hostId: 'host-original', workspaceId: 'original-workspace', workspacePath: fixturePath("workspace") } })
        return { resource: { ...params.expectedResource, zoneId: params.zoneId, path: params.path },
          result: { status: 'read', document: { path: params.path, content: '# 准确长 ID 原文件\n\n完整原正文', revision: 'sha256:' + 'a'.repeat(64) } } }
      }
      throw new Error(`Unexpected public method ${method}`)
    })
    f.client.forwardRpc = rpc
    const app = () => <MobileApp client={f.client} connection={{ state: 'connected', message: '原 Host' }} platform={createBrowserPlatform()} />
    const view = await mount(app())
    if (primary === 'space') await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Space'))
    else {
      await click(view.element.querySelector('.mobile-settings-button')!)
      const survey = document.body.querySelector('.mobile-drawer-workfaces button')!
      expect(survey.textContent).toContain('Survey'); await click(survey)
    }
    await vi.waitFor(async () => { await act(async () => {}); expect(view.element.textContent).toContain(primary === 'space' ? '长 ID 原空间' : '长 ID 原研究') })
    const contentButton = (label: string) => {
      const found = [...view.element.querySelectorAll<HTMLButtonElement>('button')].find(value => !value.closest('[hidden]') && value.querySelector('strong')?.textContent === label)
      expect(found, label).toBeDefined(); return found!
    }
    await click(contentButton(primary === 'space' ? '长 ID 原空间' : '长 ID 原研究'))
    await click(contentButton('original.md'))
    const reference = primary === 'space' ? { spaceId: ids.spaceId, tabId: ids.tabId, regionId: ids.regionId }
      : { zoneId: ids.zoneId, tabId: ids.tabId, regionId: ids.regionId }
    const family = primary === 'space' ? 'spatial' : 'survey'
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(view.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确长 ID 原文件')
      expect(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!).presentation[family]).toEqual(reference)
    })
    const owner = new DeviceWorkfaceStore(() => localStorage), durable = owner.snapshot().record, raw = localStorage.getItem(DEVICE_WORKFACE_KEY)
    expect(owner.snapshot().issue).toBeNull(); expect(durable.conversation).toEqual(seeded.conversation)
    expect(owner.parseBackup(owner.exportBackup())).toEqual(durable)
    expect(Object.keys(durable.presentation![family]!)).toEqual([primary === 'space' ? 'spaceId' : 'zoneId', 'tabId', 'regionId'])
    expect(raw).not.toContain('准确长 ID 原文件'); expect(raw).not.toContain('完整原正文')
    const previous = mounted.splice(mounted.findIndex(item => item.element === view.element), 1)[0]!
    await act(async () => previous.root.unmount()); previous.element.remove()
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(raw)
    expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record).toEqual(durable)
    const restored = await mount(app())
    await vi.waitFor(async () => { await act(async () => {}); expect(restored.element.querySelector('.mobile-region-content h1')?.textContent).toBe('准确长 ID 原文件') })
    expect(getDeviceWorkface().snapshot().record.presentation![family]).toEqual(reference)
    expect(getDeviceWorkface().snapshot().record.conversation).toEqual(seeded.conversation)
    expect(rpc.mock.calls.filter(([method]) => method === 'file.read').map(([, params]) => params.path)).toEqual(['original.md', 'original.md'])
    expect(rpc.mock.calls.filter(([method]) => !['space.ls', 'app.snapshot', 'file.read'].includes(method))).toEqual([])
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  })
  it('keeps the Core spatial ID UTF-8 limit and exact-ID rules without weakening hierarchy or the complete record budget', () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk), before = disk.raw()
    const route = { primary: 'space' as const, showSession: false, showGoalWork: false, identity: null, profile: null }
    const boundary = '汉'.repeat(5461) + 'a'
    expect(new TextEncoder().encode(boundary).byteLength).toBe(16 * 1024)
    const accepted = { ...route, spatial: { spaceId: boundary, tabId: boundary, regionId: boundary }, survey: { zoneId: boundary, tabId: boundary, regionId: boundary } }
    expect(owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...original(), presentation: accepted } })).presentation).toEqual(accepted)
    for (const id of [boundary + 'a', '', ' \t ', 'self', 'id\0nul', 'id\rcr', 'id\nlf']) {
      for (const family of ['spatial', 'survey']) for (const field of [family === 'spatial' ? 'spaceId' : 'zoneId', 'tabId', 'regionId']) {
        const context = { [family === 'spatial' ? 'spaceId' : 'zoneId']: 'original-parent', tabId: 'original-tab', regionId: 'original-region', [field]: id }
        expect(() => owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...original(), presentation: { ...route, [family]: context } } }))).toThrow()
      }
    }
    for (const context of [{ spaceId: null, tabId: 'orphan-tab', regionId: null }, { spaceId: 'parent', tabId: null, regionId: 'orphan-region' }])
      expect(() => owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...original(), presentation: { ...route, spatial: context } } }))).toThrow()
    const oversized = { ...original(), presentation: accepted, conversation: { version: 1, drafts: Array.from({ length: 33 }, (_, i) => ['draft-' + i, 'x'.repeat(65536)]), attempts: [], responses: [] } }
    expect(() => owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: oversized }))).toThrow()
    expect(disk.raw()).toBe(before); expect(disk.setItem).not.toHaveBeenCalled()
  })
  it('restores exact Space and Survey content references beside the original draft and unknown input without storing file bodies', async () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk)
    const route = { primary: 'survey' as const, showSession: false, showGoalWork: false, identity: null, profile: null,
      survey: { zoneId: 'original-study', tabId: 'second-tab', regionId: 'original-note' },
      spatial: { spaceId: 'original-space', tabId: 'second-file-tab', regionId: 'original-file' } }
    await owner.updatePresentation(original(), route)
    const restored = new DeviceWorkfaceStore(() => disk).snapshot().record
    expect(restored).toEqual({ ...original(), presentation: route })
    expect(owner.parseBackup(owner.exportBackup())).toEqual(restored)
    const laterDraft = { ...restored.conversation, drafts: [[key, '后来未发送的草稿']] as Array<[string, string]> }
    await owner.updateConversation(laterDraft)
    expect(new DeviceWorkfaceStore(() => disk).snapshot().record).toEqual({ ...restored, conversation: laterDraft })
    expect(Object.keys(restored.presentation!.survey!)).toEqual(['zoneId', 'tabId', 'regionId'])
    expect(Object.keys(restored.presentation!.spatial!)).toEqual(['spaceId', 'tabId', 'regionId'])
  })
  it('refuses incomplete or content-bearing saved frames without replacing the original record or its input guard', () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk), before = disk.raw()
    const route = { primary: 'space' as const, showSession: false, showGoalWork: false, identity: null, profile: null }
    const malformed = [
      { ...route, spatial: { spaceId: 'original-space', tabId: null, regionId: 'unparented-region' } },
      { ...route, survey: { zoneId: null, tabId: 'unparented-tab', regionId: null } },
      { ...route, spatial: { spaceId: 'original-space', tabId: 'tab', regionId: 'region', content: 'foreign body' } },
      { ...route, survey: { zoneId: 'zone', tabId: 'tab', regionId: 'region', runId: 'invented-run' } }
    ]
    for (const value of malformed) expect(() => owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...original(), presentation: value } }))).toThrow()
    expect(disk.raw()).toBe(before); expect(owner.snapshot().record).toEqual(original()); expect(disk.setItem).not.toHaveBeenCalled()
  })
  it('exports and restores original display/source references alongside original input guards without persisting live catalog or image facts', async () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk)
    const identity = retainObjectReference({ name: '原 Mote', project: '原项目', context: { spaceId: 'mote', zoneId: 'home', workspaceId: 'scratch', displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'region' },
      mote: { spaceId: 'mote', contentReference: { zoneId: 'home', hostId: 'host-original', workspaceId: 'scratch', workspacePath: fixturePath("original/scratch") },
        appearance: { spaceId: 'mote', image: { dataUrl: 'unrelated-avatar-bytes', revision: 'image' } } } })!
    const route = { primary: 'mote' as const, showSession: true, showGoalWork: false, identity, profile: { identity, sourcePath: 'BEHAVIOR.md' } }
    await owner.updatePresentation(original(), route)
    const restored = new DeviceWorkfaceStore(() => disk).snapshot().record
    expect(restored).toEqual({ ...original(), presentation: route })
    expect(owner.parseBackup(owner.exportBackup())).toEqual(restored)
    expect(disk.raw()).not.toContain('unrelated-avatar-bytes')
    const raw = disk.raw()
    for (const malformed of [
      { ...route, profile: { identity, sourcePath: '../../other-user/secret' } },
      { ...route, identity: { ...identity, context: { ...identity.context, regionId: null } } },
      { ...route, identity: { ...identity, mote: { ...identity.mote, nativeRun: 'invented-runtime' } } }
    ]) expect(() => owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...original(), presentation: malformed } }))).toThrow()
    expect(disk.raw()).toBe(raw)
    await owner.updateConversation(original().conversation)
    expect(new DeviceWorkfaceStore(() => disk).snapshot().record.presentation).toEqual(route)
  })
  it('atomically preserves navigation, Host identity, draft and the original unknown guard across a new owner', async () => {
    const disk = storage(), owner = new DeviceWorkfaceStore(() => disk)
    await owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: 'https://192.168.1.20:4321', panel: 'terminal' })
    await owner.confirmHost({ origin: 'https://192.168.1.20:4321', hostId: 'host-original' })
    const drafts = createLocalDrafts(() => disk)
    drafts.drafts.set(key, '原草稿')
    drafts.attempts.set(key, { operationId: 'intent-original', runId: 'run-original', draft: '原草稿', phase: 'sending', message: 'pending' })
    await drafts.save()
    expect(drafts.notice).toBeNull()
    const restored = new DeviceWorkfaceStore(() => disk).snapshot()
    expect(restored.issue).toBeNull()
    expect(restored.record).toEqual({ ...original(), panel: 'terminal' })
    expect(createLocalDrafts(() => disk).attempts.get(key)).toEqual({ operationId: 'intent-original', runId: 'run-original',
      draft: '原草稿', phase: 'unknown', message: '重启后的原输入回执未知；草稿保留，不会自动重投，请刷新核对原会话。' })
    expect(disk.setItem.mock.calls.map(call => call[0])).toEqual([DEVICE_WORKFACE_KEY, DEVICE_WORKFACE_KEY, DEVICE_WORKFACE_KEY])
  })
  it('retains durable bytes on a failed write and exports the current temporary workface for preservation', async () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk), before = disk.raw()
    disk.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(owner.updateNavigation({ selectedSessionId: 'session-original', hostUrl: original().hostUrl, panel: 'terminal' })).rejects.toThrow('quota')
    expect(disk.raw()).toBe(before)
    expect(owner.snapshot().record.panel).toBe('terminal')
    const exported = owner.parseBackup(owner.exportBackup())
    expect(exported).toEqual({ ...original(), panel: 'terminal' })
  })
  it('preserves unreadable original bytes and stages temporary drafts until the explicit full-record recovery', async () => {
    const disk = storage('{original-unreadable'), owner = getDeviceWorkface(() => disk), drafts = createLocalDrafts(() => disk)
    expect(owner.snapshot().issue).toContain('原记录尚未覆盖')
    drafts.drafts.set(key, '坏记录旁继续编辑的草稿'); await drafts.save()
    expect(disk.raw()).toBe('{original-unreadable'); expect(disk.setItem).not.toHaveBeenCalled()
    await owner.replaceUnreadableWithCurrent({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
    expect(new DeviceWorkfaceStore(() => disk).snapshot().record.conversation.drafts).toEqual([[key, '坏记录旁继续编辑的草稿']])
    expect(disk.setItem).toHaveBeenCalledOnce()
  })
  it('rejects incomplete, duplicate and secret-bearing imports before any write or adoption', async () => {
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
  it('adopts a complete import only after the single durable write succeeds', async () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk), before = disk.raw()
    const imported = { ...emptyDeviceWorkface(), selectedSessionId: 'imported-session', panel: 'terminal' as const }
    disk.setItem.mockImplementationOnce(() => { throw new Error('device storage unavailable') })
    await expect(owner.replaceBackup(imported)).rejects.toThrow('device storage unavailable')
    expect(disk.raw()).toBe(before); expect(owner.snapshot().record).toEqual(original())
    await owner.replaceBackup(imported)
    expect(domain(new DeviceWorkfaceStore(() => disk).snapshot().record)).toEqual(imported)
    expect(disk.setItem).toHaveBeenCalledTimes(2)
  })
  it('rejects another Host and accepts the original Host at a changed address without erasing input', async () => {
    const disk = storage(JSON.stringify(original())), owner = new DeviceWorkfaceStore(() => disk), before = disk.raw()
    expect(() => owner.confirmHost({ origin: original().hostUrl, hostId: 'replacement-host' })).toThrow('原 Host 身份不同')
    expect(owner.snapshot().record).toEqual(original()); expect(disk.raw()).toBe(before); expect(disk.setItem).not.toHaveBeenCalled()
    await owner.confirmHost({ origin: 'https://192.168.1.21:4321', hostId: 'host-original' })
    expect(owner.snapshot().record).toEqual({ ...original(), host: { origin: 'https://192.168.1.21:4321', hostId: 'host-original' } })
  })
  it('restores the actual app offline after a preserved-file import and never resends the original unknown input', async () => {
    const owner = getDeviceWorkface(), backup = owner.parseBackup(JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: original() }))
    localStorage.clear(); await owner.replaceBackup(backup)
    const f = fixture(), view = await mount(<MobileApp client={f.client} connection={{ state: 'disconnected', message: '原 Mac 尚未核实' }} platform={createBrowserPlatform()} />)
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(editor(view.element).textContent).toBe('原草稿')
    expect(view.element.textContent).toContain('重启后的原输入回执未知')
    expect(button(view.element, 'Send').disabled).toBe(false); expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
    expect(domain(JSON.parse(localStorage.getItem(DEVICE_WORKFACE_KEY)!))).toEqual(original())
  })
  it('exports from the actual recovery action without including an authorization secret', async () => {
    await getDeviceWorkface().replaceBackup(original() as ReturnType<DeviceWorkfaceStore['snapshot']>['record'])
    const exportFile = vi.fn().mockResolvedValue(undefined), restored = vi.fn()
    const view = await mount(<MobileRecoveryPanel exportFile={exportFile} onRestored={restored} />)
    await click(button(view.element, '导出工作面文件'))
    expect(exportFile).toHaveBeenCalledOnce()
    const [name, bytes] = exportFile.mock.calls[0]!
    expect(name).toBe('agentmux-workface.json')
    expect(domain(getDeviceWorkface().parseBackup(bytes))).toEqual(original())
    expect(view.element.textContent).toContain('请确认文件已保留'); expect(restored).not.toHaveBeenCalled()
    expect(Object.keys(JSON.parse(bytes))).toEqual(['schema', 'workface'])
    expect(Object.keys(JSON.parse(bytes).workface)).toEqual(['version', 'selectedSessionId', 'hostUrl', 'panel', 'host', 'conversation', 'recordId'])
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
    expect(domain(owner.snapshot().record)).toEqual(original()); expect(restored).toHaveBeenCalledOnce()
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
  it('retains staged drafts when a failed initial read recovers to an empty durable store', async () => {
    const disk = storage(), access = () => disk
    disk.getItem.mockImplementation(() => { throw new Error('storage blocked') })
    const owner = getDeviceWorkface(access), drafts = createLocalDrafts(access)
    drafts.drafts.set(key, '读取失败旁编辑'); await drafts.save()
    disk.getItem.mockImplementation(() => null)
    expect(owner.snapshot().record.conversation.drafts).toEqual([[key, '读取失败旁编辑']])
    expect(owner.parseBackup(owner.exportBackup()).conversation.drafts).toEqual([[key, '读取失败旁编辑']])
    expect(owner.snapshot().issue).toContain('当前临时工作面仍保留')
    expect(disk.setItem).not.toHaveBeenCalled()
  })
  it('reuses the same owner while the storage accessor itself is unavailable and after it becomes readable', async () => {
    const disk = storage(); let blocked = true
    const access = () => { if (blocked) throw new Error('device storage denied'); return disk }
    const drafts = createLocalDrafts(access), owner = getDeviceWorkface(access)
    drafts.drafts.set(key, '系统存储不可读时的草稿'); await drafts.save()
    expect(getDeviceWorkface(access)).toBe(owner)
    expect(owner.parseBackup(getDeviceWorkface(access).exportBackup()).conversation.drafts).toEqual([[key, '系统存储不可读时的草稿']])
    blocked = false
    expect(getDeviceWorkface(access)).toBe(owner)
    expect(owner.snapshot().record.conversation.drafts).toEqual([[key, '系统存储不可读时的草稿']])
    expect(disk.raw()).toBeNull(); expect(disk.setItem).not.toHaveBeenCalled()
  })
  it('hydrates the same temporary draft and unknown guard when a production reader is recreated during a storage issue', async () => {
    const disk = storage(), access = () => disk
    disk.getItem.mockImplementation(() => { throw new Error('storage unavailable') })
    const first = createLocalDrafts(access)
    first.drafts.set(key, '临时原草稿')
    first.attempts.set(key, { operationId: 'original-unknown', runId: 'original-run', draft: '临时原草稿', phase: 'unknown', message: 'unknown' })
    await first.save()
    const next = createLocalDrafts(access)
    expect(next.canSave).toBe(false); expect(next.notice).toContain('未确认输入仍保留')
    expect(next.drafts.get(key)).toBe('临时原草稿')
    expect(next.attempts.get(key)).toEqual({ operationId: 'original-unknown', runId: 'original-run', draft: '临时原草稿', phase: 'unknown',
      message: '重启后的原输入回执未知；草稿保留，不会自动重投，请刷新核对原会话。' })
    next.drafts.set(key, '继续编辑的草稿'); await next.save()
    expect(getDeviceWorkface(access).snapshot().record.conversation.attempts).toEqual([[key, {
      operationId: 'original-unknown', runId: 'original-run', draft: '临时原草稿', phase: 'unknown' }]])
    expect(disk.setItem).not.toHaveBeenCalled(); expect(disk.raw()).toBeNull()
  })
})
