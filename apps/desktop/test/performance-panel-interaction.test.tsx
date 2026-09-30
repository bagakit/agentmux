// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { PerformanceOverview } from '../src/renderer/src/components/performance/PerformanceOverview'
import { performanceContexts, performanceSnapshot } from '../scripts/fixtures/performance-panel/data'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import type { ToolkitSnapshot } from '../src/shared/toolkit'
import { parseMetricsObservation } from '@agentmux/core/control'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cost = { app: 0, panel: 0, projections: 0, visits: 0 }
Object.assign(globalThis, { __performanceUIRecord: (kind: string) => {
  if (kind === 'app-render') cost.app++
  if (kind === 'panel-render') cost.panel++
  if (kind === 'identity-projection') cost.projections++
  if (kind === 'identity-visit') cost.visits++
} })
const baselineCost = () => ({ ...cost })
const delta = (before: typeof cost) => Object.fromEntries(Object.entries(cost).map(([key, value]) => [key, value - before[key as keyof typeof cost]]))

let initial: ReturnType<typeof useAppStore.getState>, container: HTMLDivElement, root: Root
let publish: (snapshot: ToolkitSnapshot) => void, release: ReturnType<typeof vi.fn>
let observation: ToolkitSnapshot
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(cost, { app: 0, panel: 0, projections: 0, visits: 0 })
  initial = useAppStore.getState(); observation = structuredClone(performanceSnapshot)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  release = vi.fn(); publish = () => {}
  vi.spyOn(api.toolkit, 'observe').mockImplementation(callback => { publish = callback; callback(observation); return { dispose: release } })
  vi.spyOn(api.toolkit, 'script').mockResolvedValue({ toolId: 'performance', path: '/fixture/official/performance.sh', sha256: 'a'.repeat(64), text: 'exec agentmux metrics watch\n' })
  vi.spyOn(api.toolkit, 'run'); vi.spyOn(api.toolkit, 'stop'); vi.spyOn(api.config, 'save')
  const sessions = Array.from({ length: 128 }, (_, i) => {
    const session = composerSession(`unrelated-${i}`)
    return i < 8 ? { ...session, label: `Observed Agent ${i + 1}`, control: { ...session.control, run: { runId: `preparation-run-${i + 1}` } } } : session
  })
  useAppStore.setState({ ...initial, config: { ...composerConfig, toolkit: { performance: { enabled: true, statusBar: 'label' } },
    hosts: [composerConfig.hosts[0]!, ...Array.from({ length: 7 }, (_, i) => ({ id: `configured-${i}`, kind: 'ssh' as const, label: `Configured ${i}`, hostname: `configured-${i}.invalid` }))],
    workspaces: [{ id: 'primary', name: 'primary', hostId: 'local', path: '/fixture/primary', kind: 'folder' as const }],
    composerShortcuts: [{ id: 'one', keyword: 'one', label: 'Original prompt', body: 'Keep the draft' }] },
    loading: false, initialize: async () => () => {}, detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}),
    activeWorkspaceId: 'primary', mainSurface: 'workbench', toolsOpen: false, sessions, hostChecks: {}, error: null, tabs: {}, layouts: {},
    providerCatalog: await api.providers.list() }, true)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function node<T extends Element = HTMLElement>(selector: string, parent: ParentNode = document): T {
  const found = parent.querySelector<T>(selector)
  expect(found, `非空 connected owning 节点 ${selector}`).not.toBeNull(); expect(found!.isConnected).toBe(true)
  return found!
}
async function click(selector: string) { await act(async () => node<HTMLButtonElement>(selector).click()) }
async function mountApp() { await act(async () => root.render(<App />)) }
async function hover() { await act(async () => { node('.performance-trigger').dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 140)) }) }
function draft() { return node<HTMLTextAreaElement>('[data-prompt-editor] textarea') }

it('通过 actual App Settings 左侧入口与右侧 Toolkit，并让 script、Pause/Resume 与原 Toolkit 配置可达', async () => {
  await mountApp()
  expect(vi.mocked(api.toolkit.observe).mock.calls).toHaveLength(0)
  const trigger = node('.performance-trigger'), settings = node('[aria-label="Settings"]')
  expect(document.querySelectorAll('[aria-label="Settings"]')).toHaveLength(1)
  expect(settings.closest('.surface-navigation'), 'Settings remains in the left navigation').toBe(node('.surface-navigation'))
  expect(settings.previousElementSibling).toBe(node('.surface-navigation__surfaces'))
  expect(settings.hasAttribute('aria-current')).toBe(false)
  expect(node('.window-status-bar__right').querySelector('[aria-label="Settings"]')).toBeNull()
  expect(node('.window-status-bar__right').contains(trigger)).toBe(true)
  expect(trigger.closest('.window-status-bar__toolkits')).not.toBeNull()
  expect(node('.surface-navigation__surfaces').querySelector('[aria-label="Settings"], .performance-trigger')).toBeNull()
  expect(trigger.textContent).toContain('Performance')
  await click('.performance-trigger')
  expect(vi.mocked(api.toolkit.observe).mock.calls, '实际 Toolkit 观察 consumer 非空').toHaveLength(1)
  expect(node('[role="dialog"][aria-label="Performance"]').textContent).toContain('18.4%')
  await click('[data-performance-observation-toggle]')
  expect(release, 'Pause 只释放此 UI lease').toHaveBeenCalledTimes(1)
  expect(node('.performance-status').textContent).toBe('Paused here')
  await click('[data-performance-observation-toggle]')
  expect(vi.mocked(api.toolkit.observe).mock.calls).toHaveLength(2)
  await click('.performance-actions > button:first-child')
  expect(vi.mocked(api.toolkit.script).mock.calls, '只读 script actual API caller 非空').toHaveLength(1)
  const source = node<HTMLTextAreaElement>('[aria-label="Official Performance script source"]')
  expect(source.readOnly).toBe(true); expect(source.value).toBe('exec agentmux metrics watch\n')
  await click('[aria-label="Back to Performance"]')
  await click('.performance-actions > button:last-child')
  expect(node('.settings-page').dataset.settingsPage).toBe('toolkit')
  expect(document.querySelector('.performance-popover')).toBeNull()
  expect(api.toolkit.run).not.toHaveBeenCalled(); expect(api.toolkit.stop).not.toHaveBeenCalled()
  expect(api.config.save).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toHaveLength(128)
})

it('实际 Prompt textarea 的 hover 焦点、同节点、exact draft 与组字合同保持，关闭立即释放', async () => {
  await mountApp(); await click('[aria-label="Settings"]'); await click('[data-settings-target="prompts"]')
  const input = draft(), text = '  中文组字\nexact authored draft  '
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(2, 4)
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' }))
  })
  await hover()
  expect(document.activeElement, 'Hover preserves the original input focus').toBe(input)
  expect(draft()).toBe(input); expect(input.value).toBe(text); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4])
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', isComposing: true, keyCode: 229 })))
  expect(node('.performance-popover').getAttribute('role')).toBe('dialog')
  await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  expect(document.querySelector('.performance-popover')).toBeNull()
  expect(release, 'Close releases the owned observation lease').toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(input); expect(draft()).toBe(input); expect(input.value).toBe(text)
})

it('同步跨桥 handle 在 observe 建立期间关闭即可释放，迟到帧不能重新打开', async () => {
  vi.mocked(api.toolkit.observe).mockImplementation(callback => { publish = callback; return { dispose: release } })
  await mountApp(); await click('.performance-trigger'); await click('[data-performance-close]')
  expect(document.querySelector('.performance-popover')).toBeNull()
  expect(release, 'Opening observation handle is immediately disposed after close').toHaveBeenCalledTimes(1)
  await act(async () => publish(observation))
  expect(document.querySelector('.performance-popover')).toBeNull()
})

it('source 自身年龄不被新 envelope 时间刷新，展开行在真实新排名仍同节点和顺序', async () => {
  const render = async () => act(async () => root.render(<PerformanceOverview snapshot={observation} contexts={performanceContexts} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />))
  observation.observedAt! += 30000; observation.observation!.observedAt += 30000; observation.observation!.app.state = 'stale'; observation.observation!.app.reason = 'Application readings could not be refreshed.'
  await render()
  expect.soft(node('.performance-observation').textContent, 'Source age uses its last successful reading').toContain('30s old')
  expect(node('.performance-body').textContent).toContain('Previous reading')
  await click('[data-settings-target="runs"]')
  const row = node<HTMLDetailsElement>('[data-run-id="preparation-run-1"]')
  await act(async () => { row.open = true; row.querySelector('summary')!.focus(); row.dispatchEvent(new Event('toggle')) })
  const originalRows = Array.from(document.querySelectorAll<HTMLElement>('.performance-contributor')).map(item => item.dataset.runId)
  expect(originalRows).toHaveLength(5)
  observation = structuredClone(observation); observation.observedAt! += 1000; observation.observation!.observedAt += 1000
  observation.observation!.process.observedAt! += 1000; observation.observation!.process.lastSuccessAt! += 1000
  observation.observation!.process.data![0]!.cpuPercent = .1; observation.observation!.process.data![1]!.cpuPercent = 58.6
  await render()
  expect(node('[data-run-id="preparation-run-1"]')).toBe(row); expect(row.open).toBe(true)
  expect(document.activeElement).toBe(row.querySelector('summary'))
  expect(Array.from(document.querySelectorAll<HTMLElement>('.performance-contributor')).map(item => item.dataset.runId)).toEqual(originalRows)
  expect(row.textContent).toContain('0.1%')

  // 原独立 mounted 反例纳入同一 actual owning 场景：其他消费者不能填回此 UI 的暂停期。
  const appRender = async (key: string, paused = false) => act(async () => root.render(<PerformanceOverview key={key} snapshot={observation}
    contexts={performanceContexts} paused={paused} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />))
  const path = () => node<SVGPathElement>('.performance-metrics svg > path:last-child').getAttribute('d')!
  observation = structuredClone(performanceSnapshot)
  await appRender('pause')
  expect(path(), '实际 App 暂停前数值轨迹非空').toContain('L')
  await appRender('pause', true)
  observation = structuredClone(observation); observation.observedAt! += 2000; observation.observation!.observedAt += 2000
  observation.observation!.app.observedAt! += 2000; observation.observation!.app.lastSuccessAt! += 2000
  observation.trend.push({ observedAt: observation.observedAt!, appCpuPercent: 44, appRssKib: 655360 })
  await appRender('pause')
  expect.soft(path().match(/M/g), 'Pausing this UI leaves an App gap even while another consumer continues').toHaveLength(2)

  observation = structuredClone(performanceSnapshot)
  const sourceAt = observation.observation!.app.observedAt!
  await appRender('source-gap')
  expect(path(), '实际 App 缺测前数值轨迹非空').toContain('L')
  observation = structuredClone(observation); observation.observedAt! += 5000; observation.observation!.observedAt += 5000
  observation.observation!.app.state = 'stale'; observation.observation!.app.reason = 'Application readings could not be refreshed.'
  observation.trend.push({ observedAt: observation.observedAt!, appCpuPercent: null, appRssKib: null })
  expect(parseMetricsObservation(observation.observation).app.state).toBe('stale')
  await appRender('source-gap')
  observation = structuredClone(observation); observation.observedAt! += 1000; observation.observation!.observedAt += 1000
  observation.observation!.app.state = 'available'; observation.observation!.app.reason = null
  observation.observation!.app.observedAt = sourceAt + 1000; observation.observation!.app.lastSuccessAt = sourceAt + 1000
  observation.observation!.app.data!.cpuPercent = 44
  observation.trend.push({ observedAt: sourceAt + 1000, appCpuPercent: 44, appRssKib: 655360 })
  expect(parseMetricsObservation(observation.observation).app.data!.cpuPercent).toBe(44)
  await appRender('source-gap')
  expect(path(), '实际 App 缺测恢复数值轨迹非空').toContain('L')
  expect.soft(path().match(/M/g), 'App source watermark must remain independent from the envelope gap time').toHaveLength(2)
})

it('selected Run 来源时间独立于 gap marker；cached available 不追加旧点，fresh 才开始新段', async () => {
  const render = async () => act(async () => root.render(<PerformanceOverview snapshot={observation} contexts={performanceContexts} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />))
  await render(); await click('[data-settings-target="runs"]')
  const row = node<HTMLDetailsElement>('[data-run-id="preparation-run-1"]')
  await act(async () => { row.open = true; row.dispatchEvent(new Event('toggle')) })
  observation = structuredClone(observation); observation.observedAt! += 1000; observation.observation!.observedAt += 1000
  observation.observation!.process.observedAt! += 1000; observation.observation!.process.lastSuccessAt! += 1000
  await render()
  observation = structuredClone(observation); observation.observedAt! += 1000; observation.observation!.observedAt += 1000
  observation.observation!.process.state = 'stale'; observation.observation!.process.reason = 'Process observations could not be refreshed.'
  await render()
  const afterGap = node<SVGPathElement>('.performance-metrics--run svg > path:last-child').getAttribute('d')!
  expect(afterGap, '非空实际 Run gap 前数值轨迹').not.toBe('')
  observation = structuredClone(observation); observation.observedAt! += 1000; observation.observation!.observedAt += 1000
  observation.observation!.process.state = 'available'; observation.observation!.process.reason = null
  // available 的缓存来源时间仍是 gap 前的旧值；新的 envelope 不能把旧读数当新点。
  await render()
  expect(node<SVGPathElement>('.performance-metrics--run svg > path:last-child').getAttribute('d'), 'Cached available source must not append a duplicate point after the gap').toBe(afterGap)
  observation = structuredClone(observation); observation.observedAt! += 1000; observation.observation!.observedAt += 1000
  observation.observation!.process.state = 'available'; observation.observation!.process.reason = null
  observation.observation!.process.observedAt = observation.observedAt; observation.observation!.process.lastSuccessAt = observation.observedAt
  await render()
  const segments = node<SVGPathElement>('.performance-metrics--run svg > path:last-child').getAttribute('d')!
  expect(segments, '非空已实际绘制的 Run 轨迹').not.toBe('')
  expect(segments.match(/M/g), 'A stale gap starts a new segment instead of a false connecting line').toHaveLength(2)
  expect(segments.match(/[ML]/g), 'Only actual fresh source readings create numeric points').toHaveLength(3)
})

it('128 Session/8 Host 中 unrelated Store 更新不扫描身份；真实新 Session 数组只 join 一次并有相关身份正控', async () => {
  await mountApp()
  const updateBackground = async () => {
    for (let i = 0; i < 6; i++) await act(async () => useAppStore.setState(state => ({
      hostChecks: { ...state.hostChecks, [`irrelevant-${i}`]: { ok: true, checkedAt: i } },
      agentComposerDrafts: { ...state.agentComposerDrafts, [`unrelated-${i + 60}`]: `Unrelated draft ${i}` }, errorDismissed: i % 2 === 0
    })))
  }
  const closed = baselineCost(); await updateBackground(); const closedDelta = delta(closed)
  expect(closedDelta.panel).toBe(0); expect(closedDelta.visits).toBe(0); expect(vi.mocked(api.toolkit.observe).mock.calls).toHaveLength(0)
  expect(closedDelta.app, '原 App 实际消费六次 background 更新').toBeGreaterThanOrEqual(6)
  await click('.performance-trigger'); await click('[data-settings-target="runs"]')
  expect(node('[data-run-id="preparation-run-1"]').textContent).toContain('Observed Agent 1')
  expect(cost.visits, '非空 actual Session join 正控').toBeGreaterThanOrEqual(128)
  const open = baselineCost(); await updateBackground(); const openDelta = delta(open)
  expect(openDelta.panel, 'Stable unrelated facts do not render Performance').toBe(0)
  expect(openDelta.app).toBeGreaterThanOrEqual(6)
  expect(openDelta.visits, 'Stable sessions reference prevents an unrelated N scan').toBe(0)
  const array = baselineCost()
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions] })))
  const arrayDelta = delta(array)
  expect(arrayDelta.projections).toBe(1); expect(arrayDelta.visits).toBe(128); expect(arrayDelta.panel).toBe(0)
  const related = baselineCost()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map((session, index) => index ? session : { ...session, label: 'Actual related identity update' }) })))
  expect(node('[data-run-id="preparation-run-1"]').textContent).toContain('Actual related identity update')
  const relatedDelta = delta(related)
  expect(relatedDelta.projections).toBe(1); expect(relatedDelta.visits).toBe(128); expect(relatedDelta.panel).toBeGreaterThan(0)
  await click('[data-performance-close]'); expect(release).toHaveBeenCalledTimes(1)
  const afterClose = baselineCost(); await updateBackground(); const afterCloseDelta = delta(afterClose)
  expect(afterCloseDelta.panel).toBe(0); expect(afterCloseDelta.visits).toBe(0)
  if (process.env.AGENTMUX_PERFORMANCE_UI_EVIDENCE) appendFileSync(resolve(process.env.AGENTMUX_PERFORMANCE_UI_EVIDENCE, 'cost.jsonl'), JSON.stringify({
    schema: 'agentmux.performance-ui-owning-cost.v1', sessionCount: useAppStore.getState().sessions.length, hostCount: useAppStore.getState().config!.hosts.length,
    closed: closedDelta, open: openDelta, changedArray: arrayDelta, related: relatedDelta, afterClose: afterCloseDelta,
    boundary: '实际 App 与实际 UI loaded Source 的局部 HappyDOM 扫描/函数渲染计数；受控 DTO/API，不签官方链、native焦点或用户现场FPS。'
  }) + '\n')
})
