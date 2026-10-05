import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { readSurveyPresentation } from '../../desktop/src/renderer/src/lib/mobile-presentation'
import { click, fixture, mount, mounted } from './conversation-fixture'

const native = vi.hoisted(() => ({ back: null as (() => void) | null }))
vi.mock('../src/platform/native/device', async original => ({ ...await original<Record<string, unknown>>(),
  bindNativeDevice: vi.fn((value: { onBack(): void }) => { native.back = value.onBack; return { dispose: async () => { native.back = null } } }) }))
const source = { kind: 'file' as const, hostId: 'host-original', path: fixturePath("workspace/retained.md"), projectId: 'original-project' }
const context = { categoryId: 'original-category', topicId: 'original-topic', mode: 'knowledge' as const }
const topicFrames = { context, sources: [{ source, origin: context }] }
const draftKey = JSON.stringify(['draft', 'session-original'])
const conversation = { version: 1 as const, drafts: [[draftKey, '原未发中文草稿']] as Array<[string, string]>,
  attempts: [[draftKey, { operationId: 'original-operation', runId: 'run-original', draft: '原请求正文', phase: 'unknown' as const }]] as const, responses: [] }
const visibleButton = (element: HTMLElement, text: string) => {
  const value = [...element.querySelectorAll<HTMLButtonElement>('button')].find(button => !button.closest('[hidden]')
    && (button.getAttribute('aria-label') === text || button.textContent?.trim() === text || button.querySelector('strong')?.textContent === text))
  expect(value, text).toBeDefined(); return value!
}
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), selectedSessionId: 'session-original',
  conversation: { ...conversation, attempts: [...conversation.attempts].map(([key, value]) => [key, { ...value }]) },
  presentation: { primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null, topics: topicFrames } }) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it.each(['browser', 'native'])('%s Back leaves visible Survey content without popping the retained hidden Topic source', async mode => {
  const f = fixture(), zone = { zoneId: 'original-study', workspaceId: 'original-workspace', hostId: 'host-original', directoryPath: fixturePath("workspace"), kind: 'directory' as const, branch: null }
  const tabs = ['first', 'second'].map(name => ({ tabId: `${name}-tab`, zoneId: zone.zoneId, workspaceId: zone.workspaceId, name: `${name}原标签`, regionIds: [`${name}-browser-region`] }))
  const catalog = { spaces: [], zones: [zone], tabs, regions: tabs.map((tab, index) => ({ regionId: tab.regionIds[0]!, tabId: tab.tabId,
    kind: 'browser' as const, browserId: index ? 'original-browser' : 'wrong-browser', agentSessionId: null, runId: null, execution: null })), bindings: [], locations: [] }
  const survey = readSurveyPresentation({ surveyCollectedZones: { [zone.zoneId]: true }, surveyExplorationNames: { [zone.zoneId]: '准确原研究' },
    surveyZoneSelection: { zoneId: zone.zoneId, selection: [{ tabId: tabs[0]!.tabId, regionId: tabs[0]!.regionIds[0]! }], active: { tabId: tabs[0]!.tabId, regionId: tabs[0]!.regionIds[0]! } }, tabs: {} } as any, catalog)
  f.client.forwardRpc = vi.fn().mockImplementation(async (method: string) => {
    if (method === 'space.ls') return { catalog: { ...catalog, survey } }
    if (method === 'app.snapshot') return { projects: [], agents: [], executors: [], workspaces: [{ workspaceId: zone.workspaceId, hostId: zone.hostId, path: fixturePath("workspace"), projectId: source.projectId }], unavailable: [] }
    if (method === 'topic.category.ls') return { categories: [], unavailable: [] }
    if (method === 'topic.ls') return { topics: [], unavailable: [] }
    if (method === 'browser.targets') return { targets: [{ id: 'wrong-browser', title: '首个干扰网页', url: 'https://wrong.example/', status: 'ready' },
      { id: 'original-browser', title: '准确第二原网页', url: 'http://original.example/read', status: 'ready' }] }
    throw new Error('原来源当前未确认：' + method)
  })
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原连接' }} platform={createBrowserPlatform()} native={mode === 'native'} />)
  const originalEditor = view.element.querySelector('[contenteditable=true]')
  await click(visibleButton(view.element, '手机设置与连接'))
  const surveyEntry = document.body.querySelector<HTMLButtonElement>('.mobile-drawer-workfaces button')
  expect(surveyEntry).not.toBeNull(); await click(surveyEntry!)
  await click(visibleButton(view.element, '准确原研究'))
  const second = [...view.element.querySelectorAll<HTMLElement>('.mobile-survey-tab')].find(tab => tab.querySelector('h2')?.textContent === 'second原标签')!
  await click(visibleButton(second, '查看原网页'))
  expect(view.element.querySelector<HTMLAnchorElement>('.mobile-survey a')?.href).toBe('http://original.example/read')
  expect(getDeviceWorkface().snapshot().record.presentation!.survey).toEqual({ zoneId: zone.zoneId, tabId: 'second-tab', regionId: 'second-browser-region' })
  const back = async () => mode === 'native' ? act(async () => native.back!()) : act(async () => { history.back(); await new Promise(resolve => setTimeout(resolve, 30)) })
  await back()
  expect(getDeviceWorkface().snapshot().record.presentation!.survey).toEqual({ zoneId: zone.zoneId, tabId: null, regionId: null })
  expect(getDeviceWorkface().snapshot().record.presentation!.topics).toEqual(topicFrames)
  await back()
  expect(getDeviceWorkface().snapshot().record.presentation!.survey).toBeUndefined()
  expect(view.element.querySelector('nav[aria-label="原研究列表"]')).not.toBeNull()
  expect(getDeviceWorkface().snapshot().record.conversation).toEqual(conversation)
  expect(view.element.querySelector('[contenteditable=true]')).toBe(originalEditor)
  const calls = vi.mocked(f.client.forwardRpc!).mock.calls.length
  await click(visibleButton(view.element, 'Topics'))
  expect(getDeviceWorkface().snapshot().record.presentation!.topics).toEqual(topicFrames)
  expect(view.element.querySelector('.mobile-topic-source-reader')?.closest('[hidden]')).toBeNull()
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.slice(calls).some(([method]) => method === 'browser.targets')).toBe(false)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})
