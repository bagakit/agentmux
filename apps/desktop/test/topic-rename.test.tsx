import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  handleTopicRenameKeyDown,
  type TopicRenameKeyEvent
} from '../src/renderer/src/lib/topic-rename.js'
import { allStyles } from './helpers/styles.js'

/**
 * 这个文件守住用户报的四个 Topic 改名缺陷，一个都不许悄悄回来：
 * 「样式难看, 不能打空格, 不能方向键, 失焦后不保存」。
 *
 * 键盘与失焦这两条的正确行为落在纯函数与组件接线上，用真实 DOM 事件无法在本仓库的
 * renderToStaticMarkup 约定下触发；因此优先断言纯函数（可断言），再用源码文本补断言接线（防回归）。
 */

function keyEvent(key: string): TopicRenameKeyEvent & { stopped: boolean; defaulted: boolean } {
  const event = {
    key,
    stopped: false,
    defaulted: false,
    stopPropagation() {
      event.stopped = true
    },
    preventDefault() {
      event.defaulted = true
    }
  }
  return event
}

describe('handleTopicRenameKeyDown', () => {
  it('空格必须留在输入框里——拦下冒泡，dnd-kit 的启动键才不会把它吞掉', () => {
    // 用户报「不能打空格」的根因：空格是 KeyboardSensor 的 activation key，冒泡到挂了 listeners 的
    // 祖先 div 会被 preventDefault。stopPropagation 是让空格复活的唯一动作。
    const event = keyEvent(' ')
    const cancel = vi.fn()
    handleTopicRenameKeyDown(event, { cancel })
    expect(event.stopped).toBe(true)
    // 空格不是取消也不是提交，输入框要拿到它的默认输入行为，故绝不 preventDefault。
    expect(event.defaulted).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('方向键同样被拦下——它们是 sensor 的 move key，不拦就移动整行而不是移动光标', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const event = keyEvent(key)
      handleTopicRenameKeyDown(event, { cancel: vi.fn() })
      expect(event.stopped).toBe(true)
      expect(event.defaulted).toBe(false)
    }
  })

  it('Escape 取消编辑并阻止默认，但同样不让键冒泡到拖拽层', () => {
    const event = keyEvent('Escape')
    const cancel = vi.fn()
    handleTopicRenameKeyDown(event, { cancel })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(event.defaulted).toBe(true)
    expect(event.stopped).toBe(true)
  })

  it('Enter 不在这里处理：只拦冒泡，把提交留给表单默认 submit', () => {
    // Enter 若在此 preventDefault 就会连表单提交一起挡掉。这里只 stopPropagation，
    // 既不触发取消也不阻止默认——提交仍由 <form onSubmit> 承担。
    const event = keyEvent('Enter')
    const cancel = vi.fn()
    handleTopicRenameKeyDown(event, { cancel })
    expect(event.stopped).toBe(true)
    expect(event.defaulted).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('普通字符键照常输入：拦冒泡但不拦默认、不取消', () => {
    const event = keyEvent('a')
    const cancel = vi.fn()
    handleTopicRenameKeyDown(event, { cancel })
    expect(event.stopped).toBe(true)
    expect(event.defaulted).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
  })
})

const dockSource = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceTopicsPanel.tsx', import.meta.url),
  'utf8'
)

function renameInputBlock(): string {
  const form = dockSource.indexOf('workspace-topic-rename-form')
  expect(form).toBeGreaterThan(-1)
  const inputStart = dockSource.indexOf('<input', form)
  const inputEnd = dockSource.indexOf('/>', inputStart)
  expect(inputStart).toBeGreaterThan(-1)
  expect(inputEnd).toBeGreaterThan(inputStart)
  return dockSource.slice(inputStart, inputEnd)
}

describe('Topic 改名输入框的接线（源码断言，防止 JSX 上的回归）', () => {
  it('onBlur 提交——失焦后不保存的根因是这里此前根本没挂 onBlur', () => {
    const input = renameInputBlock()
    expect(input).toContain('onBlur={() => void commitRename(topic)}')
  })

  it('onKeyDown 走 shield 纯函数，而不是只处理 Escape 的内联版本', () => {
    const input = renameInputBlock()
    expect(input).toContain('handleTopicRenameKeyDown(event')
    // 旧的内联实现只 handle Escape、从不 stopPropagation，是空格/方向键失灵的现场。
    expect(input).not.toContain("if (event.key === 'Escape') {")
  })

  it('点击输入框自身不冒泡到行——避免误触发打开 Topic', () => {
    const input = renameInputBlock()
    expect(input).toContain('onClick={(event) => event.stopPropagation()}')
  })

  it('commitRename 先认领当前编辑项，Esc 之后那次失焦才不会报「标题不能为空」', () => {
    // 加上 onBlur 之后冒出来的新问题：按 Esc 时 cancelRename 已经把 editTitle 清空，
    // 紧接着输入框失焦又会触发一次 commitRename——没有这道认领，用户按 Esc 取消，
    // 反而会看到一条错误。这条守的是「修一个缺陷不许带出另一个」。
    const commit = dockSource.slice(
      dockSource.indexOf('async function commitRename'),
      dockSource.indexOf('const pendingId = `rename:')
    )
    const guard = commit.indexOf('if (editingTopicId !== topic.id) return')
    const emptyTitleError = commit.indexOf('Scratch Topic title cannot be empty')
    expect(guard).toBeGreaterThan(-1)
    // 顺序也是断言的一部分：认领必须发生在报错之前，放在后面等于没放。
    expect(emptyTitleError).toBeGreaterThan(guard)
  })
})

describe('Topic 改名输入框的聚焦样式（从样式表反推，防止裸 token 回归）', () => {
  const styles = allStyles()

  function rule(selector: string): string {
    const at = styles.indexOf(selector)
    expect(at, `样式表里找不到 ${selector}`).toBeGreaterThan(-1)
    const open = styles.indexOf('{', at)
    const close = styles.indexOf('}', open)
    return styles.slice(open + 1, close)
  }

  it('聚焦统一用 --focus-line 与 --focus-ring（设计合同 line 139），不用饱和前景绿描边', () => {
    const focus = rule('.workspace-topic-rename-form input:focus')
    expect(focus).toContain('var(--focus-line)')
    expect(focus).toContain('var(--focus-ring)')
  })

  it('静息态描边用 --line 线性 token，不再用 --green-2 那种前景色', () => {
    const rest = rule('.workspace-topic-rename-form input {')
    expect(rest).toContain('var(--line)')
    // --green-2 是饱和前景绿、不是线性 token；描边也不作为控件主要视觉手段。
    expect(rest).not.toContain('var(--green-2)')
  })
})
