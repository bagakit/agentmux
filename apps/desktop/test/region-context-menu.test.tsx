import { describe, expect, it, vi } from 'vitest'
import { createRegionCopyModel } from '../src/renderer/src/components/RegionContextMenu.js'
import {
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

  it('非 Agent 的 Region 不提供 Session 地址——缺席表达，不画禁用的假按钮', () => {
    const model = createRegionCopyModel({
      regionId: 'region:a-file',
      agentSessionId: null,
      writeClipboardText: vi.fn(async () => {})
    })
    // 一格文件/浏览器/launcher 没有 Agent 语义身份可寻址。
    expect(model.sessionAddress).toBeUndefined()
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
