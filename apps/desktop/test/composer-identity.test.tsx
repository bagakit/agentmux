// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
// 身份的可读名字在**头像自己身上**，不在外层包装上。`bcd94ac3` 把 composer 自己那个带
// `title` 的按钮和它的 popover 一起并进了 AgentAvatar 的 disclosure——Tab、树、名册问的是
// 同一个控件，composer 不该有第二份。所以这里读 `aria-label`：它同时是无障碍名和悬停面板的
// 标题来源，而旧的 `title` 只有鼠标用户看得到。
//
// 措辞也跟着走同一张表：`running` 读作 `Idle`（进程活着但没在干活），`exited` 读作
// `Stopped`。这不是这个文件的发明，AgentAvatar.tsx:59 与 ProjectActivity.tsx:108 用的是同一个词。
const identityName = (element: Element): string | null =>
  element.querySelector('[role="img"], [role="button"], button')?.getAttribute('aria-label') ?? null

it('shows and updates the actual Session identity, including same-provider siblings and renames', async () => {
  useAppStore.setState({ sessions: [composerSession('a'), composerSession('b'), composerSession('c', 'claude')],
    agentNames: { a: 'Review queue', b: 'Fix sizing', c: 'Investigate' } })
  await dom.render(<AgentSessionComposer key="a" sessionId="a" tabName="Release" />)
  const identity = () => dom.container.querySelector('.composer-agent-identity')!
  expect(identity().textContent).toBe('')
  expect(identity().parentElement).toBe(dom.container.querySelector('.composer-session-controls'))
  expect(identity().closest('.composer__mailbox')).toBeNull()
  expect(dom.container.querySelector('.composer__mailbox')?.parentElement).toBe(identity().parentElement)
  expect(identity().parentElement?.parentElement).toBe(dom.container.querySelector('.composer__toolbar > div:last-child'))
  expect(identity().parentElement?.querySelectorAll('.agent-avatar')).toHaveLength(1)
  expect(identityName(identity())).toBe('Review queue · Idle')
  const codex = identity().querySelector('.agent-avatar__mark')!.innerHTML
  for (const mode of ['collapsed', 'current', 'expanded']) {
    expect(dom.container.querySelector('.composer-tools')?.getAttribute('data-mode')).toBe(mode)
    expect(identity().querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Review queue · Idle')
    await dom.click('.composer-tool--mode')
  }
  await dom.render(<AgentSessionComposer key="b" sessionId="b" tabName="Release" />)
  expect(identityName(identity())).toBe('Fix sizing · Idle')
  expect(identity().querySelector('.agent-avatar__mark')!.innerHTML).toBe(codex)
  await dom.render(<AgentSessionComposer key="c" sessionId="c" tabName="Release" />)
  expect(identityName(identity())).toBe('Investigate · Idle')
  expect(identity().querySelector('.agent-avatar__mark')!.innerHTML).not.toBe(codex)
  await act(async () => useAppStore.setState({ agentNames: { c: 'Renamed investigation' } }))
  expect(identityName(identity())).toBe('Renamed investigation · Idle')
  expect(identity().querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Renamed investigation · Idle')
})

it('uses the authored Tab as fallback without manufacturing a numbered terminal identity', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" tabName="Release review" />)
  expect(identityName(dom.container.querySelector('.composer-agent-identity')!)).toBe('Release review · Idle')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(identityName(dom.container.querySelector('.composer-agent-identity')!)).toBe('codex · Idle')
})
