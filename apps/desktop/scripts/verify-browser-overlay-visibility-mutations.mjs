import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const main = 'apps/desktop/src/main/native-overlay-surfaces.ts'
const regions = 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts'
const workbench = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
const manager = 'apps/desktop/src/main/browser-view-manager.ts'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
await verifyRendererSourceMutations({
  name: `browser-overlay-visibility-mutations-${Date.now()}`,
  tests: ['apps/desktop/test/native-overlay-surfaces.test.ts', 'apps/desktop/test/native-overlay-regions.test.ts',
    'apps/desktop/test/native-overlay-pointer.test.tsx', 'apps/desktop/test/native-browser-pointer.test.ts',
    'apps/desktop/test/workbench-browser-visibility.test.tsx'],
  sources: [main, regions, workbench, pane, manager, 'apps/desktop/src/shared/native-overlay.ts',
    'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts'],
  mutations: [
    { label: 'loaded-chrome-platform-synchronization-disconnected', file: main,
      before: 'projection.view.webContents.setBackgroundThrottling(false)',
      after: 'void projection.view.webContents' },
    { label: 'loaded-chrome-platform-synchronization-repeated-on-repaint', file: main,
      before: 'if (!projection.throttlingSynchronized) {', after: 'if (true) {' },
    { label: 'chrome-platform-synchronization-before-content-load', file: main,
      before: "    projection.paintStage = 'Original Chrome frame'",
      after: "    projection.view.webContents.setBackgroundThrottling(false)\n    projection.throttlingSynchronized = true\n    projection.paintStage = 'Original Chrome frame'" },
    { label: 'closed-chrome-late-content-still-synchronized', file: main,
      before: '  private finishLoadedPaint(projection: Projection, revision: number): void {\n    if (!this.current(projection) || revision !== projection.revision) return',
      after: '  private finishLoadedPaint(projection: Projection, revision: number): void {\n    if (false) return' },
    { label: 'chrome-load-starts-before-native-owner-attachment', file: main,
      before: '        this.window.contentView.addChildView(view)\n        view.setBounds(region.bounds)',
      after: '        view.setBounds(region.bounds)' },
    { label: 'chrome-load-starts-without-actual-bounds', file: main,
      before: '        view.setBounds(region.bounds)\n        view.setVisible(true)\n',
      after: '        view.setVisible(true)\n' },
    { label: 'stale-closed-frame-failure-removes-replacement', file: main,
      before: 'if (generation !== this.generation || !this.current(projection)) continue', after: 'if (false) continue' },
    { label: 'native-chrome-pid-owner-lost', file: main,
      before: 'resourceProcessIds(): number[] {', after: 'resourceProcessIds(): number[] { return []; ' },
    { label: 'native-outside-pointer-disconnected', file: main,
      before: 'this.onBrowserPointer({ x: x / zoom, y: y / zoom, button: pointer.button === \'right\' ? 2 : pointer.button === \'middle\' ? 1 : 0 })', after: 'void zoom' },
    { label: 'native-owner-input-not-connected', file: manager,
      before: 'this.onNativePointer?.(entry.bounds, input)', after: 'void input' },
    { label: 'outside-pointer-acts-on-hidden-chrome', file: regions,
      before: "if (!target?.closest('[data-native-browser-stage]')) return", after: 'if (!target) return' },
    { label: 'ordinary-outside-pointer-promoted-to-click', file: regions,
      before: "new win.PointerEvent('pointerdown',", after: "new win.PointerEvent('click'," },
    { label: 'native-auto-popover-outside-dismissal-disconnected', file: regions,
      before: 'node.hidePopover()', after: 'void node' },

    { label: 'portal-hides-whole-browser', file: workbench,
      before: 'nativeSurfacesVisible={visible && !focusTab && activeDrag === null}',
      after: 'nativeSurfacesVisible={visible && !focusTab && activeDrag === null && portalOverlayCount === 0}' },
    { label: 'local-menu-hides-whole-browser', file: pane, before: '          restoring ||', after: '          restoring ||\n          menuOpen ||' },
    { label: 'unrelated-float-allocates-native-view', file: main,
      before: '!browsers.some(browser => boundsOverlap(browser, bounds))', after: 'false' },
    { label: 'native-pointer-disconnected', file: main,
      before: 'this.window.webContents.sendInputEvent({ ...event, x: event.x + projection.region.bounds.x, y: event.y + projection.region.bounds.y })',
      after: 'void event' },
    { label: 'modal-scrim-replaced-by-opaque-bitmap', file: main,
      before: 'if (projection.region.scrim !== undefined) {', after: 'if (false) {' },
    { label: 'popover-toggle-disconnected', file: regions,
      before: "body.addEventListener('toggle', onToggle, true)", after: 'void onToggle' },
    { label: 'css-zoom-disconnected', file: regions,
      before: 'rendererCssBoundsToWindowDip(rect, zoomFactor())', after: 'rendererCssBoundsToWindowDip(rect, 1)' }
  ]
})
