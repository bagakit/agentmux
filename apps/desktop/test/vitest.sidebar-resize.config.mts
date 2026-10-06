import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '../../..')
const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const coreAliases = Object.entries(exports).map(([key, value]) => ({ find: key === '.' ? '@agentmux/core' : `@agentmux/core/${key.slice(2)}`,
  replacement: resolve(root, 'packages/core', (value as { import: string }).import.replace('/dist/', '/src/').replace(/\.js$/, '.ts')) })).sort((a,b) => b.find.length-a.find.length)
const hook = 'apps/desktop/src/renderer/src/hooks/useSidebarResize.ts'
const changes = {
 cancel: [hook, "event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return\n    event.preventDefault(); event.stopPropagation(); finishResize(false)", "event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)) return\n    event.preventDefault(); event.stopPropagation(); finishResize(true)"],
 publication: [hook, 'if (commit && finalWidth !== width) setWidth(finalWidth)', 'if (true) setWidth(finalWidth)'],
 reset: [hook, 'setWidth(defaultWidth)', 'setWidth(clampSidebarResizeWidth(defaultWidth, minWidth, maxWidth))'],
 ime: [hook, "event.key !== 'Escape' || isImeOwnedKeyboardEvent(event)", "event.key !== 'Escape'"],
 imeReset: [hook, 'event.nativeEvent instanceof KeyboardEvent && isImeOwnedKeyboardEvent(event.nativeEvent)', 'false'],
 hidden: [hook, 'if (!resizable) finishResize(false)', 'if (false) finishResize(false)'],
 left: [hook, 'if (!resizable || event.button !== 0) return', 'if (!resizable) return'],
 sibling: [hook, 'if (ownedDrag) resetDocumentStyles()', 'resetDocumentStyles()'],
 nativeClick: [hook, 'secondPressRef.current && !movedRef.current', 'secondPressRef.current'],
 consumer: ['apps/desktop/src/renderer/src/components/ProjectRail.tsx', 'onDoubleClick={onResizeReset}', 'onDoubleClick={() => {}}']
} as const
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { conditions: ['browser'], alias: coreAliases },
  plugins: [{ name: 'actual-reference-surface-mutation', enforce: 'pre', transform(source,id) {
    const mutation = process.env.SIDEBAR_RESIZE_MUTATION as keyof typeof changes | undefined
    if (!mutation) return
    assert.ok(changes[mutation], 'Known mutation'); const [path,needle,value] = changes[mutation]
    if (relative(root,id) !== path) return
    assert.equal(source.split(needle).length-1,1, 'Unique original implementation mutation')
    if (process.env.SIDEBAR_RESIZE_MUTATION_HITS) appendFileSync(process.env.SIDEBAR_RESIZE_MUTATION_HITS,path+'\n')
    return { code: source.replace(needle,value), map: null }
  } }], test: { include: ['apps/desktop/test/sidebar-resize-cancel.test.tsx','apps/desktop/test/project-rail-resize.test.tsx','apps/desktop/test/focus-timeline-name-width.test.tsx'], setupFiles: [resolve(root,'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
