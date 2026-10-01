import { DOMParser, onWarningStopParsing } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import * as DefaultOutbound from '../src/agent-outbound-message.js'
import * as DefaultReader from '../src/agent-message-render.js'

// Proof loads the same compiled producer and shared reader in a private copy.
const { composeAgentLaunchPrompt } = process.env.AGENTMUX_TEST_INJECTED_CONTEXT_OUTBOUND
  ? await import(process.env.AGENTMUX_TEST_INJECTED_CONTEXT_OUTBOUND) as typeof DefaultOutbound : DefaultOutbound
const { parseAgentMuxMessagePrefix } = process.env.AGENTMUX_TEST_INJECTED_CONTEXT_READER
  ? await import(process.env.AGENTMUX_TEST_INJECTED_CONTEXT_READER) as typeof DefaultReader : DefaultReader

const user = '  [Message from Agent G4C2P5qRAf4t_2k3]\r\nKeep <User> & &amp; "quotes".\nLiteral </amux> stays authored.  \n'
const note = 'Project context: <canonical Session ID> & &amp; </amux>\r\n<amux from="amux">literal nested syntax</amux>\r<!-- literal --> <?literal?> ]]>.'

function readPlatform(composed: ReturnType<typeof composeAgentLaunchPrompt>, expectedBody: string) {
  const parsed = parseAgentMuxMessagePrefix(composed.text)
  expect(parsed).not.toBeNull()
  expect(parsed!.sourceLabel).toBe('')
  expect(parsed!.declaredAgentSessionId).toBeNull()
  expect(parsed!.declaredContexts).toHaveLength(1)
  const raw = parsed!.declaredContexts![0]!.raw
  expect(raw.startsWith('<amux from="amux">\n')).toBe(true)
  expect(composed.text).toBe(raw + expectedBody)
  expect(parsed!.body).toBe(expectedBody)
  expect(Buffer.from(parsed!.body)).toEqual(Buffer.from(expectedBody))
  const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(raw, 'text/xml')
  const root = document.documentElement!
  expect(Array.from(root.attributes).map(attribute => [attribute.name, attribute.value])).toEqual([['from', 'amux']])
  expect(root.childNodes.length).toBeGreaterThan(0)
  expect(Array.from(root.childNodes).map(node => node.nodeType)).toEqual([3])
  expect(root.textContent).toBe(`\n${composed.systemContext}\n`)
  return raw
}

describe('actual injected context producer and shared reader agree', () => {
  it('reads the real runtime guide with its canonical Session placeholder, leaving the entire original tail intact', () => {
    const composed = composeAgentLaunchPrompt(user, true)
    expect(composed.systemContext).toContain('[Message from Agent <canonical Session ID>]')
    const raw = readPlatform(composed, '\n\n' + user)
    expect(raw).toContain('&lt;canonical Session ID&gt;')
    expect(composed.text.endsWith(user)).toBe(true)
  })

  it.each([true, false])('keeps XML-looking platform notes inside one text context when runtime guide is %s', guide => {
    const composed = composeAgentLaunchPrompt(user, guide, note)
    expect(composed.systemContext).toContain(note)
    const raw = readPlatform(composed, '\n\n' + user)
    expect(raw).toContain('&lt;/amux&gt;')
    expect(raw).toContain('&amp;amp;')
    expect(raw).toContain('&#13;')
    expect(raw).not.toContain('<amux from="amux">literal nested syntax')
    expect(composed.text.slice(raw.length)).toBe('\n\n' + user)
  })

  it('reads an independent guide without inventing a user tail, and leaves a plain request completely unchanged', () => {
    const composed = composeAgentLaunchPrompt(undefined, true)
    expect(composed.systemContext).toContain('No request yet. Wait for the user.')
    readPlatform(composed, '')
    expect(composeAgentLaunchPrompt(user, false)).toEqual({ text: user })
  })
})
