import { act, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { MarkdownCodeBlock } from '../src/components/MarkdownCodeBlock.js'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import { ConversationMessage } from '../src/components/ConversationMessage.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root, platform: ClientUiPlatform
const copyText = vi.fn<ClientUiPlatform['copyText']>()
beforeEach(() => {
  copyText.mockReset(); copyText.mockResolvedValue(true)
  platform = { copyText, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
    renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(content: ReactNode, adapter: ClientUiPlatform | null = platform) {
  await act(async () => root.render(adapter ? <ClientUiProvider platform={adapter}>{content}</ClientUiProvider> : content))
}
const control = () => host.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!
const status = () => control()?.querySelector('[role="status"]')?.textContent
async function click() { expect(control()).not.toBeNull(); await act(async () => { control().focus(); control().click() }) }
function code(value = 'const answer = 42;', language = 'js') { return <MarkdownCodeBlock code={value} language={language} /> }
function pending() {
  const attempts: { text: string; error(error: unknown): void; resolve(value: boolean): void; reject(error: unknown): void }[] = []
  copyText.mockImplementation((text, error) => new Promise<boolean>((resolve, reject) => attempts.push({ text, error, resolve, reject })))
  return attempts
}
function retainedClick() {
  const button = control(), field = Object.keys(button).find(key => key.startsWith('__reactProps$'))!
  return (button as unknown as Record<string, { onClick(): void }>)[field]!.onClick
}

it('copies one actual conversation code block without the surrounding prose, language or toolbar', async () => {
  const source = '  const html = "<b>literal</b>";\n\tconst next = 7;\n'
  await render(<ConversationMessage messageId="code-message" speaker={{ role: 'agent', id: 'code-agent' }} name="Assistant" status="complete"
    content={`Review this snippet.\n\n\`\`\`js\n${source}\n\`\`\`\n\nKeep the surrounding prose.`} />)
  expect(host.querySelector('pre code')?.textContent).toBe(source)
  expect(host.querySelector('.md-code-toolbar__language')?.textContent).toBe('js')
  await click()
  expect(copyText).toHaveBeenCalledExactlyOnceWith(source, expect.any(Function))
  expect(status()).toBe('Copied'); expect(document.activeElement).toBe(control())
  expect(host.querySelector('pre code')?.textContent).toBe(source)
  expect(host.querySelector('b')).toBeNull()
})

it('preserves the complete supplied code string and the actual adapter receiver', async () => {
  const source = '\n\t  <tag>\n\n'
  let receiver: unknown
  const writer = vi.fn(function (this: ClientUiPlatform, text: string) { receiver = this; expect(text).toBe(source); return Promise.resolve(true) })
  const adapter = { ...platform, copyText: writer }
  await render(code(source, ''), adapter); await click()
  expect(receiver).toBe(adapter); expect(writer).toHaveBeenCalledOnce()
  expect(host.querySelector('.md-code-toolbar__language')?.textContent).toBe('Text')
  expect(host.querySelector('code')?.textContent).toBe(source)
})

it('keeps pending focus, rejects duplicate activation before a render, and waits for a real receipt', async () => {
  const attempts = pending()
  await render(code())
  await act(async () => { control().focus(); control().click(); control().click() })
  expect(attempts).toHaveLength(1)
  expect(status()).toBe('Copying…'); expect(control().getAttribute('aria-disabled')).toBe('true')
  expect(control().disabled).toBe(false); expect(document.activeElement).toBe(control())
  await act(async () => attempts[0]!.resolve(true))
  expect(status()).toBe('Copied'); expect(control().hasAttribute('aria-disabled')).toBe(false)
  expect(document.activeElement).toBe(control())
})

it('keeps false, thrown and early reported failures visible and retries through the same writer', async () => {
  copyText.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined as unknown as boolean).mockRejectedValueOnce(new Error('Clipboard unavailable'))
    .mockImplementationOnce(async (_text, error) => { error(new Error('Reported failure')); return true }).mockResolvedValue(true)
  await render(code())
  for (let index = 0; index < 4; index++) { await click(); expect(status()).toBe('Retry copy'); expect(document.activeElement).toBe(control()) }
  await click(); expect(status()).toBe('Copied'); expect(copyText).toHaveBeenCalledTimes(5)
})

it('lets a late error correct only its own receipt and never a newer copy', async () => {
  const attempts = pending()
  await render(code()); await click()
  await act(async () => attempts[0]!.resolve(true)); expect(status()).toBe('Copied')
  await act(async () => attempts[0]!.error(new Error('Late failure'))); expect(status()).toBe('Retry copy')
  await click()
  await act(async () => attempts[1]!.resolve(true)); expect(status()).toBe('Copied')
  await act(async () => attempts[0]!.error(new Error('Obsolete failure'))); expect(status()).toBe('Copied')
})

it('does not let an early error followed by success replace a retry in flight', async () => {
  const attempts = pending()
  await render(code()); await click()
  await act(async () => attempts[0]!.error(new Error('Denied'))); expect(status()).toBe('Retry copy')
  await click(); expect(attempts).toHaveLength(2)
  await act(async () => attempts[0]!.resolve(true)); expect(status()).toBe('Copying…')
  await act(async () => attempts[1]!.resolve(false)); expect(status()).toBe('Retry copy')
})

it('rejects old success, errors and handlers after A-B-A and raw-language changes', async () => {
  const attempts = pending(), presentations: string[] = []
  function Observed({ value, language }: { value: string; language: string }) {
    useLayoutEffect(() => { presentations.push(status() ?? '') }, [value, language])
    return code(value, language)
  }
  await render(<Observed value="A" language="js" />); await click()
  const obsoleteClick = retainedClick()
  await render(<Observed value="B" language="js" />)
  expect(status()).toBe('Copy'); expect(presentations.at(-1)).toBe('Copy')
  await act(async () => obsoleteClick()); expect(attempts).toHaveLength(1)
  await render(<Observed value="A" language="js" />); await click()
  await act(async () => attempts[1]!.resolve(true)); expect(status()).toBe('Copied')
  await act(async () => { attempts[0]!.resolve(true); attempts[0]!.error(new Error('Old A')) }); expect(status()).toBe('Copied')
  await render(<Observed value="A" language=" JS " />)
  expect(status()).toBe('Copy'); expect(presentations.at(-1)).toBe('Copy')
})

it('does not inherit an old adapter receipt with identical code and language', async () => {
  const attempts = pending(), nextWriter = vi.fn(async () => true)
  await render(code()); await click()
  await render(code(), { ...platform, copyText: nextWriter })
  expect(status()).toBe('Copy'); await click(); expect(status()).toBe('Copied')
  await act(async () => { attempts[0]!.resolve(false); attempts[0]!.error(new Error('Old adapter')) })
  expect(status()).toBe('Copied'); expect(nextWriter).toHaveBeenCalledExactlyOnceWith('const answer = 42;', expect.any(Function))
})

it('keeps ordinary readOnly, standalone and diagram branches free of new controls or clipboard IO', async () => {
  const content = '```js\nconst answer = 42;\n```'
  await render(<AgentMarkdown content={content} readOnly />)
  expect(control()).toBeNull(); expect(host.querySelector('code')?.textContent).toBe('const answer = 42;')
  await render(<AgentMarkdown content={content} />, null)
  expect(control()).toBeNull(); expect(host.querySelector('code')?.textContent).toBe('const answer = 42;')
  await render(<AgentMarkdown content={'```mermaid\ngraph LR; A-->B\n```'} />)
  expect(control()).toBeNull(); expect(host.querySelector('code')?.textContent).toBe('graph LR; A-->B')
  expect(copyText).not.toHaveBeenCalled()
})

it('releases the old action on unmount and does not execute its retained click handler', async () => {
  const attempts = pending()
  await render(code()); await click(); const obsoleteClick = retainedClick()
  await act(async () => root.unmount())
  await act(async () => { attempts[0]!.resolve(true); attempts[0]!.error(new Error('Unmounted')); obsoleteClick() })
  expect(attempts).toHaveLength(1); expect(host.textContent).toBe('')
  root = createRoot(host)
  await render(code('New mount'))
  expect(status()).toBe('Copy')
})
