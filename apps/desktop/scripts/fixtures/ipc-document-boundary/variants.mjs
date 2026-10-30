import assert from 'node:assert/strict'
const ipcPath='apps/desktop/src/main/ipc.ts', trustPath='apps/desktop/src/main/ipc-sender-trust.ts', sourcesPath='apps/desktop/src/main/workbench-document-sources.ts'
export const variants = {
  'handle-admission': { file: ipcPath, scope: 'handle', from: 'assertAppDocumentSender(event, contents, args.appDocumentSources())', to: 'void event' },
  'event-admission': { file: ipcPath, scope: 'handleWithEvent', from: 'assertAppDocumentSender(event, contents, args.appDocumentSources())', to: 'void event' },
  'root-frame': { file: trustPath, from: 'event.senderFrame === frame', to: 'true' },
  'url-self-authorization': { file: trustPath, from: 'appDocumentSourceAllows(sources, frame.url)', to: 'true' },
  'old-serving-document': { file: sourcesPath, from: 'sources.current && isAllowedTopFrameNavigation(sources.current, url) ||', to: '!sources.loading && sources.current && isAllowedTopFrameNavigation(sources.current, url) ||' },
  'capsule-app-gate': { file: ipcPath, from: 'const disposeCapsuleDocument = capsuleDocuments.register(ipcMain)',
    to: "const disposeCapsuleDocument = (() => { handleWithEvent('capsule:document', (event, action: unknown, value: unknown) => sessionInputOperationResult(() => capsuleDocuments.call(event, action, value))); return () => {} })()" },
  'navigation-lifetime': { file: 'apps/desktop/src/main/index.ts',
    from: "const navigation = window.loadFile(file, { query: { ...probeQuery, 'renderer-update': token } }).finally(finish)\n        try { await Promise.all([navigation, ready]) }\n        finally { clearTimeout(timer); updateReady = null }",
    to: "const navigation = window.loadFile(file, { query: { ...probeQuery, 'renderer-update': token } })\n        try { await Promise.all([navigation, ready]) }\n        finally { finish(); clearTimeout(timer); updateReady = null }" }
}
export function transform(source, file, variant) {
  if (!variant || variant.file !== file) return source
  let start = 0, end = source.length
  if (variant.scope) {
    start = source.indexOf('const ' + variant.scope + ' =')
    assert.ok(start >= 0)
    end = source.indexOf('\n  }', start) + 4
  }
  const selected = source.slice(start, end)
  assert.equal(selected.split(variant.from).length, 2, 'One original source mutation anchor: ' + file)
  return source.slice(0, start) + selected.replace(variant.from, variant.to) + source.slice(end)
}
