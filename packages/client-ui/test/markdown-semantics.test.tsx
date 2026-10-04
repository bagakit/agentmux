// @vitest-environment happy-dom
import { fixtureFileUrl, fixturePath } from '../../../test/fixture-values.mjs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import { looksLikeMarkdown, parseAgentMarkdown } from '../src/lib/agent-markdown.js'

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
function elements<T extends HTMLElement = HTMLElement>(selector: string, count: number, scope: ParentNode = container): T[] {
  const matches = Array.from(scope.querySelectorAll<T>(selector))
  expect(matches, `Nonempty Markdown projection ${selector}`).toHaveLength(count)
  return matches
}
async function click(target: HTMLElement) {
  await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
}

describe('shared Markdown document and conversation semantics', () => {
  it('parses document grammar without the conversation heuristic and reads the current draft on rerender', async () => {
    const content = '    const answer = 42'
    expect(looksLikeMarkdown(content)).toBe(false)
    await render(<><AgentMarkdown content={content} documentMode /><AgentMarkdown content={content} /></>)
    expect(element('pre code').textContent).toBe('const answer = 42')
    expect(elements('.md-paragraph', 1)[0]!.textContent).toBe(content)
    await render(<AgentMarkdown content={'# Unsaved heading\n\n*Current draft*'} documentMode />)
    expect(element('h1').textContent).toBe('Unsaved heading')
    expect(element('em').textContent).toBe('Current draft')
    expect(container.querySelector('pre')).toBeNull()
    await render(<AgentMarkdown content="" documentMode />)
    expect(element('.md-document').textContent).toBe('')
  })

  it('retains ordered starts and independent nested task state', async () => {
    await render(<AgentMarkdown documentMode content={'3. Third\n4. Fourth\n\n- [x] Done\n  - [ ] Nested\n- [ ] Pending'} />)
    expect(element<HTMLOListElement>('ol').start).toBe(3)
    const checkboxes = elements<HTMLInputElement>('input[type=checkbox]', 3)
    expect(checkboxes.map(input => input.checked)).toEqual([true, false, false])
    expect(checkboxes.map(input => input.disabled)).toEqual([true, true, true])
    expect(element('.md-task-item .md-list').textContent).toContain('Nested')
    const list = parseAgentMarkdown('0. Zero')[0]
    expect(list).toMatchObject({ kind: 'list', ordered: true, start: 0 })
  })

  it('resolves normalized reference definitions once and keeps labels to one Host action', async () => {
    const openHttpLink = vi.fn(), openWorkspaceFile = vi.fn()
    await render(<AgentMarkdown documentMode workspaceRoot={fixturePath("repo")} sourcePath="docs/guide.md" openHttpLink={openHttpLink}
      openWorkspaceFile={openWorkspaceFile} content={'[First][ReF]\n\n[local `src/main.ts`][local]\n\n[ref]: https://example.com/first\n[REF]: https://example.com/second\n[local]: ../src/main.ts:9:2\n\n[Missing][unknown]'} />)
    const links = elements<HTMLButtonElement>('button.md-link', 2)
    expect(links.map(link => link.title)).toEqual(['https://example.com/first', 'src/main.ts'])
    expect(links[1]!.querySelector('button')).toBeNull()
    await click(links[0]!)
    expect(openHttpLink).toHaveBeenCalledExactlyOnceWith('https://example.com/first', expect.objectContaining({ metaKey: false, ctrlKey: false }))
    await click(links[1]!)
    expect(openWorkspaceFile).toHaveBeenCalledExactlyOnceWith('src/main.ts', { line: 9, column: 2 }, expect.objectContaining({ metaKey: false, ctrlKey: false }))
    expect(container.textContent).toContain('[Missing][unknown]')
    expect(container.textContent).not.toContain('https://example.com/second')
  })

  it('renders document workspace image references through the Host and confines every forwarded path', async () => {
    const renderWorkspaceImage = vi.fn((path: string, alt: string) => <span data-workspace-image={path}>{alt}</span>)
    const openWorkspaceFile = vi.fn()
    const content = '![Diagram][image]\n\n[image]: ./images/a%20b.png\n\n![Remote](https://example.com/a.png)\n![Outside](../../private.png)\n![Encoded separator](images%2fa.png)\n![Malformed](broken%Q.png)'
    await render(<AgentMarkdown content={content} documentMode workspaceRoot={fixturePath("repo")} sourcePath="docs/guide.md"
      openWorkspaceFile={openWorkspaceFile} renderWorkspaceImage={renderWorkspaceImage} />)
    expect(renderWorkspaceImage).toHaveBeenCalledExactlyOnceWith('docs/images/a b.png', 'Diagram')
    expect(element('[data-workspace-image]').textContent).toBe('Diagram')
    elements('.md-image-attachment--unavailable', 4)
    expect(container.querySelector('img')).toBeNull()
    renderWorkspaceImage.mockClear()
    await render(<AgentMarkdown content="![Diagram](./images/a.png)" workspaceRoot={fixturePath("repo")} sourcePath="docs/guide.md"
      openWorkspaceFile={openWorkspaceFile} renderWorkspaceImage={renderWorkspaceImage} />)
    expect(renderWorkspaceImage).not.toHaveBeenCalled()
    await click(element('button.md-image-attachment'))
    expect(openWorkspaceFile).toHaveBeenCalledExactlyOnceWith('docs/images/a.png', undefined, expect.objectContaining({ metaKey: false, ctrlKey: false }))
  })

  it('keeps heading and footnote navigation within the clicked document', async () => {
    const content = '# 标题\n\n# 标题\n\n[Second](#%E6%A0%87%E9%A2%98-1)\n\nOne[^note], twice[^note].\n\n[^note]: **Footnote** body.'
    await render(<><AgentMarkdown content={content} documentMode /><AgentMarkdown content={content} documentMode /></>)
    const documents = elements('.md-document', 2)
    const headings = elements('h1', 2, documents[1]!)
    expect(headings.map(heading => heading.getAttribute('data-md-anchor'))).toEqual(['标题', '标题-1'])
    await click(element('button[title="#%E6%A0%87%E9%A2%98-1"]', documents[1]!))
    expect(document.activeElement).toBe(headings[1])
    const references = elements<HTMLButtonElement>('button[data-md-footnote-reference]', 2, documents[1]!)
    expect(references.map(reference => reference.textContent)).toEqual(['1', '1'])
    await click(references[1]!)
    expect(document.activeElement).toBe(element('[data-md-footnote="1"]', documents[1]!))
    expect(element('.md-footnotes strong', documents[1]!).textContent).toBe('Footnote')
    await click(element('[aria-label="Return to footnote 1 reference 2"]', documents[1]!))
    expect(document.activeElement).toBe(references[1])
    elements('.md-footnote-backlinks button', 2, documents[0]!)
  })

  it('shows linked workspace thumbnails while the outer link owns their only action', async () => {
    const renderWorkspaceImage = vi.fn((path: string, alt: string, linked?: boolean) => <span data-workspace-image={path}>
      <img src="blob:workspace-image" alt={alt} />{linked ? null : <button>Open image</button>}
    </span>)
    const openHttpLink = vi.fn(), openWorkspaceFile = vi.fn()
    const content = '[![Build status][badge]](https://example.com/status)\n\n[badge]: ../assets/status.svg'
    await render(<AgentMarkdown content={content} documentMode workspaceRoot={fixturePath("repo")} sourcePath="docs/guide.md"
      renderWorkspaceImage={renderWorkspaceImage} openHttpLink={openHttpLink} openWorkspaceFile={openWorkspaceFile} />)
    expect(renderWorkspaceImage).toHaveBeenCalledExactlyOnceWith('assets/status.svg', 'Build status', true)
    const link = element<HTMLButtonElement>('button.md-link')
    expect(element<HTMLImageElement>('img', link).alt).toBe('Build status')
    expect(link.querySelector('button')).toBeNull()
    await click(link)
    expect(openHttpLink).toHaveBeenCalledExactlyOnceWith('https://example.com/status', expect.objectContaining({ metaKey: false, ctrlKey: false }))
    expect(openWorkspaceFile).not.toHaveBeenCalled()
    renderWorkspaceImage.mockClear()
    await render(<AgentMarkdown content={content} workspaceRoot={fixturePath("repo")} sourcePath="docs/guide.md" renderWorkspaceImage={renderWorkspaceImage} openHttpLink={openHttpLink} />)
    expect(renderWorkspaceImage).not.toHaveBeenCalled()
    expect(element('button.md-link').textContent).toBe('Build status')
    expect(container.querySelector('img')).toBeNull()
  })

  it('projects recursively referenced footnotes once and avoids actions nested inside link labels', async () => {
    const openHttpLink = vi.fn()
    await render(<AgentMarkdown documentMode openHttpLink={openHttpLink}
      content={'[Read[^a]](https://example.com)\n\n[^a]: A references B[^b] and itself[^a].\n[^b]: B references A[^a].'} />)
    expect(elements('[data-md-footnote]', 2).map(note => note.getAttribute('data-md-footnote'))).toEqual(['1', '2'])
    const link = element<HTMLButtonElement>('button[title="https://example.com/"]')
    expect(link.querySelector('button')).toBeNull()
    expect(element('sup[data-md-footnote-reference="1:1"]', link).textContent).toBe('1')
    await click(link)
    expect(openHttpLink).toHaveBeenCalledTimes(1)
    elements('.md-footnote-backlinks button', 4)
  })

  it('retains hard breaks, tables, inline formatting and semantic file headings without enlarging conversation headings', async () => {
    const content = 'Heading\n=======\n\n*Italic* and **bold**, ~~removed~~.  \nNext\n\n| Left | Right |\n| :--- | ---: |\n| A | B |'
    await render(<><AgentMarkdown content={content} documentMode /><AgentMarkdown content={content} /></>)
    expect(element('h1').textContent).toBe('Heading')
    const conversation = elements('.md', 2)[1]!
    expect(element('p.md-heading', conversation).textContent).toBe('Heading')
    expect(conversation.querySelector('h1')).toBeNull()
    elements('br', 2)
    elements('em', 2)
    elements('strong', 2)
    elements('del', 2)
    expect(elements('th[data-align="right"]', 2).map(cell => cell.textContent)).toEqual(['Right', 'Right'])
  })

  it('keeps raw HTML and forbidden schemes inert while preserving readable source', async () => {
    const openHttpLink = vi.fn(), openWorkspaceFile = vi.fn()
    const content = `<script>window.compromised = true</script>\n\n<img src="https://example.com/a.png">\n\n[Unsafe](javascript:alert%281%29) [File](${fixtureFileUrl("a.txt")}) [Unknown][missing]`
    await render(<AgentMarkdown content={content} documentMode workspaceRoot={fixturePath("repo")} openHttpLink={openHttpLink} openWorkspaceFile={openWorkspaceFile} />)
    expect(container.querySelector('script, img, a, iframe, button')).toBeNull()
    expect(container.textContent).toContain('<script>window.compromised = true</script>')
    expect(container.textContent).toContain('<img src="https://example.com/a.png">')
    expect(container.textContent).toContain('Unsafe File [Unknown][missing]')
    expect(openHttpLink).not.toHaveBeenCalled()
    expect(openWorkspaceFile).not.toHaveBeenCalled()
  })
})
