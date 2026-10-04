// @vitest-environment happy-dom
import { fixtureIso } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { parseAgentMarkdownDocument } from '../src/lib/agent-markdown.js'

let container: HTMLDivElement, root: Root
const copy = vi.fn(async (_text: string) => true)
const openLink = vi.fn()
const platform: ClientUiPlatform = {
  copyText: copy, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ speaker }) => <span data-avatar-role={speaker.role} />,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  copy.mockClear(); openLink.mockClear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function render(node: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
function element(selector: string, scope: ParentNode = container): HTMLElement {
  const found = scope.querySelector<HTMLElement>(selector)
  expect(found, `Actual mounted element ${selector}`).not.toBeNull()
  return found!
}
async function click(node: HTMLElement) { await act(async () => node.click()) }

const headings = Array.from({ length: 6 }, (_, i) => `${'#'.repeat(i + 1)} Heading ${i + 1}`).join('\n\n')

describe('incoming Markdown in the shared conversation caller', () => {
  it('retains all source heading markers and nested markers without inventing setext markers', async () => {
    const content = `${headings}\n\n> ### Quoted\n\n- #### Nested\n\nSetext\n------\n\n\\# Literal\n\n\`\`\`md\n# Code\n\`\`\`\n\n#`
    await render(<ConversationMessage content={content} speaker={{ role: 'human', id: 'human' }} />)
    const rendered = [...container.querySelectorAll('.md-input .md-heading')]
    expect(rendered.map(node => node.textContent)).toEqual([
      ...Array.from({ length: 6 }, (_, i) => `${'#'.repeat(i + 1)} Heading ${i + 1}`), '### Quoted', '#### Nested', 'Setext', '#'
    ])
    expect(container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(element('pre code').textContent).toBe('# Code')
    expect(container.textContent).toContain('# Literal')
    expect(parseAgentMarkdownDocument('Plain\n===\n\n# ATX').headings.map(node => node.sourceMarker)).toEqual([undefined, '#'])
    await click(element('[aria-label="Copy message"]'))
    expect(copy).toHaveBeenCalledExactlyOnceWith(content, expect.any(Function))
  })

  it('uses complete grammar for standalone autolinks and indented code only in incoming messages', async () => {
    await render(<>
      <ConversationMessage messageId="incoming-link" content="<https://example.com/review>" speaker={{ role: 'unknown', id: 'unknown' }} openHttpLink={openLink} />
      <ConversationMessage messageId="incoming-code" content="    # literal code" speaker={{ role: 'human', id: 'human' }} />
      <ConversationMessage messageId="reply" content="<https://example.com/review>" speaker={{ role: 'agent', id: 'execution' }} conversationSessionId="execution" />
    </>)
    const input = element('[data-message-id="incoming-link"]')
    expect(element('.md-input button.md-link', input).textContent).toBe('https://example.com/review')
    await click(element('button.md-link', input))
    expect(openLink).toHaveBeenCalledExactlyOnceWith('https://example.com/review', expect.objectContaining({ metaKey: false, ctrlKey: false }))
    expect(element('[data-message-id="incoming-code"] pre code').textContent).toBe('# literal code')
    const reply = element('[data-message-id="reply"]')
    expect(reply.querySelector('.md-input')).toBeNull()
    expect(reply.textContent).toContain('<https://example.com/review>')
  })

  it('preserves full GFM structure, raw HTML, exact original copying and selectable rendered text', async () => {
    const content = '3. Third\n   - [x] Done\n   - [ ] Next\n\n> **Quoted** and *italic*\n\n| A | B |\n| --- | ---: |\n| one | two |\n\n`code` ~~removed~~\n\n<script>literal</script>'
    await render(<ConversationMessage content={content} speaker={{ role: 'human', id: 'human' }} />)
    expect((element('ol') as HTMLOListElement).start).toBe(3)
    const tasks = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(tasks.map(node => [node.checked, node.disabled])).toEqual([[true, true], [false, true]])
    expect(element('.md-quote strong').textContent).toBe('Quoted')
    expect(element('th[data-align="right"]').textContent).toBe('B')
    expect(element('.md-code').textContent).toBe('code')
    expect(element('del').textContent).toBe('removed')
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>literal</script>')
    const text = element('.md-quote strong').firstChild!
    const range = document.createRange(); range.selectNodeContents(text)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    expect(selection.toString()).toBe('Quoted')
    await click(element('[aria-label="Copy message"]'))
    expect(copy).toHaveBeenCalledExactlyOnceWith(content, expect.any(Function))
  })

  it('uses the same input mode for incoming packet and citation while execution and document headings remain unchanged', async () => {
    const content = ("[Message from Agent peer]\n<bagakit-msg type=\"agent-v1\" name=\"Peer\" time=\"" + fixtureIso() + "\"># Packet\n<cite from=\"User\">## Cited</cite></bagakit-msg>")
    await render(<>
      <ConversationMessage messageId="peer" content={content} conversationSessionId="execution" speaker={{ role: 'agent', id: 'peer' }} />
      <ConversationMessage messageId="reply" content="# Reply" conversationSessionId="execution" speaker={{ role: 'agent', id: 'execution' }} />
      <AgentMarkdown content="# Document" documentMode outline />
    </>)
    expect([...element('[data-message-id="peer"]').querySelectorAll('.md-input .md-heading')].map(node => node.textContent)).toEqual(['# Packet', '## Cited'])
    expect(element('[data-message-id="reply"] .md-heading').textContent).toBe('Reply')
    expect(element('h1').textContent).toBe('Document')
    expect(element('.md-outline__trigger')).toBeTruthy()
    await click(element('[data-message-id="peer"] [aria-label="Copy message"]'))
    expect(copy).toHaveBeenCalledExactlyOnceWith(content, expect.any(Function))
  })

  it('keeps metadata outside the title and preserves body and selection while details open', async () => {
    const content = '这项目有多少个提交, 多少行变更了?'
    const source = { kind: 'native' as const, providerId: 'grok' as const, nativeSessionId: 'native', recordId: 'record' }
    const card = () => <ConversationMessage messageId="question" content={content} createdAt={1000} speaker={{ role: 'human', id: 'human' }} inputSource={source} showInputSource />
    await render(card())
    const head = element('.log-turn__head'), title = element('.log-turn__title')
    const meta = element('.log-turn__meta'), body = element('.log-turn__body')
    expect(title.parentElement).toBe(head)
    expect(element('.log-turn__time').parentElement).toBe(head)
    expect(meta.parentElement).toBe(head.parentElement)
    expect(head.querySelector('.log-turn__input-source')).toBeNull()
    expect(meta.textContent).toContain('原生 - 未知来源')
    const text = element('.md-paragraph', body).firstChild!
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 3)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const info = element('[aria-label="Message details"]')
    info.focus(); expect(document.activeElement).toBe(info)
    await click(info)
    expect(info.getAttribute('aria-expanded')).toBe('true')
    expect(element('.conversation-input-details__body').closest('.log-turn__head')).toBe(head)
    expect(element('.log-turn__body')).toBe(body)
    expect(selection.toString()).toBe('这项目')
    await render(card())
    expect(element('.log-turn__body')).toBe(body)
    expect(element('[aria-label="Message details"]')).toBe(info)
    expect(selection.anchorNode).toBe(text)
    await click(info); expect(info.getAttribute('aria-expanded')).toBe('false')
    await click(element('[aria-label="Copy message"]'))
    expect(copy).toHaveBeenCalledExactlyOnceWith(content, expect.any(Function))
  })

  it('reads provider ranges through the actual ConversationView while Copy retains the complete original', async () => {
    const raw = '<user_query>\n# User **request**\n\n<https://example.com>\n</user_query>'
    const start = '<user_query>\n'.length, end = raw.length - '\n</user_query>'.length
    await render(<ConversationView sessionId="execution" page={{ agentSessionId: 'execution', source: { providerId: 'grok', nativeSessionId: 'native' }, nextCursor: null,
      items: [{ id: 'record', kind: 'user-message', contentParts: [{ kind: 'text', text: raw, readingRange: { start, end } }] }] }} />)
    expect(element('.md-input .md-heading').textContent).toBe('# User request')
    expect(element('.md-input strong').textContent).toBe('request')
    expect(container.textContent).not.toContain('<user_query>')
    await click(element('[aria-label="Copy message"]'))
    expect(copy).toHaveBeenCalledExactlyOnceWith(raw, expect.any(Function))
  })
})
