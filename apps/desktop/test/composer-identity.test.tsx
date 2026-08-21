// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
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
  expect(identity().getAttribute('title')).toBe('Review queue · running')
  const codex = identity().querySelector('.agent-avatar__mark')!.innerHTML
  for (const mode of ['collapsed', 'current', 'expanded']) {
    expect(dom.container.querySelector('.composer-tools')?.getAttribute('data-mode')).toBe(mode)
    expect(identity().querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Review queue · running')
    await dom.click('.composer-tool--mode')
  }
  await dom.render(<AgentSessionComposer key="b" sessionId="b" tabName="Release" />)
  expect(identity().getAttribute('title')).toBe('Fix sizing · running')
  expect(identity().querySelector('.agent-avatar__mark')!.innerHTML).toBe(codex)
  await dom.render(<AgentSessionComposer key="c" sessionId="c" tabName="Release" />)
  expect(identity().getAttribute('title')).toBe('Investigate · running')
  expect(identity().querySelector('.agent-avatar__mark')!.innerHTML).not.toBe(codex)
  await act(async () => useAppStore.setState({ agentNames: { c: 'Renamed investigation' } }))
  expect(identity().getAttribute('title')).toBe('Renamed investigation · running')
  expect(identity().querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Renamed investigation · running')
})

it('uses the authored Tab as fallback without manufacturing a numbered terminal identity', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" tabName="Release review" />)
  expect(dom.container.querySelector('.composer-agent-identity')?.getAttribute('title')).toBe('Release review · running')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(dom.container.querySelector('.composer-agent-identity')?.getAttribute('title')).toBe('codex · running')
})
