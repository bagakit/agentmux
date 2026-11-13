// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import { MarkdownRemoteImage } from '../src/components/MarkdownRemoteImage.js'
import { MarkdownExcerpt } from '../src/components/MarkdownExcerpt.js'
import { parseAgentMarkdown } from '../src/lib/agent-markdown.js'
import { markdownImageReferences } from '../src/lib/conversation-image-references.js'
import { conversationReplyPreview } from '../src/lib/conversation-reply-preview.js'
import { conversationFiles } from '../src/lib/conversation-files.js'
import { mountThemeRuntime, updateThemeSelection } from '../src/theme/runtime.js'
import { ReadingFindBodies } from '../src/lib/reading-find-body.js'
import { ConversationBodyWork } from '../src/lib/conversation-body-work.js'
import { ConversationBodyWorkContext } from '../src/components/ConversationProgressiveBody.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKSPACE = '/workspace/repo'
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(node: ReactNode) { await act(async () => root.render(node)) }
function element<T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = container): T {
  const match = scope.querySelector<T>(selector)
  expect(match, `Mounted Markdown element ${selector}`).not.toBeNull()
  return match!
}
function all<T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = container): T[] {
  return Array.from(scope.querySelectorAll<T>(selector))
}
async function click(target: HTMLElement) {
  await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
}
const workspaceImage = (path: string, alt: string) => <img data-workspace-image={path} alt={alt} />

describe('README HTML subset rendering', () => {
  it('renders alignment, authored size and inline marks without any author attribute reaching the DOM', async () => {
    await render(<AgentMarkdown documentMode workspaceRoot={WORKSPACE} sourcePath="docs/README.md" renderWorkspaceImage={workspaceImage}
      content={'<div align="center">\n\n<img src="hero.webp" alt="Hero" width="72%" onerror="steal()" style="position:fixed">\n\n<b>Bold</b> H<sub>2</sub>O x<sup>2</sup> <kbd>Ctrl</kbd>\n\n</div>'} />)
    expect(element('.md-container').getAttribute('data-align')).toBe('center')
    const frame = element('.md-image-frame')
    expect(frame.style.width).toBe('72%')
    expect(element('[data-workspace-image]', frame).getAttribute('data-workspace-image')).toBe('docs/hero.webp')
    expect(all('sub.md-sub')).toHaveLength(1)
    expect(all('sup.md-sup')).toHaveLength(1)
    expect(all('kbd.md-kbd')).toHaveLength(1)
    expect(container.innerHTML).not.toMatch(/onerror|steal|position:\s*fixed/u)
    expect(container.textContent).not.toMatch(/<\/?(?:div|img|sub|sup|kbd|b)\b/u)
  })

  it('routes HTML links through the same Host destinations as Markdown links', async () => {
    const openHttpLink = vi.fn(), openWorkspaceFile = vi.fn()
    await render(<AgentMarkdown documentMode workspaceRoot={WORKSPACE} sourcePath="docs/README.md" openHttpLink={openHttpLink} openWorkspaceFile={openWorkspaceFile}
      content={'<a href="https://example.com/x">web</a> <a href="guide.md">file</a> <a href="javascript:alert(1)">script</a> <a href="../../outside.md">escape</a>'} />)
    const buttons = all<HTMLButtonElement>('button.md-link')
    expect(buttons.map(button => button.textContent)).toEqual(['web', 'file'])
    await click(buttons[0]!)
    expect(openHttpLink).toHaveBeenCalledWith('https://example.com/x', expect.anything())
    await click(buttons[1]!)
    expect(openWorkspaceFile).toHaveBeenCalledWith('docs/guide.md', undefined, expect.anything())
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('script')
    expect(container.textContent).toContain('escape')
  })

  it('shows the picture variant that matches the App appearance and switches in place', async () => {
    const release = mountThemeRuntime(window, { appAppearance: 'dark' })
    try {
      const content = '<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="arch-dark.svg">\n  <img src="arch-light.svg" alt="Architecture" width="100%">\n</picture>'
      const parse = vi.fn(parseAgentMarkdown)
      await render(<AgentMarkdown documentMode workspaceRoot={WORKSPACE} sourcePath="README.md" renderWorkspaceImage={workspaceImage} content={content} />)
      expect(element('[data-workspace-image]').getAttribute('data-workspace-image')).toBe('arch-dark.svg')
      await act(async () => { updateThemeSelection({ appAppearance: 'light' }) })
      expect(element('[data-workspace-image]').getAttribute('data-workspace-image')).toBe('arch-light.svg')
      expect(element('[data-workspace-image]').getAttribute('alt')).toBe('Architecture')
      expect(parse).not.toHaveBeenCalled()
    } finally { release() }
  })

  it('renders layout tables as cards and data tables with headers, keeping Markdown inside cells', async () => {
    await render(<AgentMarkdown documentMode content={'<table>\n<tr>\n<td width="40%" valign="top">\n\n**Card** with `code`\n\n</td>\n<td>Second</td>\n</tr>\n</table>\n\n<table><tr><th>Name</th></tr><tr><td>Value</td></tr></table>'} />)
    const [layout, data] = all<HTMLTableElement>('table.md-html-table')
    expect(layout!.classList.contains('md-html-table--layout')).toBe(true)
    expect(layout!.getAttribute('role')).toBe('presentation')
    const cell = element<HTMLTableCellElement>('td.md-html-cell', layout!)
    expect(cell.style.width).toBe('40%')
    expect(cell.getAttribute('data-valign')).toBe('top')
    expect(element('strong', cell).textContent).toBe('Card')
    expect(element('code', cell).textContent).toBe('code')
    expect(data!.classList.contains('md-html-table--layout')).toBe(false)
    expect(element('th', data!).textContent).toBe('Name')
  })

  it('names every alert type by icon and text, not by color alone', async () => {
    const types = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']
    await render(<AgentMarkdown documentMode content={types.map(type => `> [!${type}]\n> Body ${type}`).join('\n\n')} />)
    const alerts = all('.md-alert')
    expect(alerts.map(alert => alert.getAttribute('data-alert-type'))).toEqual(types.map(type => type.toLowerCase()))
    expect(alerts.map(alert => element('.md-alert__title', alert).textContent)).toEqual(['Note', 'Tip', 'Important', 'Warning', 'Caution'])
    const icons = alerts.map(alert => element('.md-alert__title [data-semantic-icon]', alert).getAttribute('data-semantic-icon'))
    expect(new Set(icons).size).toBe(5)
    expect(icons.every(icon => icon?.startsWith('editor.markdown-alert-'))).toBe(true)
    expect(container.textContent).not.toContain('[!')
  })

  it('offers deferred find only the readable text: closed details bodies and summaries are excluded like the DOM walker', async () => {
    const readers: (() => readonly string[])[] = []
    const registry = { register(body: { read(): readonly string[] }) { readers.push(() => body.read()); return () => {} } }
    // Only a heavy body defers to the find registry, so the fixture is long like a real README.
    const content = 'Lead. '.repeat(400) + '\n\n<details>\n<summary>Summary</summary>\n\nClosed body\n\n</details>\n\n<details open>\n<summary>Shown</summary>\n\nOpen body\n\n</details>\n\n> [!NOTE]\n> Alert body\n\n<table><tr><td>Cell text</td></tr></table>'
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
    const work = new ConversationBodyWork()
    try {
      await render(<ReadingFindBodies.Provider value={registry}><ConversationBodyWorkContext.Provider value={{ work, active: true }}>
        <AgentMarkdown documentMode content={content} /></ConversationBodyWorkContext.Provider></ReadingFindBodies.Provider>)
      expect(readers).toHaveLength(1)
      expect(readers[0]!().slice(1)).toEqual(['Open body', 'Note', 'Alert body', 'Cell text'])
    } finally { work.disconnect() }
  })

  it('opens details only through its own disclosure and keeps the summary readable', async () => {
    await render(<AgentMarkdown documentMode content={'<details>\n<summary>More</summary>\n\nHidden body\n\n</details>'} />)
    const details = element<HTMLDetailsElement>('details.md-details')
    expect(details.open).toBe(false)
    expect(element('summary', details).textContent).toBe('More')
    expect(details.textContent).toContain('Hidden body')
  })

  it('keeps conversation surfaces on their own boundaries: no remote fetch, compact body', async () => {
    await render(<AgentMarkdown content={'**Hi** <img src="https://img.shields.io/badge/x" alt="Badge"> <sub>small</sub>'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(element('.md-image-attachment--unavailable').textContent).toContain('Badge')
    expect(element('sub.md-sub').textContent).toBe('small')
    expect(container.querySelector('.md-document')).toBeNull()
  })

  it('loads a remote HTTPS image lazily without a referrer and falls back to the author text', async () => {
    await render(<><MarkdownRemoteImage href="https://img.shields.io/badge/a" alt="Badge" /><MarkdownRemoteImage href="http://insecure.example/a.png" alt="Plain" /></>)
    const image = element<HTMLImageElement>('img.md-remote-image')
    expect(image.getAttribute('loading')).toBe('lazy')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(container.textContent).toContain('Plain')
    await act(async () => { image.dispatchEvent(new Event('error')) })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Badge')
  })

  it('gives every derived projection the text and images inside the new nodes', () => {
    const source = '> [!TIP]\n> Tip with ![pasted](/home/user/.agentmux/pasted/a.png) and `src/app.ts`\n\n<div align="center">\n\nCentered text\n\n</div>\n\n<table><tr><td>Cell <code>lib/util.ts</code></td></tr></table>'
    const blocks = parseAgentMarkdown(source)
    expect(conversationReplyPreview(source)).toBe('Tip with pasted and src/app.ts')
    const files = conversationFiles([{ kind: 'text', text: source }] as never, WORKSPACE).map(file => file.reference.path)
    expect(files).toEqual(expect.arrayContaining(['src/app.ts', 'lib/util.ts']))
    expect(markdownImageReferences(source, blocks, false, () => false, { readOnlyImages: true }).map(reference => reference.path)).toContain('/home/user/.agentmux/pasted/a.png')
  })

  it('reads new nodes in compact excerpts instead of mislabelling them', async () => {
    await render(<MarkdownExcerpt content={'> [!NOTE]\n> Remember <kbd>Enter</kbd>\n\n<div align="center">Middle</div>'} />)
    expect(container.querySelector('del')).toBeNull()
    expect(container.textContent).toContain('Remember Enter')
    expect(container.textContent).toContain('Middle')
  })
})

describe('Markdown document reading layout', () => {
  it('projects the Host value and reports each change without parsing again', async () => {
    const onChange = vi.fn()
    const layout = { value: { width: 'standard', typeface: 'sans', fontSize: 13 }, fontSizes: { min: 12, max: 20, default: 13 }, onChange } as const
    await render(<AgentMarkdown documentMode content={'# Title\n\nBody'} readingLayout={layout} />)
    const document = element('.md-document')
    expect(document.getAttribute('data-reading-width')).toBe('standard')
    expect(document.style.getPropertyValue('--md-reading-size')).toBe('13px')
    await click(element('button[aria-label="Reading layout"]'))
    await click(element('[role="radio"][data-option="wide"]'))
    expect(onChange).toHaveBeenLastCalledWith({ width: 'wide', typeface: 'sans', fontSize: 13 })
    await click(element('[role="radio"][data-option="serif"]'))
    expect(onChange).toHaveBeenLastCalledWith({ width: 'standard', typeface: 'serif', fontSize: 13 })
    await click(element('button[aria-label="Larger text"]'))
    expect(onChange).toHaveBeenLastCalledWith({ width: 'standard', typeface: 'sans', fontSize: 14 })
    await render(<AgentMarkdown documentMode content={'# Title\n\nBody'} readingLayout={{ ...layout, value: { width: 'full', typeface: 'serif', fontSize: 20 } }} />)
    expect(element('.md-document').getAttribute('data-reading-typeface')).toBe('serif')
    expect(element<HTMLButtonElement>('button[aria-label="Larger text"]').disabled).toBe(true)
  })

  it('is absent outside interactive documents', async () => {
    const layout = { value: { width: 'standard', typeface: 'sans', fontSize: 13 }, fontSizes: { min: 12, max: 20, default: 13 }, onChange: vi.fn() } as const
    await render(<><AgentMarkdown content={'# Title'} readingLayout={layout} /><AgentMarkdown documentMode readOnly content={'# Title'} readingLayout={layout} /></>)
    expect(container.querySelector('button[aria-label="Reading layout"]')).toBeNull()
    expect(container.querySelector('[data-reading-width]')).toBeNull()
  })
})

describe('root README files render without visible HTML source', () => {
  for (const name of ['README.md', 'README.zh-CN.md']) {
    it(name, async () => {
      const content = readFileSync(join(ROOT, name), 'utf8')
      const release = mountThemeRuntime(window, { appAppearance: 'light' })
      try {
        await render(<AgentMarkdown documentMode outline workspaceRoot={WORKSPACE} sourcePath={name} renderWorkspaceImage={workspaceImage}
          renderImage={href => href.startsWith('https:') ? <MarkdownRemoteImage href={href} alt="" /> : undefined} openHttpLink={() => {}} openWorkspaceFile={() => {}} content={content} />)
        const visible = all('.md-document p, .md-document td, .md-document li, .md-document h1, .md-document h2, .md-document h3')
          .filter(node => !node.closest('pre')).map(node => Array.from(node.childNodes).map(child => child.nodeName === 'CODE' ? '' : child.textContent).join('')).join('\n')
        expect(visible.length).toBeGreaterThan(5000)
        expect(visible).not.toMatch(/<\/?(?:div|p|img|picture|source|table|tr|td|sub|br|b)\b[^>]*>/u)
        expect(visible).not.toMatch(/\[!NOTE\]/u)
        expect(all('.md-alert[data-alert-type="note"]')).toHaveLength(1)
        expect(all('table.md-html-table--layout')).toHaveLength(3)
        expect(all('table.md-html-table--layout td')).toHaveLength(8)
        expect(all('img.md-remote-image')).toHaveLength(6)
        expect(all('[data-workspace-image*="architecture-light"]')).toHaveLength(1)
        expect(all('.md-container[data-align="center"]')).toHaveLength(1)
        expect(all('.md-paragraph[data-align="center"]').length).toBeGreaterThanOrEqual(2)
      } finally { release() }
    })
  }
})
