import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { canRenameFileExplorerNode } from '../src/renderer/src/components/FileExplorer.js'
import {
  clampSidebarResizeWidth,
  getNextSidebarResizeDraftWidth,
  getNextSidebarResizeWidth,
  getRenderedSidebarWidthCssValue
} from '../src/renderer/src/hooks/useSidebarResize.js'
import { allStyles } from './helpers/styles.js'
import {
  TOOL_DOCK_COLLAPSED_RAIL_MIN_WIDTH,
  TOOL_DOCK_MAX_WIDTH,
  TOOL_DOCK_MIN_WIDTH,
  WORKSPACE_TOOL_IDS,
  clampToolDockWidth,
  contentSlotPresentation,
  getRenderedToolDockWidth,
  getToolDockMinimumWidth,
  resolveWorkspaceTools,
  workspaceAgentGroups
} from '../src/renderer/src/lib/surface-tool-dock.js'

const surfaceToolDockSource = readFileSync(
  new URL('../src/renderer/src/components/SurfaceToolDock.tsx', import.meta.url),
  'utf8'
)
const fileExplorerSource = readFileSync(
  new URL('../src/renderer/src/components/FileExplorer.tsx', import.meta.url),
  'utf8'
)
const topicContextMenuSource = readFileSync(
  new URL('../src/renderer/src/components/TopicContextMenu.tsx', import.meta.url),
  'utf8'
)
const stylesSource = allStyles()

const workspace: WorkspaceRecord = {
  id: 'workspace',
  name: 'repo',
  hostId: 'local',
  path: '/repo',
  kind: 'folder'
}

function session(input: {
  id: string
  kind?: SessionSnapshot['kind']
  workspacePath?: string
  hostId?: string
  state?: SessionSnapshot['status']['state']
  updatedAt?: number
}): SessionSnapshot {
  const kind = input.kind ?? 'agent'
  const common = {
    id: input.id,
    hostId: input.hostId ?? 'local',
    workspacePath: input.workspacePath ?? '/repo',
    label: input.id,
    createdAt: 1,
    updatedAt: input.updatedAt ?? 1,
    processState: input.state === 'exited' ? 'exited' : 'running',
    status: {
      state: input.state ?? 'working',
      source: 'native-hook',
      observedAt: input.updatedAt ?? 1
    },
    latestOutputBytes: 0
  } as const
  return kind === 'agent'
    ? {
        ...common,
        kind: 'agent',
        providerId: 'codex',
        executorId: 'codex',
        control: {} as Extract<SessionSnapshot, { kind: 'agent' }>['control']
      }
    : {
        ...common,
        kind: 'terminal',
        providerId: null,
        control: {} as Extract<SessionSnapshot, { kind: 'terminal' }>['control']
      }
}

describe('Orca-adapted shared surface tool dock resize', () => {
  it('keeps Files, Agents and Browser as the three distinct Workspace tools', () => {
    expect(WORKSPACE_TOOL_IDS).toEqual(['files-branches', 'agents', 'browser-tools'])
  })

  it('keeps every tool for Scratch and lands on the content slot (wiki-first, not Agents)', () => {
    // Scratch is a wiki-first workspace with real topic/outcome/refs/.agents content, so the
    // content slot is meaningful — it is re-skinned as Files + Topics, not dropped.
    const scratch = resolveWorkspaceTools({ workspaceTool: 'files-branches', isScratch: true })
    expect(scratch.tools).toEqual(WORKSPACE_TOOL_IDS)
    expect(scratch.effective).toBe('files-branches')
  })

  it('keeps a Scratch selection that is still valid instead of forcing the content slot', () => {
    const scratch = resolveWorkspaceTools({ workspaceTool: 'browser-tools', isScratch: true })
    expect(scratch.tools).toEqual(WORKSPACE_TOOL_IDS)
    expect(scratch.effective).toBe('browser-tools')
  })

  it('leaves a real project with every tool and its stored selection intact', () => {
    const project = resolveWorkspaceTools({ workspaceTool: 'files-branches', isScratch: false })
    expect(project.tools).toEqual(WORKSPACE_TOOL_IDS)
    expect(project.effective).toBe('files-branches')
  })

  it('re-skins the content slot as Files + Topics only for Scratch, Topics taking the larger split', () => {
    const project = contentSlotPresentation(false)
    expect(project.label).toBe('Files + Branches')
    expect(project.showTopics).toBe(false)
    // Real projects keep the original 68/32 split unchanged.
    expect(project.fileTreeDefaultSize).toBe(68)
    expect(project.fileTreeMinSize).toBe(34)

    const scratch = contentSlotPresentation(true)
    expect(scratch.label).toBe('Files + Topics')
    expect(scratch.showTopics).toBe(true)
    // Wiki-first: the topic view is primary, so the file tree takes the smaller half.
    expect(scratch.fileTreeDefaultSize).toBe(38)
    expect(scratch.fileTreeMinSize).toBe(20)
    expect(scratch.fileTreeDefaultSize).toBeLessThan(50)
    expect(scratch.fileTreeDefaultSize).toBeLessThan(project.fileTreeDefaultSize)
  })

  it('reveals a Topic directory inside the built-in Explorer instead of Finder', () => {
    expect(surfaceToolDockSource).toContain('onRevealDirectory(topic.directoryPath)')
    // 图标要表达「聚焦定位」而不是「打开文件夹」——它把 Explorer 定位到这个目录，
    // 不是在 Finder 里开一个窗口。
    expect(surfaceToolDockSource).toContain('title="Reveal in Explorer"')
    expect(surfaceToolDockSource).toContain('<Crosshair size={13} />')
    expect(surfaceToolDockSource).not.toContain('api.files.reveal(workspace.id, topic.directoryPath)')
    expect(fileExplorerSource).toContain('next.add(revealRequest.path)')
    expect(fileExplorerSource).toContain('setSelection(createSingleFileExplorerSelection(revealRequest.path))')
  })

  it('keeps exactly one always-visible action on a Topic row', () => {
    // 用户："改名不用给个专门图标, 可以放进 topic 右键菜单"。行上只留最高频的那个动作，
    // 其余进右键菜单——两个常驻图标按钮会一直跟标题抢宽度。
    const topicRow = surfaceToolDockSource.slice(
      surfaceToolDockSource.indexOf('<SortableTopicItem'),
      surfaceToolDockSource.indexOf('</SortableTopicItem>')
    )
    expect(topicRow.match(/className="icon-button workspace-topic-/g)).toHaveLength(1)
    expect(topicRow).toContain('workspace-topic-reveal')
    expect(topicRow).not.toContain('workspace-topic-rename"')
  })

  it('drops the decorative icon from the head of every Topic row', () => {
    // 一列全同的图标不是信息，是宽度开销（密度合同《控件语言》）。行首只在真的有话说时占位——
    // 打开中的 spinner——所以网格用 auto 列，而不是留一个常驻的图标槽。
    const topicRow = surfaceToolDockSource.slice(
      surfaceToolDockSource.indexOf('className="workspace-topic-entry"'),
      surfaceToolDockSource.indexOf('</button>', surfaceToolDockSource.indexOf('className="workspace-topic-entry"'))
    )
    expect(topicRow).not.toContain('<NotebookText')
    expect(topicRow).toContain('<LoaderCircle')
    expect(stylesSource).toContain(
      '.workspace-topic-entry { min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr);'
    )
  })

  it('renames Topic titles inline while keeping stable Topic directories out of generic Rename', () => {
    // 改名移进了右键菜单，但功能不退化：菜单项仍走同一个 beginRename/commitRename。
    expect(topicContextMenuSource).toContain('<span>Rename Topic</span>')
    expect(surfaceToolDockSource).toContain('onRename={() => beginRename(topic)}')
    expect(surfaceToolDockSource).toContain('void commitRename(topic)')
    // Escape 取消已经搬进 lib/topic-rename.ts 的按键决策点（那里同时拦下冒泡，
    // 否则空格与方向键会被 dnd-kit 的 KeyboardSensor 吞掉）。这里只断言接线还在，
    // 行为本身由 topic-rename.test.tsx 守。
    expect(surfaceToolDockSource).toContain('handleTopicRenameKeyDown(event, { cancel: cancelRename })')
    expect(fileExplorerSource).toContain('scratchTopicIdFromDirectoryName(node.path) !== null')
    expect(fileExplorerSource).toContain('canRename={canRenameFileExplorerNode(workspaceId, node)}')
    const topicDirectory = {
      name: 'topic--view--stable',
      path: 'topic--view--stable',
      relativePath: 'topic--view--stable',
      isDirectory: true,
      isSymlink: false,
      depth: 0
    }
    expect(canRenameFileExplorerNode('__scratch__', topicDirectory)).toBe(false)
    expect(canRenameFileExplorerNode('project', topicDirectory)).toBe(true)
    expect(canRenameFileExplorerNode('__scratch__', { ...topicDirectory, name: 'ordinary', path: 'ordinary' })).toBe(true)
    expect(canRenameFileExplorerNode('__scratch__', { ...topicDirectory, path: `nested/${topicDirectory.path}` })).toBe(true)
  })

  it('projects only the current Workspace Agents through the Board status groups', () => {
    const groups = workspaceAgentGroups([
      session({ id: 'working-old', updatedAt: 10 }),
      session({ id: 'working-new', updatedAt: 30 }),
      session({ id: 'blocked', state: 'blocked', updatedAt: 20 }),
      session({ id: 'finished', state: 'exited', updatedAt: 40 }),
      session({ id: 'raw-terminal', kind: 'terminal', updatedAt: 50 }),
      session({ id: 'other-workspace', workspacePath: '/other', updatedAt: 60 }),
      session({ id: 'other-host', hostId: 'studio', updatedAt: 70 })
    ], workspace)

    expect(groups.map((group) => [group.id, group.sessions.map((item) => item.id)])).toEqual([
      ['working', ['working-new', 'working-old']],
      ['needs-you', ['blocked']],
      ['recent', ['finished']]
    ])
  })

  it('clamps the persisted panel width to the density budget', () => {
    expect(clampToolDockWidth(120)).toBe(TOOL_DOCK_MIN_WIDTH)
    expect(clampToolDockWidth(318)).toBe(318)
    expect(clampToolDockWidth(900)).toBe(TOOL_DOCK_MAX_WIDTH)
  })

  it('moves a left-side dock with the pointer and respects both limits', () => {
    expect(getNextSidebarResizeWidth({
      clientX: 340,
      startX: 300,
      startWidth: 300,
      deltaSign: 1,
      minWidth: 236,
      maxWidth: 440
    })).toBe(340)
    expect(getNextSidebarResizeWidth({
      clientX: 40,
      startX: 300,
      startWidth: 300,
      deltaSign: 1,
      minWidth: 236,
      maxWidth: 440
    })).toBe(236)
    expect(clampSidebarResizeWidth(900, 236, 440)).toBe(440)
  })

  it('collapses without keeping an invisible interactive width', () => {
    expect(getRenderedSidebarWidthCssValue(true, 300, 0)).toBe('300px')
    expect(getRenderedSidebarWidthCssValue(false, 300, 0)).toBe('0px')
  })

  it('contains compact window chrome and all workspace tools when the project rail is closed', () => {
    expect(getToolDockMinimumWidth(true)).toBe(TOOL_DOCK_MIN_WIDTH)
    expect(getToolDockMinimumWidth(false)).toBe(TOOL_DOCK_COLLAPSED_RAIL_MIN_WIDTH)
    expect(getRenderedToolDockWidth(TOOL_DOCK_MIN_WIDTH, false)).toBe(274)
    expect(getRenderedSidebarWidthCssValue(
      true,
      TOOL_DOCK_MIN_WIDTH,
      0,
      TOOL_DOCK_COLLAPSED_RAIL_MIN_WIDTH,
      TOOL_DOCK_MAX_WIDTH
    )).toBe('274px')
  })

  it('keeps the stored width while a closed project rail only raises the rendered floor', () => {
    const storedWidth = TOOL_DOCK_MIN_WIDTH
    expect(getRenderedToolDockWidth(storedWidth, false)).toBe(274)
    expect(getRenderedToolDockWidth(storedWidth, true)).toBe(storedWidth)
    expect(getNextSidebarResizeDraftWidth({
      clientX: 274,
      startX: 274,
      storedStartWidth: storedWidth,
      renderedStartWidth: 274,
      deltaSign: 1,
      minWidth: 274,
      maxWidth: 440
    })).toBe(storedWidth)
    expect(getNextSidebarResizeDraftWidth({
      clientX: 290,
      startX: 274,
      storedStartWidth: storedWidth,
      renderedStartWidth: 274,
      deltaSign: 1,
      minWidth: 274,
      maxWidth: 440
    })).toBe(290)
  })
})
