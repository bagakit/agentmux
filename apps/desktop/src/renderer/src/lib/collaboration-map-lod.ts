import type { CollaborationLayoutBounds } from './collaboration-layout-engine'
import { DEFAULT_FOCUS_MAP_PREFERENCES, type FocusMapPreferences } from '../../../shared/focus-map-preferences'

export const COLLABORATION_DETAIL_START = .62
export const COLLABORATION_DETAIL_END = .82
export const COLLABORATION_OVERVIEW_MARK_SIZE = 28

/** The camera can shrink a shell without shrinking its readable ink below the
 * same screen budget. Longer text is clipped into the original Reader entry. */
export const collaborationMapTextBudget = (zoom: number) => ({
  '--collaboration-name-size': `${Math.max(12, 11 / zoom)}px`,
  '--collaboration-summary-size': `${Math.max(11, 10 / zoom)}px`,
  '--collaboration-state-size': `${Math.max(10, 9 / zoom)}px`
})

const mix = (from: number, to: number, progress: number) => from + (to - from) * progress
const smooth = (from: number, to: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** Camera presentation is continuous and never changes the world's layout slots. */
export function collaborationMapLod(zoom: number, preferences: FocusMapPreferences = DEFAULT_FOCUS_MAP_PREFERENCES) {
  let identity = 0, detail = 0, status = 0, summary = 0
  for (const [index, level] of preferences.levels.entries()) {
    const progress = index === 0 ? 1 : smooth(level.from, level.to, zoom)
    identity = mix(identity, Number(level.form !== 'point'), progress)
    detail = mix(detail, Number(level.form === 'card'), progress)
    status = mix(status, Number(level.information !== 'identity'), progress)
    summary = mix(summary, Number(level.information === 'summary'), progress)
  }
  // A chosen form is a capacity. Preserve readable ink at very early custom
  // thresholds rather than projecting a complete card into a few pixels.
  identity *= smooth(.18, .32, zoom)
  detail *= smooth(.5, COLLABORATION_DETAIL_START, zoom)
  return { identity, detail, status, summary: summary * detail }
}

/** Different text layouts hand over in sequence. Their shared shell remains
 * visible, but two displaced names or avatars never become a ghosted double. */
export function collaborationMapContentInk(detail: number) {
  return { identity: 1 - smooth(0, .16, detail), detail: smooth(.16, .8, detail) }
}

/** Reserve the avatar's real projected footprint before revealing a name.
 * An intermediate camera scale must not squeeze tiny text underneath it. */
export function collaborationIdentityInk(width: number, zoom: number, progress: number, markScale: number, glyphRadius: number) {
  const avatarCenter = mix(width / 2, 20, progress)
  const avatarRadius = glyphRadius * mix(markScale, 1, progress)
  const nameLeft = avatarCenter + avatarRadius + 8
  const available = Math.max(0, (width - nameLeft - 8) * zoom)
  return { avatarCenter, nameLeft, opacity: progress * smooth(32, 60, available), fontSize: Math.max(12, 11 / zoom) }
}

/** Original small point slots cannot become giant overlapping overview marks. */
export const collaborationOverviewScale = (box: CollaborationLayoutBounds, zoom: number) =>
  Math.min(1 / zoom, Math.min(box.width, box.height) / (COLLABORATION_OVERVIEW_MARK_SIZE / 2))

export type CollaborationVisibleHull = CollaborationLayoutBounds & { radius: number }

/** One footprint owner for the rendered body, directed endpoints and label clearance.
 * The circle, compact identity and readable body share the original slot's center. */
export function collaborationVisibleHull(box: CollaborationLayoutBounds, zoom: number, overviewRadius = COLLABORATION_OVERVIEW_MARK_SIZE / 2, pointRadius = 6, preferences: FocusMapPreferences = DEFAULT_FOCUS_MAP_PREFERENCES): CollaborationVisibleHull {
  const { identity, detail, status } = collaborationMapLod(zoom, preferences)
  const scale = collaborationOverviewScale(box, zoom)
  if (box.width <= 28 && box.height <= 28) {
    const radius = mix(overviewRadius, pointRadius, identity) * mix(scale, 1, identity)
    return { x: box.x + box.width / 2 - radius, y: box.y + box.height / 2 - radius, width: radius * 2, height: radius * 2, radius }
  }
  const diameter = overviewRadius * 2 * scale
  const compactWidth = Math.min(box.width, 154), compactHeight = Math.min(box.height, 38 + 14 * status * (1 - detail))
  const width = mix(mix(diameter, compactWidth, identity), box.width, detail)
  const height = mix(mix(diameter, compactHeight, identity), box.height, detail)
  const radius = Math.min(width / 2, height / 2, mix(mix(diameter / 2, 8, identity), 6, detail))
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height, radius }
}

export const collaborationVisibleHitBounds = (box: CollaborationLayoutBounds, zoom: number, preferences: FocusMapPreferences = DEFAULT_FOCUS_MAP_PREFERENCES): CollaborationLayoutBounds => collaborationVisibleHull(box, zoom, 14, Math.min(box.width, box.height) / 2, preferences)

/** Only visible summary ink needs retained body facts. The same predicate owns
 * viewport leases and actual body reads, including custom early/late stages. */
export const collaborationMapReadsSummary = (zoom: number, preferences: FocusMapPreferences = DEFAULT_FOCUS_MAP_PREFERENCES) => {
  const lod = collaborationMapLod(zoom, preferences)
  return lod.summary > 0 && collaborationMapContentInk(lod.detail).detail > 0
}

/** Explicit camera intent uses the same effective preference as original event marks. */
export const collaborationCameraDuration = (motion: boolean, initial = false) => motion && !initial ? 280 : 0
