import { fixturePath as _hygiene_fixturePath, fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../../../packages/client-ui/src/components/AgentMarkdown'
import { ConversationMessage } from '../../../packages/client-ui/src/components/ConversationMessage'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { SessionSnapshot } from '../src/shared/contracts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const originalStore = useAppStore.getState()
beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined))
let root: Root | undefined, container: HTMLDivElement
async function render(content: ReactNode) {
  if (!root) { container = document.createElement('div'); document.body.append(container); root = createRoot(container) }
  await act(async () => root!.render(content))
}
async function click(element: HTMLElement) { await act(async () => element.click()) }
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove()
  document.querySelector('#agentmux-window-overlay-host')?.remove()
  useAppStore.setState(originalStore); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const uri = 'amux://agent/original%2FSID%20%E4%B8%AD%E6%96%87'
const sid = 'original/SID 中文'
function agent(label = 'Interface reviewer'): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id: sid, kind: 'agent', providerId: 'codex', executorId: 'reviewer', label, hostId: 'local', workspacePath: _hygiene_fixturePath("repo"),
    createdAt: 1, updatedAt: 2, agentSessionUpdatedAt: 2, processState: 'running', latestOutputBytes: 0,
    status: { state: 'working', source: 'native-hook', observedAt: _hygiene_fixtureTime(24474400000) },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'kept-run' } } }
}
describe('Desktop Agent links in the shared production conversation', () => {
  it('uses the real Desktop adapter, updates the linked name, shows lazy details, copies the URI and routes the same identity', async () => {
    const open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
    useAppStore.setState({ sessions: [agent()], agentComposerDrafts: { [sid]: 'Keep my draft' } })
    await render(<DesktopClientUiProvider><ConversationMessage speaker={{ role: 'agent', id: 'different-author' }} name="Author"
      content={`请联系 ${uri}，或 [审核同事](${uri})。`} /></DesktopClientUiProvider>)
    const links = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button.agent-avatar--inline'))
    expect(links()).toHaveLength(2)
    expect(links()[0]!.textContent).toContain('Interface reviewer'); expect(links()[1]!.textContent).toContain('审核同事')
    expect(container.querySelector('button button')).toBeNull()
    expect(document.querySelector('.inline-agent-link__details')).toBeNull()
    await act(async () => { useAppStore.setState({ sessions: [agent('Renamed reviewer')] }) })
    expect(links()[0]!.textContent).toContain('Renamed reviewer')
    await act(async () => links()[0]!.focus())
    const details = document.querySelector<HTMLElement>('.agent-identity-popover')!
    expect(details).not.toBeNull(); expect(details.textContent).toContain(sid); expect(details.textContent).toContain('Current details')
    await act(async () => window.dispatchEvent(new Event('scroll')))
    expect(document.querySelector('.agent-identity-popover')).not.toBeNull()
    const copyButton = [...details.querySelectorAll('button')].find(node => node.textContent === 'Copy Agent Link')!
    await click(copyButton); expect(copy).toHaveBeenCalledExactlyOnceWith(uri)
    await click(container.querySelector<HTMLElement>('[aria-label="Copy message"]')!)
    expect(copy).toHaveBeenLastCalledWith(`请联系 ${uri}，或 [审核同事](${uri})。`)
    await click(links()[0]!); expect(open).toHaveBeenCalledExactlyOnceWith(uri)
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Keep my draft')
    expect(useAppStore.getState().sessions[0]!.control).toMatchObject({ run: { runId: 'kept-run' } })
  })
  it('keeps an unobserved target visible and navigable and reports navigation failure at the existing error owner', async () => {
    useAppStore.setState({ sessions: [] })
    const error = new Error('Original location is unconfirmed'), report = vi.fn()
    useAppStore.setState({ reportError: report })
    const open = vi.spyOn(api.ui, 'openObjectLink').mockRejectedValue(error)
    await render(<DesktopClientUiProvider><AgentMarkdown content={uri} /></DesktopClientUiProvider>)
    const link = container.querySelector<HTMLButtonElement>('button.agent-avatar--inline')!
    expect(link.disabled).toBe(false); expect(link.textContent).toContain(sid)
    await act(async () => link.focus())
    expect(document.querySelector('.agent-identity-popover')!.textContent).toContain('details are unavailable')
    await click(link); expect(open).toHaveBeenCalledWith(uri); expect(report).toHaveBeenCalledExactlyOnceWith(error)
  })
  it('stops working motion offscreen without changing the Agent state or opening details', async () => {
    let notify: IntersectionObserverCallback | undefined
    vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { notify = callback } observe() {} disconnect() {} })
    useAppStore.setState({ sessions: [agent()] })
    await render(<DesktopClientUiProvider><AgentMarkdown content={uri} /></DesktopClientUiProvider>)
    const link = container.querySelector<HTMLElement>('.inline-agent-link')!
    expect(link.dataset.motion).toBe('off')
    await act(async () => notify!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(link.dataset.motion).toBe('on')
    await act(async () => notify!([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(link.dataset.motion).toBe('off'); expect(useAppStore.getState().sessions[0]!.status.state).toBe('working')
    expect(document.querySelector('.inline-agent-link__details')).toBeNull()
  })
})

const regionUri = 'amux://region/region%3Alauncher%3A0ef42075-2820-47b9-afcf-66bb99ea2eb8'
describe('Desktop spatial links in the shared production conversation', () => {
  it('renders the exact Region as a compact object action in bare and Markdown prose and copies the unmodified message', async () => {
    const open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
    const raw = `打开 ${regionUri}，或者 [原工作格](${regionUri})。`
    await render(<DesktopClientUiProvider><ConversationMessage content={raw} speaker={{role:'human',id:'human'}} /></DesktopClientUiProvider>)
    const links = [...container.querySelectorAll<HTMLButtonElement>('button[data-object-link-open]')]
    expect(links).toHaveLength(2)
    expect(links[0]!.textContent).toContain('Region'); expect(links[0]!.title).toContain('region:launcher:0ef42075-2820-47b9-afcf-66bb99ea2eb8')
    expect(links[1]!.textContent).toBe('原工作格')
    expect(container.querySelector('button button')).toBeNull()
    await click(links[0]!); expect(open).toHaveBeenCalledExactlyOnceWith(regionUri)
    await click(container.querySelector<HTMLElement>('[aria-label="Copy Region link"]')!); expect(copy).toHaveBeenLastCalledWith(regionUri)
    await click(container.querySelector<HTMLElement>('[aria-label="Copy message"]')!); expect(copy).toHaveBeenLastCalledWith(raw)
  })
  it('keeps each other existing spatial kind exact and reports failed open and copy through the original error owner', async () => {
    const error = new Error('Original object unavailable'), report = vi.fn(); useAppStore.setState({reportError:report})
    const open = vi.spyOn(api.ui, 'openObjectLink').mockRejectedValue(error)
    vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValue(error)
    await render(<DesktopClientUiProvider><AgentMarkdown content={'amux://tab/tab%3Aoriginal amux://space/space%3Aoriginal amux://zone/zone%3Aoriginal'} /></DesktopClientUiProvider>)
    const links=[...container.querySelectorAll<HTMLButtonElement>('button[data-object-link-open]')]
    expect(links).toHaveLength(3)
    for(const [index,kind] of ['Tab','Space','Zone'].entries()){
      expect(links[index]!.textContent).toContain(kind); expect(links[index]!.disabled).toBe(false)
      await click(links[index]!);expect(open).toHaveBeenLastCalledWith(`amux://${kind.toLowerCase()}/${kind.toLowerCase()}%3Aoriginal`)
    }
    await click(container.querySelector<HTMLElement>('[aria-label="Copy Tab link"]')!)
    expect(report).toHaveBeenCalledTimes(4);expect(report).toHaveBeenLastCalledWith(error)
    expect(container.querySelector('[aria-label="Tab link copied"]')).toBeNull()
  })
  it('binds copy success to the exact URI across the same mounted link and a late reply', async () => {
    let resolveCopy!: () => void
    vi.spyOn(api.ui, 'writeClipboardText').mockImplementationOnce(() => new Promise<void>(resolve => { resolveCopy = resolve }))
    const view = (uri: string) => <DesktopClientUiProvider><AgentMarkdown content={uri} /></DesktopClientUiProvider>
    await render(view(regionUri))
    const original = container.querySelector('[data-object-link-open]')
    expect(original).not.toBeNull()
    await click(container.querySelector<HTMLElement>('[aria-label="Copy Region link"]')!)
    const replacement = 'amux://region/region%3Aother'
    await render(view(replacement))
    expect(container.querySelector('[data-object-link-open]')).toBe(original)
    await act(async () => resolveCopy())
    expect(container.querySelector('[aria-label="Region link copied"]')).toBeNull()
    expect(container.querySelector('[aria-label="Copy Region link"]')).not.toBeNull()
    await click(container.querySelector<HTMLElement>('[aria-label="Copy Region link"]')!)
    expect(container.querySelector('[aria-label="Region link copied"]')).not.toBeNull()
  })

})
