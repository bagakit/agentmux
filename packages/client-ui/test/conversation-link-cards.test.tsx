import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { readingMatches } from '../src/lib/reading-find.js'
import { ReadingFind } from '../src/components/ReadingFind.js'
import { ConversationBodyWorkContext } from '../src/components/ConversationProgressiveBody.js'
import { ConversationBodyWork } from '../src/lib/conversation-body-work.js'

const uri = 'https://docs.example.test/guide/%E6%B5%8B%E8%AF%95?q=hello%20world&lang=zh#details'
const label = '架构参考：让每一个原始链接都可以核对'
let host: HTMLDivElement, root: Root
const open = vi.fn(), copy = vi.fn(async () => true), fetch = vi.fn(), external = vi.fn()
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', fetch); vi.stubGlobal('open', external)
  open.mockClear(); copy.mockClear(); fetch.mockClear(); external.mockClear()
  copy.mockResolvedValue(true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const render = async (node: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>))
const message = (content: string, role: 'agent' | 'human' = 'agent') => <ConversationMessage messageId="original-message" conversationSessionId="original-agent"
  speaker={{ role, id: role === 'agent' ? 'original-agent' : 'original-human' }} content={content} openHttpLink={open} />
const cards = () => host.querySelectorAll('.md-link-card')

describe('local conversation link cards through the actual shared consumer', () => {
  it('renders an authored standalone link from the actual Agent message with its exact target', async () => {
    await render(message(`[${label}](${uri})`))
    expect(cards()).toHaveLength(1)
    expect(cards()[0]!.textContent).toContain(label)
    expect(cards()[0]!.textContent).toContain('docs.example.test')
    expect(cards()[0]!.querySelector('.md-link-card__open')).not.toBeNull()
    expect(cards()[0]!.querySelector('details')?.textContent).toContain(uri)
  })
  it('reaches cards for bare URL messages and independent bare URL paragraphs', async () => {
    for (const content of [uri, `原始阅读入口。\n\n${uri}\n\n接着讨论。`]) {
      await render(message(content)); expect(cards()).toHaveLength(1)
    }
  })
  it('preserves the shared grammar for uppercase HTTP autolinks', async () => {
    await render(message('<HTTPS://example.test>'))
    expect(cards()).toHaveLength(1)
    await act(async () => (host.querySelector('.md-link-card__open') as HTMLButtonElement).click())
    expect(open.mock.calls.at(-1)?.[0]).toBe('https://example.test/')
    await render(message('HTTPS://example.test'))
    expect(cards()).toHaveLength(1)
  })
  it('uses the same independent-link rule in user input while retaining literal heading markers', async () => {
    await render(message(`# 我的阅读入口\n\n[${label}](${uri})`, 'human'))
    expect(cards()).toHaveLength(1)
    expect(host.querySelector('.md-heading')?.textContent).toBe('# 我的阅读入口')
  })
  it('keeps inline prose and nested Markdown meanings instead of promoting every link', async () => {
    for (const content of [`正文里的 [原始链接](${uri}) 继续阅读。`, `# [标题](${uri})`,
      `- [列表](${uri})`, `> [引用](${uri})`, `| 参考 |\n| --- |\n| [表格](${uri}) |`,
      `\`[代码](${uri})\``, `\`\`\`text\n${uri}\n\`\`\``, `[第一个](${uri}) [第二个](${uri})`]) {
      await render(message(content)); expect(cards(), content).toHaveLength(0)
    }
  })
  it('preserves document, readonly and missing-adapter behavior', async () => {
    for (const props of [{ documentMode: true, openHttpLink: open }, { readOnly: true, openHttpLink: open }, {}]) {
      await render(<AgentMarkdown content={`[${label}](${uri})`} {...props} />)
      expect(cards()).toHaveLength(0)
      expect(host.textContent).toContain(label)
    }
    expect(open).not.toHaveBeenCalled()
  })
  it('does not claim file, internal object, image or unsupported-scheme semantics', async () => {
    for (const content of ['[文件](./README.md)', '[对象](amux://session/original-agent)',
      '![页面](amux://capsule/original-capsule)', '[邮件](mailto:test@example.test)', '[脚本](javascript:alert(1))']) {
      await render(message(content)); expect(cards(), content).toHaveLength(0)
    }
  })
  it('retains the original linked-image consumer instead of replacing its media with a card', async () => {
    const image = vi.fn((href: string, alt: string, linked?: boolean) => <span data-original-media={href}>{alt} {String(linked)}</span>)
    await render(<AgentMarkdown content={`[![原始架构图](https://media.example.test/original.png)](${uri})`} openHttpLink={open} renderImage={image} />)
    expect(cards()).toHaveLength(0)
    expect(host.querySelector('[data-original-media]')?.getAttribute('data-original-media')).toBe('https://media.example.test/original.png')
    expect(host.querySelector('[data-original-media]')?.textContent).toContain('true')
    expect(image).toHaveBeenCalledWith('https://media.example.test/original.png', '原始架构图', true)
  })
  it('passes the exact URI and original click modifiers to the existing Host callback once', async () => {
    await render(message(`[${label}](${uri})`))
    await act(async () => host.querySelector('.md-link-card__open')!.dispatchEvent(new MouseEvent('click', {
      bubbles: true, metaKey: true, ctrlKey: true, altKey: true, clientX: 27, clientY: 46
    })))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenLastCalledWith(uri, { metaKey: true, ctrlKey: true, altKey: true, clientX: 27, clientY: 46 })
  })
  it('copies the complete original URI through ContentCopyButton without opening it', async () => {
    await render(message(`[${label}](${uri})`))
    await act(async () => (host.querySelector('.md-link-card .content-copy') as HTMLButtonElement).click())
    expect(copy).toHaveBeenCalledWith(uri, expect.any(Function))
    expect(open).not.toHaveBeenCalled()
    expect(cards()[0]!.querySelector('.content-copy')?.getAttribute('data-copy-state')).toBe('copied')
  })
  it('keeps the visible authored title and target searchable without footer action labels', async () => {
    await render(message(`[${label}](${uri})`))
    expect(readingMatches(host, label, '.log-turn__body')).toHaveLength(1)
    expect(readingMatches(host, uri, '.log-turn__body')).toHaveLength(1)
    expect(readingMatches(host, 'Copy', '.log-turn__body')).toHaveLength(0)
    expect(readingMatches(host, 'Link address', '.log-turn__body')).toHaveLength(0)
  })
  it('keeps local rendering and unrelated refresh free of metadata, images or Browser opening', async () => {
    await render(message(`[${label}](${uri})`))
    await render(message(`[${label}](${uri})\n\n另一个本地段落。`))
    expect(cards()).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled(); expect(external).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
    expect(host.querySelectorAll('.md-link-card img, .md-link-card iframe, .md-link-card video')).toHaveLength(0)
  })
  it.each(['authored-tail', 'bare-original', 'two-adjacent-cards'])('reattaches the exact deferred reading range (%s)', async kind => {
    const highlights = new Map<string, Set<Range>>()
    class HighlightSet extends Set<Range> { constructor(...ranges: Range[]) { super(ranges) } }
    vi.stubGlobal('Highlight', HighlightSet)
    vi.stubGlobal('CSS', { ...window.CSS, highlights, supports: () => false, escape: (value: string) => value })
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    const work = new ConversationBodyWork()
    const first = '原始参考：' + '这是一份很长但必须可以完整阅读和定位的中文标题。'.repeat(8) + '准确尾部'
    const link = kind === 'bare-original' ? 'https://example.test' : kind === 'two-adjacent-cards'
      ? `[重复参考](${uri})\n\n[重复参考](https://second.example.test)` : `[${first}](${uri})`
    const query = kind === 'bare-original' ? link : kind === 'two-adjacent-cards' ? '重复参考' : '准确尾部'
    const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const current = () => [...highlights].find(([name]) => name.endsWith('-current'))?.[1].values().next().value
    try {
      await render(<><span data-original-selection>原有选择</span><ReadingFind source="original-link-message" label="loaded conversation" bodySelector=".readable" scrollSelector=".viewport">
        <div className="readable viewport"><ConversationBodyWorkContext.Provider value={{ work, active: true }}>
          <AgentMarkdown content={'原正文。'.repeat(520) + '\n\n' + link} openHttpLink={open} />
        </ConversationBodyWorkContext.Provider></div>
      </ReadingFind></>)
      const body = host.querySelector<HTMLElement>('[data-conversation-body-presented]')!
      expect(body?.getAttribute('data-conversation-body-presented')).toBe('false')
      expect(cards()).toHaveLength(0)
      const selection = document.createRange(); selection.selectNodeContents(host.querySelector('[data-original-selection]')!)
      getSelection()!.addRange(selection)
      await act(async () => (host.querySelector('[aria-label="Find in loaded conversation"]') as HTMLButtonElement).click())
      const input = host.querySelector<HTMLInputElement>('input[type="search"]')!; input.focus()
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }); await tick()
      expect(host.querySelector('output')?.textContent).toBe(kind === 'two-adjacent-cards' ? '1 / 2' : '1 / 1')
      expect(body.getAttribute('data-conversation-body-presented')).toBe('false')
      await act(async () => (host.querySelector('[aria-label="Next match"]') as HTMLButtonElement).click()); await tick()
      expect(body.getAttribute('data-conversation-body-presented')).toBe('true')
      expect(current()?.toString()).toBe(query)
      expect(body.contains(current()!.startContainer)).toBe(true)
      expect(current()!.startContainer.parentElement?.closest('.md-link-card')).toBe(cards()[0])
      expect(getSelection()!.getRangeAt(0)).toBe(selection)
      expect(getSelection()!.toString()).toBe('原有选择')
      expect(document.activeElement).toBe(input)
      if (kind === 'two-adjacent-cards') {
        await act(async () => (host.querySelector('[aria-label="Next match"]') as HTMLButtonElement).click()); await tick()
        expect(current()?.toString()).toBe(query)
        expect(current()!.startContainer.parentElement?.closest('.md-link-card')).toBe(cards()[1])
        expect(readingMatches(host, '重复参考重复参考', '.readable')).toHaveLength(0)
      }
      expect(fetch).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
    } finally { work.disconnect() }
  })
})
