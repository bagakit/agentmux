import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import * as core from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { isMoteGroupMethod } from '@agentmux/core/mote/group'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { createHostMoteGroups } from '../../host/src/mote-group'
import { createMoteChatAgents } from '../../host/src/mote-chat-agents'
import { MoteGroupStore } from '../../host/src/mote-group-store'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { MoteGroupMessage, MoteGroupParamsMap, MoteGroupSummary } from '@agentmux/core/mote/group'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste, waitForElement } from './conversation-fixture'

const connected = { state: 'connected' as const, message: '原 Mac 已连接' }
const spaceId = 'group-mote', secondId = 'other-mote', hostId = 'host-original', groupId = 'original-group'
const content = { zoneId: 'mote-zone', workspaceId: 'mote-workspace', hostId, workspacePath: '/fixture/original-mote' }
const target = { spaceId, zoneId: content.zoneId, expectedResource: { hostId, workspaceId: content.workspaceId, workspacePath: content.workspacePath } }
const second = { ...target, spaceId: secondId, zoneId: 'other-mote-zone' }
const filesWorkspace = { workspaceId: 'files-workspace', hostId, path: '/fixture/original-project', name: '原项目', kind: 'folder' as const,
  projectId: null, repoPath: null, branch: null }
const commonFileZone = { workspaceId: filesWorkspace.workspaceId, hostId, kind: 'directory' as const, branch: null }
const filesZone = { ...commonFileZone, zoneId: 'group-topic-zone', directoryPath: filesWorkspace.path + '/materials' }
const filesResource = { hostId, workspaceId: filesWorkspace.workspaceId, workspacePath: filesWorkspace.path }
const filesTarget = { spaceId: 'bound-topic', zoneId: filesZone.zoneId, expectedResource: filesResource }
const topic = { topicId: filesTarget.spaceId, hostId, zoneId: filesZone.zoneId, workspaceId: filesWorkspace.workspaceId,
  directoryPath: filesZone.directoryPath, title: '实验资料', summary: '', categorySpaceIds: [], chatIds: [], spatialRevision: 1, contentKind: 'topic' as const }
const main = { hostId, sessionId: 'session-original', displayWorkspaceId: content.workspaceId, groupId: 'main-group', tabId: 'main-tab', regionId: 'main-region' }
const catalog: AgentMuxSpaceCatalog = {
  spaces: [spaceId, secondId].map((id, index) => ({ spaceId: id, kind: 'mote', name: index === 0 ? '研究' : '设计',
    topicId: id, hostId, directoryPath: content.workspacePath, projectId: null })),
  zones: [{ ...commonFileZone, zoneId: 'parent-zone', directoryPath: filesWorkspace.path }, filesZone], tabs: [], regions: [], locations: [], bindings: [],
  motePresentation: [
    { spaceId, content, quickMode: { status: 'saved', version: 'original-version', defaults: { conversation: main } }, conversation: main },
    { spaceId: secondId, content: { ...content, zoneId: second.zoneId }, quickMode: { status: 'saved', version: 'second-version', defaults: {} }, conversation: null },
  ],
}
const mainPage = { main: { target, identity: { hostId, moteId: spaceId }, status: 'ready', resource: { ...content, zonePath: content.workspacePath, path: 'MOTE.md' },
  documentRevision: 'original-version', roleRevision: 'original-role', current: main, issue: null }, links: [], incarnation: 'original-journal', throughSequence: 0,
  next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }

beforeEach(async () => {
  window.history.replaceState(null, '')
  localStorage.clear()
  const owner = getDeviceWorkface()
  await owner.replaceBackup(emptyDeviceWorkface())
  await owner.updatePresentation({ selectedSessionId: main.sessionId, hostUrl: '', panel: 'conversation' },
    { primary: 'mote', showSession: true, showGoalWork: false, identity: { name: '原主对话', project: '研究', mote: { spaceId, name: '研究', contentReference: content } },
      profile: null, moteView: { spaceId, section: 'discussion', detail: false, directAgent: false } })
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
const queryButton = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text && !node.closest('[hidden]'))
async function enter(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit(form: Element) {
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}
const sheet = () => document.querySelector<HTMLElement>('.mobile-sheet--mote-groups')!
const close = () => click(button(sheet(), '关闭面板'))

it('opens an independent group from the Mobile Mote directory and the exact participant view from Threads', async () => {
  const f = fixture(), platform = createBrowserPlatform(), owner = getDeviceWorkface()
  const group: MoteGroupSummary = { id: groupId, name: '研究与设计群', lastMessage: null, revision: 2,
    avatarMoteIds: [spaceId, secondId], announcement: { body: '先确认资料再做比较', updatedAt: fixtureEpoch(2), operationId: 'first-announcement' },
    topic: filesTarget, members: [{ moteId: spaceId, name: '研究', target, role: 'admin', state: 'active', thread: { hostId, agentSessionId: 'peer' } },
      { moteId: secondId, name: '设计', target: second, role: 'member', state: 'active', thread: null }] }
  const messages: MoteGroupMessage[] = []
  let confirmBoundTopic = false
  let created = false, loseCreateReceipt = true, loseFirstReceipt = true
  const rpc = vi.fn(async (method: string, input: unknown, _options?: unknown, _fence?: unknown) => {
    if (method === 'space.ls' || method === 'space.inspect') return { catalog }
    if (method === 'space.mote.dialogue.read') return mainPage
    if (method === 'app.snapshot') return { agents: [], projects: [], executors: [], workspaces: [filesWorkspace], unavailable: [] }
    if (method === 'topic.ls') return { topics: [topic, { ...topic, topicId: 'mote-as-topic', contentKind: 'mote' }], unavailable: [] }
    if (method === 'space.mote.group.file.read' || method === 'space.mote.group.file.list') {
      const request = input as MoteGroupParamsMap[typeof method]
      expect(request.groupId).toBe(groupId)
      const path = request.path
      const resource = { ...filesResource, zoneId: confirmBoundTopic ? filesZone.zoneId : 'parent-zone', zonePath: filesZone.directoryPath, path }
      if (method === 'space.mote.group.file.list') return { resource, result: {
        status: 'directory-listed', entries: [{ name: '决策.md', path: 'materials/决策.md', isDirectory: false, isSymlink: false }], complete: true, partialReason: null,
      } }
      return { resource, result: { status: 'read', document: { path, revision: 'owner-revision', content: '# 原项目决策\n\n先确认实验范围。' } } }
    }
    if (method === 'space.mote.group.list') return { groups: created ? [structuredClone(group)] : [], nextBeforeSequence: null }
    if (method === 'space.mote.group.create') {
      created = true
      if (loseCreateReceipt) { loseCreateReceipt = false; throw new Error('建群原回执暂不可用') }
      return { group: structuredClone(group) }
    }
    if (method === 'space.mote.group.inspect') return { group: structuredClone(group), messages: structuredClone(messages), nextBeforeSequence: null, viewerId: 'phone-user' }
    if (method === 'space.mote.group.send') {
      const request = input as MoteGroupParamsMap['space.mote.group.send']
      const message = messages.find(item => item.id === request.operationId) ?? { id: request.operationId, sequence: messages.length + 1, groupId,
        createdAt: fixtureEpoch(2), body: request.body, author: { kind: 'human' as const, id: 'phone-user' },
        deliveries: request.recipientIds.map(moteId => ({ moteId, operationId: request.operationId + '-' + moteId, status: 'accepted' as const })) }
      if (!messages.length) { messages.push(message); group.lastMessage = message }
      if (loseFirstReceipt) { loseFirstReceipt = false; throw new Error('原请求的回执暂不可用') }
      return { message: structuredClone(message) }
    }
    return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [], goals: [], categories: [], topics: [] }
  })
  f.client.forwardRpc = rpc
  f.client.ensureAgentContinuity = vi.fn()
  const view = await mount(<MobileApp client={f.client} platform={platform} connection={connected} restoreWorkface />)
  await paste(view.element, '原主对话的草稿')
  const originalEditor = editor(view.element)
  expect(rpc.mock.calls.filter(([method]) => method.startsWith('space.mote.group.'))
    .every(([method]) => method === 'space.mote.group.list')).toBe(true)
  await click(button(view.element, '返回 Mote'))
  const directory = await waitForElement(view.element, '.mobile-space-navigation')
  await click(button(directory, '群聊'))
  await vi.waitFor(() => expect(sheet().textContent).toContain('暂无群聊'))
  await click(button(sheet(), '创建群聊'))
  const name = await waitForElement<HTMLInputElement>(sheet(), '.mote-group__field input')
  await enter(name, group.name)
  const members = await waitForElement(sheet(), '.mote-group__candidate-list')
  await act(async () => { members.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
  const search = await waitForElement<HTMLInputElement>(sheet(), 'input[aria-label="搜索 Mote"]')
  await enter(search, 'no-matching-mote')
  await vi.waitFor(() => expect(sheet().textContent).toContain('没有匹配的 Mote'))
  expect(sheet().querySelectorAll('.mote-group__selected li')).toHaveLength(1)
  await click(sheet().querySelector<HTMLButtonElement>('.mote-group__selected li button')!)
  expect(sheet().querySelector('.mote-group__selected')).toBeNull()
  await click(sheet().querySelector<HTMLButtonElement>('button[aria-label="清空成员搜索"]')!)
  const restoredCandidates = await waitForElement(sheet(), '.mote-group__candidate-list')
  for (const control of restoredCandidates.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    await act(async () => { control.click() })
  }
  expect(sheet().querySelectorAll('.mote-group__selected li')).toHaveLength(2)
  await submit(await waitForElement(sheet(), '.mote-group__create'))
  await vi.waitFor(() => expect(sheet().textContent).toContain('建群原回执暂不可用'))
  const createCalls = () => rpc.mock.calls.filter(([method]) => method === 'space.mote.group.create')
  expect(createCalls()[0]?.[1]).toMatchObject({ name: group.name, members: [target, second] })
  expect(owner.snapshot().record.conversation.drafts.some(([key]) => key.includes('mote-group-creation'))).toBe(true)
  await close()
  await click(button(directory, '群聊'))
  await click(button(sheet(), '继续创建群聊'))
  expect((await waitForElement<HTMLInputElement>(sheet(), '.mote-group__field input')).value).toBe(group.name)
  await submit(await waitForElement(sheet(), '.mote-group__create'))
  await vi.waitFor(() => expect(createCalls()).toHaveLength(2))
  expect(createCalls()[1]?.[1]).toEqual(createCalls()[0]?.[1])
  await paste(await waitForElement<HTMLElement>(sheet(), '.mote-group__send'), '这条消息只请研究参与')
  const recipients = await waitForElement(sheet(), '[aria-label="选择参与成员"]')
  await click(button(recipients, '研究'))
  await submit(await waitForElement(sheet(), '.mote-group__composer'))
  await vi.waitFor(() => expect(sheet().textContent).toContain('原请求的回执暂不可用'))
  const writes = () => rpc.mock.calls.filter(([method]) => method === 'space.mote.group.send')
  expect(writes()).toHaveLength(1)
  const originalRequest = writes()[0]?.[1]
  expect(owner.snapshot().record.conversation.drafts.some(([, draft]) => draft.includes('这条消息只请研究参与'))).toBe(true)
  expect(originalRequest).toMatchObject({ groupId, body: '这条消息只请研究参与', recipientIds: [spaceId] })

  await close()
  await click(button(directory, '群聊'))
  await vi.waitFor(() => expect(queryButton(sheet(), group.name + messages[0]?.body)).toBeDefined())
  await click(button(sheet(), '查看 研究与设计群 的群资料'))
  const detailsPanel = await waitForElement(sheet(), '[aria-label="群资料"]')
  expect(detailsPanel.textContent).toContain('管理员')
  expect(sheet().querySelector('.mote-group__identity .mote-group-avatar')?.getAttribute('data-faces')).toBe('2')
  await click(button(detailsPanel, '公告与设置'))
  const topicPicker = await waitForElement<HTMLSelectElement>(detailsPanel, 'select')
  expect([...topicPicker.options].map(option => option.value)).toEqual(['', filesTarget.spaceId])
  expect(topicPicker.value).toBe(filesTarget.spaceId)
  expect((await waitForElement<HTMLTextAreaElement>(detailsPanel, 'textarea')).value).toBe('先确认资料再做比较')
  await click(button(sheet(), '群文件'))
  await vi.waitFor(() => expect(sheet().textContent).toContain('群文件绑定已变化'))
  const reader = await waitForElement(sheet(), '.mote-group-files')
  expect(queryButton(reader, '决策.md')).toBeUndefined()
  confirmBoundTopic = true
  await click(button(reader, '重读'))
  await vi.waitFor(() => expect(queryButton(reader, '决策.md')).toBeDefined())
  await click(button(reader, '决策.md'))
  await vi.waitFor(() => expect(reader.querySelector('article h1')?.textContent).toBe('原项目决策'))
  expect(rpc.mock.calls.filter(([method]) => method === 'topic.inspect' || method.startsWith('file.'))).toHaveLength(0)
  expect(rpc.mock.calls.filter(([method]) => method.startsWith('space.mote.group.file.')).map(([method, input]) => [method, input])).toEqual([
    ['space.mote.group.file.list', { groupId, path: '.', limit: 100 }],
    ['space.mote.group.file.list', { groupId, path: '.', limit: 100 }],
    ['space.mote.group.file.read', { groupId, path: '决策.md' }],
  ])
  await click(button(reader, '返回上层来源'))
  await vi.waitFor(() => expect(queryButton(reader, '决策.md')).toBeDefined())
  await click(button(reader, '返回群聊'))
  expect(detailsPanel.closest('[hidden]')).toBeNull()
  await click(button(sheet(), '返回'))
  const restored = await waitForElement<HTMLElement>(sheet(), '[aria-label="群消息"]')
  expect(restored.textContent).toBe('这条消息只请研究参与')
  await submit(await waitForElement(sheet(), '.mote-group__composer'))
  await vi.waitFor(() => expect(writes()).toHaveLength(2))
  expect(writes()[1]?.[1]).toEqual(originalRequest)
  await vi.waitFor(() => expect(sheet().querySelector('.mote-group__message[data-own] strong')?.textContent).toBe('我'))
  await close()

  await click(button(directory, '研究'))
  const threadsTab = await waitForElement(view.element, '[role="tab"][id$="-threads-tab"]')
  await click(threadsTab)
  const threads = await waitForElement<HTMLElement>(view.element, '.mobile-mote-threads-panel:not([hidden])')
  await click(button(threads, '群聊'))
  await vi.waitFor(() => expect(queryButton(sheet(), group.name + messages[0]?.body)).toBeDefined())
  await click(queryButton(sheet(), group.name + messages[0]?.body)!)
  await vi.waitFor(() => expect(rpc.mock.calls.map(([method, input]) => [method, input])).toContainEqual(['space.mote.group.list', { moteId: spaceId, limit: 30, receiptProjection: 'stored' }]))
  await vi.waitFor(() => expect(sheet().textContent).toContain('正在查看 研究 的群内视角'))
  expect(sheet().querySelector('[aria-label="群消息"]')).toBeNull()
  const details = await waitForElement<HTMLDetailsElement>(sheet(), '.mote-group__thread')
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  await waitForElement(sheet(), '[aria-label="群内 Agent 原会话"]')
  await vi.waitFor(() => expect(f.readHistory.mock.calls.some(([id]) => id === 'peer')).toBe(true))
  await close()
  expect(editor(view.element)).toBe(originalEditor)
  expect(originalEditor.textContent).toBe('原主对话的草稿')
  expect(owner.snapshot().record.selectedSessionId).toBe(main.sessionId)
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
})

it('creates, publishes, and manages a Mobile group through the public Core and original Host store', async () => {
  const transport = await rpcOwnerFixture([], core)
  const surface = fixture()
  const prepare = vi.fn(async () => { throw new Error('Original member executor temporarily unavailable') })
  const resources = {
    read: async (mote: typeof target) => {
      if (mote.spaceId !== target.spaceId) throw new Error('Foreign Mote')
      const workspace = { id: content.workspaceId, hostId, name: 'Mobile original', path: content.workspacePath }
      return { workspace, topic: { id: spaceId, title: '研究', summary: '', kind: 'mote' as const, collaborators: [],
        directoryPath: content.workspacePath, physicalDirectoryPath: content.workspacePath, topicPath: 'topic.md',
        quickMode: { status: 'saved' as const, version: 'original-version', defaults: { executorId: 'original-executor' } } } }
    },
    prepare,
  }
  const agents = createMoteChatAgents({ resources, clients: () => [{ hostId, client: transport.client }],
    executors: { resolve: async () => ({ providerId: 'codex', launch: {} }) } })
  const store = new MoteGroupStore(join(transport.root, 'original-group.sqlite'))
  const confirm = vi.fn(async (source: typeof filesTarget) => expect(source).toEqual(filesTarget))
  const untouched = async () => { throw new Error('This operation only binds the original Topic') }
  const server = new core.AgentMuxControlServer({ socketPath: join(transport.root, 'groups.sock'), coreClients: transport.coreClients,
    moteGroups: createHostMoteGroups({ store, agents, client: () => transport.client, files: { confirm, list: untouched, read: untouched } }) })
  await server.start()
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const forward: NonNullable<AgentMuxHostedClient['forwardRpc']> = async (method, input) => {
      if (isMoteGroupMethod(method)) return rpc.call(method, input)
      if (method === 'space.ls' || method === 'space.inspect') return { catalog } as core.AgentMuxRpcResult<typeof method>
      if (method === 'space.mote.dialogue.read') return mainPage as core.AgentMuxRpcResult<typeof method>
      if (method === 'topic.ls') return { topics: [topic], unavailable: [] } as core.AgentMuxRpcResult<typeof method>
      return { agents: [], goals: [], workspaces: [filesWorkspace], unavailable: [] } as unknown as core.AgentMuxRpcResult<typeof method>
    }
    surface.client.forwardRpc = forward
    const view = await mount(<MobileApp client={surface.client} platform={createBrowserPlatform()} connection={connected} restoreWorkface />)
    await click(button(view.element, '返回 Mote'))
    const directory = await waitForElement(view.element, '.mobile-space-navigation')
    await click(button(directory, '群聊'))
    await click(button(sheet(), '创建群聊'))
    await enter(await waitForElement<HTMLInputElement>(sheet(), '.mote-group__field input'), '原 Host 项目群')
    const candidate = await waitForElement<HTMLInputElement>(sheet(), '.mote-group__candidate input')
    await act(async () => { candidate.click() })
    const setup = await waitForElement<HTMLDetailsElement>(sheet(), '.mote-group-settings__create')
    await act(async () => { setup.open = true })
    await click(button(setup, '研究'))
    await enter(await waitForElement<HTMLTextAreaElement>(setup, 'textarea'), '只在本群留原项目材料')
    const topicPicker = await waitForElement<HTMLSelectElement>(setup, 'select')
    await vi.waitFor(() => expect([...topicPicker.options].map(option => option.value)).toContain(filesTarget.spaceId))
    await act(async () => {
      topicPicker.value = filesTarget.spaceId
      topicPicker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await submit(await waitForElement(sheet(), '.mote-group__create'))
    await vi.waitFor(() => expect(sheet().textContent, sheet().textContent ?? '').toContain('按需回应'), { timeout: 1800 })
    await paste(await waitForElement<HTMLElement>(sheet(), '.mote-group__send'), '从手机发给这个群')
    await click(button(await waitForElement(sheet(), '[aria-label="选择参与成员"]'), '研究'))
    await submit(await waitForElement(sheet(), '.mote-group__composer'))
    await vi.waitFor(() => expect(sheet().querySelector('.mote-group__message[data-own] strong')?.textContent).toBe('我'))
    const listing = await rpc.call('space.mote.group.list', { moteId: spaceId })
    expect(listing.groups).toHaveLength(1)
    expect(listing.groups[0]).toMatchObject({ avatarMoteIds: [spaceId], topic: filesTarget, announcement: { body: '只在本群留原项目材料' } })
    expect(confirm).toHaveBeenCalledOnce()
    const read = await rpc.call('space.mote.group.inspect', { groupId: listing.groups[0]!.id })
    expect(read.messages).toHaveLength(1)
    expect(read.messages[0]).toMatchObject({ body: '从手机发给这个群', author: { kind: 'human', id: read.viewerId },
      deliveries: [{ moteId: spaceId, status: 'failed', issue: 'Original member executor temporarily unavailable' }] })
    expect(prepare).toHaveBeenCalledOnce()
    await click(button(sheet(), '群资料'))
    const details = await waitForElement(sheet(), '[aria-label="群资料"]')
    await click(button(details, '设为管理员'))
    await vi.waitFor(() => expect(queryButton(details, '撤下管理员')).toBeDefined())
    await click(button(details, '公告与设置'))
    await enter(await waitForElement<HTMLTextAreaElement>(details, 'textarea'), '这周先补完整原始材料')
    await click(button(details, '保存群资料'))
    await vi.waitFor(async () => {
      const observed = await rpc.call('space.mote.group.inspect', { groupId: read.group.id })
      expect(observed.group).toMatchObject({ topic: filesTarget, announcement: { body: '这周先补完整原始材料' },
        members: [{ moteId: spaceId, role: 'admin', state: 'active' }] })
      expect(observed.messages.filter(message => message.event?.kind === 'announcement-updated')).toMatchObject([
        { author: { kind: 'system' }, body: '这周先补完整原始材料', deliveries: [] },
      ])
    })
    expect(surface.submit).not.toHaveBeenCalled()
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe(main.sessionId)
  } finally {
    await rpc.dispose()
    await server.stop()
    await transport.close()
  }
})
