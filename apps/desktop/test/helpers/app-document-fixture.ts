import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppDocumentSources } from '../../src/main/workbench-document-sources'

const documents = new WeakMap<object, () => AppDocumentSources>()

/** Explicit fake Electron document facts for domain fixtures, never a production admission bypass.
 * The private source is constructed here; an existing arbitrary URL cannot grant itself authority.
 * Keep existing frame identities and supplied negative facts intact. */
export function testAppDocumentSources(contents: object): () => AppDocumentSources {
  const existing = documents.get(contents)
  if (existing) return existing
  const filePath = join(tmpdir(), 'agentmux-ipc-fixture', randomUUID(), 'renderer', 'index.html')
  let frame = Reflect.get(contents, 'mainFrame')
  if (!('mainFrame' in contents)) { frame = {}; Reflect.set(contents, 'mainFrame', frame) }
  if (frame && typeof frame === 'object') {
    if (!('url' in frame)) Reflect.set(frame, 'url', pathToFileURL(filePath).href)
    if (!('detached' in frame)) Reflect.set(frame, 'detached', false)
    if (!('isDestroyed' in frame)) Reflect.set(frame, 'isDestroyed', () => false)
  }
  if (!('isDestroyed' in contents)) Reflect.set(contents, 'isDestroyed', () => false)
  const current = { mode: 'prod' as const, filePath }
  const read = () => ({ current, loading: null })
  documents.set(contents, read)
  return read
}
