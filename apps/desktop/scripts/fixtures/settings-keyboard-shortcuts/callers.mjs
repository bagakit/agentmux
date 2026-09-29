import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function verifyCallers(root, output) {
  const ts = createRequire(path.join(root, 'apps/desktop/package.json'))('typescript')
  const prefix = 'apps/desktop/src/renderer/src/'
  const files = execFileSync('rg', ['--files', prefix], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(file => /\.tsx?$/.test(file))
  assert.ok(files.length > 0, 'Production Source scan is nonempty')
  const parsed = new Map()
  for (const file of files) {
    const source = await fs.readFile(path.join(root, file), 'utf8')
    assert.ok(source.length > 0)
    parsed.set(file, { source, ast: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) })
  }
  const moduleFile = prefix + 'components/settings/modules/keyboard-shortcuts.tsx'
  const module = parsed.get(moduleFile)
  assert.ok(module, 'The owning contribution exists')
  const declarations = []
  function visit(ast, match) { const walk = node => { match(node); ts.forEachChild(node, walk) }; walk(ast) }
  visit(module.ast, node => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.push(node) })
  const contribution = declarations.find(node => node.initializer?.getText(module.ast).includes("id: 'keyboard-shortcuts'"))
  assert.ok(contribution, 'A real declaration contributes this page')
  const contributionName = contribution.name.text
  const paneAssignment = []
  visit(contribution, node => { if (ts.isPropertyAssignment(node) && node.name.getText(module.ast) === 'Pane' && ts.isIdentifier(node.initializer)) paneAssignment.push(node.initializer.text) })
  assert.equal(paneAssignment.length, 1, 'The contribution registers one actual pane')
  const paneName = paneAssignment[0]
  function definition(file, name) {
    const found = []
    visit(parsed.get(file).ast, node => { if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText() === name) found.push(node) })
    assert.equal(found.length, 1, 'Definition is derived and unique: ' + name)
    return { file, symbol: found[0].name.getText() }
  }
  function callers(def) {
    const found = []
    for (const [file, { ast }] of parsed) {
      if (file === def.file) continue
      visit(ast, node => {
        if (!ts.isIdentifier(node) || node.text !== def.symbol) return
        const p = node.parent
        if (ts.isCallExpression(p) && p.expression === node || ts.isPropertyAssignment(p) && p.initializer === node || ts.isArrayLiteralExpression(p) || ts.isJsxOpeningElement(p) && p.tagName === node || ts.isJsxSelfClosingElement(p) && p.tagName === node || ts.isCallExpression(p) && p.arguments.includes(node) || ts.isPropertyAccessExpression(p) && p.expression === node) {
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
          found.push({ file, line, expression: p.getText(ast) })
        }
      })
    }
    assert.ok(found.length > 0, 'Actual production caller collection is nonempty: ' + def.symbol)
    return { ...def, callers: found }
  }
  const paneFile = [...parsed].find(([file, { ast }]) => file !== moduleFile && ast.statements.some(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === paneName))?.[0]
  assert.ok(paneFile)
  const definitions = [definition(moduleFile, contributionName), definition(paneFile, paneName), definition(prefix + 'components/SettingsNavigation.tsx', 'SettingsNavigation'), definition(prefix + 'lib/shortcut-cheat-sheet.ts', 'buildCheatSheet'), definition(prefix + 'lib/workbench-shortcuts.ts', 'windowShortcutHandlers')]
  const graph = definitions.map(callers)
  const entries = []
  for (const file of [prefix + 'App.tsx', prefix + 'components/WindowUtilityBar.tsx', prefix + 'components/ProjectRailToolbar.tsx']) {
    const { ast } = parsed.get(file), calls = []
    visit(ast, node => { if (ts.isCallExpression(node) && node.arguments.some(argument => ts.isStringLiteral(argument) && argument.text === 'keyboard-shortcuts')) calls.push({ expression: node.getText(ast), line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 }) })
    assert.ok(calls.length > 0, 'Each real help entry requests this page: ' + file)
    entries.push({ file, calls })
  }
  const actualApp = parsed.get(prefix + 'App.tsx').source
  assert.match(actualApp, /openShortcuts:\s*\(\)\s*=>\s*openSettings\('keyboard-shortcuts'\)/)
  const obsolete = [...parsed].filter(([, { source }]) => /ShortcutsCheatSheet|shortcutsHelpOpen|openShortcutHelp|shortcutsHelp:/.test(source)).map(([file]) => file)
  assert.deepEqual(obsolete, [], 'No obsolete overlay or synthetic entry in production Source')
  const receipt = { passed: true, boundary: 'Definition-derived nonempty production references/calls, excluding the definition file and imports/tests. Actual reachability is separately falsified by private Source Renderer mutants.', files: files.length, graph, entries, source: Object.fromEntries([...parsed].map(([file, { source }]) => [file, createHash('sha256').update(source).digest('hex')])) }
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(path.join(output, 'caller-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  return { passed: true, output: path.join(output, 'caller-receipt.json'), definitions: graph.length, entries: entries.length }
}
