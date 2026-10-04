import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import ts from 'typescript'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const store = 'apps/desktop/src/renderer/src/store.ts'
const secondary = 'apps/desktop/src/renderer/src/components/LauncherSecondarySurfaces.tsx'
const launchResult = 'apps/desktop/src/shared/session-launch-result.ts'
const tests = ['apps/desktop/test/launcher-prewarm-recovery.test.tsx', 'apps/desktop/test/launcher-prewarm-failure.test.tsx',
  'apps/desktop/test/terminal-create-confirmation-ipc.test.ts']
const sources = [store, secondary, launchResult, 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx',
  'apps/desktop/src/renderer/src/lib/warm-terminal-preview.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/desktop/test/helpers/first-execution-ipc-bridge.ts', 'apps/desktop/test/helpers/local-runtime-connector.ts', 'apps/desktop/browser-extension/protocol.js']
const mutations = [
  { label: 'same-request-uuid-lost', file: store,
    before: '    const request = creation.request\n', after: '    const request = { ...creation.request, createOperationId: crypto.randomUUID() }\n' },
  { label: 'first-error-discarded', file: store,
    before: '    const creation: WarmTerminalCreation = { request, inFlight: true }\n    const ready = api.sessions.launchTerminal(request).catch((error) => {\n      creation.inFlight = false\n      creation.issue = sessionLaunchFailure(error)\n',
    after: '    const creation: WarmTerminalCreation = { request, inFlight: true }\n    const ready = api.sessions.launchTerminal(request).catch((error) => {\n      creation.inFlight = false\n      delete creation.issue\n' },
  { label: 'visible-check-disconnected', file: secondary,
    before: 'onClick={checkWarmTerminal}', after: 'onClick={() => {}}' },
  { label: 'typed-code-stripped', file: launchResult,
    before: "    code: source?.code ?? 'TERMINAL_CREATE_UNCONFIRMED',", after: "    code: 'DISCARDED_CODE'," },
  { label: 'restored-event-retry-loop', file: store,
    before: '    if (hostRestored && creation.hostRecoveryAttempted) return null\n', after: '' },
  { label: 'healthy-foreign-slot-replaced', file: store,
    before: '    if (existing) return\n', after: '' },
  { label: 'pending-original-slot-discarded', file: store,
    before: 'warmTerminal: { ...held, claimingLauncherId },', after: 'warmTerminal: null,' },
  { label: 'late-confirmation-resurrects-view', file: store,
    before: `      if (launcher && (get().tabs[launcher.tabId]?.regions[launcher.regionId] !== launcherSurface ||
        !workbenchViewCloseAllowsView(get().closingWorkbenchViews, launcher.tabId))) return
`, after: '' },
  { label: 'late-confirmation-double-claim', file: store,
    before: `      if (live.claimingLauncherId) throw new Error('This reusable shell is already opening. Check its original request after that opening settles.')
`, after: '' }
]

// A real call outside the definition is required for each repaired boundary.
const callers = [
  [secondary, 'retryWarmTerminal'], [store, 'retryWarmTerminal'], [store, 'launchTerminal'],
  ['apps/desktop/src/main/ipc.ts', 'sessionLaunchResult'], ['apps/desktop/src/main/ipc.ts', 'launchTerminal'],
  ['apps/desktop/src/preload/index.ts', 'unwrapSessionLaunchResult'],
  ['apps/desktop/src/main/runtime-controller.ts', 'createTerminal'], ['packages/core/src/client.ts', 'start']
]
const callerEvidence = []
for (const [file, name] of callers) {
  const source = await readFile(join(root, file), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const matches = []
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const call = node.expression
      if ((ts.isIdentifier(call) && call.text === name) || (ts.isPropertyAccessExpression(call) && call.name.text === name) ||
        (name === 'unwrapSessionLaunchResult' && ts.isPropertyAccessExpression(call) && call.name.text === 'then' && node.arguments.some(arg => ts.isIdentifier(arg) && arg.text === name))) {
        matches.push(ast.getLineAndCharacterOfPosition(node.getStart()).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(matches.length > 0, `Missing actual production caller: ${file}/${name}`)
  callerEvidence.push({ file, name, lines: matches, sourceSha256: createHash('sha256').update(source).digest('hex') })
}
const evidence = join(root, '.tmp/launcher-warm-availability')
await mkdir(evidence, { recursive: true })
await writeFile(join(evidence, 'production-callers.json'), JSON.stringify({ callers: callerEvidence, nonempty: true }, null, 2) + '\n')
await verifyRendererSourceMutations({ name: 'loaded-mutations', tests, sources, mutations, evidenceRoot: evidence })
