export const tests = ['apps/desktop/test/vega-preview.test.ts', 'apps/desktop/test/vega-preview-lifecycle.test.tsx', 'apps/desktop/test/workspace-vega-loader.test.ts']
export const sources = ['apps/desktop/src/renderer/src/lib/file-formats/vega-spec.ts', 'apps/desktop/src/renderer/src/lib/file-formats/vega-worker.ts', 'apps/desktop/src/renderer/src/lib/file-formats/vega-chart.worker.ts', 'apps/desktop/src/renderer/src/lib/file-formats/vega-chart-protocol.ts', 'apps/desktop/src/renderer/src/components/file-preview/VegaFilePreview.tsx', 'apps/desktop/src/renderer/src/lib/file-formats/workspace-vega-loader.ts']
export const mutations = [
  { label: 'vega-ast-removed', file: sources[0], before: '{ ast: true }', after: '{ ast: false }' },
  { label: 'vega-worker-termination-removed', file: sources[1], before: 'worker.terminate()', after: 'void worker' },
  { label: 'vega-view-finalize-removed', file: sources[2], before: 'view?.finalize()', after: 'void view' },
  { label: 'vega-original-workspace-check-removed', file: sources[5], before: 'invalidated || binding(workspaceId) !== original', after: 'false' },
  { label: 'vega-dom-event-bridge-removed', file: sources[4], before: 'chart.current?.event(packet)', after: 'void packet' },
  { label: 'vega-typed-signal-bridge-removed', file: sources[4], before: 'chart.current?.setSignal(binding.signal, value)', after: 'void value' },
  { label: 'vega-explicit-width-overwritten', file: sources[2], before: 'if (responsiveWidth) view.width(containerWidth)', after: 'view.width(containerWidth)' }
]
