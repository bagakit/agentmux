import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BrowserInputHistoryStore } from '../../../src/main/browser-input-history.js'

it('reads the actual private durable file in an independent Node process', async () => {
  const root = process.env.AGENTMUX_HISTORY_PRIVATE_DIRECTORY
  const mode = process.env.AGENTMUX_HISTORY_PROCESS_MODE
  expect(root).toBeTruthy()
  expect(['save', 'recover-delete']).toContain(mode)
  const scope = { workspaceId: 'history-process-workspace', profileId: '11111111-1111-4111-8111-111111111111' }
  const store = new BrowserInputHistoryStore(join(root!, 'history'))
  let before
  if (mode === 'save') {
    await store.record(scope, 'first process search')
    await store.record(scope, 'https://example.invalid/path?q=keep%2Bcase#part')
    await store.record(scope, 'deleted before restart')
    const removed = await store.remove(scope, 'deleted before restart')
    expect(removed.entries.map(entry => entry.text)).toEqual(['https://example.invalid/path?q=keep%2Bcase#part', 'first process search'])
    before = removed
  } else {
    before = await store.list(scope)
    expect(before.entries.map(entry => entry.text)).toEqual(['https://example.invalid/path?q=keep%2Bcase#part', 'first process search'])
    const removed = await store.remove(scope, 'first process search')
    expect(removed.entries.map(entry => entry.text)).toEqual(['https://example.invalid/path?q=keep%2Bcase#part'])
    await store.clear(scope)
  }
  await store.flush()
  await writeFile(join(root!, `${mode}.json`), `${JSON.stringify({ pid: process.pid, scope, before, after: await store.list(scope) })}\n`)
})
