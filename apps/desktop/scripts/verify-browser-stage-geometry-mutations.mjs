import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const observer = 'apps/desktop/src/renderer/src/lib/browser-stage-geometry.ts'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
await verifyRendererSourceMutations({
  name: `browser-stage-geometry-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/browser-stage-geometry.test.ts', 'apps/desktop/test/browser-stage-geometry-real-library.test.ts'],
  sources: [observer, pane, 'apps/desktop/src/renderer/src/lib/browser-bounds-sync.ts',
    'apps/desktop/src/shared/browser-bounds.ts', 'apps/desktop/src/renderer/src/lib/region-focus.ts'],
  mutations: [
    { label: 'inactive-stage-subscribed', file: observer, before: 'if (!active) return () => {}', after: 'if (false) return () => {}' },
    { label: 'position-callback-disconnected', file: observer,
      before: 'autoUpdate(stage, stage, update,', after: 'autoUpdate(stage, stage, () => {},' },
    { label: 'layout-shifts-ignored', file: observer, before: 'layoutShift: true', after: 'layoutShift: false' },
    { label: 'idle-frame-polling', file: observer, before: 'animationFrame: false', after: 'animationFrame: true' },
    { label: 'same-target-resize-loop', file: observer, before: 'elementResize: false', after: 'elementResize: true' },
    { label: 'size-observation-lost', file: observer, before: 'resize.observe(stage)', after: 'void stage' },
    { label: 'size-callback-disconnected', file: observer, before: 'new ResizeObserver(update)', after: 'new ResizeObserver(() => {})' },
    { label: 'position-cleanup-lost', file: observer, before: 'stop(); resize.disconnect()', after: 'resize.disconnect()' },
    { label: 'size-cleanup-lost', file: observer, before: 'stop(); resize.disconnect()', after: 'stop()' },
    { label: 'product-observer-disconnected', file: pane,
      before: 'observeBrowserStageGeometry(stage, update, visible && !released && !restoring)', after: '(() => {})' }
  ]
})
