// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSourceFile, isImportDeclaration, isNamedImports, ScriptTarget } from 'typescript'
import { createWorkspaceLayout } from '@agentmux/layout'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MoteIcon } from '../src/renderer/src/components/MoteIcon'
import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree'
import { SpaceCreateMenu } from '../src/renderer/src/components/SpaceCreateMenu'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { TopicPresence } from '../src/renderer/src/components/TopicPresence'
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { SemanticIcon } from '../src/renderer/src/components/semantic-icons'
import { QuickSwitcher } from '../src/renderer/src/components/QuickSwitcher'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'

const initial = useAppStore.getState()
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: '/topics', kind: 'folder' as const }
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})

function renderedMote(size: number): SVGSVGElement {
  const node = document.createElement('div')
  node.innerHTML = renderToStaticMarkup(createElement(MoteIcon, { size }))
  const svg = node.querySelector('svg')
  expect(svg).not.toBeNull()
  return svg!
}

describe('Mote vector identity', () => {
  it('uses the same solid, carved silhouette at small sizes without decorative effects', () => {
    const paths = [12, 16, 24].map((size) => {
      const svg = renderedMote(size)
      expect(svg.getAttribute('width')).toBe(String(size))
      expect(svg.getAttribute('height')).toBe(String(size))
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
      expect(svg.getAttribute('fill')).toBe('currentColor')
      expect(svg.getAttribute('stroke')).toBe('none')
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.querySelectorAll('path')).toHaveLength(1)
      const path = svg.querySelector('path')!
      expect(path.getAttribute('fill-rule')).toBe('evenodd')
      const d = path.getAttribute('d')!
      expect(d.length).toBeGreaterThan(100)
      expect(d.match(/[Mm]/gu)).toHaveLength(2)
      expect(svg.querySelector('filter, linearGradient, radialGradient, animate, image')).toBeNull()
      return d
    })
    expect(paths).toHaveLength(3)
    expect(new Set(paths).size).toBe(1)
  })

  it('mounts that mark in the real Mote tree row and the open creation menu', async () => {
    vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
    useAppStore.setState({ layouts: {}, tabs: {}, collapsedProjectGroups: {}, pinnedItems: {} })
    await act(async () => root.render(<><SpaceTopicsTree workspace={workspace} icons={{}} onChangeIcon={() => {}} /><SpaceCreateMenu onOpenFolder={async () => {}} /></>))
    const tree = container.querySelector('[aria-label="Open Mote"] svg')
    expect(tree).not.toBeNull()
    const contour = renderedMote(14).querySelector('path')!.getAttribute('d')
    expect(tree?.querySelector('path')?.getAttribute('d')).toBe(contour)
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add Space"]')!
    expect(trigger).not.toBeNull()
    await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })) })
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['Open Folder As a Project', 'Create Another Topic', 'Create Mote'])
    const creation = items.find((item) => item.textContent === 'Create Mote')!
    expect(creation.querySelector('svg path')?.getAttribute('d')).toBe(contour)
  })

  it('keeps the spark badge data and official Provider asset while changing its glyph', () => {
    const node = document.createElement('div')
    node.innerHTML = renderToStaticMarkup(<AgentAvatar providerId="codex" appearance={{ badge: 'spark' }} size={24} />)
    expect(node.querySelector('[data-agent-provider="codex"]')).not.toBeNull()
    const badge = node.querySelector('[data-avatar-badge="spark"]')
    expect(badge).not.toBeNull()
    expect(badge?.querySelector('path')?.getAttribute('d')).toBe(renderedMote(8).querySelector('path')!.getAttribute('d'))
    expect(badge?.querySelector('svg')?.getAttribute('width')).toBe('6')
  })

  it('renders creation, skill and permissions as separate meanings in real consumers', async () => {
    const launcher = renderToStaticMarkup(<TopicPresence agents={[]} tabs={[{
      tabId: 'new-tab', title: 'New Tab', active: true,
      regions: [{ regionId: 'new-region', surfaceKind: 'launcher', bounds: { x: 0, y: 0, width: 1, height: 1 }, executorLabel: '', activity: '' }]
    }]} />)
    expect(launcher).toContain('lucide-panels-top-left')
    expect(renderToStaticMarkup(<SemanticIcon name="skill" />)).toContain('lucide-puzzle')
    const config = await api.config.get()
    await act(async () => root.render(<AgentSettingsPane config={config} onSave={async () => {}} />))
    const actions = [...container.querySelectorAll('button')].filter((button) => button.textContent?.includes('Enable YOLO'))
    expect(actions.length).toBeGreaterThan(0)
    for (const button of actions) expect(button.querySelector('.lucide-shield-off')).not.toBeNull()
    const tab = createWorkbenchTab('new-tab', { regionId: 'new-region', kind: 'launcher', workspaceId: workspace.id })
    useAppStore.setState({ config: { ...config, workspaces: [workspace] }, sessions: [],
      tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('main', [tab.id]) } })
    await act(async () => root.render(<QuickSwitcher open onClose={() => {}} />))
    expect(document.querySelectorAll('.quick-switch__row')).toHaveLength(1)
    expect(document.querySelector('.quick-switch__row .lucide-panels-top-left')).not.toBeNull()
  })

  it('scans a nonempty production source set for starburst imports and real mark callers', () => {
    const sourceRoot = fileURLToPath(new NodeURL('../src/', import.meta.url))
    const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
    expect(files.length).toBeGreaterThan(0)
    const imports: string[] = []
    const forbidden: string[] = []
    const callers: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const syntax = createSourceFile(file, source, ScriptTarget.Latest)
      for (const statement of syntax.statements) {
        if (!isImportDeclaration(statement) || statement.moduleSpecifier.getText(syntax).replace(/['"]/gu, '') !== 'lucide-react') continue
        const bindings = statement.importClause?.namedBindings
        if (!bindings || !isNamedImports(bindings)) continue
        for (const specifier of bindings.elements) {
          const name = (specifier.propertyName ?? specifier.name).text
          imports.push(`${file}:${name}`)
          if (/^(?:Sparkles|WandSparkles)$/u.test(name)) forbidden.push(`${file}:${name}`)
        }
      }
      if (!file.endsWith('/MoteIcon.tsx') && /<MoteIcon\b|spark:\s*MoteIcon\b/u.test(source)) callers.push(file)
    }
    expect(imports.length).toBeGreaterThan(0)
    expect(forbidden).toEqual([])
    expect(callers.length).toBeGreaterThan(0)
  })
})
