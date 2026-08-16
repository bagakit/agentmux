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
  expect([...group.querySelectorAll(':scope > button')].map(button => button.getAttribute('aria-label'))).toEqual([
    expect.stringContaining('Context usage'), 'Send steer', 'Interrupt the current turn', expect.stringContaining('Mailbox:')
  ])
  expect(group.querySelector('.composer__identity .agent-avatar')).not.toBeNull()
  expect(dom.container.querySelector('.composer__toolbar > div:last-child')?.contains(group)).toBe(true)
  const button = group.querySelector<HTMLButtonElement>('[aria-label="Interrupt the current turn"]')!
  expect(button.querySelector('.lucide-hand')).not.toBeNull()
  expect(button.title).toContain('keep this session')
  await dom.click('.composer__mailbox')
  expect(interrupt).not.toHaveBeenCalled()
  await dom.click('[aria-label="Interrupt the current turn"]')
  expect(interrupt).toHaveBeenCalledExactlyOnceWith('agent-1')
  expect(useAppStore.getState().sessions).toEqual([{ ...session, status: { state: 'working', source: 'native-hook', observedAt: 1 } }])
  expect(dom.draft()).toBe('Keep my draft')
})

it('uses one continuous surface without independent send/interrupt fills or avatar glow', () => {
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
  expect(body('.composer-session-controls .agent-avatar')).toContain('box-shadow: none')
  expect(body('.composer-session-controls .agent-avatar:is(.status--working, .status--running)')).toContain('outline: none')
})
