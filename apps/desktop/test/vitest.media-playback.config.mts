import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const changes = {
  'unknown-live': ['packages/editor-extensions/src/engines/media-player.ts', "if (!window) return 'unknown'", "if (!window) return 'at-live'"],
  'pointer-speed': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'direction: 1, wrap: true', 'direction: 1, wrap: false']
} as const

export default defineConfig({ ...original,
  // These owners consume Core source directly, so concurrent unrelated Core builds cannot qualify them.
  resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: resolve(root, 'packages/core/src/index.ts') }] },
  plugins: [{ name: 'media-playback-source-mutations', enforce: 'pre', transform(source, id) {
    const mutation = process.env.MEDIA_PLAYBACK_MUTATION as keyof typeof changes | undefined
    if (!mutation) return
    assert.ok(changes[mutation], 'Known media playback mutation')
    const [path, needle, replacement] = changes[mutation]
    if (relative(root, id) !== path) return
    assert.equal(source.split(needle).length - 1, 1, 'Exactly one loaded mutation anchor')
    const code = source.replace(needle, replacement)
    if (process.env.MEDIA_PLAYBACK_HITS) appendFileSync(process.env.MEDIA_PLAYBACK_HITS,
      JSON.stringify({ mutation, path, original: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(code).digest('hex') }) + '\n')
    return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], passWithNoTests: false, include: [
    'apps/desktop/test/workspace-media-streams.test.ts', 'apps/desktop/test/workspace-media-playlists.test.ts',
    'apps/desktop/test/media-player.test.tsx'
  ] }
})
