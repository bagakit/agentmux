import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export const pageDecoderMutations = {
  'original-offset': ['apps/desktop/src/main/workspace-cbr-archives.ts', 'let position = 0', 'let position = 1'],
  'exact-entry': ['apps/desktop/src/main/workspace-cbr-archives.ts', 'if (path !== selected)', 'if (false)'],
  'cbr-consumer': ['packages/editor-extensions/src/books/page-decoders/cbr.ts', 'source.loadEntry(page.path, signal)', 'source.loadEntry(pages[0]!.path, signal)'],
  'page-release': ['packages/editor-extensions/src/books/page-decoders/page-book.ts', 'URL.revokeObjectURL(resident.document)', 'void resident.document'],
  'resident-race': ['packages/editor-extensions/src/books/page-decoders/page-book.ts', 'pending?.controller.abort(); pending = undefined\n        return Promise.resolve(resident.document)', 'return Promise.resolve(resident.document)'],
  'djvu-page': ['packages/editor-extensions/src/books/page-decoders/djvu.worker.ts', 'document.render_page(data.index, targetDpi)', 'document.render_page(0, targetDpi)'],
  'djvu-terminate': ['packages/editor-extensions/src/books/page-decoders/djvu.ts', 'worker?.terminate(); worker = undefined', 'worker = undefined'],
}
export function pageDecoderMutation(name, hits) {
  if (!name) return []
  assert.ok(pageDecoderMutations[name], 'A named real page-decoder mutation')
  const [file, before, after] = pageDecoderMutations[name]
  return [{ name: 'page-decoder-mutation-' + name, enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== resolve(root, file)) return
    const anchors = source.split(before).length - 1
    assert.equal(anchors, 1, 'Exactly one checked-out page-decoder source anchor')
    appendFileSync(hits, JSON.stringify({ name, file, anchors, sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
    return source.replace(before, after)
  } }]
}
