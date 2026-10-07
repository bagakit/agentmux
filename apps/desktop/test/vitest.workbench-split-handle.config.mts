import { defineConfig } from 'vitest/config'
import original from './vitest.launch-choice-details.config.mts'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const changes = {
  cancel: ['apps/desktop/src/renderer/src/lib/split-ratio-commit.ts', 'if (this.dragOrigin !== null) this.latestRatio = this.dragOrigin\n    this.dragOrigin = null\n    this.dragging = false', ''],
  release: ['apps/desktop/src/renderer/src/lib/split-ratio-commit.ts', 'this.dragOrigin = null\n      this.commitLatest()', 'this.dragOrigin = null'],
  equalize: ['apps/desktop/src/renderer/src/components/WorkbenchSplitHandle.tsx', 'group.current?.setLayout([50, 50])', ''],
  ime: ['apps/desktop/src/renderer/src/components/WorkbenchSplitHandle.tsx', "event.key !== 'Enter' || isImeOwnedKeyboardEvent(event)", "event.key !== 'Enter'"],
  regionDirection: ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'nodePath, node.direction, regionIds(node)', 'nodePath, regionIds(node)'],
  groupDirection: ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'projection?.presentationId, node.direction, groupIds(node)', 'projection?.presentationId, groupIds(node)'],
  unavailable: ['apps/desktop/src/renderer/src/components/WorkbenchSplitHandle.tsx', 'if (latest.current.disabled) return', '']
} as const
export default defineConfig({ ...original, plugins: [{ name: 'original-workbench-split-mutations', enforce: 'pre', transform(source, id) {
  const name = process.env.DIVIDER_MUTATION as keyof typeof changes | undefined
  if (!name) return
  assert.ok(changes[name]); const [file, needle, replacement] = changes[name]
  if (relative(root, id) !== file) return
  assert.equal(source.split(needle).length - 1, 1)
  if (process.env.DIVIDER_HITS) appendFileSync(process.env.DIVIDER_HITS, file + '\n')
  return { code: source.replace(needle, replacement), map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/workbench-split-handle.test.tsx', 'apps/desktop/test/workbench-split-scope.test.tsx', 'apps/desktop/test/split-layout-registration.test.ts'], passWithNoTests: false } })
