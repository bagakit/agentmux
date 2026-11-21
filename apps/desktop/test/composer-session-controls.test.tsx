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
  const settings = group.querySelector('.composer-session-controls__settings')!
  expect([...settings.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual([
    expect.stringMatching(/^Model\b/), expect.stringContaining('Context usage')
  ])
  const activity = group.querySelector('.composer-session-controls__activity')!
  const button = group.querySelector<HTMLButtonElement>('[aria-label="Interrupt the current turn"]')!
  expect([...group.children]).toEqual([settings, activity, button])
  expect(dom.container.querySelector('.composer__toolbar > div:last-child')?.contains(group)).toBe(true)
  expect(button.querySelector('[data-semantic-icon="action.stop"]')).not.toBeNull()
  expect(button.title).toContain('keep this session')
  const identity = activity.querySelector('.composer-agent-identity')!
  const mailbox = activity.querySelector('.composer__mailbox')!
  expect(mailbox.compareDocumentPosition(identity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

it('uses the Composer surface for secondary actions and emphasizes the primary button', () => {
  const rules = [...allStyleRules().matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  expect(rules.length).toBeGreaterThan(0)
  const body = (target: string) => {
    const found = rules.filter(([, selector]) => selector!.trim() === target)
    expect(found, target).toHaveLength(1)
    return found[0]![2]!
  }
  expect(body('.composer-session-controls')).not.toContain('background:')
  expect(body('.composer-send')).toContain('background: var(--green-text)')
  expect(body('.composer-send--working:not(:disabled)')).toContain('background: var(--surface-3)')
  expect(body('.composer-session-controls .agent-avatar')).toContain('box-shadow: none')
  expect(body('.agent-avatar')).toContain('background: transparent')
  expect(body('.agent-avatar')).not.toMatch(/(?:^|;)\s*outline:/u)
  expect(body('.agent-avatar__contour')).toContain('filter: none')
  expect(body('.agent-avatar__contour')).not.toContain('drop-shadow(')
  const identityRule = body('.composer-agent-identity')
  expect(identityRule).not.toMatch(/(?:^|;)\s*background:/u)
  expect(identityRule).not.toMatch(/(?:^|;)\s*border:/u)
})
