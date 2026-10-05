import { fixturePath as _reshape_fixturePath } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { ReactNode } from 'react'

const root = createRoot(document.getElementById('root')!)
const grammar: Array<{ bytes: number; collectHeadings: boolean; duration: number }> = (globalThis as any).__markdownParseProbe = []
const actions: unknown[] = []
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
function platform(generation: number): ClientUiPlatform {
  return { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
    renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null,
    renderObjectLink: reference => <button data-current-object={generation} onClick={() => actions.push({ generation, kind: 'object', uri: reference.uri })}>{reference.label}</button> }
}
function show(children: ReactNode, generation = 0) {
  flushSync(() => root.render(<ClientUiProvider platform={platform(generation)}>{children}</ClientUiProvider>))
}
function facts() {
  const host = document.getElementById('root')!
  return { calls: grammar.length, text: host.textContent, document: !!host.querySelector('.md-document'), input: !!host.querySelector('.md-input'),
    outline: !!host.querySelector('.md-outline__trigger'), heading: host.querySelector('.md-heading')?.textContent,
    headingTag: host.querySelector('.md-heading')?.tagName, links: [...host.querySelectorAll<HTMLButtonElement>('button.md-link')].map(button => ({ text: button.textContent, title: button.title })),
    images: [...host.querySelectorAll('[data-current-image]')].map(image => image.textContent), object: host.querySelector('[data-current-object]')?.getAttribute('data-current-object') }
}
function click(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
  if (!button) throw Error('Actual current Host action did not mount: ' + text)
  button.click()
}
;(window as any).markdownParseReuse = {
  async conversation() {
    show(null)
    const start = grammar.length, actionStart = actions.length
    const content = '# Current **body**\n\n[Current link](https://example.com/reuse)\n\n' + Array.from({ length: 64 }, (_, index) => `Paragraph ${index} keeps **bold** and *emphasis* readable.`).join('\n\n')
    const page: AgentSessionHistoryPage = { agentSessionId: 'private-reading', source: { providerId: 'codex', nativeSessionId: 'private-native-source' }, nextCursor: null,
      items: [{ id: 'unchanged-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: content }] }] }
    const render = (generation: number, current = page) => show(<ConversationView sessionId="private-reading" page={current}
      workspaceRoot={_reshape_fixturePath("private/workspace-") + generation} openHttpLink={url => actions.push({ generation, kind: 'http', url })} />, generation)
    render(0)
    const initialCalls = grammar.length - start, body = document.querySelector('.log-turn__body'), snapshots = []
    for (let generation = 1; generation <= 20; generation++) {
      await frame(); render(generation); snapshots.push({ generation, calls: grammar.length - start, bodySame: document.querySelector('.log-turn__body') === body })
    }
    click('Current link')
    const unchangedCalls = grammar.length - start
    render(21, { ...page, items: [{ ...page.items[0]!, contentParts: [{ kind: 'text', text: '# Fresh **changed body**\n\n[New link](https://example.com/new)' }] }] })
    const changed = facts()
    if (changed.links.some(link => link.text === 'New link')) click('New link')
    return { contentBytes: new TextEncoder().encode(content).length, initialCalls, unchangedCalls, finalCalls: grammar.length - start,
      changed, snapshots, actions: actions.slice(actionStart), grammar: grammar.slice(start) }
  },
  modes() {
    show(null)
    const start = grammar.length, snapshots = []
    const render = (props: Record<string, unknown>) => { show(<AgentMarkdown content="<https://example.com/reuse>" {...props} />); snapshots.push(facts()) }
    render({})
    render({ inputMode: true })
    render({})
    render({ content: '# Heading', inputMode: true })
    render({ content: '# Heading', documentMode: true, inputMode: true })
    render({ content: '# Heading', documentMode: true, outline: true })
    render({ content: '# Heading', documentMode: true, outline: true, readOnly: true })
    render({ content: '# Heading', documentMode: true, outline: true })
    render({ content: 'Fresh plain prose.' })
    return { snapshots, grammar: grammar.slice(start) }
  },
  currentActions() {
    show(null)
    const start = grammar.length, actionStart = actions.length
    const content = ("[Web](https://example.com/current) [File](./a.ts:9:2) [Home](~/src/home.ts) [Absolute](" + _reshape_fixturePath("private/repo/src/absolute.ts") + ")\n\n![Image](./image.png)")
    const render = (generation: number, sourcePath: string, workspaceRoot: string, homeDir: string) => show(<AgentMarkdown content={content} documentMode
      sourcePath={sourcePath} workspaceRoot={workspaceRoot} homeDir={homeDir}
      openHttpLink={url => actions.push({ generation, kind: 'http', url })}
      openWorkspaceFile={(path, location) => actions.push({ generation, kind: 'file', path, location })}
      renderWorkspaceImage={(path, alt) => <span data-current-image={generation}>{generation}:{path}:{alt}</span>} />, generation)
    render(0, 'docs/guide.md', _reshape_fixturePath("private"), _reshape_fixturePath("private/repo"))
    const first = facts()
    render(1, 'notes/guide.md', _reshape_fixturePath("private/repo"), _reshape_fixturePath("private/repo/new-home"))
    const second = facts()
    click('Web'); click('File'); click('Home'); click('Absolute')
    show(<AgentMarkdown content={content} documentMode readOnly renderImage={() => { throw Error('Read-only image must not invoke Host IO') }} />, 2)
    const inert = facts()
    show(<AgentMarkdown content="[Agent](amux://agent/private-agent)" />, 3)
    const object = facts(); if (object.object) click('Agent')
    show(<AgentMarkdown content="[Agent](amux://agent/private-agent)" />, 4)
    const freshObject = facts(); if (freshObject.object) click('Agent')
    show(<AgentMarkdown content="![Attachment](attachment:plot.png)" renderImage={(href, alt) => <span data-current-image="5">5:{href}:{alt}</span>} />, 5)
    const image = facts()
    show(<AgentMarkdown content="![Attachment](attachment:plot.png)" renderImage={(href, alt) => <span data-current-image="6">6:{href}:{alt}</span>} />, 6)
    return { first, second, inert, object, freshObject, image, freshImage: facts(), actions: actions.slice(actionStart), grammar: grammar.slice(start) }
  },
  instances() {
    show(null)
    const start = grammar.length, content = '# Independent current result'
    show(<><AgentMarkdown content={content} /><AgentMarkdown content={content} /></>)
    const two = grammar.length - start
    show(null)
    show(<AgentMarkdown content={content} />)
    return { two, afterRemount: grammar.length - start, text: document.getElementById('root')!.textContent }
  }
}
