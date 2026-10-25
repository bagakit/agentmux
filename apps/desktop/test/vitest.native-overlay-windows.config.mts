import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import original from '../../../vitest.config'
const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/main/native-overlay-windows.ts', hook = 'apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts', regions = 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts'
const changes = {
  permanentBlur: ['apps/desktop/src/preload/index.ts', 'const initialTheme: ThemeBootstrap | null =', "if (process.isMainFrame) window.addEventListener('blur', event => { if (event.target === window && event.isTrusted) ipcRenderer.sendSync(NATIVE_OVERLAY_FOCUS_CHANNEL) }, true)\nconst initialTheme: ThemeBootstrap | null ="],
  idleBlur: [hook, '() => mayHaveProjection &&', '() => true &&'],
  pendingRemoval: [hook, 'if (regions.length) mayHaveProjection = true', 'mayHaveProjection = regions.length > 0'],
  newerProjection: [hook, 'receipt.projected === 0 && !pending', 'receipt.projected === 0'],
  actualWindow: [owner, 'const window = this.windows.windowForDocument(document)\n    if (window.isDestroyed()', 'const window = this.main\n    if (window.isDestroyed()'],
  originalOwner: [owner, 'this.browsers.nativeOwner(browserId, window)', 'this.browsers.nativeOwner(browserId)'],
  originalInput: [owner, 'this.entries.get(this.browsers.windowForView(owner.view))', 'this.entries.get(this.main)'],
  scopedInput: [owner, '{ ...input, ...(entry.document ? { document: entry.document } : {}) }', '{ ...input }'],
  exactFocus: ['apps/desktop/src/main/native-overlay-focus.ts', '(document === undefined ? overlays : scoped?.(document))', '(overlays)'],
  relatedRefresh: [owner, 'const entry = this.entries.get(window)\n    if (!entry) return\n    await entry.surfaces.refresh()', 'for (const entry of this.entries.values()) await entry.surfaces.refresh()'],
  disposal: [owner, 'entry.release()', 'void entry'],
  originalRoot: [regions, "&& !node.hasAttribute('data-workbench-document-root')", ''],
  initialDemand: [regions, 'initialDemand ?? null', 'null'],
  actualScale: [hook, 'zoomFactor = visibility.zoomFactor', 'zoomFactor = api.ui.getZoomFactor()'],
  documentDemand: [hook, '!sameNativeOverlayDocument(visibility.document, scope) || ', ''],
  documentInput: [hook, 'if (sameNativeOverlayDocument(input.document, scope)) overlays.handleNativeInput(input)', 'overlays.handleNativeInput(input)']
} as const
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export default defineConfig({ ...original, plugins: [{ name: 'actual-native-document-overlay-mutants', enforce: 'pre', transform(source, id) {
  const name = process.env.NATIVE_WINDOW_OVERLAY_MUTATION as keyof typeof changes | undefined
  if (!name) return
  assert.ok(changes[name]); const [file, needle, replacement] = changes[name]
  if (relative(root, id) !== file) return
  const occurrences = source.split(needle).length - 1; assert.equal(occurrences, 1)
  const changed = source.replace(needle, replacement)
  if (process.env.NATIVE_WINDOW_OVERLAY_HITS) appendFileSync(process.env.NATIVE_WINDOW_OVERLAY_HITS,
    JSON.stringify({ name, file, occurrences, source: sha(source), changed: sha(changed) }) + '\n')
  return { code: changed, map: null }
} }], test: { ...original.test, include: [
  'apps/desktop/test/native-overlay-focus.test.ts', 'apps/desktop/test/native-overlay-chrome.test.tsx',
  'apps/desktop/test/native-overlay-pointer.test.tsx', 'apps/desktop/test/native-overlay-regions.test.ts',
  'apps/desktop/test/native-overlay-surfaces.test.ts', 'apps/desktop/test/native-overlay-windows.test.ts',
  'apps/desktop/test/native-overlay-document.test.tsx'
], passWithNoTests: false, maxWorkers: 2, testTimeout: 15000, hookTimeout: 15000 } })
