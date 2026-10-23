import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/components/AgentMarkdown'
import { ConversationMessage } from '../src/components/ConversationMessage'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import { objectLinkReference, splitObjectLinkReferences } from '../src/lib/object-link-reference'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined))
let root: Root | undefined, container: HTMLDivElement
async function render(content: ReactNode) {
  if (!root) { container = document.createElement('div'); document.body.append(container); root = createRoot(container) }
  await act(async () => root!.render(content))
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const uri = 'amux://capsule/123456789ABC'
const adapter: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null,
  renderObjectLink: reference => <button data-capsule-reference={reference.target.kind === 'capsule' ? reference.target.capsuleId : ''} data-uri={reference.uri}>{reference.label ?? reference.uri}</button> }

it('delivers the same exact Capsule reference through both shared Markdown and plain conversation readers', async () => {
  expect(objectLinkReference(uri)).toEqual({ uri, target: { kind: 'capsule', capsuleId: '123456789ABC' } })
  expect(splitObjectLinkReferences(`Read ${uri}`)).toMatchObject([{ kind: 'text', text: 'Read ' }, { kind: 'object', reference: { uri, target: { kind: 'capsule', capsuleId: '123456789ABC' } } }])
  await render(<ClientUiProvider platform={adapter}><AgentMarkdown content={`Read ${uri} and [review page](${uri}).`} /></ClientUiProvider>)
  const refs = () => Array.from(container.querySelectorAll<HTMLElement>('[data-capsule-reference]'))
  expect(refs()).toHaveLength(2)
  expect(refs().map(element => [element.dataset.capsuleReference, element.dataset.uri])).toEqual([['123456789ABC', uri], ['123456789ABC', uri]])
  await render(<ClientUiProvider platform={adapter}><ConversationMessage speaker={{ role: 'assistant', id: 'original' }} content={`Generated ${uri}`} /></ClientUiProvider>)
  expect(refs()).toHaveLength(1); expect(refs()[0]!.dataset.uri).toBe(uri)
})

it('keeps executable or noncanonical Capsule links inert and preserves document mode', async () => {
  const invalid = [uri + '?reply=yes', uri + '#open', 'amux://capsule/%31', uri + '/child']
  expect(invalid).toHaveLength(4)
  for (const value of invalid) expect(objectLinkReference(value)).toBeNull()
  await render(<ClientUiProvider platform={adapter}><AgentMarkdown content={invalid.join(' ')} /></ClientUiProvider>)
  expect(container.querySelectorAll('[data-capsule-reference]')).toHaveLength(0)
  await render(<ClientUiProvider platform={adapter}><AgentMarkdown content={uri} documentMode /></ClientUiProvider>)
  expect(container.querySelectorAll('button')).toHaveLength(0)
})
