import { fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/components/AgentMarkdown'
import { ConversationMessage } from '../src/components/ConversationMessage'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
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
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const adapter: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null,
  renderAgentLink: reference => <button data-reference={reference.agentSessionId} data-uri={reference.uri}>{reference.label ?? reference.agentSessionId}</button> }
const uri = 'amux://agent/original%2FSID%20%E4%B8%AD%E6%96%87'
const sid = 'original/SID 中文'
const refs = () => Array.from(container.querySelectorAll<HTMLElement>('[data-reference]'))

describe('Agent references in the shared production conversation', () => {
  it('handles bare-text fast paths, Chinese prose, repetitions and explicit labels with the original identity', async () => {
    await render(<ClientUiProvider platform={adapter}><ConversationMessage speaker={{ role: 'human', id: 'human' }}
      content={`联系${uri}，再联系 ${uri}`} /></ClientUiProvider>)
    expect(refs()).toHaveLength(2)
    expect(refs().map(node => [node.dataset.reference, node.dataset.uri])).toEqual([[sid, uri], [sid, uri]])
    expect(container.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('human')
    await render(<ClientUiProvider platform={adapter}><AgentMarkdown content={`请交给 [**review** agent](${uri})。`} /></ClientUiProvider>)
    expect(refs()).toHaveLength(1); expect(refs()[0]!.textContent).toBe('review agent')
    expect(refs()[0]!.dataset.reference).toBe(sid)
  })
  it('keeps code, inert previews, other object kinds and invalid or nested URLs literal', async () => {
    const unsafe = ['amux://agent/%ZZ', 'amux://agent/a?send=x', 'amux://agent/a#b', 'amux://agent/%61', 'amux://tab/a', 'https://example.test/?link=amux://agent/a']
    await render(<ClientUiProvider platform={adapter}><AgentMarkdown content={unsafe.join(' ')} /></ClientUiProvider>)
    expect(refs()).toHaveLength(0)
    await render(<ClientUiProvider platform={adapter}><AgentMarkdown content={`\`${uri}\`\n\n\`\`\`text\n${uri}\n\`\`\`\n\n[${uri}](https://example.test)`} /></ClientUiProvider>)
    expect(refs()).toHaveLength(0); expect(container.querySelectorAll('code')).toHaveLength(2)
    await render(<ClientUiProvider platform={adapter}><AgentMarkdown content={`${uri} [agent](${uri})`} readOnly /></ClientUiProvider>)
    expect(refs()).toHaveLength(0); expect(container.querySelectorAll('button')).toHaveLength(0)
    await render(<AgentMarkdown content={uri} />)
    expect(container.textContent).toBe(uri)
  })
  it('retains URI punctuation as identity instead of silently guessing a shorter SID, and preserves surrounding file actions', async () => {
    const openWorkspaceFile = vi.fn()
    await render(<ClientUiProvider platform={adapter}><AgentMarkdown workspaceRoot={fixturePath("repo")} openWorkspaceFile={openWorkspaceFile}
      content={'amux://agent/id.\n\nRead `src/main.ts:7` and amux://agent/name(1)'} /></ClientUiProvider>)
    expect(refs().map(node => node.dataset.reference)).toEqual(['id.', 'name(1)'])
    await click(container.querySelector<HTMLElement>('button.md-link--file')!)
    expect(openWorkspaceFile).toHaveBeenCalledWith('src/main.ts', { line: 7 }, expect.anything())
  })
})
