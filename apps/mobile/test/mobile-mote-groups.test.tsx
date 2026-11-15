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
const main = { hostId, sessionId: 'session-original', displayWorkspaceId: content.workspaceId, groupId: 'main-group', tabId: 'main-tab', regionId: 'main-region' }
const catalog: AgentMuxSpaceCatalog = {
  spaces: [spaceId, secondId].map((id, index) => ({ spaceId: id, kind: 'mote', name: index === 0 ? '研究' : '设计',
    topicId: id, hostId, directoryPath: content.workspacePath, projectId: null })),
  zones: [], tabs: [], regions: [], locations: [], bindings: [],
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
  const group: MoteGroupSummary = { id: groupId, name: '研究与设计群', lastMessage: null,
    members: [{ moteId: spaceId, name: '研究', target, thread: { hostId, agentSessionId: 'peer' } },
      { moteId: secondId, name: '设计', target: second, thread: null }] }
  const messages: MoteGroupMessage[] = []
  let created = false, loseCreateReceipt = true, loseFirstReceipt = true
  const rpc = vi.fn(async (method: string, input: unknown) => {
    if (method === 'space.ls' || method === 'space.inspect') return { catalog }
    if (method === 'space.mote.dialogue.read') return mainPage
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
  expect(rpc.mock.calls.some(([method]) => method.startsWith('space.mote.group.'))).toBe(false)
  await click(button(view.element, '返回 Mote'))
  const directory = await waitForElement(view.element, '.mobile-space-navigation')
  await click(button(directory, '群聊'))
  await vi.waitFor(() => expect(sheet().textContent).toContain('暂无群聊'))
  await click(button(sheet(), '创建群聊'))
  const name = await waitForElement<HTMLInputElement>(sheet(), '.mote-group__field input')
  await enter(name, group.name)
  const members = await waitForElement(sheet(), '.mote-group__candidate-list')
  for (const control of members.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    await act(async () => { control.click() })
  }
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
  const text = await waitForElement<HTMLTextAreaElement>(sheet(), '[aria-label="群消息"]')
  await enter(text, '这条消息只请研究参与')
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
  await waitForElement(sheet(), '[aria-label="群成员"]')
  const restored = await waitForElement<HTMLTextAreaElement>(sheet(), '[aria-label="群消息"]')
  expect(restored.value).toBe('这条消息只请研究参与')
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
  await vi.waitFor(() => expect(rpc.mock.calls.map(([method, input]) => [method, input])).toContainEqual(['space.mote.group.list', { moteId: spaceId, limit: 30 }]))
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

it('publishes a Mobile composer message through the real public Core and original Host group store', async () => {
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
  const server = new core.AgentMuxControlServer({ socketPath: join(transport.root, 'groups.sock'), coreClients: transport.coreClients,
    moteGroups: createHostMoteGroups({ store, agents, client: () => transport.client }) })
  await server.start()
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const forward: NonNullable<AgentMuxHostedClient['forwardRpc']> = async (method, input) => {
      if (isMoteGroupMethod(method)) return rpc.call(method, input)
      if (method === 'space.ls' || method === 'space.inspect') return { catalog } as core.AgentMuxRpcResult<typeof method>
      if (method === 'space.mote.dialogue.read') return mainPage as core.AgentMuxRpcResult<typeof method>
      return { agents: [], goals: [], unavailable: [] } as unknown as core.AgentMuxRpcResult<typeof method>
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
    await submit(await waitForElement(sheet(), '.mote-group__create'))
    const text = await waitForElement<HTMLTextAreaElement>(sheet(), '[aria-label="群消息"]')
    await enter(text, '从手机发给这个群')
    await click(button(await waitForElement(sheet(), '[aria-label="选择参与成员"]'), '研究'))
    await submit(await waitForElement(sheet(), '.mote-group__composer'))
    await vi.waitFor(() => expect(sheet().querySelector('.mote-group__message[data-own] strong')?.textContent).toBe('我'))
    const listing = await rpc.call('space.mote.group.list', { moteId: spaceId })
    expect(listing.groups).toHaveLength(1)
    const read = await rpc.call('space.mote.group.inspect', { groupId: listing.groups[0]!.id })
    expect(read.messages).toHaveLength(1)
    expect(read.messages[0]).toMatchObject({ body: '从手机发给这个群', author: { kind: 'human', id: read.viewerId },
      deliveries: [{ moteId: spaceId, status: 'failed', issue: 'Original member executor temporarily unavailable' }] })
    expect(prepare).toHaveBeenCalledOnce()
    expect(surface.submit).not.toHaveBeenCalled()
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe(main.sessionId)
  } finally {
    await rpc.dispose()
    await server.stop()
    await transport.close()
  }
})
