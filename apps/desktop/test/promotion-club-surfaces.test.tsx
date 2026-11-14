// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { composerDOM } from './helpers/composer-dom-fixture'
import { TopicDirectorySettingsPane } from '../src/renderer/src/components/settings/TopicDirectorySettingsPane'
import { MoteDirectorySettingsPane } from '../src/renderer/src/components/settings/MoteDirectorySettingsPane'
import { TopicPromotionDialog } from '../src/renderer/src/components/TopicPromotionDialog'
import { TopicActionsMenu } from '../src/renderer/src/components/TopicContextMenu'
import { moteSettingsModule } from '../src/renderer/src/components/settings/modules/mote'
import { motePromotionSettingsModule } from '../src/renderer/src/components/settings/modules/topic'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import * as floating from '../src/renderer/src/lib/pmo-teams-topic-floating'

const dom = composerDOM()
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!

it('Promotion explains Club and Thread separately and its Clubs action uses the original directory entry', async () => {
  const open = vi.spyOn(floating, 'requestPmoTeamsTopicFloatingOpen').mockImplementation(() => {}), close = vi.fn()
  await dom.render(<TopicDirectorySettingsPane config={useAppStore.getState().config!} onClose={close} promotion />)
  expect(dom.container.textContent).toContain('Agent → Mote Thread')
  expect(dom.container.textContent).toContain('Topic → Mote Club')
  expect(dom.container.textContent).toContain('Continue work through Takeover')
  expect(dom.container.textContent).toContain('A new Agent continues the work; the original location, membership and Main remain.')
  expect(dom.container.textContent).not.toContain('same Agent and conversation continue in a Mote with its own space')
  await act(async () => button('Open Clubs').click())
  expect(close).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce()
  expect(motePromotionSettingsModule.searchTargets.some(target => target.id === 'agent-transfer')).toBe(true)
})

it('the original directory settings retain their owner and identify the global roster as Clubs', async () => {
  const open = vi.fn(), save = vi.fn()
  await dom.render(<MoteDirectorySettingsPane view="collaborators" avatarSize={45} onSave={save} onOpen={open} />)
  expect(moteSettingsModule.title).toBe('Clubs')
  await act(async () => button('Open Clubs').click())
  expect(open).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled()
})

it('the actual Topic menu names the Club result and preserves its Promotion action', async () => {
  const promote = vi.fn(), noop = () => {}
  await dom.render(<TopicActionsMenu title="Original direction" pinned={false} onPromote={promote}
    onCopyPath={noop} onCopyLink={noop} onRename={noop} onReveal={noop} onTogglePin={noop} onEditWiki={noop} />)
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions for Original direction"]')!
  await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); trigger.click() })
  const action = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(node => node.textContent?.trim() === 'Promote to Mote Club…')
  expect(action).toBeDefined()
  expect(action!.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('object.promotion')
  await act(async () => action!.click())
  await vi.waitFor(() => expect(promote).toHaveBeenCalledOnce())
})

it('Topic Club promotion continues a frozen original operation when new promotions are disabled', async () => {
  useAppStore.setState(state => ({ config: { ...state.config!, promotion: { enabled: false } } }))
  const partial = { operationId: 'original-topic-operation', topicId: 'original-topic', state: 'partial', stage: 'spatial',
    topic: null, moteSpaceId: null, unavailable: [], diskDurability: 'confirmed' }
  const call = vi.spyOn(api.topics, 'call').mockResolvedValue({ promotion: partial } as never)
  await dom.render(<TopicPromotionDialog target={{ topicId: partial.topicId, title: 'Original direction' }} onClose={() => {}} onPromoted={() => {}} />)
  expect(button('继续晋升').disabled).toBe(false)
  expect(document.querySelector('.topic-promotion__journey')?.textContent).toContain('MOTE CLUB')
  await act(async () => button('继续晋升').click())
  expect(call).toHaveBeenLastCalledWith('topic.promote.apply', { topicId: partial.topicId, operationId: partial.operationId })
})
