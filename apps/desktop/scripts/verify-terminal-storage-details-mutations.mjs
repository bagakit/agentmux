import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import ts from 'typescript'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
const details = 'apps/desktop/src/renderer/src/components/TerminalStorageDetails.tsx'
const service = 'apps/desktop/src/renderer/src/components/TerminalServiceNotices.tsx'
const terminal = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const tests = ['apps/desktop/test/terminal-storage-details.test.tsx']
const sources = [details, service, terminal, 'apps/desktop/test/helpers/client-ui-render.tsx']
const mutations = [
  { label: 'late-replacement-sample-applied', file: details,
    before: 'current.current.target !== target || !current.current.visible || ', after: '' },
  { label: 'unsupported-capability-invented', file: details,
    before: "observation?.status === 'observed' ? observation.storage : null", after: 'observation?.storage ?? null' },
  { label: 'confirmed-watermark-confused', file: details,
    before: '{offset(persistence.confirmedByte)}</dd>', after: '{offset(persistence.offeredByte)}</dd>' },
  { label: 'completed-foreign-pending-stuck', file: details,
    before: 'if (mounted.current && sequence.current === request) setPending(previous => previous === target ? null : previous)',
    after: 'if (mounted.current && current.current.target === target && sequence.current === request) setPending(null)' },
  { label: 'service-window-consumer-disconnected', file: service,
    before: '{storageControl ? <TerminalStorageDetails', after: '{false ? <TerminalStorageDetails' }
]
const callerEvidence = []
for (const [file, name, kind] of [[details, 'observeStorage', 'call'], [service, 'TerminalStorageDetails', 'jsx'], [terminal, 'TerminalServiceNotices', 'jsx']]) {
  const source = await readFile(join(root, file), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = []
  function visit(node) {
    if (kind === 'call' && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name ||
      kind === 'jsx' && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === name) {
      lines.push(ast.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast); assert.ok(lines.length > 0, `Missing actual production caller: ${file}/${name}`)
  callerEvidence.push({ file, name, lines, sha256: createHash('sha256').update(source).digest('hex') })
}
const evidence = join(root, '.tmp/terminal-storage-details')
await mkdir(evidence, { recursive: true })
await writeFile(join(evidence, 'production-callers.json'), JSON.stringify({ nonempty: true, callers: callerEvidence }, null, 2) + '\n')
await verifyRendererSourceMutations({ name: 'loaded-mutations', tests, sources, mutations, evidenceRoot: evidence })
