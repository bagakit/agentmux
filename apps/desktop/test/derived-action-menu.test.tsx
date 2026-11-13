// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { composerDOM } from './helpers/composer-dom-fixture'
import * as Menu from '../src/renderer/src/components/HoverDropdownMenu'
import { AgentMenuContent } from '../src/renderer/src/components/AgentMenuContent'
import { WorkbenchMenuScope } from '../src/renderer/src/components/WorkbenchMenuScope'
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM()
const review = { id: 'review', label: 'Review this work', base: 'new-agent' as const, instruction: 'Review the changes.' }
const retry = { id: 'retry', label: 'Try another approach', base: 'fork' as const, instruction: 'Try a different design.' }
const labels = (root: ParentNode) => [...root.querySelectorAll('[role="menuitem"]')].map(node => node.textContent?.trim())
async function mount(props: Partial<Parameters<typeof AgentMenuContent>[0]> = {}) {
  await dom.render(<Menu.Root open><Menu.Trigger>Actions</Menu.Trigger><Menu.Content data-product-menu="">
    <WorkbenchMenuScope.Provider value={Menu}><AgentMenuContent name="Original Agent" executorLabel="Executor" sessionId="canonical-agent"
      executionHost={{ id: 'local', label: 'This Mac', kind: 'local', configured: true, cwd: '/original' }} links={null}
      onTakeOver={() => {}} onLearn={() => {}} onRestart={() => {}} onStop={() => {}}
      extensions={{ controls: <Menu.Item className="tab-context-menu__item">Fork current conversation…</Menu.Item>,
        forkAction: action => <Menu.Item className="tab-context-menu__item" data-derived-action={action.id}>{action.label}…</Menu.Item> }}
      {...props} /></WorkbenchMenuScope.Provider>
  </Menu.Content></Menu.Root>)
  return document.querySelector<HTMLElement>('[data-product-menu]')!
}

it('lists visible official actions, then the user actions in saved order, and keeps the lifecycle apart', async () => {
  useAppStore.setState({ config: { ...useAppStore.getState().config!, agentDerivedActions: { actions: [review, retry], hidden: ['pass-on-experience'] } } })
  const onDerived = vi.fn(), onCustomize = vi.fn()
  const root = await mount({ onDerived, onCustomize })
  expect(labels(root.querySelector('[role="group"][aria-label="Derived actions"]')!)).toEqual(['Take over', 'Fork current conversation…', 'Review this work…', 'Try another approach…', 'Customize…'])
  expect(labels(root.querySelector('[role="group"][aria-label="Session lifecycle"]')!)).toEqual(['Restart Session…', 'Stop Agent'])
  await act(async () => root.querySelector<HTMLElement>('[data-derived-action="review"]')!.click())
  expect(onDerived).toHaveBeenCalledExactlyOnceWith(review)
  await act(async () => root.querySelector<HTMLElement>('[data-derived-customize]')!.click())
  expect(onCustomize).toHaveBeenCalledOnce()
})

it('a read-only view shows no custom action and keeps official visibility', async () => {
  useAppStore.setState({ config: { ...useAppStore.getState().config!, agentDerivedActions: { actions: [review] } } })
  const root = await mount({ readOnly: true, onDerived: vi.fn(), onCustomize: vi.fn() })
  expect(root.querySelector('[data-derived-action="review"]')).toBeNull()
  expect(root.querySelector('[data-derived-customize]')).toBeNull()
  expect(root.querySelector('[role="group"][aria-label="Session lifecycle"]')).toBeNull()
})
