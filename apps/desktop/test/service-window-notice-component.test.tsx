import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ServiceWindowNotice } from '../src/renderer/src/components/ServiceWindowNotice.js'
import type { RenderableServiceNotice } from '../src/renderer/src/lib/service-window-notice.js'

/**
 * 服务窗的展示层。组件是纯展示——所有判定在 lib，这里只证明它把三段文案画出来、且形态对：
 * 停在旁边不消失（`role="status"`，不是 dialog、不是 toast），不给关闭键（随条件消失而非随用户点关闭）。
 */

const DEGRADED: RenderableServiceNotice = {
  kind: 'process-degraded',
  notice: {
    step: 'Reconnecting to this Agent didn’t complete',
    mode: 'The Agent process is still running; only the link dropped',
    restore: 'Resume the session to reattach'
  }
}

describe('ServiceWindowNotice', () => {
  it('拿到 null 就什么也不渲染——完全好的与完全坏了都不由服务窗承载', () => {
    expect(renderToStaticMarkup(createElement(ServiceWindowNotice, { notice: null }))).toBe('')
  })

  it('把三段文案都画出来', () => {
    const markup = renderToStaticMarkup(createElement(ServiceWindowNotice, { notice: DEGRADED }))
    expect(markup).toContain('Reconnecting to this Agent didn’t complete')
    expect(markup).toContain('The Agent process is still running; only the link dropped')
    expect(markup).toContain('Resume the session to reattach')
  })

  it('是告示不是弹窗：role=status、随条件消失，因此不含关闭键', () => {
    const markup = renderToStaticMarkup(createElement(ServiceWindowNotice, { notice: DEGRADED }))
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    // dialog 会抢焦点、挡路；服务窗不是那个。
    expect(markup).not.toContain('role="dialog"')
    // 它随条件解除而消失，而非随用户点关闭——所以没有关闭键（那会让用户误以为能永久打发它）。
    expect(markup.toLowerCase()).not.toContain('dismiss')
    expect(markup).not.toContain('aria-label="Close"')
  })

  it('分不清用中性语气，不误染成「需要注意」的琥珀', () => {
    const indeterminate: RenderableServiceNotice = {
      kind: 'indeterminate',
      notice: { step: 's', mode: 'm', restore: 'r' }
    }
    const markup = renderToStaticMarkup(createElement(ServiceWindowNotice, { notice: indeterminate }))
    // data-kind 让 CSS 把分不清的图标从琥珀让出到中性；类名在，样式才接得上。
    expect(markup).toContain('data-kind="indeterminate"')
  })
})
