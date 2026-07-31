import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Ruler } from '../src/renderer/src/components/ActivityView.js'
import { createRulerScale } from '../src/renderer/src/lib/activity-ruler.js'
import type { AgentTimelineItem } from '../src/shared/contracts.js'
import { ConversationAxis } from '../src/renderer/src/components/ConversationAxis.js'
import { speaksAsHuman } from '../src/renderer/src/lib/conversation-axis.js'
import type { ConversationAxisMark } from '../src/renderer/src/lib/conversation-axis.js'
import type { ConversationSpeaker } from '../src/renderer/src/lib/conversation-speaker.js'

/**
 * 轴标记的原话面板：出口接线的验收。
 *
 * **不用 `renderToStaticMarkup`**。这一条是从本仓的一次真实假绿学来的：react-dom/server 不跑 effect、
 * 也不输出任何 handler，实测把 `onClick` 整行删掉，标记流上的 35 条断言全绿、typecheck 也不报
 * （未开 noUnusedLocals）。而这个 task 交付的**全部**是 handler：hover/focus 出面板、离开/失焦/Escape
 * 关面板。所以这里把组件当函数求值，从 element 树上取到那些 handler 并真的调用它们——无需 DOM，也
 * 不引入新依赖。
 *
 * 分工：引文取值本身由 conversation-quote.test.ts 在纯函数层钉住（那条性质在无 DOM 处可判）；这里
 * 只钉**接线**：四个事件收敛到一对出口、交出去的是标记矩形而不是指针、Escape 的吞与不吞。
 */
function item(overrides: Partial<AgentTimelineItem>): AgentTimelineItem {
  return {
    id: 'item-1',
    agentSessionId: 'agent-1',
    kind: 'user_message',
    status: 'complete',
    source: 'user',
    createdAt: 1_000,
    updatedAt: 1_000,
    title: 'Event',
    ...overrides
  }
}

function fixture(): AgentTimelineItem[] {
  return [
    item({ id: 'u1', createdAt: 0, content: '第一句问' }),
    item({ id: 't1', kind: 'tool_call', source: 'native-hook', createdAt: 250 }),
    item({ id: 'a1', kind: 'assistant_message', source: 'native-hook', createdAt: 1_000, content: 'Agent 的答' }),
    item({ id: 'u2', createdAt: 4_000, content: '第二句问' })
  ]
}

const describeSpeaker = (speaker: ConversationSpeaker): { name: string } =>
  speaker.role === 'human' ? { name: 'You' } : { name: 'Claude' }

type Peek = { rect: DOMRect; mark: ConversationAxisMark; name: string }

/** 标记的矩形。`getBoundingClientRect` 在无 DOM 下不存在，所以按每枚标记喂一个可辨别的假矩形。 */
function rectFor(index: number): DOMRect {
  const left = 100 + index * 50
  return {
    left,
    top: 200,
    width: 24,
    height: 24,
    right: left + 24,
    bottom: 224,
    x: left,
    y: 200,
    toJSON: () => ({})
  } as DOMRect
}

/**
 * 把轴当函数求值，取出每枚标记的 handler 集合。
 *
 * `currentTarget` 只喂 `getBoundingClientRect`——组件只用这一个，喂一整个 HTMLButtonElement 的假货
 * 会让这个 helper 变成一份需要跟着 DOM 演进的模拟实现。
 */
function axisMarks(
  props: Partial<Parameters<typeof ConversationAxis>[0]> = {}
): {
  handlers: Record<string, (event?: unknown) => unknown>
  index: number
}[] {
  const axis = ConversationAxis({
    items: fixture(),
    belongs: speaksAsHuman,
    label: 'Speakers',
    size: 16,
    describe: describeSpeaker,
    selectedIndex: null,
    onSelect: () => {},
    ...props
  } as Parameters<typeof ConversationAxis>[0])
  const marks = (axis as ReactElement<{ children: ReactElement[] }>).props.children
  return marks.map((mark, i) => {
    const button = (mark.type as (p: unknown) => ReactElement<Record<string, never>>)(mark.props)
    return { handlers: button.props as unknown as Record<string, (event?: unknown) => unknown>, index: i }
  })
}

describe('轴标记的原话面板', () => {
  it('hover 与 focus 走同一个出口——不是两条各自维护的通路', () => {
    // 触屏上没有 hover、键盘上没有指针。若两者各写一份，移动端与键盘就成了两套实现，而设计要的是
    // 「不存在只能靠鼠标 hover 才能获得的信息」。判据不是"两个 handler 都存在"（那种断言对"两个各
    // 自实现、行为已经漂了"完全失明），而是**两者是同一个函数引用**。
    const [first] = axisMarks({ onPeek: () => {}, onPeekEnd: () => false })
    expect(first!.handlers.onPointerEnter).toBeTypeOf('function')
    expect(first!.handlers.onPointerEnter).toBe(first!.handlers.onFocus)
  })

  it('hover 一枚标记就交出它的矩形与身份——面板据此锚定', () => {
    const seen: Peek[] = []
    const marks = axisMarks({ onPeek: (peek: Peek) => seen.push(peek), onPeekEnd: () => false })
    expect(marks).toHaveLength(2)
    marks[0]!.handlers.onPointerEnter!({ currentTarget: { getBoundingClientRect: () => rectFor(0) } })
    expect(seen).toHaveLength(1)
    // 矩形是标记自己的，不是指针位置：面板与它所描述的那枚头像因此是固定关系，不会随指针在 24px
    // 命中区内部漂移。
    expect(seen[0]!.rect.left).toBe(100)
    expect(seen[0]!.rect.width).toBe(24)
    // 交出的是这枚标记对应的那条 item（u1，全量下标 0），以及已经解析好的名字——名字在轴里已经
    // 解析过一次（button 的 aria-label 就是它），让调用方再解析一遍就是同一个判断写两处。
    expect(seen[0]!.mark.item.id).toBe('u1')
    expect(seen[0]!.mark.index).toBe(0)
    expect(seen[0]!.name).toBe('You')
  })

  it('每枚标记交出的是自己那条 item——不是第一条，也不是轴内序号', () => {
    // 两枚人类发言在全量里是第 0 与第 3 条。若实现把 mark 闭包写错（比如都指向 marks[0]，或传轴内
    // 序号 0/1），第二枚会给出 u1 或 tool_call，而面板会显示错误的那句话——这正是"面板给错原话"
    // 这类 bug 唯一能被抓住的地方。
    const seen: Peek[] = []
    const marks = axisMarks({ onPeek: (peek: Peek) => seen.push(peek), onPeekEnd: () => false })
    marks.forEach((mark, i) => {
      mark.handlers.onPointerEnter!({ currentTarget: { getBoundingClientRect: () => rectFor(i) } })
    })
    expect(seen.map((peek) => peek.mark.item.id)).toEqual(['u1', 'u2'])
    expect(seen.map((peek) => peek.mark.index)).toEqual([0, 3])
    // 矩形也各是各的——两枚标记不共用一个锚点。
    expect(seen.map((peek) => peek.rect.left)).toEqual([100, 150])
  })

  it('指针离开与失焦走同一条关闭出口', () => {
    let closed = 0
    const [first] = axisMarks({ onPeek: () => {}, onPeekEnd: () => { closed += 1; return true } })
    first!.handlers.onPointerLeave!()
    first!.handlers.onBlur!()
    expect(closed).toBe(2)
  })

  it('Escape 关面板，且面板真的开着时才吃掉这个键', () => {
    // 轴不持有面板状态，所以「该不该 stopPropagation」只能由持有状态的那一层回答。无条件吞掉会让
    // Escape 在面板关着时也被静默吃掉，而外层可能正等着用它关一个更大的东西（Region、对话框）。
    const events = (): { key: string; stopped: number } & { stopPropagation: () => void } => {
      const record = { key: 'Escape', stopped: 0, stopPropagation: () => { record.stopped += 1 } }
      return record
    }

    // 面板开着（onPeekEnd 返回 true）：关掉它，并吃掉这个键。
    const open = ConversationAxis({
      items: fixture(),
      belongs: speaksAsHuman,
      label: 'Speakers',
      size: 16,
      describe: describeSpeaker,
      selectedIndex: null,
      onSelect: () => {},
      onPeek: () => {},
      onPeekEnd: () => true
    } as Parameters<typeof ConversationAxis>[0])
    const openKeyDown = (open as ReactElement<{ onKeyDown: (e: unknown) => void }>).props.onKeyDown
    const openEvent = events()
    openKeyDown(openEvent)
    expect(openEvent.stopped, 'Escape 关掉了面板却没有吃掉这个键').toBe(1)

    // 面板没开（返回 false）：这个键必须继续往上冒。
    const closed = ConversationAxis({
      items: fixture(),
      belongs: speaksAsHuman,
      label: 'Speakers',
      size: 16,
      describe: describeSpeaker,
      selectedIndex: null,
      onSelect: () => {},
      onPeek: () => {},
      onPeekEnd: () => false
    } as Parameters<typeof ConversationAxis>[0])
    const closedKeyDown = (closed as ReactElement<{ onKeyDown: (e: unknown) => void }>).props.onKeyDown
    const closedEvent = events()
    closedKeyDown(closedEvent)
    expect(closedEvent.stopped, '面板没开着，Escape 被轴静默吞掉了').toBe(0)
  })

  it('除 Escape 之外的键一律不碰——轴不劫持键盘', () => {
    // 轴上的标记是 button，Enter/Space 要留给它们自己的激活，方向键要留给外层滚动容器。
    let closed = 0
    const axis = ConversationAxis({
      items: fixture(),
      belongs: speaksAsHuman,
      label: 'Speakers',
      size: 16,
      describe: describeSpeaker,
      selectedIndex: null,
      onSelect: () => {},
      onPeek: () => {},
      onPeekEnd: () => { closed += 1; return true }
    } as Parameters<typeof ConversationAxis>[0])
    const onKeyDown = (axis as ReactElement<{ onKeyDown: (e: unknown) => void }>).props.onKeyDown
    for (const key of ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home']) {
      let stopped = 0
      onKeyDown({ key, stopPropagation: () => { stopped += 1 } })
      expect(stopped, `${key} 被轴吃掉了`).toBe(0)
    }
    expect(closed, '非 Escape 的键触发了关闭').toBe(0)
  })

  it('没接面板出口时轴照常工作——面板是可选的增强，不是轴的前提', () => {
    // 两条轴在 Activity 之外的调用方（今天没有，将来会有）可能不需要面板。缺出口时 hover/blur/Escape
    // 都不许抛——若实现写成 `onPeek(...)` 而不是 `onPeek?.(...)`，这条会红。
    const [first] = axisMarks()
    expect(() =>
      first!.handlers.onPointerEnter!({ currentTarget: { getBoundingClientRect: () => rectFor(0) } })
    ).not.toThrow()
    expect(() => first!.handlers.onPointerLeave!()).not.toThrow()
    expect(() => first!.handlers.onBlur!()).not.toThrow()
    const axis = ConversationAxis({
      items: fixture(),
      belongs: speaksAsHuman,
      label: 'Speakers',
      size: 16,
      describe: describeSpeaker,
      selectedIndex: null,
      onSelect: () => {}
    } as Parameters<typeof ConversationAxis>[0])
    const onKeyDown = (axis as ReactElement<{ onKeyDown: (e: unknown) => void }>).props.onKeyDown
    expect(() => onKeyDown({ key: 'Escape', stopPropagation: () => {} })).not.toThrow()
  })

  it('点按仍然是选中，不是开面板——两个手势各有各的结果', () => {
    // 面板是"看一眼那句话"，点按是"跳到那句话"。若实现把 onClick 也改成开面板，轴就失去了它的主
    // 用途；反过来若 hover 也触发选中，指针扫过轴会把日志滚得乱跳。
    const picked: number[] = []
    const seen: Peek[] = []
    const marks = axisMarks({
      onSelect: (index: number) => picked.push(index),
      onPeek: (peek: Peek) => seen.push(peek),
      onPeekEnd: () => false
    })
    marks[0]!.handlers.onPointerEnter!({ currentTarget: { getBoundingClientRect: () => rectFor(0) } })
    expect(picked, 'hover 触发了选中').toEqual([])
    marks[0]!.handlers.onClick!()
    expect(picked).toEqual([0])
    expect(seen).toHaveLength(1)
  })
})

/**
 * Ruler 这一侧的接线：面板的两种内容源、空引文不开面板、Escape 的返回值。
 *
 * 同样把组件当函数求值——但 Ruler 用了 `useState`/`useRef`，直接调用会因为不在 render 环境里而抛。
 * 所以这里走 `renderToStaticMarkup` 拿标记，再用 element 树取 `axes` 那个函数出口：面板的显隐要
 * state，但**出口接的是谁**是纯结构，能在标记之外直接读出来。
 */
describe('Ruler 侧的面板接线', () => {
  it('轴拿到的 onPeek/onPeekEnd 是 Ruler 自己的那两个出口——不是 undefined', () => {
    // 这条守的是「接线断了但没人知道」：`axes?.({...})` 若被改成 `axes?.()` 或干脆 `null`，轴上就
    // 再也不会有面板，而所有标记流断言照旧全绿（面板本来就不在 SSR 输出里）。
    const captured: { onPeek: unknown; onPeekEnd: unknown }[] = []
    renderToStaticMarkup(
      createElement(Ruler, {
        items: fixture(),
        scale: createRulerScale(
          fixture().map((entry) => entry.createdAt),
          100
        ),
        selectedIndex: null,
        band: null,
        onSelect: () => {},
        axes: (peek) => {
          captured.push(peek)
          return null
        }
      })
    )
    expect(captured, 'Ruler 根本没调用 axes——两条轴不会被渲染').toHaveLength(1)
    expect(captured[0]!.onPeek, 'onPeek 没接上，hover 永远不出面板').toBeTypeOf('function')
    expect(captured[0]!.onPeekEnd, 'onPeekEnd 没接上，面板关不掉').toBeTypeOf('function')
  })

  it('面板关着时 onPeekEnd 返回 false——Escape 不会被静默吞掉', () => {
    // 轴按这个返回值决定要不要 stopPropagation（已由上面那条 Escape 断言钉住轴那一半）。若这一侧
    // 恒返回 true，Escape 在面板关着时也会被吃掉，外层再也关不掉 Region 或对话框；而恒返回 false
    // 则是面板关掉了却仍把键放上去，外层跟着关掉一个更大的东西。两个方向都在这里判。
    const captured: { onPeekEnd: () => boolean }[] = []
    renderToStaticMarkup(
      createElement(Ruler, {
        items: fixture(),
        scale: createRulerScale(
          fixture().map((entry) => entry.createdAt),
          100
        ),
        selectedIndex: null,
        band: null,
        onSelect: () => {},
        axes: (peek) => {
          captured.push(peek as { onPeekEnd: () => boolean })
          return null
        }
      })
    )
    // 刚渲染出来，面板必然是关着的——此时 Escape 必须继续往上冒。
    expect(captured[0]!.onPeekEnd(), '面板关着却报告"关掉了一个开着的面板"').toBe(false)
  })
})
