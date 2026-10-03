// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const grammar = vi.hoisted(() => ({ calls: 0 }))
vi.mock('unified', async importOriginal => {
  const original = await importOriginal<typeof import('unified')>()
  return { ...original, unified: (...args: Parameters<typeof original.unified>) => {
    const processor = original.unified(...args)
    const parse = processor.parse
    processor.parse = function (...values: Parameters<typeof parse>) {
      grammar.calls++
      return parse.apply(this, values)
    }
    return processor
  } }
})
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import * as markdown from '../src/lib/agent-markdown.js'

let root: Root, container: HTMLDivElement
beforeEach(() => {
  grammar.calls = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(node: ReactNode) { await act(async () => root.render(node)) }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function click(node: HTMLElement) { await act(async () => node.click()); await settle() }
function element<T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = container): T {
  const match = scope.querySelector<T>(selector)
  expect(match, `Mounted outline target ${selector}`).not.toBeNull()
  return match!
}

describe('file Markdown outline', () => {
  it('reuses one document parse and projects labels only while open', async () => {
    const parse = vi.spyOn(markdown, 'parseAgentMarkdownDocument')
    const labels = vi.spyOn(markdown, 'markdownHeadingText')
    await render(<AgentMarkdown documentMode outline content={'# One\n\n## Two'} />)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(grammar.calls).toBe(1)
    expect(labels).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="Document outline"]')).toBeNull()
    await click(element('.md-outline__trigger'))
    const entries = [...container.querySelectorAll<HTMLButtonElement>('[data-md-outline-anchor]')]
    expect(entries.map(entry => entry.textContent)).toEqual(['One', 'Two'])
    expect(labels).toHaveBeenCalledTimes(2)
    expect(parse).toHaveBeenCalledTimes(1)
    await click(element('[aria-label="Close document outline"]'))
    expect(container.querySelector('[aria-label="Document outline"]')).toBeNull()
    expect(labels).toHaveBeenCalledTimes(2)
    await click(element('.md-outline__trigger'))
    expect(parse).toHaveBeenCalledTimes(1)
    expect(labels).toHaveBeenCalledTimes(4)
    expect(grammar.calls).toBe(1)
  })

  it('retains original nodes, duplicate anchors, nested heading order and inline labels', async () => {
    const content = '# **标题** `API`\n\n## 标题 API\n\n> ### *Nested*\n\n- #### List heading\n\n```md\n# Not a heading\n```\n\nPlain prose'
    const parsed = markdown.parseAgentMarkdownDocument(content)
    expect(parsed.headings).toHaveLength(4)
    expect(parsed.headings[0]).toBe(parsed.blocks[0])
    expect(parsed.headings.map(heading => heading.anchor)).toEqual(['标题-api', '标题-api-1', 'nested', 'list-heading'])
    await render(<AgentMarkdown documentMode outline content={content} />)
    await click(element('.md-outline__trigger'))
    const entries = [...container.querySelectorAll<HTMLButtonElement>('[data-md-outline-anchor]')]
    expect(entries.map(entry => [entry.textContent, entry.dataset.mdOutlineAnchor, entry.dataset.level])).toEqual([
      ['标题 API', '标题-api', '1'], ['标题 API', '标题-api-1', '2'], ['Nested', 'nested', '3'], ['List heading', 'list-heading', '4']
    ])
    expect(container.querySelector('pre code')?.textContent).toBe('# Not a heading')
  })

  it('navigates only the clicked Region and leaves focus on the heading after dismissal', async () => {
    const content = '# 标题\n\nBody\n\n# 标题'
    const openHttp = vi.fn(), openFile = vi.fn()
    await render(<><AgentMarkdown documentMode outline content={content} openHttpLink={openHttp} openWorkspaceFile={openFile} />
      <AgentMarkdown documentMode outline content={content} openHttpLink={openHttp} openWorkspaceFile={openFile} /></>)
    const documents = [...container.querySelectorAll<HTMLElement>('[data-markdown-root]')]
    expect(documents).toHaveLength(2)
    const first = element('[data-md-anchor="标题-1"]', documents[0]!)
    const second = element('[data-md-anchor="标题-1"]', documents[1]!)
    const firstScroll = vi.spyOn(first, 'scrollIntoView'), secondScroll = vi.spyOn(second, 'scrollIntoView')
    await click(element('.md-outline__trigger', documents[1]!))
    await click(element('[data-md-outline-anchor="标题-1"]', documents[1]!))
    expect(document.activeElement).toBe(second)
    expect(secondScroll).toHaveBeenCalledExactlyOnceWith({ block: 'start' })
    expect(firstScroll).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="Document outline"]')).toBeNull()
    expect(openHttp).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('returns focus on Escape and reflects unsaved content without a second document owner', async () => {
    await render(<AgentMarkdown documentMode outline content={'# Saved\n\n## Original'} />)
    const trigger = element('.md-outline__trigger')
    await click(trigger)
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await settle()
    expect(container.querySelector('[aria-label="Document outline"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    await click(trigger)
    await render(<AgentMarkdown documentMode outline content={'# Unsaved\n\n## Current draft'} />)
    expect([...container.querySelectorAll('[data-md-outline-anchor]')].map(node => node.textContent)).toEqual(['Unsaved', 'Current draft'])
    await click(element('[data-md-outline-anchor="current-draft"]'))
    expect(document.activeElement).toBe(element('[data-md-anchor="current-draft"]'))
  })

  it('does not collect document outlines for conversations, inert previews or heading-free files', async () => {
    const parse = vi.spyOn(markdown, 'parseAgentMarkdownDocument')
    await render(<><AgentMarkdown outline content="# Conversation" />
      <AgentMarkdown outline documentMode readOnly content="# Inert" />
      <AgentMarkdown documentMode outline content="No headings here." /></>)
    expect(parse).toHaveBeenCalledExactlyOnceWith('No headings here.')
    expect(container.querySelector('.md-outline__trigger')).toBeNull()
    expect(container.textContent).toContain('Conversation')
    expect(container.textContent).toContain('Inert')
    expect(container.textContent).toContain('No headings here.')
  })
})
