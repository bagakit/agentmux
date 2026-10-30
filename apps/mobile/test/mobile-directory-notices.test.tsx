import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const originalReason = '目录配置读取未完成 [SOURCE_UNAVAILABLE]\nHost=original-host; Space=original-folder; request=original-read. 完整原因与原对象保留。'
function directoryFixture() {
  const f = fixture()
  const catalog: AgentMuxSpaceCatalog = { spaces: [
    { spaceId: 'original-folder', kind: 'folder', name: '当前项目', hostId: 'local', directoryPath: '/fixture/project', projectId: 'original-project', issue: originalReason },
    { spaceId: 'original-mote', kind: 'mote', name: '协作伙伴', hostId: 'local', directoryPath: '/fixture/mote', projectId: null, issue: originalReason }
  ], zones: [], tabs: [], regions: [], locations: [], bindings: [],
    agentPresentation: [{ agentSessionId: 'session-original', name: '当前工作', project: '当前项目', detail: '正在核对资料', group: 'working', state: 'working', providerId: 'codex', recap: null,
      projectGroup: { key: 'original-project', projectId: 'original-project', hostId: 'local', name: '当前项目', spaceId: 'original-folder' } }] }
  let failed = false, resolved = false
  const rpc = vi.fn(async (method: string) => {
    if (method === 'space.ls') {
      if (failed) throw Error('本次目录读取失败 [READ_FAILED]；上次目录仍保留。')
      return { catalog: resolved ? { ...catalog, spaces: catalog.spaces.map(({ issue: _, ...space }) => space) } : catalog }
    }
    throw Error('Unexpected read: ' + method)
  })
  f.client.forwardRpc = rpc as typeof f.client.forwardRpc
  f.client.subscribeRpc = vi.fn().mockResolvedValue({ subscriptionId: 'original-appearance', dispose: async () => {} })
  return { ...f, rpc, catalog, fail: () => { failed = true }, resolve: () => { failed = false; resolved = true } }
}
const directoryEntry = (root: ParentNode) => root.querySelector<HTMLButtonElement>('button.mobile-directory-notice')!
const directoryDialog = () => document.body.querySelector<HTMLElement>('.mobile-directory-issues')!

it.each(['focus', 'mote', 'space'] as const)('keeps %s issues in the actual App header and explicitly re-reads only the directory', async home => {
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' },
    { primary: home, showSession: false, showGoalWork: false, identity: null, profile: null })
  const f = directoryFixture(), view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '已连接' }} platform={createBrowserPlatform()} restoreWorkface />)
  await vi.waitFor(() => expect(directoryEntry(view.element)).not.toBeNull())
  const entry = directoryEntry(view.element)
  expect(entry.closest('.mobile-page-header .mobile-section-actions')).not.toBeNull()
  expect(entry.getAttribute('aria-label')).toContain('项待确认')
  expect(view.element.querySelector('details.mobile-directory-notice')).toBeNull()
  expect(view.element.querySelector('.mobile-spatial-panel')?.textContent).not.toContain(originalReason)
  const before = f.rpc.mock.calls.length, retained = structuredClone(getDeviceWorkface().snapshot().record)
  await click(entry)
  expect(directoryDialog().textContent).toContain(home === 'mote' ? '协作伙伴' : '当前项目')
  expect(directoryDialog().textContent).toContain(originalReason)
  expect(f.rpc).toHaveBeenCalledTimes(before)
  await click(button(directoryDialog(), '关闭目录信息'))
  expect(directoryDialog()).toBeNull()
  expect(f.rpc).toHaveBeenCalledTimes(before)
  expect(getDeviceWorkface().snapshot().record).toEqual(retained)
  await click(entry)
  f.fail()
  await click(button(directoryDialog(), '重新读取目录'))
  expect(f.rpc).toHaveBeenCalledTimes(before + 1)
  expect(f.rpc.mock.calls.at(-1)).toEqual(['space.ls', { target: {}, presentation: true }])
  expect(directoryDialog().textContent).toContain('本次目录读取失败 [READ_FAILED]')
  expect(directoryDialog().textContent).toContain(originalReason)
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  f.resolve()
  await click(button(directoryDialog(), '重新读取目录'))
  expect(f.rpc).toHaveBeenCalledTimes(before + 2)
  expect(directoryEntry(view.element)).toBeNull()
  expect(directoryDialog()).toBeNull()
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.inspectInput).not.toHaveBeenCalled()
  expect(f.rpc.mock.calls.every(([method]) => method === 'space.ls')).toBe(true)
})

it('scopes missing selected-session metadata to that conversation while retaining diagnostics and its mounted draft', async () => {
  await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const f = directoryFixture(), readSession = f.client.agentSession.bind(f.client)
  let missing = false
  vi.spyOn(f.client, 'agentSession').mockImplementation(id => { if (missing && id === 'session-original') throw Error('Original Session metadata unavailable'); return readSession(id) })
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '已连接' }} platform={createBrowserPlatform()} />)
  await paste(view.element, '保留这段对话里的未发送正文')
  const originalEditor = editor(view.element), originalDraft = structuredClone(getDeviceWorkface().snapshot().record.conversation)
  missing = true
  await act(async () => f.emit({ type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' } } as never))
  expect(view.element.querySelector('.mobile-service-notice')?.textContent).toContain('原会话元信息尚未核实')
  for (const home of ['Focus', 'Mote', 'Space']) {
    await click(button(view.element.querySelector('.mobile-navigation')!, home))
    expect(view.element.querySelector('.mobile-service-notice')?.textContent ?? '').not.toContain('原会话元信息尚未核实')
    expect(editor(view.element)).toBe(originalEditor)
    expect(originalEditor.textContent).toBe('保留这段对话里的未发送正文')
  }
  await click(button(view.element, '手机设置与连接'))
  await click(button(document.body, '提醒与诊断'))
  const diagnostic = document.body.querySelector('.mobile-session-diagnostic')!
  expect(diagnostic).not.toBeNull()
  expect(diagnostic.textContent).toContain('原会话元信息尚未核实')
  expect(diagnostic.textContent).toContain('session-original')
  expect(button(diagnostic, '查看 Mac 连接')).toBeDefined()
  await click(button(diagnostic, '返回这段对话'))
  expect(view.element.querySelector('.mobile-service-notice')?.textContent).toContain('原会话元信息尚未核实')
  expect(editor(view.element)).toBe(originalEditor)
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(originalDraft)
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.inspectInput).not.toHaveBeenCalled()
})
