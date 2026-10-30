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
const pages: ClientUiPlatform = { ...adapter, renderCapsuleEmbed: input => <section data-page={input.capsuleId}
  data-uri={input.uri} data-key={input.presentationKey} data-visible={input.visible}>{input.title || 'Saved page'}</section> }
const pageIds = () => Array.from(container.querySelectorAll<HTMLElement>('[data-page]')).map(element => element.dataset.page)
async function renderPages(content: string, props: Partial<Parameters<typeof AgentMarkdown>[0]> = {}, platform = pages) {
  await render(<ClientUiProvider platform={platform}><AgentMarkdown content={content} embedIdentity="original-message" {...props} /></ClientUiProvider>)
}

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

it('embeds ordinary bare Capsule references beside their original prose without repeating the same block page', async () => {
  const second = 'amux://capsule/ABCDEFGHJKLM'
  await renderPages(`Read ${uri} and **${second}** then ${uri}`)
  expect(pageIds()).toEqual(['123456789ABC', 'ABCDEFGHJKLM'])
  expect(container.querySelector('.md-paragraph')?.textContent).toBe(`Read ${uri} and ${second} then ${uri}`)
  expect(container.querySelectorAll('[data-capsule-reference]')).toHaveLength(3)
  expect(Array.from(container.querySelectorAll<HTMLElement>('[data-page]')).map(node => node.dataset.uri)).toEqual([uri, second])
  expect(container.querySelector('.md-paragraph [data-page]')).toBeNull()
  await renderPages(uri)
  expect(pageIds()).toEqual(['123456789ABC'])
  expect(container.querySelector('.md-paragraph')).toBeNull()
})

it('embeds ordinary Markdown Capsule references while preserving sentence text and the exact original page', async () => {
  await renderPages(`已重做成[图标候选与实际尺寸对比](${uri})，可以直接看。`)
  expect(pageIds()).toEqual(['123456789ABC'])
  expect(container.querySelector('.md-paragraph')?.textContent).toBe('已重做成图标候选与实际尺寸对比，可以直接看。')
  expect(container.querySelector('[data-page]')?.textContent).toBe('图标候选与实际尺寸对比')
  expect(container.querySelector('[data-page]')?.getAttribute('data-uri')).toBe(uri)
  expect(container.querySelector('.md-paragraph')?.nextElementSibling?.getAttribute('data-capsule-embed')).toBe('123456789ABC')
  await renderPages(`[Direct page](${uri})`)
  expect(pageIds()).toEqual(['123456789ABC'])
  expect(container.querySelector('.md-paragraph')).toBeNull()
})

it('keeps original image presentation positions and deduplicates mixed syntax within one block', async () => {
  const second = 'amux://capsule/ABCDEFGHJKLM'
  await renderPages(`![Original page](${uri}) ![Second page](${second})`)
  const firstKey = container.querySelector('[data-page]')?.getAttribute('data-key')
  expect(firstKey).toBe(JSON.stringify(['original-message', '0', 0, uri]))
  expect(container.querySelectorAll('[data-page]')[1]?.getAttribute('data-key')).toBe(JSON.stringify(['original-message', '0', 2, second]))
  await renderPages(`![Original page](${uri}) [same page](${uri}) ${uri}`)
  expect(pageIds()).toEqual(['123456789ABC'])
  expect(container.querySelector('[data-page]')?.getAttribute('data-key')).toBe(firstKey)
  await renderPages(`![Original page](${uri})\n\n[Separate reading block](${uri})`)
  expect(pageIds()).toEqual(['123456789ABC', '123456789ABC'])
  expect(new Set(Array.from(container.querySelectorAll<HTMLElement>('[data-page]')).map(node => node.dataset.key)).size).toBe(2)
})

it('places heading, list, quote, table and footnote pages after their owning block with legal markup', async () => {
  const refs = ['HeadingPage1', 'ListPage1234', 'QuotePage123', 'TablePage123', 'FootnotePage'].map(id => `amux://capsule/${id}`)
  await renderPages(`# Title [heading](${refs[0]})\n\n- List ${refs[1]}\n\n> Quote [page](${refs[2]})\n\n| Result |\n| --- |\n| [Table page](${refs[3]}) |\n\nFootnote[^page].\n\n[^page]: Footnote [page](${refs[4]})`)
  expect(pageIds()).toEqual(['HeadingPage1', 'ListPage1234', 'QuotePage123', 'TablePage123', 'FootnotePage'])
  expect(container.querySelectorAll('p [data-page], table [data-page], th [data-page], td [data-page]')).toHaveLength(0)
  expect(container.querySelector('.md-heading')?.nextElementSibling?.getAttribute('data-capsule-embed')).toBe('HeadingPage1')
  expect(container.querySelector('.md-table-scroll')?.nextElementSibling?.getAttribute('data-capsule-embed')).toBe('TablePage123')
  expect(container.querySelector('.md-list > li [data-page]')?.getAttribute('data-page')).toBe('ListPage1234')
  expect(container.querySelector('blockquote [data-page]')?.getAttribute('data-page')).toBe('QuotePage123')
  expect(container.querySelector('.md-footnotes [data-page]')?.getAttribute('data-page')).toBe('FootnotePage')
})

it('keeps code, math, noncanonical references and other link labels inert for page rendering', async () => {
  await renderPages(`\`${uri}\`\n\n\`\`\`md\n[example](${uri})\n\`\`\`\n\n$\\text{${uri}}$\n\n[${uri}](https://example.test)\n\n[invalid](${uri}?reply=yes)`)
  expect(pageIds()).toEqual([])
  expect(container.textContent).toContain(uri)
})

it('retains readable ordinary references without page work in readOnly, document and unsupported readers', async () => {
  const renderPage = vi.fn(pages.renderCapsuleEmbed!)
  const platform = { ...pages, renderCapsuleEmbed: renderPage }
  for (const props of [{ readOnly: true }, { documentMode: true }, { embedIdentity: undefined }]) {
    await renderPages(`Read [page](${uri}) and ${uri}`, props, platform)
    expect(pageIds()).toEqual([])
    expect(container.textContent).toContain('Read page and')
  }
  await renderPages(`[page](${uri})`, {}, adapter)
  expect(pageIds()).toEqual([])
  expect(container.querySelector('[data-capsule-reference]')?.getAttribute('data-uri')).toBe(uri)
  expect(renderPage).not.toHaveBeenCalled()
})
