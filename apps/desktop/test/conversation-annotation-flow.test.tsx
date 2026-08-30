// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ConversationMessage } from '../src/renderer/src/components/ConversationMessage.js'

/**
 * 选中一段正文 → 写一条注解 → 交给宿主。这条走的是用户真的会走的那条路。
 *
 * 病史（2026-09-25）：`conversation-annotation.test.ts` 三条断言全是读源码文本
 * (`expect(message).toContain('messageId: string')` 命中的是**类型标注**，
 * `toContain('quote: string')` 同理)。实测变异：把注解弹层的渲染条件改成
 * `{false && selection && onAnnotate ? …}`——弹层从此永不出现，整条注解能力断掉，而
 * 那份 gate 的 **6 条全绿**。源码里的字符串一个没少，`toContain` 照旧为真。
 *
 * 所以这份判据渲染组件、造一次真选区、点真按钮。它守四件事：
 *   1. 没选区时弹层不在——它是选中才出现的东西，不是常驻面板；
 *   2. 选中后弹层出现，且**引文就是选中的那段**（不是整条消息）；
 *   3. 注解空着时提交键是禁用的——交一条空注解等于什么都没说；
 *   4. 提交后宿主拿到 messageId / quote / start / end / note 五个字段，range 对得上原文。
 *
 * 为什么不走 `renderToStaticMarkup`：弹层由 `useState` 的 selection 驱动，静态渲染永远
 * 停在第一帧，看不见"选中之后"。
 */

const CONTENT = 'The runtime attached, then the worker reported back.'
const QUOTE = 'the worker reported back'

const BASE = {
  messageId: 'm-42',
  speaker: { role: 'agent' as const, id: 'agent-1' },
  name: 'Agent',
  content: CONTENT,
  status: 'complete' as const,
  createdAt: 1,
  origin: 1
}

/** 在正文里造一次真的用户选区，并触发组件监听的那个事件。 */
function selectInsideBody(host: HTMLElement, quote: string): void {
  const body = host.querySelector<HTMLDivElement>('.log-turn__body')
  expect(body, '正文容器不在——选区判据没有落脚点，整条测试在空转').not.toBeNull()
  // 找到真正承载文字的那个文本节点：选区必须落在它上面，组件要用
  // `bodyRef.current.contains(range.commonAncestorContainer)` 核对归属。
  const walker = document.createTreeWalker(body!, NodeFilter.SHOW_TEXT)
  let node: Node | null = null
  let offset = -1
  while ((node = walker.nextNode())) {
    const index = (node.textContent ?? '').indexOf(quote)
    if (index !== -1) { offset = index; break }
  }
  expect(node, `正文里找不到 "${quote}" 这段文本节点——选区造不出来，后面每条断言都会是空转`).not.toBeNull()

  const range = document.createRange()
  range.setStart(node!, offset)
  range.setEnd(node!, offset + quote.length)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  expect(selection.toString(), '选区造出来是空的').toBe(quote)

  body!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

describe('对话消息上的选区注解', () => {
  // 不给这个标志，`act()` 只打一行 stderr 警告就放行——状态更新会在断言之后才刷进 DOM，
  // 于是"点了没反应"读起来像通过。
  beforeAll(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })

  it('选中正文才出现注解弹层，引文就是选中的那段', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(
      createElement(ConversationMessage, { ...BASE, onAnnotate: vi.fn() })
    ))

    expect(
      host.querySelector('.log-turn__annotation'),
      '还没选中任何东西，注解弹层就已经在了——它该是选中才出现的'
    ).toBeNull()

    await act(async () => { selectInsideBody(host, QUOTE) })

    const dialog = host.querySelector('.log-turn__annotation')
    expect(
      dialog,
      '选中正文后注解弹层没有出现。源码里有那段 JSX 不等于它会渲染——' +
        '把渲染条件改成恒假，读源码的那份 gate 照样全绿（2026-09-25 实测）'
    ).not.toBeNull()
    expect(
      dialog!.querySelector('.log-turn__annotation-quote')?.textContent,
      '弹层里的引文不是选中的那段——注解会挂到错的位置上'
    ).toContain(QUOTE)

    await act(async () => root.unmount())
    host.remove()
  })

  it('注解写了字才提交得了，交出去的 range 对得上原文', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onAnnotate = vi.fn()
    await act(async () => root.render(createElement(ConversationMessage, { ...BASE, onAnnotate })))
    await act(async () => { selectInsideBody(host, QUOTE) })

    const submit = [...host.querySelectorAll<HTMLButtonElement>('.log-turn__annotation-actions button')]
      .find((button) => button.textContent?.includes('Add note'))
    expect(submit, '提交键不在弹层里——这条判据在空转').toBeDefined()
    expect(submit!.disabled, '注解还空着，提交键却是可点的：交一条空注解等于什么都没说').toBe(true)

    const textarea = host.querySelector<HTMLTextAreaElement>('.log-turn__annotation textarea')
    expect(textarea, '注解输入框不在弹层里').not.toBeNull()
    await act(async () => {
      // 受控输入：直接设 value 不会让 React 看见，要走原生 setter 再派发 input。
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea!, 'Check this branch.')
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submit!.disabled, '注解写了字，提交键还是禁用的——这条路走不通').toBe(false)

    await act(async () => submit!.click())

    expect(onAnnotate, '点了提交，宿主没收到注解').toHaveBeenCalledTimes(1)
    const annotation = onAnnotate.mock.calls[0]![0]
    expect(annotation.messageId, '注解没带消息身份，宿主无法把它挂回原消息').toBe('m-42')
    expect(annotation.quote).toBe(QUOTE)
    expect(annotation.note).toBe('Check this branch.')
    // range 不是抄来的数字，要真能在原文里切回同一段——切错了注解就落在别的字上。
    expect(
      CONTENT.slice(annotation.start, annotation.end),
      `start/end 切不回引文：切出来的是 "${CONTENT.slice(annotation.start, annotation.end)}"`
    ).toBe(QUOTE)

    await act(async () => root.unmount())
    host.remove()
  })

  it('宿主没接注解时，选中正文不会弹出一个点了没用的弹层', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    // 不传 onAnnotate：Gallery 这类只读场景就是这么用的。
    await act(async () => root.render(createElement(ConversationMessage, { ...BASE })))
    await act(async () => { selectInsideBody(host, QUOTE) })

    expect(
      host.querySelector('.log-turn__annotation'),
      '宿主没接 onAnnotate，却弹出了注解框——用户写完点提交会什么都不发生'
    ).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })
})
