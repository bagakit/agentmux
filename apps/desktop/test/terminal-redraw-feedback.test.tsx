// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TerminalReplayGapNotice } from '../src/renderer/src/components/TerminalReplayGapNotice'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
afterEach(() => { document.body.replaceChildren() })
it.each(['success', 'unavailable', 'failure'] as const)('reports the actual %s outcome of the Redraw button', async (outcome) => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let resolve!: (accepted: boolean) => void, reject!: (error: Error) => void
  const onRedraw = vi.fn(() => new Promise<boolean>((yes, no) => { resolve = yes; reject = no }))
  try {
    await act(async () => root.render(<TerminalReplayGapNotice canRedraw onRedraw={onRedraw} />))
    const button = container.querySelector('button')!
    await act(async () => button.click())
    expect(onRedraw).toHaveBeenCalledOnce()
    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain('Requesting')
    await act(async () => { if (outcome === 'failure') reject(new Error('resize failed')); else resolve(outcome === 'success') })
    if (outcome === 'success') {
      expect(container.querySelector('button')).toBeNull()
      expect(container.textContent).not.toContain('Earlier scrollback')
      expect(container.querySelector('[role="status"]')?.getAttribute('title')).toContain('cannot restore missing history')
      expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain('Screen redraw requested')
    } else {
      expect(button.disabled).toBe(false)
      expect(container.textContent).toContain(outcome === 'failure' ? 'resize failed' : 'not ready')
    }
  } finally { await act(async () => root.unmount()) }
})
it('TerminalView returns the real viewport outcome to the visible notice', () => {
  // happy-dom 会用它自己的 URL 覆盖全局，`new URL(..).protocol` 不是 file，readFileSync(URL) 会抛。
  // 从 import.meta.url 的字符串本身算路径，绕开被替换的 URL 构造器。
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '../src/renderer/src/components/TerminalView.tsx'), 'utf8')
  expect(source.length).toBeGreaterThan(0)
  // 重构把单行拆成了绑定 + return。只截取 redrawCurrentScreen 的函数体来守：真返回值
  // 必须来自真调用，而非硬编码 true——缺了真调用或改成 `return true` 都会红。
  const redraw = source.slice(source.indexOf('async function redrawCurrentScreen'))
  expect(redraw).toContain('const redrawn = await viewport.requestContentRedraw()')
  expect(redraw).toMatch(/return redrawn\b/)
  expect(source).toContain('onRedraw={redrawCurrentScreen}')
  expect(source).toContain('setReplayGap(false)')
  expect(source).toContain('A settled Region grid is a real current-screen confirmation')
})
