import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
export const sourcePaths = ['components/GlobalFocusSurface.tsx','components/FocusProjectLanes.tsx','components/FocusContextRow.tsx','components/FocusDisconnectedGroup.tsx','components/FocusDisconnectedProjects.tsx','components/SpaceObjectIcon.tsx','lib/focus-project-lanes.ts'].map(file => `apps/desktop/src/renderer/src/${file}`)
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export function laneSourceBinding(root) {
  const css = readFileSync(path.join(root, 'apps/desktop/src/renderer/src/styles/focus.css'), 'utf8')
  const end = css.indexOf('/* One scroll canvas'), start = css.indexOf('.focus-pmo-attention {'), stop = css.indexOf('.focus-filters--mac', start)
  assert.ok(end > 0 && start > end && stop > start, 'Actual scoped Focus lane stylesheet boundaries are nonempty.')
  return { ...Object.fromEntries(sourcePaths.map(file => [file, sha(readFileSync(path.join(root,file)))])), 'focus.css:lane-segments': sha(css.slice(0,end)+css.slice(start,stop)) }
}
