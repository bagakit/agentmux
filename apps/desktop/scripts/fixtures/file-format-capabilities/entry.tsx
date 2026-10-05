// Reuse the real Workbench/FileExplorer/store shell; this fixture adds only observations.
const nativeWorker = window.Worker
const workers: Array<{ url: string; terminated: boolean }> = []
window.Worker = class extends nativeWorker {
  fact: { url: string; terminated: boolean }
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); this.fact = { url: String(url), terminated: false }; workers.push(this.fact) }
  override terminate() { this.fact.terminated = true; super.terminate() }
}
const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL), blobs = new Map<string, Blob | MediaSource>()
URL.createObjectURL = object => { const url = createUrl(object); blobs.set(url, object); return url }
URL.revokeObjectURL = url => { blobs.delete(url); revokeUrl(url) }
// Observe before any product module or the shell's top-level startup can create resources.
const { useAppStore } = await import('../../../src/renderer/src/store')
const { addWorkbenchRegion } = await import('../../../src/renderer/src/lib/workbench-tabs')
const { workspaceFileFormat } = await import('../../../src/shared/workspace-file-format')
await import('../file-surface-quality/visual/entry')
const probe = (window as any).filePreviewProbe
function snapshot() {
  const state = useAppStore.getState()
  return structuredClone({ tabs: state.tabs, layouts: state.layouts, activeWorkspaceId: state.activeWorkspaceId,
    documents: Object.fromEntries(Object.entries(state.documents).filter(([key]) => state.dirtyDocuments[key])),
    dirtyDocuments: Object.fromEntries(Object.entries(state.dirtyDocuments).filter(([, dirty]) => dirty)), editorRegionModes: state.editorRegionModes })
}
const beforeFixture = snapshot()
Object.assign(probe, {
  beforeFormatFixture: beforeFixture,
  snapshot,
  defaultMode: (path: string) => workspaceFileFormat(path).defaultMode === 'edit' ? 'source' : 'preview',
  executeControl: (request: Parameters<ReturnType<typeof useAppStore.getState>['executeControl']>[0]) => useAppStore.getState().executeControl(request),
  splitActive(ratio = .4) {
    const state = useAppStore.getState(), layout = state.layouts[probe.workspaceId]!, group = layout.groups.find(item => item.id === layout.activeGroupId)!, tab = state.tabs[group.activeTabId!]!, regionId = tab.layout.activeRegionId
    let next = Object.keys(tab.regions).length > 1 ? tab : addWorkbenchRegion(tab, regionId, 'right', { regionId: `format-neighbor:${tab.id}`, kind: 'file', workspaceId: probe.workspaceId, path: 'notes.md' })
    if (next.layout.root.type === 'split') next = { ...next, layout: { ...next.layout, root: { ...next.layout.root, ratio }, activeRegionId: regionId } }
    useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: next } })
  },
  blobText: (url: string) => { const blob = blobs.get(url); if (!(blob instanceof Blob)) throw Error('The original live Blob is unavailable'); return blob.text() },
  resources: () => ({ workers: workers.map(worker => ({ ...worker })), blobs: [...blobs.keys()],
    frames: [...document.querySelectorAll('iframe')].map(frame => ({ title: frame.title, sandbox: frame.getAttribute('sandbox'), src: frame.src })) }),
  excalPaint() {
    for (const canvas of probe.activeRegion()?.querySelectorAll('canvas') ?? []) {
      const context = canvas.getContext('2d')
      if (!context || !canvas.width || !canvas.height) continue
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let blue = 0, green = 0
      const bounds = { blue: [canvas.width, canvas.height, -1, -1], green: [canvas.width, canvas.height, -1, -1] }
      for (let index = 0; index < pixels.length; index += 16) {
        const [r, g, b, a] = pixels.subarray(index, index + 4), x = (index / 4) % canvas.width, y = Math.floor(index / 4 / canvas.width)
        const color = a > 200 && b > r + 12 && b > g + 8 ? 'blue' : a > 200 && g > r + 12 && g > b + 8 ? 'green' : null
        if (color) { if (color === 'blue') blue++; else green++; const box = bounds[color]; box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y) }
      }
      if (blue > 50 && green > 50) return { ready: Object.values(bounds).every(box => box[0] > 0 && box[1] > 0 && box[2] < canvas.width - 1 && box[3] < canvas.height - 1), blue, green, bounds, width: canvas.width, height: canvas.height }
    }
    return { ready: false }
  },
  async model() {
    const { editor } = await import('monaco-editor')
    const models = editor.getModels()
    return models.map(model => ({ uri: model.uri.toString(), content: model.getValue(), language: model.getLanguageId(), firstLineTokens: editor.tokenize(model.getLineContent(1), model.getLanguageId())[0]?.map(token => token.type) }))
  }
})
