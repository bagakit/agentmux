const collector = 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts'
const hook = 'apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts'
const shared = 'apps/desktop/src/shared/native-overlay.ts'
export const schedulingMutations = [
  { name: 'no-known-geometry-check', path: collector, edits: [['if (!collectRequested) for (const [node, previous] of geometryBounds)', 'if (false) for (const [node, previous] of geometryBounds)']], expected: 'movement without mutation' },
  { name: 'full-scan-every-frame', path: collector, edits: [['if (collectRequested || changed) collect()', 'collect()']], expected: 'only reads the known rectangles' },
  { name: 'unbounded-stable-frames', path: collector, edits: [[' && stableFrames < STABLE_GEOMETRY_FRAMES', '']], expected: 'releases its frame after a bounded confirmation' },
  { name: 'no-layout-shift-observation', path: collector, edits: [["if (typeof win.IntersectionObserver === 'function') for (const node of observed)", 'if (false) for (const node of observed)']], expected: 'releases its frame after a bounded confirmation' },
  { name: 'wrong-document-frame', path: collector, edits: [['frame = win.requestAnimationFrame(tick)', 'frame = window.requestAnimationFrame(tick)']], expected: 'source document frame' },
  { name: 'duplicate-publish', path: hook, edits: [['if (sameNativeOverlayRegions(delivered, next.regions))', 'if (false)']], expected: 'identical descriptors do not republish' },
  { name: 'compare-before-flight-settles', path: hook, edits: [['pending = { regions: structuredClone(regions)', 'if (sameNativeOverlayRegions(delivered, regions)) return; pending = { regions: structuredClone(regions)']], expected: 'A followed by B in flight then A' },
  { name: 'rejected-cache-retained', path: hook, edits: [['delivered = undefined\n              const message', '/* stale cache retained */\n              const message']], expected: 'unconfirmed in-flight delivery invalidates' },
  { name: 'caller-snapshot-omitted', path: hook, edits: [['regions: structuredClone(regions)', 'regions']], expected: 'caller mutates its next desired geometry' },
  { name: 'stage-bounds-ignored', path: shared, edits: [[' && boundsEqual(stage.bounds, otherStages[stageIndex]!.bounds)', '']], expected: 'complete ordered descriptor for stage-x' },
  { name: 'late-warning-overwrites-clear', path: hook, edits: [['if (warningRevision === beforeWarnings) nativeWarning = receipt.warning', 'nativeWarning = receipt.warning']], expected: 'notice cleared by its actual owner' }
]
