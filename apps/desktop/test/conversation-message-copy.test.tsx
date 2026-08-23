import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/renderer/src/components/ConversationMessage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/renderer/src/styles/activity-conversation.css', import.meta.url), 'utf8')

describe('conversation message copy contract', () => {
  it('copies the complete message through the shared clipboard outlet', () => {
    expect(source).toContain('copyTextToClipboard(content')
    expect(source).toContain('title="Copy message"')
    expect(source).toContain("copyState === 'copied'")
  })

  it('uses the editorial human lane without the old left rail', () => {
    const humanStart = styles.indexOf(".log-turn[data-speaker-role='human'] {")
    expect(humanStart).toBeGreaterThan(-1)
    const humanEnd = styles.indexOf('}', humanStart)
    expect(styles.slice(humanStart, humanEnd)).toContain('justify-self: end')
    expect(styles.slice(humanStart, humanEnd)).not.toContain('border-left')
  })
})
