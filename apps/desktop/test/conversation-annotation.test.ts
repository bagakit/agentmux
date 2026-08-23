import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const message = readFileSync(new URL('../src/renderer/src/components/ConversationMessage.tsx', import.meta.url), 'utf8')
const pane = readFileSync(new URL('../src/renderer/src/components/SessionPane.tsx', import.meta.url), 'utf8')
const activity = readFileSync(new URL('../src/renderer/src/components/ActivityView.tsx', import.meta.url), 'utf8')

describe('conversation annotation contract', () => {
  it('preserves message identity, quote range and note before handing it to the host', () => {
    expect(message).toContain('messageId: string')
    expect(message).toContain('quote: string')
    expect(message).toContain('start: number')
    expect(message).toContain('end: number')
    expect(message).toContain('onAnnotate({ messageId, quote: selection.quote')
  })

  it('routes a selected quote into the current Agent draft instead of inventing a second send path', () => {
    expect(activity).toContain('...(onAnnotate ? { onAnnotate } : {})')
    expect(pane).toContain('const reference = `Regarding this message:')
    expect(pane).toContain('setAgentComposerDraft(sessionId')
  })
})
