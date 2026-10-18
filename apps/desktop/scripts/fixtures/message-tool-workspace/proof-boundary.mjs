import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import ts from 'typescript'

export const noteLinkBoundaryFile = 'apps/desktop/src/renderer/src/lib/note-file-link.ts'
export const noteLinkBoundaryExports = ['openDesktopNoteLink', 'resolveDesktopNoteFileLink', 'useDesktopNoteLinkOpener']
export const noteLinkParserVersion = ts.version
/** Only bodies of these unexecuted functions may vary. Imports and signatures stay exact. */
export function noteLinkStructure(source) {
  const file = ts.createSourceFile(noteLinkBoundaryFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assert.equal(file.parseDiagnostics.length, 0, 'The scoped Note module must parse')
  const printer = ts.createPrinter({ removeComments: true }), names = []
  const statements = file.statements.map(node => {
    if (ts.isImportDeclaration(node)) return printer.printNode(ts.EmitHint.Unspecified, node, file)
    assert.ok(ts.isFunctionDeclaration(node) && node.body && node.name &&
      node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      node.modifiers.every(modifier => [ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.AsyncKeyword].includes(modifier.kind)),
    'The scoped Note module permits only imports and exported function declarations, with no top-level effects')
    names.push(node.name.text)
    return printer.printNode(ts.EmitHint.Unspecified, ts.factory.updateFunctionDeclaration(node,
      node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, ts.factory.createBlock([])), file)
  })
  assert.deepEqual(names.sort(), noteLinkBoundaryExports, 'The exact three fenced actions remain the complete exports')
  return { file: noteLinkBoundaryFile, exports: [...noteLinkBoundaryExports],
    structureSha256: createHash('sha256').update(JSON.stringify(statements)).digest('hex') }
}
