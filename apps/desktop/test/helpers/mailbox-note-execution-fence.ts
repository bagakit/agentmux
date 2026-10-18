import { afterAll, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const fence = vi.hoisted(() => ({ actualModuleLoaded: false, calls: {
  openDesktopNoteLink: 0, resolveDesktopNoteFileLink: 0, useDesktopNoteLinkOpener: 0
} }))
vi.mock('../../src/renderer/src/lib/note-file-link', async importOriginal => {
  // Retain and evaluate its actual import graph; only the three action exports are fenced.
  await importOriginal()
  fence.actualModuleLoaded = true
  return Object.fromEntries(Object.keys(fence.calls).map(name => [name, () => {
    fence.calls[name as keyof typeof fence.calls]++
    throw new Error('This A2A scope unexpectedly executed Note link action: ' + name)
  }]))
})
afterAll(() => {
  const evidence = process.env.AGENTMUX_MESSAGE_WORKSPACE_EVIDENCE ?? process.env.AGENTMUX_MESSAGE_DATA_EVIDENCE
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    writeFileSync(resolve(evidence, 'note-link-execution.json'), JSON.stringify(fence, null, 2) + '\n')
  }
  expect(fence.actualModuleLoaded).toBe(true)
  expect(fence.calls).toEqual({ openDesktopNoteLink: 0, resolveDesktopNoteFileLink: 0, useDesktopNoteLinkOpener: 0 })
})
