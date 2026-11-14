import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readAppServerSessionHistoryPage } from '../src/providers/app-server.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** A minimal stdio app-server: answers the read handshake with one paginated thread and the given items. */
async function appServer(items: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'amx-app-server-input-')); roots.push(root)
  const script = join(root, 'app-server.mjs')
  await writeFile(script, `
import { createInterface } from 'node:readline'
const items = ${JSON.stringify(items)}
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const result = request.method === 'initialize' ? {}
    : request.method === 'thread/read' ? { thread: { id: 'native-thread', historyMode: 'paginated' } }
    : { data: items, nextCursor: null }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
})
process.stdin.on('end', () => process.exit(0))
`)
  return { command: process.execPath, args: [script], workspacePath: root, env: {} }
}

it('reports the client id an app-server input echoes as the native input fact Core can confirm', async () => {
  const source = { providerId: 'codex', nativeSessionId: 'native-thread' }
  const server = await appServer([
    { turnId: 'turn-typed', item: { type: 'userMessage', id: 'user-typed', clientId: null, content: [{ type: 'text', text: 'Typed natively' }] } },
    { turnId: 'turn-sent', item: { type: 'userMessage', id: 'user-sent', clientId: 'amux-input-v1.synthetic', content: [{ type: 'text', text: 'Sent by AgentMux' }] } }
  ])
  const page = await readAppServerSessionHistoryPage({ ...server, source, limit: 10, signal: new AbortController().signal } as never)
  const sent = page.items.find(item => item.id === 'user-sent'), typed = page.items.find(item => item.id === 'user-typed')
  expect(sent?.conversation?.nativeInput).toEqual({ source, semanticItemId: 'user-sent', turnId: 'turn-sent', clientCorrelation: 'amux-input-v1.synthetic' })
  // No client id is no claim: the native input stays independent.
  expect(typed?.conversation).toBeUndefined()
  // A reported correlation is only a fact; Core alone confirms it against the durable claim.
  expect(sent?.conversation?.adoptedInput).toBeUndefined()
})
