import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('message tools syntax', () => {
  it('supports slash command suggestions and file/skill references', async () => {
    const composer = await readFile(resolve(import.meta.dirname, '../src/renderer/src/components/AgentComposer.tsx'), 'utf8')
    const tools = await readFile(resolve(import.meta.dirname, '../src/renderer/src/components/AgentComposerTools.tsx'), 'utf8')
    expect(composer).toContain("trigger.startsWith('/') ? 'command'")
    expect(tools).toContain('onChooseSkill')
    expect(tools).toContain('onCommand')
  })
})
