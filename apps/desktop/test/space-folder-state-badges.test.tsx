// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import type { SessionSnapshot } from '../src/shared/contracts'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { allStyleRules } from './helpers/styles'

const initial = useAppStore.getState()
let mounted: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount())
  mounted = undefined
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
  document.body.replaceChildren()
})
function agent(id: string, state: SessionSnapshot['status']['state'], workspacePath = '/projects/alpha'): SessionSnapshot {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath, label: id, createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state, source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as SessionSnapshot
}
async function renderFolders(sessions: SessionSnapshot[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  useAppStore.setState({ config: { ...initial.config!, version: 9, hosts: [], executors: {}, workspaces: [
    { id: 'alpha', name: 'Alpha', hostId: 'local', path: '/projects/alpha', kind: 'folder' },
    { id: 'empty', name: 'Empty folder', hostId: 'local', path: '/other/empty', kind: 'folder' }
  ] }, sessions, timelines: {}, agentNames: {}, providerCatalog: [], activeWorkspaceId: 'alpha', mainSurface: 'workbench', collapsedProjectGroups: {}, pinnedItems: {} })
  const container = document.createElement('div')
  document.body.append(container)
  mounted = createRoot(container)
  await act(async () => mounted!.render(createElement(WorkspaceSidebar)))
  const folder = container.querySelector<HTMLButtonElement>('[data-workspace-id="alpha"]')
  expect(folder).not.toBeNull()
  const entry = folder!.closest('.project-rail-entry')!
  expect(entry).not.toBeNull()
  return { container, entry }
}
function cssRule(selector: string): string {
  const rules = allStyleRules()
  expect(rules.length).toBeGreaterThan(1000)
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(rules)
  expect(found, `Missing rule for ${selector}`).not.toBeNull()
  expect(found![1]!.trim().length).toBeGreaterThan(0)
  return found![1]!
}
function declaration(rule: string, property: string): string {
  const found = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(rule)
  expect(found, `Missing ${property}`).not.toBeNull()
  return found![1]!.trim()
}
function px(value: string): number {
  const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
  const declarations = token ? [...allStyleRules().matchAll(new RegExp(`${token}:\\s*([\\d.]+)px`, 'g'))] : []
  if (token) expect(declarations.length, `Unresolved ${token}`).toBeGreaterThan(0)
  const result = Number(token ? declarations[0]![1] : value.replace(/px$/, ''))
  expect(Number.isFinite(result)).toBe(true)
  return result
}

it('renders exact existing state totals on the Folder row and keeps full accessible labels', async () => {
  const states = [['waiting', 2], ['blocked', 1], ['error', 1], ['working', 12], ['running', 3], ['done', 4]] as const
  const sessions = states.flatMap(([state, count]) => Array.from({ length: count }, (_, i) => agent(`${state}-${i}`, state)))
  sessions.push(agent('unrelated', 'working', '/elsewhere'))
  const { container, entry } = await renderFolders(sessions)
  const trigger = entry.querySelector<HTMLButtonElement>('.project-activity')
  expect(trigger).not.toBeNull()
  const metrics = [...trigger!.querySelectorAll('.project-activity__metric')]
  expect(metrics.map(metric => [metric.className, metric.querySelector('strong')?.textContent])).toEqual([
    ['project-activity__metric project-activity__metric--needs-you', '3'],
    ['project-activity__metric project-activity__metric--error', '1']
  ])
  expect(metrics.map(metric => metric.querySelectorAll('svg').length)).toEqual([1, 1])
  const fullCounts = '3 Needs you · 1 Error · 12 Working · 3 Idle · 4 Completed'
  expect(trigger!.getAttribute('aria-label')).toContain(fullCounts)
  expect(trigger!.title).toContain(fullCounts)
  const empty = container.querySelector('[data-workspace-id="empty"]')!.closest('.project-rail-entry')!
  expect(empty.querySelector('.project-activity')).toBeNull()
  expect(useAppStore.getState().sessions).toEqual(sessions)
})

it('removes zero-count decorations when the existing Session projection changes', async () => {
  const session = agent('live', 'working')
  const { entry } = await renderFolders([session])
  expect([...entry.querySelectorAll('.project-activity__metric')].map(metric => metric.className)).toEqual(['project-activity__metric project-activity__metric--working'])
  await act(async () => useAppStore.setState({ sessions: [{ ...session, status: { ...session.status, state: 'waiting' } }] }))
  expect([...entry.querySelectorAll('.project-activity__metric')].map(metric => [metric.className, metric.textContent])).toEqual([['project-activity__metric project-activity__metric--needs-you', '1']])
  await act(async () => useAppStore.setState({ sessions: [] }))
  expect(entry.querySelector('.project-activity')).toBeNull()
})

it('overlaps count and icon in the same grid cell with a tighter inter-status gap', async () => {
  const { entry } = await renderFolders([agent('live', 'working')])
  expect(entry.querySelectorAll('.project-activity__metrics')).toHaveLength(1)
  expect(entry.querySelectorAll('.project-activity__metric > svg')).toHaveLength(1)
  expect(entry.querySelectorAll('.project-activity__metric > strong')).toHaveLength(1)
  const metric = cssRule('.project-activity__metric')
  const icon = cssRule('.project-activity__metric > svg')
  const badge = cssRule('.project-activity__metric > strong')
  expect(declaration(metric, 'display')).toBe('inline-grid')
  expect(declaration(badge, 'grid-area')).toBe(declaration(icon, 'grid-area'))
  expect(declaration(badge, 'align-self')).toBe('start')
  expect(declaration(badge, 'justify-self')).toBe('end')
  expect(declaration(badge, 'font-size')).toBe('var(--fs-micro)')
  expect(declaration(badge, 'min-width')).toBe('1em')
  const gap = px(declaration(cssRule('.project-activity__metrics'), 'gap'))
  const iconWidth = Number(entry.querySelector('.project-activity__metric > svg')?.getAttribute('width'))
  expect(iconWidth).toBeGreaterThan(0)
  expect(gap).toBeLessThan(iconWidth / 3)
  expect(px(declaration(metric, 'min-width'))).toBeLessThan(22)
})
