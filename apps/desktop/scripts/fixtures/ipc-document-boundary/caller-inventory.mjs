import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'

/** Completeness check for the required argument only; behavior is proved by the registered bridge. */
export async function ipcCallerInventory(root) {
  const ts = createRequire(join(root, 'apps/desktop/package.json'))('typescript'), rows = []
  const files = execFileSync('git', ['ls-files', 'apps/desktop/test', 'apps/desktop/scripts', 'apps/desktop/src/main/index.ts'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  const unwrap = value => { while (value && (ts.isAsExpression(value) || ts.isParenthesizedExpression(value) || ts.isTypeAssertionExpression(value))) value = value.expression; return value }
  for (const file of files.filter(file => /\.(ts|tsx)$/u.test(file))) {
    const source = ts.createSourceFile(file, await readFile(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const declarations = [], calls = []
    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push(node)
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'registerIpc') calls.push(node)
      ts.forEachChild(node, visit)
    }; visit(source)
    for (const call of calls) {
      let argument = unwrap(call.arguments[0])
      if (argument && ts.isIdentifier(argument)) {
        const scopes = new Set(); for (let node = call.parent; node; node = node.parent) scopes.add(node)
        const found = declarations.filter(node => node.name.text === argument.text && node.pos < call.pos && scopes.has(node.parent.parent.parent))
        assert.equal(found.length, 1, 'One original lexical args owner: ' + file)
        argument = unwrap(found[0].initializer)
      }
      assert.ok(argument && ts.isObjectLiteralExpression(argument), 'Actual original caller object: ' + file)
      assert.equal(argument.properties.filter(property => property.name?.getText(source) === 'appDocumentSources').length, 1,
        'One explicit original-source getter: ' + file)
      rows.push({ file, line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1 })
    }
  }
  assert.ok(rows.length >= 70, 'Original App and all fixture consumers were actually scanned')
  return rows
}
