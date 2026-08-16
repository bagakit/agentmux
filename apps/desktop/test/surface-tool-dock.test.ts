import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { fileManagerName } from '../src/renderer/src/lib/host-platform.js'

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
import { allStyleRules, allStyles } from './helpers/styles.js'
import { SELECTOR_PRESENCE_MAX, SelectorPresence } from '../src/renderer/src/components/SelectorList.js'
import {
  TOOL_DOCK_COLLAPSED_RAIL_MIN_WIDTH,
  TOOL_DOCK_MAX_WIDTH,
  TOOL_DOCK_MIN_WIDTH,
  WORKSPACE_TOOL_IDS,
  clampToolDockWidth,
  contentSlotPresentation,
  getRenderedToolDockWidth,
  getToolDockMinimumWidth,
  resolveExplorerCollapsed,
  resolveWorkspaceTools,
  workspaceAgentGroups
} from '../src/renderer/src/lib/surface-tool-dock.js'

const topicsPanelSource = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceTopicsPanel.tsx', import.meta.url),
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
const branchesPanelSource = readFileSync(
  new URL('../src/renderer/src/components/BranchesPanel.tsx', import.meta.url),
  'utf8'
)
const selectorListSource = readFileSync(
  new URL('../src/renderer/src/components/SelectorList.tsx', import.meta.url),
  'utf8'
)
const surfaceToolDockSource = readFileSync(
  new URL('../src/renderer/src/components/SurfaceToolDock.tsx', import.meta.url),
  'utf8'
)
const stylesSource = allStyles()

// --- AST helpers for the reveal-wording guard ---------------------------------
// 取值再质询，不做「禁止拼法在场」的字符串扫描（[[forbidden-shape-guard-misfires]]）。

/** 系统文件管理器名字集，从 lib 的 SSOT 派生：三态各自的名字，加上各名字里独占的词。 */
function deriveOsFileManagerNames(): string[] {
  const fullNames = (['mac', 'windows', 'other'] as const).map((platform) => fileManagerName(platform))
  const wordCounts = new Map<string, number>()
  for (const name of fullNames) {
    for (const word of name.split(/\s+/)) wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1)
  }
  // 共享词（如 "File" 同属 File Explorer / File Manager）不进禁词集——否则会误伤 "File changed on
  // disk" 这类正当文案。只有各名字独占的词（Finder / Explorer / Manager）与完整短语才是安全的判据。
  const distinctWords = [...wordCounts].filter(([, count]) => count === 1).map(([word]) => word)
  return [...new Set([...fullNames, ...distinctWords])]
}

/** 一段文本里命中的系统文件管理器名字（整词比对，不管引号形态）。 */
function osNamesInText(text: string, names: string[]): string[] {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return names.filter((name) => new RegExp(`\\b${escape(name)}\\b`).test(text))
}

function parseTsx(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function jsxAttribute(opening: ts.JsxOpeningLikeElement, attributeName: string): ts.JsxAttribute | undefined {
  for (const property of opening.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.name.getText(opening.getSourceFile()) === attributeName) {
      return property
    }
  }
  return undefined
}

/** JSX 属性的静态字符串取值（字符串字面量或无插值的模板串）；不是静态字符串时返回 null。 */
function staticJsxAttributeString(element: ts.JsxElement, attributeName: string): string | null {
  const attribute = jsxAttribute(element.openingElement, attributeName)
  if (!attribute?.initializer) return null
  let expression: ts.Node = attribute.initializer
  if (ts.isJsxExpression(expression)) {
    if (!expression.expression) return null
    expression = expression.expression
  }
  if (ts.isStringLiteralLike(expression)) return expression.text
  if (ts.isTemplateExpression(expression)) {
    // 模板串里插值处（如 `${topic.title}`）用空串拼接——判据只关心它写死的那些字里有没有 OS 名字。
    return expression.head.text + expression.templateSpans.map((span) => span.literal.text).join('')
  }
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
  return null
}

function findJsxElementByClassName(source: ts.SourceFile, className: string): ts.JsxElement | undefined {
  let found: ts.JsxElement | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const classAttribute = jsxAttribute(node.openingElement, 'className')
      if (
        classAttribute?.initializer &&
        ts.isStringLiteral(classAttribute.initializer) &&
        classAttribute.initializer.text.split(/\s+/).includes(className)
      ) {
        found = node
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

// --- 行布局的判据 ---------------------------------------------------------------
// 这一族此前钉的是**机制**（`.workspace-topic-entry` 那条三列网格的字面形状），而机制恰好
// 不成立：`leading` 可空，网格按轨道摆放，只来两段时尾部的头像簇被自动摆进 identity 那条
// 轨道，直接压在摘要文字上（#467，实测 overlap=70px）。两条测试的**标题**说的才是要守的
// 性质，它们的正文却在为那份错机制背书——所以判据换成"哪一层定义排布、缺席的那段会不会
// 占位"，而不是任何一条 CSS 字面量。

/**
 * 一条规则的声明体；注释已剥除（一条规则的理由注释会满足判"在不在场"的正则）。
 *
 * 选择器必须**整条相等**，不能只是子串命中。实测过的坑：删掉 selector.css 里那条
 * `.selector-row__leading`，`/\.selector-row__leading\s*\{/` 仍被 source-control.css 的
 * `.branch-row .selector-row__leading` 满足——兄弟规则替被删的规则作了保。
 */
function ruleBody(selector: string): string {
  for (const [, selectors, body] of allStyleRules().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors!.split(',').some((one) => one.trim() === selector)) return body!
  }
  return ''
}

/** 一条规则里某个属性的取值（`display`、`flex` 等）；不在场时空串。 */
function declaration(selector: string, property: string): string {
  return ruleBody(selector).match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim() ?? ''
}

/**
 * `SelectorRow` 直接渲染出的那几个 className（顶层壳 + 它的直接子级）。
 *
 * 判"行的排布归共享层"要拿真实的段名去问，而不是抄一份清单——抄的那份会与组件漂移，
 * 而漂移的方向恰好是让守卫看不见新增的那一段。
 */
function selectorRowSegments(): { shell: string; children: string[] } {
  const source = parseTsx('SelectorList.tsx', selectorListSource)
  let shell: ts.JsxElement | undefined
  const visit = (node: ts.Node): void => {
    if (
      !shell &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'SelectorRow' &&
      node.body
    ) {
      const findShell = (inner: ts.Node): void => {
        if (!shell && ts.isJsxElement(inner)) shell = inner
        if (!shell) ts.forEachChild(inner, findShell)
      }
      ts.forEachChild(node.body, findShell)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  if (!shell) throw new Error('SelectorList.tsx 里找不到 SelectorRow 返回的 JSX 元素——这个读取器要跟着改')
  const shellClass = staticJsxAttributeString(shell, 'className')
  if (!shellClass) {
    // 裸 fragment（`<>…</>`）不是 JsxElement，走不到这里；顶层壳没有静态 className 同样
    // 意味着"行"在 DOM 里没有自己的元素，那么 selector.css 里那条 `.selector-row` 规则
    // 就是死代码——#467 的第一版修法差点这样发货。
    throw new Error('SelectorRow 的顶层壳没有静态 className：行在 DOM 里没有自己的元素')
  }
  const children: string[] = []
  for (const child of shell.children) {
    if (!ts.isJsxElement(child)) continue
    const name = staticJsxAttributeString(child, 'className')
    if (name) children.push(name)
  }
  // 条件渲染的段（`{leading ? <span …/> : null}`）藏在 JsxExpression 里，上面那轮取不到。
  // 它们恰恰是本缺陷的主角——可空的那一段——所以必须一起收进来。
  const collectConditional = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const name = staticJsxAttributeString(node, 'className')
      if (name && !children.includes(name)) children.push(name)
      return
    }
    ts.forEachChild(node, collectConditional)
  }
  for (const child of shell.children) {
    if (ts.isJsxExpression(child) && child.expression) collectConditional(child.expression)
  }
  return { shell: shellClass, children }
}

function findContextMenuItemBySelectHandler(source: ts.SourceFile, handler: string): ts.JsxElement | undefined {
  let found: ts.JsxElement | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source).endsWith('Item')) {
      const onSelect = jsxAttribute(node.openingElement, 'onSelect')
      if (onSelect && jsxSubtreeUsesIdentifier(node.openingElement, handler)) found = node
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

function jsxTextChildren(element: ts.JsxElement): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const trimmed = node.text.trim()
      if (trimmed) out.push(trimmed)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(element, visit)
  return out
}

function jsxSubtreeUsesIdentifier(node: ts.Node, identifier: string): boolean {
  let uses = false
  const visit = (inner: ts.Node): void => {
    if (ts.isIdentifier(inner) && inner.text === identifier) uses = true
    ts.forEachChild(inner, visit)
  }
  visit(node)
  return uses
}
// -----------------------------------------------------------------------------


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

describe('shared surface tool dock resize', () => {
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

  it('collapses the Explorer by default only for Scratch (Topics is its primary view)', () => {
    // 两个方向都断言：单向断言会被把常量写死满足，而这条测试存在的意义就是抓那种写死。
    // Scratch 折叠只看 Topics；Project 展开因为 Branches 是它的次级视图。
    expect(contentSlotPresentation(true).explorerCollapsedByDefault).toBe(true)
    expect(contentSlotPresentation(false).explorerCollapsedByDefault).toBe(false)
  })

  it('resolves the Explorer collapse: explicit override wins, absence falls back to the kind default', () => {
    // 读写复用的那次解析。缺席（override === undefined）必须回落到 kind 默认，**绝不**读成展开——
    // 把它写成 `?? false` 会让默认折叠的 Scratch 又弹回展开，抹掉「按 kind 默认」这一档。
    // 四个方向全断言：缺席 × 两种 kind 默认，加上显式覆盖压过两种默认。单向断言会被写死常量满足。
    expect(resolveExplorerCollapsed(undefined, true)).toBe(true)   // 缺席 → Scratch 默认折叠
    expect(resolveExplorerCollapsed(undefined, false)).toBe(false) // 缺席 → Project 默认展开
    expect(resolveExplorerCollapsed(false, true)).toBe(false)      // 显式展开压过折叠默认
    expect(resolveExplorerCollapsed(true, false)).toBe(true)       // 显式折叠压过展开默认
  })

  it('drives the collapse from one resolved value read and written through the same key', () => {
    // §2.3.1 / 验收：读与写同一个 key、同一次解析。组件把 resolveExplorerCollapsed 的结果算成一个
    // 局部 const，读（渲染哪一支）与写（toggle 取反）都用它，绝不在写入点另算一遍。
    expect(surfaceToolDockSource).toContain(
      'resolveExplorerCollapsed(explorerCollapsedOverride, presentation.explorerCollapsedByDefault)'
    )
    // override 与写入都按 workspace.id 这一个 key，读写不漂移。
    expect(surfaceToolDockSource).toContain('state.explorerCollapsed[workspace.id]')
    expect(surfaceToolDockSource).toContain('setExplorerCollapsed(workspace.id, !collapsed)')
    // chevron 朝向与 aria-expanded 两个方向都跟真实状态：折叠 → 朝右 + aria-expanded=false。
    expect(surfaceToolDockSource).toContain('aria-expanded={!collapsed}')
    expect(surfaceToolDockSource).toMatch(/collapsed \? <ChevronRight size=\{13\} \/> : <ChevronDown size=\{13\} \/>/)
  })

  it('renders no PanelGroup when collapsed so no dead resize handle survives', () => {
    // §2.3.1：折叠态整块交给 workspace-tools-collapsed，不进 PanelGroup——「可拖但无意义的死把手」
    // 因此不可能存在（把手根本没被渲染）。展开态仍走 PanelGroup + 把手。
    const start = surfaceToolDockSource.indexOf('{collapsed ? (')
    const end = surfaceToolDockSource.indexOf('<PanelGroup')
    // 两个锚点都得真的找到。`indexOf` 落空返回 -1 时 `slice(start, -1)` **不是切出空串，而是扩张到
    // 倒数第一个字符**——于是这段扫描会从「只看折叠支」悄悄变成「扫整个文件」，而下面那条
    // `not.toContain('PanelResizeHandle')` 会因为扫到了展开支里的把手而变红……或者更糟，
    // start 落空时整段偏移，断言在错误的范围上恒真。两条前置断言让下一次改名**响**而不是哑。
    expect(start, '找不到折叠分支的起点——判据落空，下面的断言扫的不是这一支').toBeGreaterThan(-1)
    expect(end, '找不到 PanelGroup 止锚——slice 会扩张到文件末尾').toBeGreaterThan(start)
    const collapsedBranch = surfaceToolDockSource.slice(start, end)
    expect(collapsedBranch).toContain('workspace-tools-collapsed')
    expect(collapsedBranch).not.toContain('PanelResizeHandle')
    // 展开支才有把手：折叠支不渲染它，是这条特性的全部意义。
    expect(surfaceToolDockSource).toContain('<PanelResizeHandle className="workspace-tools-resize-handle" />')
  })

  it('把 Topic 目录定位到自家文件面板，而不是打开系统文件管理器', () => {
    expect(topicsPanelSource).toContain('onRevealDirectory(topic.directoryPath)')
    // 图标要表达「聚焦定位」而不是「打开文件夹」——它把自家那棵树滚到这个目录，
    // 不是在系统文件管理器里开一个窗口。
    expect(topicsPanelSource).toContain('title="Reveal in Files"')
    expect(topicsPanelSource).toContain('<Crosshair size={13} />')
    expect(topicsPanelSource).not.toContain('api.files.reveal(workspace.id, topic.directoryPath)')
    expect(fileExplorerSource).toContain('next.add(revealRequest.path)')
    expect(fileExplorerSource).toContain('setSelection(createSingleFileExplorerSelection(revealRequest.path))')
  })

  it('这条内部定位不许借用系统文件管理器的说法（那是三态文案，会在别的平台上说错话）', () => {
    // 原文案是 "Reveal in Explorer"：产品里没有任何界面把那个面板叫 "Explorer"（它叫
    // "Files + Branches"），而 "Explorer" 恰好是 Windows 系统文件管理器的名字——一个内部导航
    // 动作于是看起来像在承诺打开操作系统的窗口。反向的错法同样要挡：把这里改成
    // `revealInFileManagerLabel()` 会在 mac 上显示 "Reveal in Finder"，而它根本不开 Finder。
    //
    // 此前的判据是「禁止三种拼法的字符串不在场」——`'"Reveal in Explorer"'`、`'>Reveal in Explorer<'`、
    // ``'in Explorer`'``。两个 review agent 实测它对真泄漏失明：HEAD 里的 `aria-label={'Reveal in
    // Explorer'}` 是**单引号**、包在 JSX 表达式容器里，三种拼法一个都不匹配，20/20 全绿。把 aria-label
    // 换成 ``Reveal ${topic.title} in Finder`` 同样存活。这是本仓的 [[forbidden-shape-guard-misfires]]：
    // 禁止形状既能被换个拼法绕过，又会误伤讲道理的注释（这两个文件的注释本来就写着那些名字）。
    //
    // 改成**取值再质询**：用 TS parser 找到那个 reveal 控件，取它真正呈现给用户的两处文案
    // （`title` 与 `aria-label`），把每一处按整词比对系统文件管理器的名字集——不管它用单引号、双引号
    // 还是模板串。名字集从 lib 的 SSOT（`fileManagerName`）派生，不手抄，这样 lib 改了名字这里跟着变。
    const OS_FILE_MANAGER_NAMES = deriveOsFileManagerNames()
    // `File Manager` 与 `File Explorer` 共享 "File"，"File" 于是不能单独进禁词集（"File changed on
    // disk" 这类正当文案会误伤）；只有各名字独占的词（Explorer / Finder / Manager）与完整短语才算。
    expect(OS_FILE_MANAGER_NAMES, '派生的禁词集丢了那些独占短词').toEqual(
      expect.arrayContaining(['Finder', 'Explorer', 'Manager', 'File Explorer', 'File Manager'])
    )
    expect(OS_FILE_MANAGER_NAMES, '"File" 被单独禁了，会误伤 "File changed on disk" 这类正当文案')
      .not.toContain('File')

    // SurfaceToolDock 上的图标按钮：className 里含 workspace-topic-reveal。
    const dockButton = findJsxElementByClassName(
      parseTsx('WorkspaceTopicsPanel.tsx', topicsPanelSource),
      'workspace-topic-reveal'
    )
    expect(dockButton, 'SurfaceToolDock 里找不到 reveal 图标按钮——判据落空，下面几条会恒真').not.toBeUndefined()
    const dockTitle = staticJsxAttributeString(dockButton!, 'title')
    const dockAria = staticJsxAttributeString(dockButton!, 'aria-label')
    // 正面钉住两处取值：`title` 原本就有正断言，`aria-label` 从前是个没人钉的空槽——下一个泄漏正是
    // 往那种空槽里去。两处都要**恰好点名**那个内部面板（"Files"），且都不带任何操作系统的名字。
    expect(dockTitle, 'reveal 按钮的 title 不再指向自家 Files 面板').toContain('Files')
    expect(dockAria, 'reveal 按钮的 aria-label 不再指向自家 Files 面板（这个槽从前没人钉，是泄漏最爱去的地方）')
      .toContain('Files')
    expect(osNamesInText(dockTitle ?? '', OS_FILE_MANAGER_NAMES), `reveal 按钮 title 借用了系统文件管理器的说法`).toEqual([])
    expect(osNamesInText(dockAria ?? '', OS_FILE_MANAGER_NAMES), `reveal 按钮 aria-label 借用了系统文件管理器的说法`).toEqual([])
    // 反向的错法：改走 lib 的三态文案（`revealInFileManagerLabel()`）会说 "Reveal in Finder"，
    // 而这个按钮根本不开 Finder。它是个函数调用不是字符串字面量，上面的整词比对看不见它，单独守。
    expect(jsxSubtreeUsesIdentifier(dockButton!, 'revealInFileManagerLabel'),
      'reveal 按钮借用了 lib/host-platform 的三态文案，但它不开系统文件管理器').toBe(false)

    // TopicContextMenu 上的同一个动作：onSelect 走 onReveal 的那个 ContextMenu.Item。
    const menuSource = readFileSync(
      new URL('../src/renderer/src/components/TopicContextMenu.tsx', import.meta.url),
      'utf8'
    )
    const menuItem = findContextMenuItemBySelectHandler(
      parseTsx('TopicContextMenu.tsx', menuSource),
      'onReveal'
    )
    expect(menuItem, 'TopicContextMenu 里找不到 onReveal 菜单项——判据落空').not.toBeUndefined()
    const menuTexts = jsxTextChildren(menuItem!)
    expect(menuTexts.join(' '), 'reveal 菜单项不再指向自家 Files 面板').toContain('Files')
    expect(osNamesInText(menuTexts.join(' '), OS_FILE_MANAGER_NAMES),
      'reveal 菜单项借用了系统文件管理器的说法').toEqual([])
    expect(jsxSubtreeUsesIdentifier(menuItem!, 'revealInFileManagerLabel'),
      'reveal 菜单项借用了 lib/host-platform 的三态文案，但它不开系统文件管理器').toBe(false)

    // 自检：整词比对本身要真能报出这三种拼法的违规，否则上面的 toEqual([]) 是因为谓词永远为空才绿。
    // 用合成源码质询，不往产品代码里种违规（[[forbidden-shape-guard-misfires]] 的做法）。
    for (const spelling of ['"Reveal in Explorer"', "'Reveal in Explorer'", '`Reveal ${x} in Finder`']) {
      const probe = findJsxElementByClassName(
        parseTsx('probe.tsx', `const e = <button className="workspace-topic-reveal" aria-label={${spelling}}></button>`),
        'workspace-topic-reveal'
      )!
      const probeAria = staticJsxAttributeString(probe, 'aria-label') ?? ''
      expect(osNamesInText(probeAria, OS_FILE_MANAGER_NAMES).length, `谓词认不出这个拼法：${spelling}`).toBeGreaterThan(0)
    }
    // 反向自检：干净的自家文案不许被误报，否则这道门会逼人把合法代码改坏。
    expect(osNamesInText('Reveal in Files', OS_FILE_MANAGER_NAMES), '谓词误报了自家 Files 文案').toEqual([])
    expect(osNamesInText('File changed on disk', OS_FILE_MANAGER_NAMES), '谓词把 "File" 当禁词误报了').toEqual([])
  })

  it('keeps exactly one always-visible action on a Topic row', () => {
    // 用户："改名不用给个专门图标, 可以放进 topic 右键菜单"。行上只留最高频的那个动作，
    // 其余进右键菜单——两个常驻图标按钮会一直跟标题抢宽度。
    const topicRow = topicsPanelSource.slice(
      topicsPanelSource.indexOf('<SortableTopicItem'),
      topicsPanelSource.indexOf('</SortableTopicItem>')
    )
    expect(topicRow.match(/className="icon-button workspace-topic-/g)).toHaveLength(1)
    expect(topicRow).toContain('workspace-topic-reveal')
    expect(topicRow).not.toContain('workspace-topic-rename"')
  })

  it('drops the decorative icon from the head of every Topic row', () => {
    // 一列全同的图标不是信息，是宽度开销（密度合同《控件语言》）。行首只在真的有话说时占位——
    // 打开中的 spinner——所以那一段是**条件渲染**的，不是一个常驻的图标槽。
    const topicRow = topicsPanelSource.slice(
      topicsPanelSource.indexOf('className="workspace-topic-entry"'),
      topicsPanelSource.indexOf('</button>', topicsPanelSource.indexOf('className="workspace-topic-entry"'))
    )
    expect(topicRow).not.toContain('<NotebookText')
    expect(topicRow).toContain('<LoaderCircle')
    // 「不占位」必须由布局模型兑现，不能只由 JSX 里的 `? :` 兑现：网格按轨道摆放，一条恒在的
    // 轨道会替缺席的那段留出位子与 gap，标题的左缘于是随 spinner 在不在而跳动。flex 下缺席的
    // 孩子既不占轨道也不产生 gap——这正是这条测试真正要守的性质。
    expect(declaration('.workspace-topic-entry', 'display')).toBe('flex')
    expect(ruleBody('.workspace-topic-entry')).not.toContain('grid-template-columns')
  })

  it('anchors the Agent cluster to the row edge, not to the end of the summary text', () => {
    // 用户："右边的 icon 没有对齐"，以及 #467："agent icon 和文字叠起来了"。两次都指向同一处：
    // 头像簇与 identity 的关系。此前这条判据钉的是"容器自写的三列网格"，而那份机制**不成立**：
    // `leading` 可空，只来两段时簇被自动摆进 identity 那条轨道，直接压在摘要文字上（Electron
    // 实测 overlap=70px，236–420 全宽区间同病）。所以判据换成两件真正承重的事——
    //
    // 一、行的排布只有一处定义，且那一处在共享层。容器各写一份轨道表就是缺陷的温床：两个容器
    //    当时各有一份，Branch 侧靠"恰好总是三个孩子"躲过，不是靠布局正确。
    const segments = selectorRowSegments()
    expect(segments.shell).toBe('selector-row')
    // 壳自己的排布归 selector.css：容器只该管内外边距、背景与状态色。
    expect(declaration('.selector-row', 'display')).toBe('flex')
    for (const container of ['.workspace-topic-entry', '.branch-row']) {
      expect(ruleBody(container), `${container} 不得自写行内轨道表`).not.toContain('grid-template-columns')
    }
    // 二、identity 吃掉剩余宽度、尾部按内容定宽。这一对才让簇的右缘对齐行而不是对齐文字末端：
    //    identity 可伸缩，于是它先让出尾部所需的宽度，剩下的全归自己；尾部不伸不缩。
    expect(declaration('.selector-row__identity', 'flex')).toBe('1 1 auto')
    expect(declaration('.selector-row__identity', 'min-width')).toBe('0')
    expect(declaration('.selector-row__meta', 'flex')).toBe('0 0 auto')
    expect(declaration('.selector-row__meta', 'justify-content')).toBe('flex-end')
    // 每一段都要有人接住——漏一条规则，那段就退回 inline 默认值，min-width:0 也就不在场了。
    for (const name of segments.children) {
      expect(ruleBody(`.${name}`), `${name} 在 selector.css 里没有对应规则`).not.toBe('')
    }
    // 自检：判据必须真的落在"可空的那一段"上。leading 若哪天变成常驻的，这条断言会红，
    // 提醒重新判断上面那套理由还成不成立（#467 的成因就是它可空）。
    expect(segments.children).toContain('selector-row__leading')
    expect(topicsPanelSource).toMatch(/leading=\{pending === topic\.id \?/)
  })

  it('stacks the avatars instead of tiling them, with the rightmost on top', () => {
    // 用户要"会中参与者"那种沉陷效果。叠压是**相邻两枚之间**的关系——写在每一枚上会把整簇
    // 往左推、第一枚越过自己的左缘（这个错误在声明失效期间完全看不出来）。
    const overlap = stylesSource.match(
      /\.selector-presence__slot \+ \.selector-presence__slot\s*\{([^}]*)\}/
    )?.[1] ?? ''
    expect(overlap.length).toBeGreaterThan(0)
    expect(overlap).toMatch(/margin-left:\s*calc\(-1 \* var\(--sp-\d\)\)/)
    // 负值绝不写成 `-var(...)`：那不是合法 CSS，整条声明会被静默丢弃，叠压根本不会发生。
    // 这一族由 stylesheet-organisation.test.ts 全表扫描守住，这里只钉住本条的正确形态。
  })

  it('renames Topic titles inline while keeping stable Topic directories out of generic Rename', () => {
    // 改名移进了右键菜单，但功能不退化：菜单项仍走同一个 beginRename/commitRename。
    expect(topicContextMenuSource).toContain('<span>Rename Topic</span>')
    expect(topicsPanelSource).toContain('onRename={() => beginRename(topic)}')
    expect(topicsPanelSource).toContain('void commitRename(topic)')
    // Escape 取消已经搬进 lib/topic-rename.ts 的按键决策点（那里同时拦下冒泡，
    // 否则空格与方向键会被 dnd-kit 的 KeyboardSensor 吞掉）。这里只断言接线还在，
    // 行为本身由 topic-rename.test.tsx 守。
    expect(topicsPanelSource).toContain('handleTopicRenameKeyDown(event, { cancel: cancelRename })')
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

  it('shares one presentation layer between the Branch bar and the Topic bar', () => {
    // 用户第 5 条：两个 bar "底层是不是可以复用一个可复用组件"。判据不是"看起来一样"，是
    // **真的是同一段代码**——竖切闭合检查：只接一侧就等于抽了个组件却没接上，两处仍会各自漂移
    // （此前正是如此：Branch 侧头像截断到 4 给 +N，Topic 侧无上限铺完；一个 header 用 small
    // 一个用 em）。这条断言两个面板都经同一批共享符号渲染。
    for (const source of [topicsPanelSource, branchesPanelSource]) {
      expect(source).toContain("from './SelectorList'")
      expect(source).toContain('<SelectorListHeader')
      expect(source).toContain('<SelectorRow')
      expect(source).toContain('<SelectorPresence')
    }
    // 反向：两侧都不得再留一份自己的写法。
    expect(branchesPanelSource).not.toContain('branch-row__agents')
    expect(branchesPanelSource).not.toContain('branch-row__identity')
    expect(topicsPanelSource).not.toContain('workspace-topic-agents')
    expect(topicsPanelSource).not.toContain('workspace-topic-title-line')
    // 而那些写法的 CSS 也要一起走，否则死规则会留在表里让人以为还有第二套。
    expect(stylesSource).not.toContain('.branch-row__agents')
    expect(stylesSource).not.toContain('.workspace-topic-title-line')
  })

  it('caps the avatar cluster on both bars with one shared number', () => {
    // 叠压省宽度但不是无限的。Topic 侧此前无上限（直接 map 全量），一个 8 人的 Topic 会把
    // 标题挤没；共享后两侧取同一个上限，超出折成 +N 且全名进 tooltip。
    //
    // 这条**真渲染**而不是扫源码文本。此前它只断言 `SELECTOR_PRESENCE_MAX > 0` 加三条 toContain：
    // 实测把常量从 4 改成 999，`999 > 0` 仍真、三个字符串原样在，29 条全绿——而 8 人 Topic
    // 会全量铺开挤没标题，正是上面这段注释说要防的那个退化。下界断言比 bug 粗，抓不住它。
    //
    // 判据取"超出就得折"这个行为，不给常量钉一个手抄的上界数字（那只是换一处手抄）。名单长度
    // 取注释里说的那个「8 人的 Topic」——它是**需求**，不是实现常量的副本。绝不能写成
    // `SELECTOR_PRESENCE_MAX + 3`：那样常量改成 999 时名单跟着长到 1002，slots 仍等于常量，断言恒真。
    //
    // 四颗变异各自独占红（其余 28 条全绿）：999 → 不折；1 → 折成一枚；组件内改 `max = 3` 而导出
    // 仍是 6 → 常量变摆设；`roster = agents` 改成 `visible` → 折起来的人名从 tooltip 里消失。
    const agents = Array.from({ length: 8 }, (_, index) => ({
      key: `agent-${index}`,
      label: `Agent ${index}`,
      providerId: 'codex' as const,
      state: 'running' as const,
      attention: null
    }))
    const markup = renderToStaticMarkup(createElement(SelectorPresence, { agents }))

    const slots = markup.split('selector-presence__slot').length - 1
    expect(slots, '8 个 Agent 全铺开了——正是注释里说会把标题挤没的那个退化').toBeLessThan(agents.length)
    // 但折完仍要读作"一摞"，不能只剩一枚加个数字——那时 +N 承载了全部信息，叠压本身失去意义。
    expect(slots, '折得只剩一枚，叠压没有意义了').toBeGreaterThan(1)
    // 折起来的枚数要对得上：画 3 枚却说 +9 是另一种坏法。
    expect(markup, '折起来的枚数与 +N 对不上').toContain(`+${agents.length - slots}`)
    // 而导出的那个常量必须**就是**真实上限，不是个摆设：CSS 与另一侧面板都拿它当共享的数，
    // 组件里若另写一个字面量（`slice(0, 4)` 而导出说 6），两处就又漂了。
    expect(slots, '导出的 SELECTOR_PRESENCE_MAX 不是组件真正用的上限').toBe(SELECTOR_PRESENCE_MAX)
    // 折起来的不能就此消失：簇整体的 tooltip 仍报全部名字，包括没画出来的那几个。
    for (const agent of agents) {
      expect(markup, `${agent.label} 被折起来后从名单里消失了`).toContain(agent.label)
    }
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
