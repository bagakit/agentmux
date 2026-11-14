// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { MoteThreadsPanel } from '../src/renderer/src/components/MoteThreadsPanel'
import { MoteDialogueViewContext } from '../src/renderer/src/lib/mote-dialogue-view'
import { useAppStore } from '../src/renderer/src/store'
import { moteConfig, seedMoteWorkface } from './fixtures/mote-workface'
import type { WorkbenchProjectionSelection } from '../src/renderer/src/lib/workbench-projection'

const facts = vi.hoisted(() => ({ locations: [
  { displayWorkspaceId: 'workspace-one', groupId: 'group-one', tabId: 'tab-original', regionId: 'region-original' },
  { displayWorkspaceId: 'workspace-two', groupId: 'group-two', tabId: 'tab-original', regionId: 'region-original' },
  { displayWorkspaceId: 'workspace-one', groupId: 'group-one', tabId: 'tab-original', regionId: 'region-original' }
] }))
vi.mock('../src/renderer/src/lib/mote-team', () => ({ moteMembers: () => [{ hostId: 'worker-host', agentSessionId: 'worker-original', regions: [], locations: facts.locations }] }))
vi.mock('../src/renderer/src/lib/desktop-focus-navigation', () => ({ workbenchSelectionCatalog: () => ({
  regions: [{ tabId: 'tab-original', regionId: 'region-original', kind: 'agent', agentSessionId: 'worker-original', execution: { hostId: 'worker-host' } }],
  locations: facts.locations
}) }))
vi.mock('../src/renderer/src/components/MoteCooperation', () => ({ MoteCooperation: () => null }))
vi.mock('@agentmux/client-ui/components/MoteConversationThreads', () => ({ MoteWorkThreads: ({ onOpenWork }: any) =>
  <button onClick={() => onOpenWork({ origin: { hostId: 'worker-host', recipientSessionId: 'worker-original' } })}>打开原工作</button> }))
const original = useAppStore.getState()
let root: ReturnType<typeof createClientUiRoot> | undefined, host: HTMLDivElement | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); useAppStore.setState(original, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('names each original thread position from its Workspace while selection retains the complete original reference', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seedMoteWorkface()
  useAppStore.setState({ config: { ...moteConfig, workspaces: [...moteConfig.workspaces,
    { ...moteConfig.workspaces[1]!, id: 'workspace-one', name: '设计项目' }] } })
  const select = vi.fn<(_: WorkbenchProjectionSelection) => boolean>(() => true)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  await act(async () => root!.render(<MoteDialogueViewContext.Provider value={{ target: { spaceId: 'mote-original' }, page: null } as any}>
    <MoteThreadsPanel scope={{} as any} active onSelect={() => false} onOpenOriginal={select} />
  </MoteDialogueViewContext.Provider>))
  await act(async () => host!.querySelector<HTMLButtonElement>('button')!.click())
  const positions = host.querySelector<HTMLElement>('[aria-label="选择原工作位置"]')!
  expect(positions).not.toBeNull()
  const buttons = positions.querySelectorAll<HTMLButtonElement>('button')
  expect(buttons).toHaveLength(3)
  expect(buttons[0]!.textContent).toContain('设计项目'); expect(buttons[1]!.textContent).toContain('项目未确认')
  expect(positions.textContent).not.toContain('workspace-one'); expect(positions.textContent).not.toContain('workspace-two')
  await act(async () => buttons[1]!.click())
  expect(select).toHaveBeenCalledExactlyOnceWith(facts.locations[1])
  expect(host.querySelector('[aria-label="选择原工作位置"]')).toBeNull()
})
