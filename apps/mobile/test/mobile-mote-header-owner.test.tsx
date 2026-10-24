import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { click, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const sid = 'session-original', spaceId = 'original-mote', agentName = '原 Agent 会话名称', moteName = '保留完整原对象名称的协作 Mote'
const connected = { state: 'connected' as const, message: '原 Host' }
const content = { zoneId: 'original-zone', hostId: 'host-original', workspaceId: 'original-workspace', workspacePath: fixturePath('original-mote') }
const context = { spaceId, zoneId: content.zoneId, workspaceId: content.workspaceId, displayWorkspaceId: 'original-display', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const moteFact = { spaceId, content, quickMode: { status: 'missing' }, conversation: null }
const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [], motePresentation: [moteFact], appearance: [{ spaceId, preset: 'primary-mote' }] }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 28, height: 28 }] as unknown as DOMRectList) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })

async function setup(home: 'mote' | 'focus', kind: 'mote' | 'ordinary', name?: string) {
  const f = fixture(), owner = getDeviceWorkface()
  const identity = { name: agentName, project: '原项目', context, ...(kind === 'mote' ? { mote: { spaceId, ...(name === undefined ? {} : { name }), contentReference: content } } : {}) }
  await owner.updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' }, { primary: home, showSession: true, showGoalWork: false, identity, profile: null })
  f.client.forwardRpc = vi.fn(async (method: string) => {
    if (method === 'goal.ls') return { goals: [], unavailable: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'topic.ls') return { topics: [], unavailable: [] }
    if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    return { catalog }
  }) as any
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} native />)
  await paste(view.element, '原会话未发送草稿')
  return { f, owner, view, identity, originalEditor: editor(view.element) }
}

it.each([{ name: moteName, expected: moteName }, { name: undefined, expected: 'Mote 名称未确认' }])('Mote workface preserves original Mote name $expected and opens its original Profile', async ({ name, expected }) => {
  const { f, owner, view, originalEditor } = await setup('mote', 'mote', name)
  const title = view.element.querySelector<HTMLButtonElement>('.mobile-header .mobile-mote-heading')!
  expect(title.querySelector('.mobile-session-title')?.textContent).toBe(expected)
  expect(title.getAttribute('aria-label')).toBe(`${expected} · 查看身份与状态`)
  expect(title.textContent).not.toContain(agentName)
  await click(title)
  expect(document.querySelector('[role="dialog"] [data-mote-space-id]')?.getAttribute('data-mote-space-id')).toBe(spaceId)
  expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(expected)
  expect(f.client.forwardRpc).toHaveBeenCalledWith('space.ls', { target: { spaceId }, presentation: true })
  await click(document.querySelector('[role="dialog"] [aria-label="关闭面板"]')!)
  expect(editor(view.element)).toBe(originalEditor); expect(originalEditor.textContent).toContain('原会话未发送草稿')
  expect(owner.snapshot().record.selectedSessionId).toBe(sid); expect(f.client.agentSession(sid).run.runId).toBe('run-original'); expect(f.submit).not.toHaveBeenCalled()
})

it.each(['mote', 'ordinary'] as const)('workspace %s neighbor retains its own Agent heading and original conversation', async kind => {
  const { f, owner, view, originalEditor } = await setup('focus', kind, moteName)
  expect(view.element.querySelector('.mobile-header .mobile-session-title')?.textContent).toBe(agentName)
  const title = view.element.querySelector<HTMLButtonElement>('.mobile-header .mobile-mote-heading')
  if (kind === 'mote') {
    expect(title?.getAttribute('aria-label')).toBe(`${agentName} · 查看身份与状态`)
    await click(title!); expect(document.querySelector('[role="dialog"] [data-mote-space-id]')?.getAttribute('data-mote-space-id')).toBe(spaceId)
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(moteName)
    await click(document.querySelector('[role="dialog"] [aria-label="关闭面板"]')!)
  } else expect(title).toBeNull()
  expect(editor(view.element)).toBe(originalEditor); expect(originalEditor.textContent).toContain('原会话未发送草稿')
  expect(owner.snapshot().record.selectedSessionId).toBe(sid); expect(f.client.agentSession(sid).run.runId).toBe('run-original'); expect(f.submit).not.toHaveBeenCalled()
})
