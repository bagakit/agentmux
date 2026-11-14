import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import original from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const changes = {
  'unknown-live': ['packages/editor-extensions/src/engines/media-player.ts', "if (!window) return 'unknown'", "if (!window) return 'at-live'"],
  'pointer-speed': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'direction: 1, wrap: true', 'direction: 1, wrap: false'],
  'seek-every-request': ['packages/editor-extensions/src/engines/media-player.ts', 'if (open && flight === null) {', 'if (open) {'],
  'seek-oldest-waiting': ['packages/editor-extensions/src/engines/media-player.ts', "next = time\n      return 'queued'", "next ??= time\n      return 'queued'"],
  'seek-landing-keeps-waiting': ['packages/editor-extensions/src/engines/media-player.ts', 'next = null\n      if (time === flight', 'if (time === flight'],
  'pointer-rerenders-player': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'onPointerMove={audioOnly ? undefined : wake}',
    'onPointerMove={audioOnly ? undefined : () => { wake(); setFacts(previous => ({ ...previous })) }}'],
  'pointing-bare-track': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', "getPropertyValue('--media-thumb')) || 0", "getPropertyValue('--media-thumb')) * 0 || 0"],
  'pointing-unstepped': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'Math.round(along * TIMELINE_STEPS) / TIMELINE_STEPS * span', 'along * span'],
  'wake-while-awake': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'if (activeNow.current === next) return; ', ''],
  'thumb-read-every-move': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'thumbWidth.current ??= ', ''],
  'drag-keeps-playing': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'if (hold.resume) { quiet.current.pause = true; element.pause() }', 'if (hold.resume) { quiet.current.pause = false }'],
  'drag-stays-paused': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'quiet.current.play = true; void element.play().catch(() => { quiet.current.play = false })', 'quiet.current.play = false'],
  'drag-bypasses-queue': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'if (holding.current?.follow) seeks.current!.request(time)', 'if (holding.current?.follow) media.current!.currentTime = time'],
  'release-bypasses-queue': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'if (hold?.follow) seeks.current!.land(time); else element.currentTime = time', 'element.currentTime = time'],
  'drag-audio-follows': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'const hold = { follow: !audioOnly,', 'const hold = { follow: true,'],
  'drag-announces-play': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', "if (quiet.current.play) quiet.current.play = false; else announce('Playing')", "announce('Playing')"],
  'drag-announces-pause': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', "if (quiet.current.pause) quiet.current.pause = false; else if (!released.current) announce('Paused')", "if (!released.current) announce('Paused')"],
  'drag-shows-disc': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'facts.paused && !facts.ended && !failure && !drag ?', 'facts.paused && !facts.ended && !failure ?'],
  'drag-shows-pause': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', 'const playingShown = drag ? drag.resume : playing', 'const playingShown = playing'],
  'drag-lands-on-key-release': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'onKeyUp={() => { if (!pressed.current) onLand() }}', 'onKeyUp={onLand}'],
  'press-keeps-old-value': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'if (pressedAt) onScrub(pressedAt.time)', 'void pressedAt']
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
