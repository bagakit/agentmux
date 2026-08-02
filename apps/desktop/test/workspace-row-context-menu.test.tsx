import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})
// 组件顶层 import 了 store 与 api；本组测试只碰纯函数与源码文本，给它们最小桩以免拉起整套运行时。
vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), { getState: () => ({}) })
}))
vi.mock('../src/renderer/src/lib/api.js', () => ({ api: { files: { reveal: vi.fn() } } }))

import {
  createWorkspaceRowMenuModel,
  type WorkspaceRowMenuEntry
} from '../src/renderer/src/components/WorkspaceRowContextMenu.js'

// 工作区侧栏的 Scratch / Project 行补右键菜单。这组测试守两件事，两侧都判：
//   1. 每一项「该出现时出现 / 不该出现时不出现」——分支名仅 git worktree、reveal/terminal 仅本机、
//      移除仅可移除的行；且每一项点下去真的调到它那一路（不是壳）。
//   2. 渲染层碰不到任何在场判断——在场与顺序全在 entries 数据侧，JSX 只 map，没有可取反的三元。
//
// 与 region-context-menu.test.tsx 同一个教训：Radix Content 默认关闭且在 Portal 里，
// renderToStaticMarkup 渲不出它，"渲出来数菜单项"这条路走不通；所以把在场降成数据来断言。

/** 一次给全字段的桩，用例只覆盖它关心的那几个。 */
function modelFor(overrides: Partial<Parameters<typeof createWorkspaceRowMenuModel>[0]> = {}) {
  return createWorkspaceRowMenuModel({
    path: '/repo',
    branch: null,
    isLocal: true,
    revealLabel: 'Reveal in Finder',
    removable: true,
    copyText: vi.fn(),
    reveal: vi.fn(),
    openTerminal: vi.fn(),
    remove: vi.fn(),
    ...overrides
  })
}

function actionIds(entries: readonly WorkspaceRowMenuEntry[]): string[] {
  return entries.filter((entry) => entry.kind === 'action').map((entry) => (entry.kind === 'action' ? entry.action.id : ''))
}

describe('每一项的 gating——该出现时出现', () => {
  it('本机、有分支、可移除的项目行：五项俱全，移除前恰好一道分隔线', () => {
    const entries = modelFor({ branch: 'feature/x', isLocal: true, removable: true }).entries
    expect(actionIds(entries)).toEqual(['copy-path', 'copy-branch', 'reveal', 'open-terminal', 'remove'])
    const separators = entries.filter((entry) => entry.kind === 'separator')
    expect(separators).toHaveLength(1)
    // 分隔线两侧都得有东西：贴顶或悬底的线是噪音。
    const at = entries.findIndex((entry) => entry.kind === 'separator')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(entries.length - 1)
    // 移除紧跟在分隔线后。
    expect(entries[at + 1]).toEqual({ kind: 'action', action: expect.objectContaining({ id: 'remove' }) })
  })
})

describe('每一项的 gating——不该出现时不出现', () => {
  it('无分支：不画复制分支名', () => {
    // 一个聚合多个 worktree 的 folder 项目没有单一分支——这一项必须缺席，而不是给个复制空串的假按钮。
    expect(actionIds(modelFor({ branch: null }).entries)).not.toContain('copy-branch')
  })

  it('远端主机：不画 reveal 与 open-terminal（两条都只对本机成立）', () => {
    const ids = actionIds(modelFor({ isLocal: false, branch: 'b' }).entries)
    expect(ids).not.toContain('reveal')
    expect(ids).not.toContain('open-terminal')
    // 但复制路径 / 复制分支名与主机无关，仍在。
    expect(ids).toContain('copy-path')
    expect(ids).toContain('copy-branch')
  })

  it('不可移除的行（Scratch）：不画移除，也就没有那道分隔线', () => {
    const entries = modelFor({ removable: false }).entries
    expect(actionIds(entries)).not.toContain('remove')
    expect(entries.some((entry) => entry.kind === 'separator')).toBe(false)
  })

  it('Scratch 的极小形态：本机、无分支、不可移除——只剩复制路径 + reveal + 终端，无分隔线', () => {
    const entries = modelFor({ branch: null, isLocal: true, removable: false }).entries
    expect(actionIds(entries)).toEqual(['copy-path', 'reveal', 'open-terminal'])
    expect(entries.some((entry) => entry.kind === 'separator')).toBe(false)
  })
})

describe('每一项点下去真的调到它那一路（不是壳）', () => {
  it('copy-path 复制 path、copy-branch 复制 branch，各调各的、内容各异', () => {
    const copyText = vi.fn()
    const model = createWorkspaceRowMenuModel({
      path: '/w/repo',
      branch: 'feature/x',
      isLocal: true,
      revealLabel: 'Reveal in Finder',
      removable: true,
      copyText,
      reveal: vi.fn(),
      openTerminal: vi.fn(),
      remove: vi.fn()
    })
    const byId = new Map(
      model.entries.filter((e) => e.kind === 'action').map((e) => (e.kind === 'action' ? [e.action.id, e.action] : ['', e]))
    )
    byId.get('copy-path')!.onSelect()
    expect(copyText).toHaveBeenLastCalledWith('/w/repo')
    byId.get('copy-branch')!.onSelect()
    expect(copyText).toHaveBeenLastCalledWith('feature/x')
    // 复制路径与复制分支名绝不能互为别名：把两项的 onSelect 搞反，上面两条各自锚死的字面量必红。
    expect(copyText).toHaveBeenCalledTimes(2)
  })

  it('reveal / open-terminal / remove 各自触发自己的回调', () => {
    const reveal = vi.fn()
    const openTerminal = vi.fn()
    const remove = vi.fn()
    const model = modelFor({ branch: 'b', reveal, openTerminal, remove })
    const byId = new Map(
      model.entries.filter((e) => e.kind === 'action').map((e) => (e.kind === 'action' ? [e.action.id, e.action] : ['', e]))
    )
    byId.get('reveal')!.onSelect()
    byId.get('open-terminal')!.onSelect()
    byId.get('remove')!.onSelect()
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(openTerminal).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    // 各调各的，没有串线。
    expect(reveal).not.toBe(openTerminal)
  })

  it('reveal 用的是传入的平台文案（Finder / File Explorer / File Manager 那一套）', () => {
    const model = modelFor({ revealLabel: 'Reveal in File Explorer' })
    const reveal = model.entries.find((e) => e.kind === 'action' && e.action.id === 'reveal')
    expect(reveal?.kind === 'action' ? reveal.action.label : '').toBe('Reveal in File Explorer')
  })
})

// ---------------------------------------------------------------------------
// 渲染层碰不到任何在场判断——没有字段可判，就没有条件可取反。
//
// 这才是真正挡住「菜单项静默不渲染」的守卫：若 JSX 退回 `{isLocal ? <Item/> : null}`，一个
// `{false && isLocal ? …}` 就能让 reveal/terminal 对用户彻底消失而源码 grep 照旧命中。渲染只认
// entries，在场与顺序在数据侧决定，而那一侧上面几条真跑得到。
// ---------------------------------------------------------------------------
describe('JSX 里没有可以取反的在场判断', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/components/WorkspaceRowContextMenu.tsx', import.meta.url)),
    'utf8'
  )
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const opens = withoutComments.indexOf('<ContextMenu.Content')
  const closes = withoutComments.indexOf('</ContextMenu.Content>')
  const content = withoutComments.slice(opens, closes)

  it('自检：真的截到了那段 JSX', () => {
    expect(opens).toBeGreaterThan(-1)
    expect(closes).toBeGreaterThan(opens)
    expect(content).toContain('ContextMenu.Item')
  })

  it('画的就是那份清单，不是一串三元表达式', () => {
    expect(content).toContain('model.entries.map(')
  })

  it('渲染层不直接读任何 gating 字段——那些判断只在 entries 数据侧', () => {
    for (const field of ['input.branch', 'input.isLocal', 'input.removable', 'onRemove ?', 'onRemove !==']) {
      expect(content, `${field} 又被渲染层直接读了`).not.toContain(field)
    }
  })
})

// ---------------------------------------------------------------------------
// 复制走的是剪贴板唯一出口——这个壳没有自己直接写剪贴板。
//
// clipboard-copy.test.ts 已用整树扫描守「只有出口碰 api.ui.writeClipboardText」。这里补壳侧另一半：
// 本组件的复制路径确实转发给了出口。两条合起来——壳既不能绕过出口，也不能把转发整个删掉。
// ---------------------------------------------------------------------------
describe('复制转发给剪贴板唯一出口', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/components/WorkspaceRowContextMenu.tsx', import.meta.url)),
    'utf8'
  )
  it('源码里出现了对 copyTextToClipboard 的调用，且没有自己直接写剪贴板', () => {
    expect(source).toContain('copyTextToClipboard(')
    // 直接写剪贴板的 sink 只该在出口里出现，这个壳不该有。
    expect(source).not.toMatch(/api\.ui\.writeClipboardText\b/)
  })
})
