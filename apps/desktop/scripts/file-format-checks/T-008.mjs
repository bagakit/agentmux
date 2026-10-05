export const owningConfig = 'apps/desktop/test/diagram-format.config.mts'
export const tests = ['apps/desktop/test/file-format-controller.test.ts', 'apps/desktop/test/file-format-engine.test.ts', 'packages/core/test/file-format-cli.test.ts']
export const sources = [
  'apps/desktop/src/renderer/src/lib/file-formats/format-file-region.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/format-engine.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/format-worker.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/format-support.ts',
  'apps/desktop/src/renderer/src/lib/file-formats/monaco-format-adapter.ts',
  'apps/desktop/src/renderer/src/components/FileSourceEditor.tsx', 'apps/desktop/src/renderer/src/components/EditorPane.tsx',
  'packages/core/test/helpers/workface-cli.ts', 'packages/core/test/helpers/object-cli-receipt.ts', 'packages/core/test/helpers/object-cli-rpc.ts',
  'packages/core/src/space-control.ts', 'packages/core/src/control.ts', 'packages/core/src/space-control-parser.ts',
  'packages/core/src/rpc-business-codec.ts', 'packages/core/src/public-rpc.ts', 'packages/core/src/agentmux.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/bin/amux',
  'apps/desktop/src/shared/workspace-file-format.ts'
]
export const mutations = [
  { label: 'format-overwrites-new-draft', file: sources[0], before: 'adapters.get(regionId) !== adapter || !adapter.isCurrent(snapshot)', after: 'false' },
  { label: 'format-worker-survives-cancel', file: sources[0], before: 'worker.terminate()', after: 'void 0' },
  { label: 'format-keeps-computing-old-source', file: sources[0], before: "const cleanup = adapter.watch(snapshot, error => finish(error === undefined\n        ? { status: 'stale', message: 'The draft changed while formatting. Format the current draft again.' }\n        : { status: 'failed', message: 'The current source could not be checked. Retry formatting the draft.' }))", after: 'const cleanup = () => {}' },
  { label: 'format-writes-outside-undo-owner', file: sources[4], before: "editor.executeEdits('agentmux.formatDocument', [{ range: model.getFullModelRange(), text: content, forceMoveMarkers: true }])", after: 'true' },
  { label: 'jsonl-loses-integer-precision', file: sources[1], before: 'return jsonc.applyEdits(line, jsonc.format(line, undefined, { insertSpaces: true, tabSize: 2, eol: newline, keepLines: true }))', after: 'return JSON.stringify(JSON.parse(line))' }
]
