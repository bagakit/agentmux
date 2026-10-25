// @vitest-environment happy-dom
import './helpers/goal-responsibility-product'
import { fixture, mount, container } from './helpers/goal-responsibility-product'
import { act, createElement } from 'react'
import { expect, it } from 'vitest'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'

it('switches the original Goal list and board without selecting or requesting work', async () => {
  const f = await fixture({ patrol: true }); await f.finite(); await f.publish()
  useAppStore.setState({ selectedDemandId: null })
  await mount(createElement(GlobalBoardSurface))
  const drafts = useAppStore.getState().agentComposerDrafts
  const group = container.querySelector('[aria-label="Goal view"]')!
  const list = group.querySelector<HTMLButtonElement>('[aria-label="List view"]')!
  const board = group.querySelector<HTMLButtonElement>('[aria-label="Board view"]')!
  expect(group.getAttribute('role')).toBe('tablist')
  expect(list.getAttribute('aria-selected')).toBe('true')
  const requests = (await f.proof()).exchanges.filter(call => call.method === 'goal.patrol').length
  await act(async () => {
    list.focus(); list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  expect(board.getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(board)
  expect(container.querySelector('.goals-board [data-demand-id="goal"]')).not.toBeNull()
  await act(async () => board.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })))
  expect(list.getAttribute('aria-selected')).toBe('true')
  expect(container.querySelector('.goals-list [data-demand-id="goal"]')).not.toBeNull()
  expect(useAppStore.getState().selectedDemandId).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect((await f.proof()).exchanges.filter(call => call.method === 'goal.patrol')).toHaveLength(requests)
  expect(f.stop).not.toHaveBeenCalled()
})
