import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRegionCopyModel } from '../src/renderer/src/components/RegionContextMenu.js'
import {
  formatMessagingAddress,
  formatRegionAddress,
  formatSessionAddress
} from '../src/renderer/src/lib/agent-address.js'

// Region 右键菜单存在的理由：分屏承载多个 Agent 时，你想寻址的那一格往往恰恰不是当前聚焦的
// 那一格。点哪格就是哪格，不推断焦点——这是 Tab 菜单做不到的事。

describe('Region 右键菜单：点哪格就是哪格', () => {
  it('承载 Agent 的 Region 同时给出 Region 地址与 Session 地址', async () => {
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const model = createRegionCopyModel({
      regionId: 'region:pane-2',
      agentSessionId: 'agent-7',
      writeClipboardText
    })

    expect(model.regionAddress.label).toBe('Copy Region Address')
    expect(model.sessionAddress?.label).toBe('Copy Session Address')

    await model.regionAddress.onSelect()
    // 内容来自唯一 formatter，组件不自己拼字符串。
    expect(writeClipboardText).toHaveBeenCalledWith(formatRegionAddress('region:pane-2'))

    await model.sessionAddress?.onSelect()
    expect(writeClipboardText).toHaveBeenCalledWith(formatSessionAddress('agent-7'))
  })

  it('寻址的是被点的那一格，与当前聚焦哪一格无关', async () => {
    const writeClipboardText = vi.fn(async (_text: string) => {})
    // 聚焦在 pane-1，但用户右键的是 pane-9。
    const model = createRegionCopyModel({
      regionId: 'region:pane-9',
      agentSessionId: null,
      writeClipboardText
    })

    await model.regionAddress.onSelect()
    const copied = writeClipboardText.mock.calls[0]![0]
    expect(copied).toContain('region:pane-9')
    expect(copied).not.toContain('pane-1')
  })

  it('承载 Agent 的一格给出交接入口，复制的是那一格的 Region 地址', async () => {
    // 交接是这个菜单的主要意图。点击发生在某一格上，我们知道是哪一格而接收方不知道，
    // 所以它解析成 Region 而非 Session——把消歧做在源头。
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const model = createRegionCopyModel({
      regionId: 'region:pane-2',
      agentSessionId: 'agent-7',
      writeClipboardText
    })
    expect(model.handoff?.label).toBe('Message this Agent')
    await model.handoff?.onSelect()
    expect(writeClipboardText).toHaveBeenCalledWith(formatMessagingAddress({
      agentSessionId: 'agent-7',
      regionId: 'region:pane-2'
    }))
    // 退化成 Session 地址会丢掉"是哪一格"，那正是这个入口要保住的信息。
    expect(writeClipboardText).not.toHaveBeenCalledWith(formatSessionAddress('agent-7'))
  })

  it('非 Agent 的 Region 不提供 Session 地址——缺席表达，不画禁用的假按钮', () => {
    const model = createRegionCopyModel({
      regionId: 'region:a-file',
      agentSessionId: null,
      writeClipboardText: vi.fn(async () => {})
    })
    // 一格文件/浏览器/launcher 没有 Agent 语义身份可寻址。
    expect(model.sessionAddress).toBeUndefined()
    // 没有 Agent 就没有可交接的对象，交接入口同样缺席。
    expect(model.handoff).toBeUndefined()
    // 但它仍然是一格，Region 地址照样有意义（inspect 得到它显示什么）。
    expect(model.regionAddress).toBeDefined()
  })

  it('复制失败不炸掉菜单', async () => {
    const writeClipboardText = vi.fn(async () => { throw new Error('clipboard denied') })
    const model = createRegionCopyModel({
      regionId: 'region:x',
      agentSessionId: null,
      writeClipboardText
    })
    await expect(model.regionAddress.onSelect()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 画出来的那份清单。
//
// 此前"用户点得到"这件事只由 `readFileSync` + `toContain('model.handoff.onSelect')` 守。把 JSX
// 的条件改成 `{false && model.handoff ? (`——「Message this Agent」与它的分隔符**永不渲染**，
// 那条能力对用户根本不存在——而被 grep 的字面量在 `false &&` 之后原样都在，34 条全绿（实测）。
// Radix 的 Content 默认关闭且在 Portal 里，`renderToStaticMarkup` 渲不出它，所以"真挂载点一下"
// 这条路走不通；于是把在场与顺序降成 `entries` 数据，让它跑得到、断言得着。
// ---------------------------------------------------------------------------
describe('菜单画哪几项、什么顺序', () => {
  function entriesFor(agentSessionId: string | null) {
    return createRegionCopyModel({
      regionId: 'region:pane-2',
      agentSessionId,
      writeClipboardText: vi.fn(async () => {})
    }).entries
  }

  it('承载 Agent 时交接排第一——那是用户来这个菜单的主要意图', () => {
    const first = entriesFor('agent-7')[0]
    expect(first?.kind).toBe('action')
    // 只断言"handoff 在清单里"会放过它排到末尾；位置本身就是这个设计决定。
    expect(first?.kind === 'action' ? first.action.label : undefined).toBe('Message this Agent')
  })

  it('清单不多不少，就是在场的那些动作', () => {
    // `entries` 是从三个字段派生出来的，所以这条守的是派生关系本身：漏一项（用户点不到）
    // 和多一项（画出个空动作）都红。
    const labels = entriesFor('agent-7')
      .filter((entry) => entry.kind === 'action')
      .map((entry) => (entry.kind === 'action' ? entry.action.label : ''))
    expect(labels).toEqual([
      'Message this Agent',
      'Copy Region Address',
      'Copy Session Address'
    ])
    expect(
      entriesFor(null)
        .filter((entry) => entry.kind === 'action')
        .map((entry) => (entry.kind === 'action' ? entry.action.label : ''))
    ).toEqual(['Copy Region Address'])
  })

  it('分隔线恰好一道，且真的隔着两组东西', () => {
    const entries = entriesFor('agent-7')
    const separators = entries.filter((entry) => entry.kind === 'separator')
    expect(separators).toHaveLength(1)
    // 贴在顶上或悬在底下的线是噪音——它必须两侧都有东西。
    const at = entries.findIndex((entry) => entry.kind === 'separator')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(entries.length - 1)
  })

  it('没有交接可做时不画那道线', () => {
    // 只有一组东西，线没有可隔的对象。
    expect(entriesFor(null).some((entry) => entry.kind === 'separator')).toBe(false)
  })

  it('清单里每一项都真的点得动，且复制的内容与那个字段一致', async () => {
    // 派生出来的可能是个壳：label 对、onSelect 是另一项的（或者干脆是空函数）。
    // 所以逐项点一遍，看剪贴板收到什么。
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const model = createRegionCopyModel({
      regionId: 'region:pane-2',
      agentSessionId: 'agent-7',
      writeClipboardText
    })
    const expected = new Map<string, string>([
      ['Message this Agent', formatMessagingAddress({ agentSessionId: 'agent-7', regionId: 'region:pane-2' })],
      ['Copy Region Address', formatRegionAddress('region:pane-2')],
      ['Copy Session Address', formatSessionAddress('agent-7')]
    ])

    let clicked = 0
    for (const entry of model.entries) {
      if (entry.kind !== 'action') continue
      writeClipboardText.mockClear()
      await entry.action.onSelect()
      expect(writeClipboardText, `${entry.action.label} 点下去什么都没发生`).toHaveBeenCalledWith(
        expected.get(entry.action.label)
      )
      clicked += 1
    }
    // 扫描式断言要自证扫到了东西：空清单的 for 循环永远是绿的。
    expect(clicked).toBe(expected.size)
  })
})

describe('JSX 里没有可以取反的在场判断', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/RegionContextMenu.tsx', import.meta.url),
    'utf8'
  )
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const opens = withoutComments.indexOf('<ContextMenu.Content')
  const closes = withoutComments.indexOf('</ContextMenu.Content>')
  const content = withoutComments.slice(opens, closes)

  it('自检：真的截到了那段 JSX', () => {
    // 截空了的话，下面几条 not.toContain 会以最难发现的方式恒绿。
    expect(opens).toBeGreaterThan(-1)
    expect(closes).toBeGreaterThan(opens)
    expect(content).toContain('ContextMenu.Item')
  })

  it('画的就是那份清单，不是一串三元表达式', () => {
    expect(content).toContain('model.entries.map(')
  })

  it('渲染层碰不到那几个可选字段——没有字段可判，也就没有条件可取反', () => {
    // 这才是真正的守卫：`{model.handoff ? (` 这种写法一旦回来，`{false && model.handoff ? (`
    // 就又能在全绿之下把那一项从界面上抹掉。渲染只认 entries，在场与顺序在数据侧决定，
    // 而那一侧上面几条真跑得到。
    for (const field of ['model.handoff', 'model.sessionAddress']) {
      expect(content, `${field} 又被渲染层直接读了`).not.toContain(field)
    }
  })
})
