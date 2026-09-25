// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { ServiceWindowNotice } from '../src/renderer/src/components/ServiceWindowNotice.js'
import type { RenderableServiceNotice } from '../src/renderer/src/lib/service-window-notice.js'
import { useAppStore } from '../src/renderer/src/store'
import { createJSONStorage } from 'zustand/middleware'

/**
 * 服务窗的展示层。组件是纯展示——所有判定在 lib，这里只证明它把三段文案画出来、且形态对：
 * 完整内容保持三事实与 status 语义；局部的收起与复查由公共 disclosure owner 管理，inbox 不嵌套关闭键。
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

  it('完整内容是 status 告示，关闭由外层 owner 统一管理', () => {
    const markup = renderToStaticMarkup(createElement(ServiceWindowNotice, { notice: DEGRADED }))
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    // dialog 会抢焦点、挡路；服务窗不是那个。
    expect(markup).not.toContain('role="dialog"')
    // Global/Mailbox 已有关闭；完整内容不再叠一个关闭 owner。
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

  it('两个可渲染档都轻声说——服务窗承载的只有 alive/unknown，音量随 kind 派生为 polite', () => {
    // T-003：降级不该用第 1 类的音量喊。可渲染的两类（process-degraded⟸alive、indeterminate⟸unknown）
    // 都必须 polite+status；把哪一档的音量改成 assertive，这里就变红。
    // （dead 那档 assertive 不经服务窗渲染——它由恢复横幅承载，见 lib 里的音量表注释。）
    for (const kind of ['process-degraded', 'indeterminate'] as const) {
      const notice: RenderableServiceNotice = { kind, notice: { step: 's', mode: 'm', restore: 'r' } }
      const markup = renderToStaticMarkup(createElement(ServiceWindowNotice, { notice }))
      expect(markup).toContain('aria-live="polite"')
      expect(markup).toContain('role="status"')
      expect(markup).not.toContain('aria-live="assertive"')
    }
  })
})

it('local receipt survives diagnostics, unavailable projection, remount and durable hydration; real causes, Runs and recurrence remain discoverable', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), storage = useAppStore.persist.getOptions().storage
  let durable = ''
  useAppStore.persist.setOptions({ storage: createJSONStorage(() => ({ getItem: () => durable || null,
    setItem: (_key, value) => { durable = value }, removeItem: () => { durable = '' } })) })
  const container = document.createElement('div'); document.body.append(container)
  const input = document.createElement('textarea'); document.body.append(input); input.focus()
  let root = createRoot(container)
  async function show(notice: RenderableServiceNotice | null = DEGRADED, cause = 'transport-disconnected', run = 'run-a', available = true) {
    await act(async () => root.render(<ServiceWindowNotice notice={notice} disclosure={{
      scope: `local:private-host:private-session:${run}`, id: 'transport', cause, available }} />))
  }
  const unread = () => container.querySelector('.service-disclosure')?.getAttribute('data-unread')
  async function toggle(newState: 'open' | 'closed') {
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: newState })
    await act(async () => container.querySelector('.service-disclosure__details')!.dispatchEvent(event))
  }
  try {
    useAppStore.setState({ noticeReadReceipts: {} })
    await show(); expect(unread()).toBe('true'); expect(document.activeElement).toBe(input)
    expect(container.querySelector('.service-disclosure__details')!.getAttribute('popover')).toBe('auto')
    expect(container.querySelector('.service-disclosure__details')!.textContent).toContain(DEGRADED.notice.restore)
    await act(async () => container.querySelector<HTMLButtonElement>('.service-disclosure__close')!.click())
    expect(unread()).toBe('false')
    const receipt = useAppStore.getState().noticeReadReceipts
    expect(Object.keys(receipt)).toEqual(['local:private-host:private-session:run-a'])
    await show({ ...DEGRADED, notice: { ...DEGRADED.notice, mode: 'Diagnostic metadata changed: cursor 999' } })
    expect(unread()).toBe('false'); expect(useAppStore.getState().noticeReadReceipts).toEqual(receipt)
    await show(null, 'transport-disconnected', 'run-a', false)
    expect(container.innerHTML).toBe(''); expect(useAppStore.getState().noticeReadReceipts).toEqual(receipt)
    await act(async () => root.unmount()); root = createRoot(container)
    const saved = durable
    useAppStore.setState({ noticeReadReceipts: {} }); durable = saved
    await useAppStore.persist.rehydrate(); await show(); expect(unread()).toBe('false')
    await toggle('open')
    await show(DEGRADED, 'permission-denied'); await toggle('closed'); expect(unread()).toBe('true')
    await toggle('open')
    await show(DEGRADED, 'transport-disconnected', 'run-b'); await toggle('closed'); expect(unread()).toBe('true')
    await show(); expect(unread()).toBe('true')
    await act(async () => container.querySelector<HTMLButtonElement>('.service-disclosure__close')!.click())
    await show(null); expect(container.innerHTML).toBe('')
    await show(); expect(unread()).toBe('true')
  } finally {
    await act(async () => root.unmount()); container.remove(); input.remove()
    useAppStore.persist.setOptions({ storage }); useAppStore.setState(initial, true); vi.unstubAllGlobals()
  }
})
