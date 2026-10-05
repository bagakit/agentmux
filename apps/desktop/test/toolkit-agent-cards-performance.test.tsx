// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { PerformanceOverview } from '../src/renderer/src/components/performance/PerformanceOverview'
import { performanceSnapshot } from '../scripts/fixtures/performance-panel/data'
import type { ToolkitMetricsSnapshot } from '../src/shared/toolkit'
let root: Root, container: HTMLDivElement, sample: ToolkitMetricsSnapshot
const initial = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  sample = structuredClone(performanceSnapshot)
  sample.observation!.runTotals = {coverage:{trackedRuns:8,observedRoots:8,missingRoots:0},cpuPercent:90,rssKib:4194304,processCount:24}
  sample.observation!.process.data![0]!.cpuPercent = 90; sample.observation!.process.data![1]!.cpuPercent = 90
  const first = composerSession('actual-agent'); first.label = 'Review the exact Toolkit contract'; first.control.run.runId = 'preparation-run-1'
  useAppStore.setState({config:composerConfig,sessions:[first],agentNames:{}})
})
afterEach(async () => {await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial,true); vi.restoreAllMocks(); vi.unstubAllGlobals()})
const node = <T extends Element = HTMLElement>(selector: string) => {const value = document.querySelector<T>(selector); expect(value,selector).not.toBeNull(); expect(value!.isConnected).toBe(true); return value!}
const click = async (selector: string) => act(async () => node<HTMLElement>(selector).click())
const render = async (paused=false) => act(async () => root.render(<PerformanceOverview snapshot={sample} close={()=>{}} onConfigure={()=>{}} onViewScript={()=>{}} paused={paused} />))
const runs = async () => {await render(); await click('[data-settings-target="runs"]')}
it('actual Performance consumes the public card and source total before row peaks, top five and selection', async () => {
  await runs()
  const totals = node('[data-run-total-values]'); expect(totals.textContent).toContain('90.0%'); expect(totals.textContent).toContain('0.90 cores'); expect(totals.textContent).toContain('4.0 GiB')
  expect(node('[data-run-totals]').textContent).toContain('8 / 8 roots observed')
  expect(container.querySelectorAll('.performance-contributor')).toHaveLength(5)
  const card = node('[data-run-id="preparation-run-1"] [data-toolkit-agent-card]')
  expect(card.textContent).toContain('Review the exact Toolkit contract'); expect(card.getAttribute('data-agent-card-state')).toBe('resolved')
  expect(card.querySelector('[data-card-field="avatar"]')).not.toBeNull()
  await click('.performance-show-all'); expect(container.querySelectorAll('.performance-contributor')).toHaveLength(8)
  const details = node<HTMLDetailsElement>('[data-run-id="preparation-run-1"]')
  await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'))})
  expect(node('.performance-metrics--run').textContent).toContain('Selected CPU')
  expect(node('[data-run-total-values]').textContent).toBe(totals.textContent)
  expect(container.textContent).toContain('row peaks can occur at different times')
})
it('field configuration is from the same public result; missing document cannot privately manufacture a standard card', async () => {
  await runs(); expect(node('[data-toolkit-agent-card]').textContent).toContain('Review the exact Toolkit contract')
  sample = structuredClone(sample); sample.document!.agentCards!.fields = ['runId']; await render()
  const card = node('[data-run-id="preparation-run-1"] [data-toolkit-agent-card]')
  expect(card.querySelector('[data-card-field="name"]')).toBeNull(); expect(card.querySelector('[data-card-field="avatar"]')).toBeNull()
  expect(card.textContent).toContain('preparation-run-1')
  sample = structuredClone(sample); sample.document = null; await render()
  expect(container.querySelector('[data-toolkit-agent-card]')).toBeNull(); expect(container.textContent).toContain('Agent card unavailable')
  expect(node('[data-run-total-values]').textContent).toContain('90.0%')
})
it('duplicate card references never last-win; omitted cards preserve all rows and full totals', async () => {
  sample.document!.agentCards!.items.push(structuredClone(sample.document!.agentCards!.items[0]!))
  await runs()
  const first = node('[data-run-id="preparation-run-1"]')
  expect(first.textContent).toContain('Agent card ambiguous'); expect(first.querySelector('[data-toolkit-agent-card]')).toBeNull()
  sample = structuredClone(sample); sample.document!.agentCards!.items = []; sample.document!.agentCards!.omittedItems = 8; await render()
  expect(container.textContent).toContain('8 Agent cards omitted'); expect(node('[data-run-total-values]').textContent).toContain('90.0%')
  await click('.performance-show-all'); expect(container.querySelectorAll('.performance-contributor')).toHaveLength(8)
})
it('partial, unavailable, stale and paused readings preserve coverage and source age without false zero totals', async () => {
  await runs()
  sample = structuredClone(sample); sample.observedAt! += 30000; sample.observation!.observedAt += 30000
  sample.observation!.process.state = 'stale'; sample.observation!.process.reason = 'Original process source unavailable'
  await render(true); expect(node('.performance-observation').textContent).toContain('30s old'); expect(node('[data-run-total-values]').textContent).toContain('90.0%'); expect(container.textContent).toContain('Previous reading')
  sample = structuredClone(sample); sample.observation!.runTotals = {coverage:{trackedRuns:8,observedRoots:7,missingRoots:1},cpuPercent:null,rssKib:null,processCount:null}; await render()
  expect(node('[data-run-total-values]').textContent).not.toContain('0.0%'); expect(container.textContent).toContain('1 tracked roots missing')
  sample = structuredClone(sample); sample.observation!.process = {data:null,state:'unavailable',reason:'No process reading',observedAt:null,lastSuccessAt:null}; sample.observation!.runTotals=null; await render()
  expect(node('[data-run-totals]').textContent).toContain('Coverage unavailable'); expect(node('[data-run-total-values]').textContent).not.toContain('0.0%')
})
it('refresh preserves exact details, focus and scroll while identity updates remain visible', async () => {
  await runs(); const details=node<HTMLDetailsElement>('[data-run-id="preparation-run-1"]'), summary=details.querySelector('summary')!
  await act(async()=>{details.open=true;summary.focus();details.dispatchEvent(new Event('toggle'))}); node('.performance-body').scrollTop=120
  sample=structuredClone(sample); sample.sequence++; sample.observation!.process.data![0]!.cpuPercent=.1
  await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(s=>({...s,label:'Updated original Agent identity'}))})))
  await render(); expect(node('[data-run-id="preparation-run-1"]')).toBe(details);expect(details.open).toBe(true);expect(document.activeElement).toBe(summary);expect(node('.performance-body').scrollTop).toBe(120)
  expect(details.textContent).toContain('Updated original Agent identity');expect(details.textContent).toContain('0.1%')
})
it('actual App Toolkit stream supplies the public card and totals; pause releases its UI lease without Run actions', async () => {
  const release=vi.fn(); let publish=(_value:ToolkitMetricsSnapshot)=>{}
  vi.spyOn(api.toolkit,'observe').mockImplementation((_id,callback)=>{publish=callback;callback(sample);return {dispose:release}})
  const run=vi.spyOn(api.toolkit,'run'),stop=vi.spyOn(api.toolkit,'stop')
  useAppStore.setState({...useAppStore.getState(),loading:false,initialize:async()=>()=>{},detectExecutors:vi.fn(async()=>{}),checkHost:vi.fn(async()=>{}),
    config:{...composerConfig,toolkit:{performance:{enabled:true,statusBar:'label'}}},providerCatalog:await api.providers.list(),mainSurface:'workbench',toolsOpen:false,tabs:{},layouts:{}},true)
  await act(async()=>root.render(<App />)); await click('.performance-trigger');await click('[data-settings-target="runs"]')
  expect(node('[data-toolkit-agent-card]').textContent).toContain('Review the exact Toolkit contract');expect(node('[data-run-total-values]').textContent).toContain('90.0%')
  await act(async()=>{sample=structuredClone(sample);sample.observation!.runTotals!.cpuPercent=55;publish(sample)})
  expect(node('[data-run-total-values]').textContent).toContain('55.0%')
  await click('[data-performance-observation-toggle]');expect(release).toHaveBeenCalledOnce();expect(run).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled()
})
it('two hosts with the same Run ID keep different rows and exact generic identities', async () => {
  const other = composerSession('other-agent'); other.hostId = 'other'; other.control.hostId = 'other'; other.control.run.runId = 'preparation-run-1'; other.label = 'Other Host Agent'
  useAppStore.setState(state=>({sessions:[...state.sessions,other]}))
  sample.observation!.process.data![1]!.hostId = 'other'; sample.observation!.process.data![1]!.runId = 'preparation-run-1'
  sample.document!.agentCards!.items[1]!.reference = {kind:'run',hostId:'other',runId:'preparation-run-1'}
  await runs()
  expect(node('[data-run-host="local"][data-run-id="preparation-run-1"] [data-toolkit-agent-card]').textContent).toContain('Review the exact Toolkit contract')
  expect(node('[data-run-host="other"][data-run-id="preparation-run-1"] [data-toolkit-agent-card]').textContent).toContain('Other Host Agent')
})
