import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { AgentMuxRpcService, type ExecutionHost } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog, AgentMuxMotePresentation } from '@agentmux/core/control'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'
import { FileReadOwner } from '../../desktop/src/main/file-read-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { MobileMoteProfile } from '../src/navigation/MobileMoteProfile'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { getDeviceWorkface, emptyDeviceWorkface, DeviceWorkfaceStore, DEVICE_WORKFACE_KEY } from '../src/recovery/device-workface'
import { button, click, deferred, fixture, mount, mounted } from './conversation-fixture'

const hostId = 'original-mote-files-host', workspaceId = 'original-mote-files-workspace'
const normalBody = '# 第二 Mote 原稿\n\n原正文，不得换第一 Mote。'
const resources: Array<{ path: string; files: WorkspaceFiles }> = []
async function waitFor(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 }) }
async function edit(element: HTMLElement, body: string) {
  const input = element.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, body)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function save(element: HTMLElement) {
  await act(async () => element.querySelector('.mobile-mote-file-editor form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
function currentDraft() { return getDeviceWorkface().snapshot().record.moteFileDrafts?.find(value => value.scope.spaceId === 'second-mote' && value.scope.runtimeId === 'original-mote-file-runtime') }
beforeEach(async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  await getDeviceWorkface().confirmHost({ origin: location.origin, hostId })
  await getDeviceWorkface().updateConversation({ version: 1, drafts: [['original-conversation', '未发原对话稿']], attempts: [], responses: [] })
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  for (const resource of resources.splice(0)) { await resource.files.dispose(); await rm(resource.path, { recursive: true, force: true }) }
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); window.history.replaceState(null, '')
})
async function original() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'amx-mote-file-owner-')))
  await mkdir(join(path, 'first')); await mkdir(join(path, 'second'))
  await writeFile(join(path, 'first/SOUL.md'), '# 第一 Mote 不得改写')
  await writeFile(join(path, 'second/SOUL.md'), normalBody)
  let fault: 'receipt' | 'temporary-write' | undefined
  let remote = false
  const files = new WorkspaceFiles(() => ({ kind: remote ? 'ssh' : 'local' } as ExecutionHost), { localWriteFault: () => { const value = fault; fault = undefined; return value } })
  resources.push({ path, files })
  const workspace = { id: workspaceId, name: '原文件 Workspace', hostId, path, kind: 'folder' as const }
  const facts: AgentMuxMotePresentation[] = ['first', 'second'].map(name => ({
    spaceId: name + '-mote', content: { zoneId: name + '-zone', hostId, workspaceId, workspacePath: path },
    quickMode: { status: 'missing' }, conversation: null
  }))
  let catalog: AgentMuxSpaceCatalog = {
    spaces: ['first', 'second'].map(name => ({ spaceId: name + '-mote', kind: 'mote', name: name === 'second' ? '准确第二 Mote' : '第一 Mote',
      hostId, directoryPath: join(path, name), projectId: null })),
    zones: ['first', 'second'].map(name => ({ zoneId: name + '-zone', kind: 'home', workspaceId, hostId, directoryPath: join(path, name), branch: null })),
    tabs: [], regions: [], locations: [], bindings: ['first', 'second'].map(name => ({ spaceId: name + '-mote', zoneId: name + '-zone' })),
    motePresentation: facts
  }
  const fileOwner = new FileReadOwner({ files, catalog: async () => catalog, workspace: id => id === workspaceId ? workspace : undefined })
  const service = new AgentMuxRpcService({ files: fileOwner, coreClients: () => [] })
  const reads = vi.spyOn(files, 'read'), writes = vi.spyOn(files, 'write')
  const f = fixture(); f.sessions.clear()
  let runtime = { runtimeId: 'original-mote-file-runtime', ownerInstanceId: 'original-mote-file-process', availability: 'connected' }
  f.client.runtimeOwnerIdentity = () => runtime as ReturnType<AgentMuxHostedClient['runtimeOwnerIdentity']>
  const rpc = vi.fn(async (method: string, params: any) => {
    if (method === 'file.read' || method === 'file.write' || method === 'file.create') return service.call(method, params, { principal: { kind: 'device', id: 'private-original-device' } })
    if (method === 'space.ls') {
      const result = parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'private-mote-discovery', ok: true, operation: 'space.ls', result: { catalog } })
      if (result.operation !== 'space.ls') throw new Error('Original public Space codec must match')
      return { catalog: result.result.catalog }
    }
    if (method === 'app.snapshot') return { agents: [], unavailable: [] }
    if (method === 'goal.ls') return { goals: [], unavailable: [] }
    throw new Error('Unexpected mounted public attempt: ' + method)
  })
  f.client.forwardRpc = rpc as NonNullable<AgentMuxHostedClient['forwardRpc']>
  const identity = { name: '准确第二 Mote', project: '原项目', mote: { spaceId: facts[1]!.spaceId, facts: facts[1]! } }
  const copyText = vi.fn(async (_text: string, _error: (error: unknown) => void) => true)
  const createView = async (offline = false) => mount(<MobileMoteProfile identity={identity} client={offline ? null : f.client} copyText={copyText} />)
  const enter = async (element: HTMLElement, selected = 'SOUL.md') => {
    await click(button(element, selected === 'BEHAVIOR.md' ? '合作方式 · BEHAVIOR.md' : selected === 'topic.md' ? '原摘要 · topic.md' : selected === 'SOUL.md' ? '自我设定 · SOUL.md' : 'MOTE.md'))
    await waitFor(() => expect(element.querySelector('.mobile-mote-source')?.textContent).toContain(selected))
    await waitFor(() => expect(reads).toHaveBeenCalled())
    // The renderer receives only the actual native File body, not fixture HTML.
    await waitFor(() => expect(element.querySelector('.mobile-mote-source')?.textContent).not.toContain('正在读取原文件'))
    await click(button(element, '编辑原稿'))
    await waitFor(() => expect(element.querySelector('[aria-label="Mote 原文件正文"]')).not.toBeNull())
  }
  const mutations = () => rpc.mock.calls.map(([method]) => method).filter(method => !['space.ls', 'file.read', 'app.snapshot', 'goal.ls'].includes(method))
  return { path, files, fileOwner, rpc, reads, writes, identity, f, copyText, createView, enter, mutations,
    fault(kind: 'receipt' | 'temporary-write' = 'receipt') { fault = kind },
    remote() { remote = true },
    remap() { catalog = { ...catalog, zones: catalog.zones.map(zone => zone.zoneId === 'second-zone' ? { ...zone, directoryPath: join(path, 'remapped') } : zone) } },
    rebind() { runtime = { ...runtime, ownerInstanceId: 'different-mote-process' } } }
}

describe('actual Mote Profile editor → public Files → original native owner', () => {
  it('edits the exact second Mote from the real App without eager file reads or unrelated writes', async () => {
    const f = await original(), overlay = document.createElement('div'); document.body.append(overlay)
    localStorage.setItem('agentmux-mobile-home', 'mote')
    const platform = createBrowserPlatform({ overlayContainer: () => overlay })
    const conversationBefore = getDeviceWorkface().snapshot().record.conversation
    const view = await mount(<MobileApp client={f.f.client} connection={{ state: 'connected', message: '原私有 Host' }} platform={platform} />)
    await waitFor(() => expect(view.element.textContent).toContain('准确第二 Mote'))
    expect(f.reads).not.toHaveBeenCalled()
    await click([...view.element.querySelectorAll<HTMLButtonElement>('.mobile-session-list button')].find(value => value.textContent?.includes('准确第二 Mote'))!)
    await click(button(view.element, '查看 Mote 资料'))
    await f.enter(overlay)
    await waitFor(() => expect(getDeviceWorkface().snapshot().record.presentation?.profile?.sourcePath).toBe('SOUL.md'))
    const before = getDeviceWorkface().snapshot().record
    expect(overlay.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')?.value).toBe(normalBody)
    const body = '# 明确第二 Mote 新原稿\n完整中文末行'
    await edit(overlay, body); await save(overlay)
    await waitFor(() => expect(currentDraft()?.baseline).toMatchObject({ status: 'read', content: body }))
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe(body)
    expect(await readFile(join(f.path, 'first/SOUL.md'), 'utf8')).toBe('# 第一 Mote 不得改写')
    expect(f.writes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hostId, id: workspaceId, path: f.path }), {
      path: 'second/SOUL.md', content: body, expectedRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    })
    expect(f.mutations()).toEqual(['file.write'])
    const { moteFileDrafts: _drafts, ...other } = getDeviceWorkface().snapshot().record
    expect(other).toEqual(before)
    expect(other.conversation).toEqual(conversationBefore)
    expect(f.f.submit).not.toHaveBeenCalled()
  }, 15000)
  it('creates only an explicitly confirmed deleted original file using full mapped resource and null CAS', async () => {
    const f = await original(), view = await f.createView()
    await f.enter(view.element, 'BEHAVIOR.md')
    await edit(view.element, '# 原行为文件\n用户自己写的原文，不经过另一 YAML 表单')
    await save(view.element)
    await waitFor(() => expect(f.mutations()).toEqual(['file.create']))
    await waitFor(() => expect(currentDraft()?.baseline?.status).toBe('read'))
    expect(await readFile(join(f.path, 'second/BEHAVIOR.md'), 'utf8')).toBe('# 原行为文件\n用户自己写的原文，不经过另一 YAML 表单')
    const input = f.rpc.mock.calls.find(([method]) => method === 'file.create')![1]
    expect(input).toMatchObject({ spaceId: 'second-mote', zoneId: 'second-zone', path: 'BEHAVIOR.md', expectedRevision: null,
      expectedResource: { hostId, workspaceId, workspacePath: f.path, zonePath: join(f.path, 'second'), path: 'second/BEHAVIOR.md' } })
    expect(f.writes).toHaveBeenCalledTimes(1)
    expect(f.f.submit).not.toHaveBeenCalled()
  })
  it('saves an untouched raw BOM/CRLF source through the actual owner without normalizing it or adding YAML semantics', async () => {
    const f = await original(), body = '\uFEFF---\r\n原未知键: 保留\r\n---\r\n原中文正文\r\n完整末行\r\n'
    await writeFile(join(f.path, 'second/SOUL.md'), body)
    const view = await f.createView(); await f.enter(view.element); await save(view.element)
    await waitFor(() => expect(currentDraft()?.baseline).toMatchObject({ status: 'read', content: body }))
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe(body)
    expect(f.rpc.mock.calls.find(([method]) => method === 'file.write')![1].content).toBe(body)
    expect(f.mutations()).toEqual(['file.write'])
  })
  it('keeps native receipt-unknown, the frozen full request and later draft through checks, backup/new owner and remount', async () => {
    const f = await original(), view = await f.createView(); await f.enter(view.element)
    const before = getDeviceWorkface().snapshot().record, sent = '已写但回执未知\n完整原发送正文', later = '未发送后来稿\n中文最后一行'
    await edit(view.element, sent); f.fault(); await save(view.element)
    await waitFor(() => expect(currentDraft()?.attempts[0]?.phase).toBe('unknown'))
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe(sent)
    await edit(view.element, later); await waitFor(() => expect(currentDraft()?.body).toBe(later))
    const frozen = structuredClone(currentDraft()!)
    expect(frozen.attempts[0]!.input).toMatchObject({ content: sent, expectedRevision: frozen.baseline?.status === 'read' ? frozen.baseline.revision : undefined,
      expectedResource: frozen.scope.resource, zoneId: 'second-zone', spaceId: 'second-mote', path: 'SOUL.md' })
    await click(button(view.element, '核对原文件'))
    await waitFor(() => expect(view.element.textContent).toContain('已核对当前原文件'))
    expect(currentDraft()).toEqual(frozen)
    const reopened = new DeviceWorkfaceStore(() => localStorage)
    expect(reopened.parseBackup(getDeviceWorkface().exportBackup()).moteFileDrafts).toEqual([frozen])
    await click(button(view.element, '返回原文件')); await click(button(view.element, '返回资料'))
    await f.enter(view.element)
    expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')?.value).toBe(later)
    expect(currentDraft()).toEqual(frozen)
    await click(button(view.element, '核对原文件'))
    await waitFor(() => expect(view.element.textContent).toContain('采用当前修订'))
    await click(button(view.element, '采用当前修订'))
    await waitFor(() => expect(currentDraft()?.blockedAttemptId).toBeNull())
    expect(currentDraft()?.body).toBe(later)
    expect(currentDraft()?.attempts).toEqual(frozen.attempts)
    expect(f.writes).toHaveBeenCalledTimes(1)
    await save(view.element)
    await waitFor(() => expect(f.writes).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(currentDraft()?.baseline).toMatchObject({ status: 'read', content: later }))
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe(later)
    expect(f.mutations()).toEqual(['file.write', 'file.write'])
    const after = getDeviceWorkface().snapshot().record
    const { moteFileDrafts: _drafts, ...other } = after
    expect(other).toEqual(before)
    expect(f.f.submit).not.toHaveBeenCalled()
  })
  it.each(['committed', 'failed'] as const)('does not authorize another File Save while explicit adoption awaits its original %s device commit ACK', async adoptionResult => {
    const f = await original()
    const read = await f.fileOwner.read({ zoneId: 'second-zone', spaceId: 'second-mote', path: 'SOUL.md', expectedResource: { hostId, workspaceId, workspacePath: f.path } })
    expect(read.result.status).toBe('read'); expect(read.resource).not.toBeNull()
    await getDeviceWorkface().editMoteFileDraft(null, { scope: { origin: location.origin, runtimeId: 'other-retained-runtime', deviceHostId: hostId,
      spaceId: 'second-mote', path: 'SOUL.md', resource: read.resource! }, body: '另一原 Host 保留的完整稿',
      baseline: read.result.status === 'read' ? { status: 'read', content: read.result.document.content, revision: read.result.document.revision } : null,
      attempts: [], blockedAttemptId: null }, getDeviceWorkface().recordIdentity())
    const view = await f.createView(); await f.enter(view.element)
    await edit(view.element, '未知原保存正文'); f.fault(); await save(view.element)
    await waitFor(() => expect(currentDraft()?.attempts[0]?.phase).toBe('unknown'))
    await edit(view.element, '采用期间未发的完整后来稿')
    await waitFor(() => expect(currentDraft()?.body).toBe('采用期间未发的完整后来稿'))
    const originalDraft = structuredClone(currentDraft()!)
    await click(button(view.element, '核对原文件'))
    await waitFor(() => expect(view.element.textContent).toContain('采用当前修订'))
    const owner = getDeviceWorkface(), gate = deferred<void>(), editDraft = owner.editMoteFileDraft.bind(owner)
    let waiting = false
    vi.spyOn(owner, 'editMoteFileDraft').mockImplementation(async (...args) => {
      if (!waiting && args[1].blockedAttemptId === null && args[1].attempts.length === 1) {
        waiting = true; await gate.promise
        if (adoptionResult === 'failed') vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('original adoption storage failure') })
      }
      return editDraft(...args)
    })
    try {
      await click(button(view.element, '采用当前修订'))
      await waitFor(() => expect(waiting).toBe(true))
      expect(currentDraft()).toEqual(originalDraft)
      await save(view.element)
      expect(view.element.textContent).not.toContain('正在保存原文件')
      await click(button(view.element, '采用这份设备稿'))
      expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')?.value).toBe('采用期间未发的完整后来稿')
      expect(f.mutations()).toEqual(['file.write'])
    } finally { gate.resolve() }
    await waitFor(() => expect(view.element.textContent).not.toContain('正在采用当前修订'))
    expect(currentDraft()?.blockedAttemptId).toBe(adoptionResult === 'committed' ? null : originalDraft.blockedAttemptId)
    expect(currentDraft()?.baseline).toEqual(adoptionResult === 'committed' ? { status: 'read', content: '未知原保存正文', revision: 'sha256:' + createHash('sha256').update('未知原保存正文').digest('hex') } : originalDraft.baseline)
    expect(currentDraft()?.attempts).toEqual(originalDraft.attempts)
    expect(currentDraft()?.body).toBe('采用期间未发的完整后来稿')
    expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')?.value).toBe('采用期间未发的完整后来稿')
    expect(f.mutations()).toEqual(['file.write'])
    expect(f.f.submit).not.toHaveBeenCalled()
  })
  it('awaits the actual device transaction ACK before forwarding and refuses replacement during that wait', async () => {
    const f = await original(), view = await f.createView(); await f.enter(view.element); await edit(view.element, '明确保存稿')
    await waitFor(() => expect(currentDraft()?.body).toBe('明确保存稿'))
    const owner = getDeviceWorkface(), gate = deferred<void>(), editDraft = owner.editMoteFileDraft.bind(owner)
    vi.spyOn(owner, 'editMoteFileDraft').mockImplementation(async (...args) => {
      const ack = await editDraft(...args)
      if (args[1].attempts.some(attempt => attempt.phase === 'sending')) await gate.promise
      return ack
    })
    await save(view.element)
    await waitFor(() => expect(currentDraft()?.attempts[0]?.phase).toBe('sending'))
    expect(f.writes).not.toHaveBeenCalled()
    expect(f.mutations()).toEqual([])
    await owner.replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1, drafts: [['new-original', '新的完整原稿']], attempts: [], responses: [] } })
    const replacement = owner.snapshot().record
    gate.resolve(); await waitFor(() => expect(view.element.textContent).not.toContain('正在保存原文件'))
    expect(owner.snapshot().record).toEqual(replacement)
    expect(f.writes).not.toHaveBeenCalled()
    await click(button(view.element, '复制原稿'))
    expect(f.copyText).toHaveBeenCalledWith('明确保存稿', expect.any(Function))
  })
  it('never applies an actual late written receipt to a new record after unmount', async () => {
    const f = await original(), view = await f.createView(); await f.enter(view.element); await edit(view.element, '卸载前冻结原正文')
    const gate = deferred<void>(), originalWrite = f.fileOwner.write.bind(f.fileOwner)
    let answered = false
    vi.spyOn(f.fileOwner, 'write').mockImplementation(async input => { const result = await originalWrite(input); answered = true; await gate.promise; return result })
    await save(view.element); await waitFor(() => expect(answered).toBe(true))
    expect(currentDraft()?.attempts[0]?.input.content).toBe('卸载前冻结原正文')
    await act(async () => view.render(<span>原编辑页已卸载</span>))
    const owner = getDeviceWorkface()
    await owner.replaceBackup({ ...emptyDeviceWorkface(), conversation: { version: 1, drafts: [['new-record', '新记录全文']], attempts: [], responses: [] } })
    const replacement = owner.snapshot().record
    gate.resolve(); await act(async () => {})
    expect(owner.snapshot().record).toEqual(replacement)
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe('卸载前冻结原正文')
    expect(f.mutations()).toEqual(['file.write'])
  })
  it.each(['written', 'error'] as const)('keeps the original draft when its actual %s receipt arrives after navigation unmount in the same record', async outcome => {
    const f = await original(), view = await f.createView(); await f.enter(view.element)
    await edit(view.element, '导航前冻结原保存'); if (outcome === 'error') f.fault('temporary-write')
    const gate = deferred<void>(), originalWrite = f.fileOwner.write.bind(f.fileOwner)
    let answered = false
    vi.spyOn(f.fileOwner, 'write').mockImplementation(async input => {
      const result = await originalWrite(input)
      expect(result.result.status).toBe(outcome)
      answered = true
      await gate.promise; return result
    })
    await save(view.element); await waitFor(() => expect(answered).toBe(true))
    await edit(view.element, '未发的导航后来稿')
    await waitFor(() => expect(currentDraft()?.body).toBe('未发的导航后来稿'))
    await click(button(view.element, '返回原文件')); await click(button(view.element, '返回资料'))
    await f.enter(view.element, 'BEHAVIOR.md')
    await edit(view.element, '另一原文件的未发完整稿')
    await waitFor(() => expect(getDeviceWorkface().snapshot().record.moteFileDrafts?.find(value => value.scope.path === 'BEHAVIOR.md')?.body).toBe('另一原文件的未发完整稿'))
    const before = structuredClone(getDeviceWorkface().snapshot().record)
    expect(before.moteFileDrafts!.find(value => value.scope.path === 'SOUL.md')!.attempts[0]!.input.content).toBe('导航前冻结原保存')
    gate.resolve()
    await f.rpc.mock.results.find((_, index) => f.rpc.mock.calls[index]![0] === 'file.write')!.value
    await act(async () => {})
    expect(getDeviceWorkface().snapshot().record).toEqual(before)
    expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')?.value).toBe('另一原文件的未发完整稿')
    await click(button(view.element, '返回原文件')); await click(button(view.element, '返回资料'))
    await f.enter(view.element)
    expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')?.value).toBe('未发的导航后来稿')
    expect(view.element.textContent).toContain('保存回执未确认')
    expect(currentDraft()?.attempts[0]!.input).toEqual(before.moteFileDrafts![0]!.attempts[0]!.input)
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe(outcome === 'written' ? '导航前冻结原保存' : normalBody)
    expect(f.mutations()).toEqual(['file.write'])
    expect(f.f.submit).not.toHaveBeenCalled()
  })
  it('does not apply an old written receipt after the controlled SDK owner instance changes', async () => {
    const f = await original(), view = await f.createView(); await f.enter(view.element); await edit(view.element, '原实例明确保存的全文')
    const gate = deferred<void>(), originalWrite = f.fileOwner.write.bind(f.fileOwner)
    let answered = false
    vi.spyOn(f.fileOwner, 'write').mockImplementation(async input => { const result = await originalWrite(input); answered = true; await gate.promise; return result })
    await save(view.element); await waitFor(() => expect(answered).toBe(true))
    const originalDraft = structuredClone(currentDraft()!)
    f.rebind(); gate.resolve()
    await waitFor(() => expect(view.element.textContent).not.toContain('正在保存原文件'))
    expect(currentDraft()).toEqual(originalDraft)
    expect(currentDraft()?.attempts[0]?.ownerInstanceId).toBe('original-mote-file-process')
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe('原实例明确保存的全文')
    expect(f.mutations()).toEqual(['file.write'])
  })
  it('rejects an actual changed mapping without replacing either original file or current draft', async () => {
    const f = await original(), view = await f.createView(); await f.enter(view.element)
    await edit(view.element, '原文件待保存稿')
    await mkdir(join(f.path, 'remapped')); await writeFile(join(f.path, 'remapped/SOUL.md'), '新映射不得被旧请求写入')
    f.remap(); await save(view.element)
    await waitFor(() => expect(currentDraft()?.attempts[0]?.phase).toBe('unknown'))
    expect(f.writes).not.toHaveBeenCalled()
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe(normalBody)
    expect(await readFile(join(f.path, 'remapped/SOUL.md'), 'utf8')).toBe('新映射不得被旧请求写入')
    await click(button(view.element, '核对原文件'))
    await waitFor(() => expect(view.element.textContent).toContain('原文件映射已改变'))
    expect(view.element.querySelector('[aria-label="Mote 原文件正文"]')).not.toBeNull()
    expect(currentDraft()?.body).toBe('原文件待保存稿')
    expect(f.mutations()).toEqual(['file.write'])
    expect(f.f.submit).not.toHaveBeenCalled()
  })
  it('keeps a real revision conflict and both complete bodies without a blind retry', async () => {
    const f = await original(), view = await f.createView(); await f.enter(view.element)
    await edit(view.element, '本页完整后来稿')
    await writeFile(join(f.path, 'second/SOUL.md'), '外部原 writer 的新全文')
    await save(view.element)
    await waitFor(() => expect(currentDraft()?.attempts[0]?.phase).toBe('failed'))
    expect(currentDraft()?.body).toBe('本页完整后来稿')
    expect(currentDraft()?.blockedAttemptId).toBe(currentDraft()?.attempts[0]?.attemptId)
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe('外部原 writer 的新全文')
    expect(f.writes).toHaveBeenCalledTimes(1)
    await click(button(view.element, '核对原文件'))
    await waitFor(() => expect(view.element.textContent).toContain('外部原 writer 的新全文'))
    expect(f.writes).toHaveBeenCalledTimes(1)
    expect(f.mutations()).toEqual(['file.write'])
  })
  it('preserves input typed before the original read finishes and requires explicit adoption of the actual revision', async () => {
    const f = await original(), gate = deferred<void>(), originalRead = f.fileOwner.read.bind(f.fileOwner)
    vi.spyOn(f.fileOwner, 'read').mockImplementationOnce(async (...args) => { const result = await originalRead(...args); await gate.promise; return result })
    const view = await f.createView()
    await click(button(view.element, '自我设定 · SOUL.md'))
    await waitFor(() => expect(f.reads).toHaveBeenCalledTimes(1))
    await click(button(view.element, '编辑原稿')); await edit(view.element, '读取期间输入的完整后来稿')
    await save(view.element); expect(f.writes).not.toHaveBeenCalled()
    gate.resolve()
    await waitFor(() => expect(view.element.textContent).toContain('采用当前修订'))
    expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')?.value).toBe('读取期间输入的完整后来稿')
    await click(button(view.element, '采用当前修订'))
    await waitFor(() => expect(currentDraft()?.baseline?.status).toBe('read'))
    await save(view.element)
    await waitFor(() => expect(currentDraft()?.baseline).toMatchObject({ content: '读取期间输入的完整后来稿' }))
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe('读取期间输入的完整后来稿')
    expect(f.mutations()).toEqual(['file.write'])
  })
  it('allows explicit original File Save during a known device write gap without fabricating a backup ACK', async () => {
    const f = await original(), view = await f.createView(); await f.enter(view.element)
    const raw = localStorage.getItem(DEVICE_WORKFACE_KEY)
    expect(raw).not.toBeNull()
    const owner = getDeviceWorkface(), memorySnapshot = owner.snapshot.bind(owner)
    const originalBytes = new DeviceWorkfaceStore(() => localStorage)
    // The observation exposes the actual saved record, not a pending draft.
    // The original transaction still owns its real storage failure classification.
    vi.spyOn(owner, 'snapshot').mockImplementation(() => ({ record: originalBytes.snapshot().record, issue: memorySnapshot().issue }))
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('device quota write unavailable') })
    await edit(view.element, '设备不可写期间的完整原稿'); await save(view.element)
    await waitFor(() => expect(f.writes).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(view.element.textContent).toContain('未进入设备备份'))
    await vi.waitFor(async () => expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe('设备不可写期间的完整原稿'))
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(raw)
    expect(owner.snapshot().record.moteFileDrafts).toBeUndefined()
    const frozen = JSON.parse(view.element.querySelector('.mobile-mote-file-editor article pre')!.textContent!)
    expect(frozen.content).toBe('设备不可写期间的完整原稿')
    expect(frozen.expectedResource).toMatchObject({ hostId, workspaceId, workspacePath: f.path, path: 'second/SOUL.md' })
    expect(getDeviceWorkface().snapshot().issue).not.toBeNull()
    await click(button(view.element, '复制原稿'))
    expect(f.copyText).toHaveBeenCalledWith('设备不可写期间的完整原稿', expect.any(Function))
    expect(f.mutations()).toEqual(['file.write'])
    expect(f.f.submit).not.toHaveBeenCalled()
    write.mockRestore()
  }, 15000)
  it('keeps an explicit File Save usable when other valid device drafts leave too little backup capacity', async () => {
    const f = await original(), owner = getDeviceWorkface()
    await owner.updateConversation({ ...owner.snapshot().record.conversation,
      drafts: Array.from({ length: 30 }, (_, index) => ['other-original-' + index, 'x'.repeat(65536)]) })
    const view = await f.createView(); await f.enter(view.element)
    const body = '合法原文件完整正文\n' + 'z'.repeat(72 * 1024)
    await edit(view.element, body)
    await waitFor(() => expect(currentDraft()?.body).toBe(body))
    const raw = localStorage.getItem(DEVICE_WORKFACE_KEY), before = structuredClone(owner.snapshot().record)
    expect(new TextEncoder().encode(raw!).byteLength).toBeLessThan(2 * 1024 * 1024)
    await save(view.element)
    await vi.waitFor(async () => expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe(body), { timeout: 10000 })
    await waitFor(() => expect(view.element.textContent).toContain('未进入设备备份'))
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(raw)
    expect(owner.snapshot().record).toEqual(before)
    expect(owner.snapshot().issue).toBeNull()
    const pending = JSON.parse(view.element.querySelector('.mobile-mote-file-editor article pre')!.textContent!)
    expect(pending).toMatchObject({ content: body, expectedRevision: before.moteFileDrafts![0]!.baseline!.status === 'read' ? before.moteFileDrafts![0]!.baseline!.revision : null,
      expectedResource: before.moteFileDrafts![0]!.scope.resource, spaceId: 'second-mote', zoneId: 'second-zone', path: 'SOUL.md' })
    const later = body + '\n未发的中文后来稿'
    await edit(view.element, later); await click(button(view.element, '复制原稿'))
    expect(f.copyText).toHaveBeenCalledWith(later, expect.any(Function))
    expect(JSON.parse(view.element.querySelector('.mobile-mote-file-editor article pre')!.textContent!).content).toBe(body)
    expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')?.value).toBe(later)
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(raw)
    expect(f.mutations()).toEqual(['file.write'])
    expect(f.f.submit).not.toHaveBeenCalled()
  }, 15000)
  it('keeps the later complete body and unknown input before explicitly adopting a different committed device draft', async () => {
    const f = await original(), view = await f.createView(); await f.enter(view.element)
    await edit(view.element, '原未知保存正文'); f.fault(); await save(view.element)
    await waitFor(() => expect(currentDraft()?.attempts[0]?.phase).toBe('unknown'))
    const originalDraft = structuredClone(currentDraft()!), other = new DeviceWorkfaceStore(() => localStorage)
    await other.editMoteFileDraft(originalDraft, { ...originalDraft, body: '另一页面的完整原稿' }, other.recordIdentity())
    await edit(view.element, '本页未应用的完整后来稿')
    await waitFor(() => expect(view.element.textContent).toContain('采用设备原稿'))
    const conflict = getDeviceWorkface().snapshot().record.moteFileDraftConflicts![0]!
    expect(conflict.body).toBe('本页未应用的完整后来稿')
    expect(conflict.attempts).toEqual(originalDraft.attempts)
    await edit(view.element, '冲突之后更晚的完整中文稿')
    await waitFor(() => expect(getDeviceWorkface().snapshot().record.moteFileDraftConflicts?.find(value => value.body === '冲突之后更晚的完整中文稿')?.attempts).toEqual(originalDraft.attempts))
    await click(button(view.element, '采用设备原稿'))
    await waitFor(() => expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="Mote 原文件正文"]')?.value).toBe('另一页面的完整原稿'))
    expect(view.element.textContent).toContain('采用前保留的本页原稿')
    const beforeCopy = [...view.element.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === '复制采用前原稿')!
    await click(beforeCopy)
    expect(f.copyText).toHaveBeenCalledWith('冲突之后更晚的完整中文稿', expect.any(Function))
    const localCopy = JSON.parse([...view.element.querySelectorAll('details')].find(value => value.querySelector('summary')?.textContent?.startsWith('采用前保留'))!.querySelectorAll('pre')[1]!.textContent!)
    expect(localCopy.body).toBe('冲突之后更晚的完整中文稿')
    expect(localCopy.attempts).toEqual(originalDraft.attempts)
    expect(currentDraft()?.attempts).toEqual(originalDraft.attempts)
    expect(f.mutations()).toEqual(['file.write'])
    expect(f.f.submit).not.toHaveBeenCalled()
  })
  it('keeps editing and copying after the original owner reports remote atomic save unsupported', async () => {
    const f = await original(), view = await f.createView(); await f.enter(view.element)
    await edit(view.element, '原 remote 错误也不丢稿'); f.remote(); await save(view.element)
    await waitFor(() => expect(currentDraft()?.attempts[0]?.issue).toContain('REMOTE_WORKSPACE_FILE_WRITE_UNSUPPORTED'))
    await edit(view.element, 'remote 失败后的完整后来稿')
    await click(button(view.element, '复制原稿'))
    expect(f.copyText).toHaveBeenCalledWith('remote 失败后的完整后来稿', expect.any(Function))
    expect(await readFile(join(f.path, 'second/SOUL.md'), 'utf8')).toBe(normalBody)
    expect(f.mutations()).toEqual(['file.write'])
    expect(f.f.submit).not.toHaveBeenCalled()
  })
})
