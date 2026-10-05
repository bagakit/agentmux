export const tests = ['apps/desktop/test/excalidraw-preview.test.tsx', 'apps/desktop/test/excalidraw-local-fonts.test.ts']
export const sources = ['apps/desktop/src/renderer/src/components/file-preview/ExcalidrawFilePreview.tsx', 'apps/desktop/src/renderer/src/lib/file-formats/excalidraw-scene.ts', 'apps/desktop/src/renderer/src/lib/file-data-preview.ts', 'apps/desktop/scripts/excalidraw-local-fonts.ts', 'apps/desktop/scripts/file-diagram-assets.ts']
export const mutations = [
  { label: 'excalidraw-view-mode-removed', file: sources[0], before: 'viewModeEnabled zenModeEnabled', after: 'viewModeEnabled={false} zenModeEnabled' },
  { label: 'excalidraw-files-validation-removed', file: sources[1], before: "value.type !== 'excalidraw'", after: 'false' },
  { label: 'excalidraw-late-import-cancellation-removed', file: sources[0], before: 'if (cancelled) return', after: 'void cancelled' },
  { label: 'excalidraw-viewport-fit-removed', file: sources[0], before: 'api.current?.scrollToContent(undefined,', after: 'void (undefined,' },
  { label: 'excalidraw-hosted-font-fallback-retained', file: sources[3], before: "return code.replace(matches[0], 'void 0')", after: 'return code' },
  { label: 'excalidraw-production-transform-disconnected', file: sources[4], before: 'transform: localizeExcalidrawFontUrls,', after: 'transform: undefined,' },
  { label: 'excalidraw-dev-optimizer-transform-disconnected', file: sources[4], before: "const contents = localizeExcalidrawFontUrls(readFileSync(path, 'utf8'), path)", after: "const contents = readFileSync(path, 'utf8')" }
]
