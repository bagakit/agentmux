// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { allStyleRules } from './helpers/styles'

const dom = composerDOM()
it('groups real Session controls and interrupts only the current reply', async () => {
  const interrupt = vi.spyOn(useAppStore.getState(), 'interrupt').mockResolvedValue()
  const session = composerSession()
  useAppStore.setState({ sessions: [{ ...session, status: { state: 'working', source: 'native-hook', observedAt: 1 } }] })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const groups = dom.container.querySelectorAll('[role="group"][aria-label="Session controls"]')
  expect(groups).toHaveLength(1)
  const group = groups[0]!
  // 身份不再是这一组里的第 4 个 `<button>`：`bcd94ac3` 把 composer 自己那个带 popover 的按钮
  // 并进了 AgentAvatar 的 disclosure，于是它是个包着头像的 `<span>`。剩下三个才是真正的按钮。
  expect([...group.querySelectorAll(':scope > button')].map(button => button.getAttribute('aria-label'))).toEqual([
    expect.stringContaining('Context usage'), 'Interrupt the current turn', expect.stringContaining('Mailbox:')
  ])
  expect(group.querySelector('.composer-agent-identity .agent-avatar')).not.toBeNull()
  expect(dom.container.querySelector('.composer__toolbar > div:last-child')?.contains(group)).toBe(true)
  const button = group.querySelector<HTMLButtonElement>('[aria-label="Interrupt the current turn"]')!
  expect(button.querySelector('.lucide-square')).not.toBeNull()
  expect(button.title).toContain('keep this session')
  const identity = group.querySelector('.composer-agent-identity')!
  const mailbox = group.querySelector('.composer__mailbox')!
  expect(identity.parentElement).toBe(group)
  expect(mailbox.parentElement).toBe(group)
  expect(identity.contains(mailbox)).toBe(false)
  // 两个 disclosure 依旧各自独立，只是机制不同了：身份走 AgentAvatar 的 hover/focus 门户
  // （`aria-describedby` 指向它自己的面板），mailbox 仍走原生 popover。要守的是"互不相干"，
  // 不是"都用 popovertarget"——旧断言钉的是后者，而那个机制已经不在身份这一侧了。
  const mailboxTarget = mailbox.getAttribute('popovertarget')
  expect(mailboxTarget).toBeTruthy()
  expect(identity.getAttribute('popovertarget')).toBeNull()
  const avatar = identity.querySelector('.agent-avatar')!
  expect(avatar.getAttribute('aria-describedby')).toBeNull()
  await dom.hover('.composer-agent-identity .agent-avatar')
  const describedBy = avatar.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  expect(describedBy).not.toBe(mailboxTarget)
  expect(document.getElementById(describedBy!)?.classList.contains('agent-identity-popover')).toBe(true)
  expect(interrupt).not.toHaveBeenCalled()
  await dom.click('.composer__mailbox')
  expect(interrupt).not.toHaveBeenCalled()
  await dom.click('[aria-label="Interrupt the current turn"]')
  expect(interrupt).toHaveBeenCalledExactlyOnceWith('agent-1')
  expect(useAppStore.getState().sessions).toEqual([{ ...session, status: { state: 'working', source: 'native-hook', observedAt: 1 } }])
  expect(dom.draft()).toBe('Keep my draft')
})

it('uses one continuous surface and a Provider contour instead of a rectangular avatar frame', () => {
  const rules = [...allStyleRules().matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  expect(rules.length).toBeGreaterThan(0)
  const body = (target: string) => {
    const found = rules.filter(([, selector]) => selector!.trim() === target)
    expect(found, target).toHaveLength(1)
    return found[0]![2]!
  }
  expect(body('.composer-session-controls')).toContain('background: var(--surface-2)')
  expect(body('.composer-session-controls')).toContain('gap: 0')
  expect(body('.composer-send')).toContain('background: transparent')
  expect(body('.composer-send--working').trim()).toBe('color: var(--text-2);')
  expect(rules.some(([, selector]) => selector!.trim() === '.composer-send--working:hover:not(:disabled)')).toBe(false)
  expect(body('.composer-session-controls .agent-avatar')).toContain('box-shadow: none')
  expect(body('.agent-avatar')).toContain('background: transparent')
  expect(body('.agent-avatar')).not.toMatch(/(?:^|;)\s*outline:/u)
  expect(body('.agent-avatar__contour')).toContain('filter: none')
  expect(body('.agent-avatar__contour')).not.toContain('drop-shadow(')
  // 这里曾经断言 `.composer-session-controls .composer-agent-identity { background: transparent }`。
  // 那条覆盖存在只是因为身份当年是个 `<button>`，UA 会给按钮一层灰底。`bcd94ac3` 把它并进
  // AgentAvatar 的 disclosure 之后它是个 `<span>`，本来就没有底——覆盖是过时的，不是丢了。
  // 还需要成立的是「一整片连续表面」：身份自己不得再画第二块底或第二道边。
  const identityRule = body('.composer-agent-identity')
  expect(identityRule).not.toMatch(/(?:^|;)\s*background:/u)
  expect(identityRule).not.toMatch(/(?:^|;)\s*border:/u)
})
