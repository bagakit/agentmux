import { describe, expect, it } from 'vitest'
import { parseAgentMarkdown } from '@agentmux/client-ui/agent-markdown'
describe('conversation image attachments', () => {
  it('preserves image attachment metadata without fetching remote URLs', () => {
    const [paragraph] = parseAgentMarkdown('![shot](images/shot.png)')
    expect(paragraph?.kind).toBe('paragraph')
    expect(paragraph && paragraph.kind === 'paragraph' && paragraph.children).toContainEqual({ kind: 'image', href: 'images/shot.png', alt: 'shot' })
  })
})
