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
  'preview-playlists': ['packages/editor-extensions/src/engines/media-player.ts', "return source === 'video' && stream", "return source !== 'audio' && stream"],
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
  'press-keeps-old-value': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'if (pressedAt) onScrub(pressedAt.time)', 'void pressedAt'],
  'preview-at-mount': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'const decoderShown = preview !== null && decoding', 'const decoderShown = preview !== null'],
  'preview-no-dwell': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', '}, PREVIEW_DWELL_MS)', '}, 0)'],
  'preview-preload-auto': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'muted preload="metadata"', 'muted preload="auto"'],
  'preview-never-released': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'release.current = null; setDecoding(false) }, PREVIEW_RELEASE_MS)', 'release.current = null }, PREVIEW_RELEASE_MS)'],
  'preview-return-keeps-release': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'now.session += 1\n      if (release.current) { clearTimeout(release.current); release.current = null }', 'now.session += 1'],
  'preview-ignores-idle': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'useEffect(() => { if (!controlsShown) leave() }, [controlsShown, leave])', 'useEffect(() => {}, [controlsShown, leave])'],
  'preview-ignores-hidden': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', "if (document.visibilityState === 'hidden') leave()", 'void document'],
  'preview-after-main-failure': ['packages/editor-extensions/src/ui/MediaPlayer.tsx', "decode === 'ready' && facts.width > 0", "decode !== 'loading' && facts.width > 0"],
  'preview-frame-early': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', "if (status === 'resting') setFrameShown(true)", "if (status !== 'queued') setFrameShown(true)"],
  'preview-rest-unseen': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', "if (status === 'resting') setFrameShown(true)", "if (status === 'resting') void 0"],
  'preview-in-flight-unadopted': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', "else if (status === 'in-flight') pointing.current.issued = pointing.current.session", "else if (status === 'in-flight') void 0"],
  'preview-stale-frame': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'fresh = now.issued === now.session', 'fresh = true'],
  'preview-keeps-source': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', "node.removeAttribute('src'); node.load()", 'node.load()'],
  'preview-during-drag': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'if (preview && !pressed.current && pointed.room', 'if (preview && pointed.room'],
  'preview-in-short-player': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', ' && pointed.room >= PREVIEW_MIN_ROOM', ''],
  'preview-frame-while-held': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'pressed.current = true\n    stopPreviewing()', 'pressed.current = true'],
  'preview-retry-within-pointing': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'if (now.failed === now.session) return', ''],
  'preview-never-retries': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'if (now.failed === now.session) return', 'if (now.failed !== -1) return'],
  'preview-error-reaches-main': ['packages/editor-extensions/src/ui/MediaTimeline.tsx', 'const onPreviewError = () => {', 'const onPreviewError = () => { onHold();']
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
