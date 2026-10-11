import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/components/AgentInformationReader.tsx'
const changes = {
  escapedScope: ['? getModalOverlayContainer(opening.anchor) : null', '? null : null'],
  staleTransient: ['if (event.target === modalSlot && !detachedFromModal.current) agentInformationPreview.dismiss(request.token)', 'if (false) agentInformationPreview.dismiss(request.token)'],
  trappedBookmark: ['if (request.pinned || request.bookmark) detachedFromModal.current = true', 'if (false) detachedFromModal.current = true'],
  ignoredFrontOrder: ['if (following !== before) moveReadingHost(readingHost, destination, before)', 'if (false) moveReadingHost(readingHost, destination, before)'],
  escapedGlobalRank: ["zIndex: 'var(--layer-popover)'", 'zIndex: `calc(var(--layer-popover) + ${agentInformationPreview.getAll().findIndex(item => item.token === request.token)})`'],
  missingEscapeOwner: ['active={attachedToModal}', 'active={false}']
} as const
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...original, plugins: [{ name: 'reader-modal-lifecycle-mutants', enforce: 'pre', transform(source, id) {
  const name = process.env.READER_MODAL_MUTATION as keyof typeof changes | undefined
  if (!name || relative(root, id) !== owner) return
  assert.ok(changes[name])
  const [needle, replacement] = changes[name]
  const occurrences = source.split(needle).length - 1
  assert.equal(occurrences, 1)
  const changed = source.replace(needle, replacement)
  if (process.env.READER_MODAL_HITS) appendFileSync(process.env.READER_MODAL_HITS,
    JSON.stringify({ name, file: owner, occurrences, source: sha(source), changed: sha(changed),
      inputHashes: Object.fromEntries(['apps/desktop/test/reader-modal-mutations.config.mts', 'apps/desktop/test/agent-bookmark-interaction.test.tsx', 'apps/desktop/test/agent-bookmarks.integration.test.tsx']
        .map(file => [file, sha(readFileSync(resolve(root, file), 'utf8'))])) }) + '\n')
  return { code: changed, map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/agent-bookmark-interaction.test.tsx', 'apps/desktop/test/agent-bookmarks.integration.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
