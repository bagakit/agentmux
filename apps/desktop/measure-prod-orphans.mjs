import { readdirSync, readFileSync } from 'node:fs'
import ts from 'typescript'

const RENDERER_SRC = 'src/renderer/src'
const LIB_DIR = `${RENDERER_SRC}/lib`
const TEST_DIR = 'test'

function sourceFilesUnder(root) {
  return readdirSync(root, { recursive: true })
    .map((e) => String(e))
    .filter((e) => /\.tsx?$/u.test(e))
    .map((e) => `${root}/${e}`)
}
function parse(file) {
  const src = readFileSync(file, 'utf8')
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
}
function exportedNames(statement) {
  const isExported = (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    return statement.exportClause.elements.map((el) => el.name.text)
  }
  if (!isExported) return []
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((d) => d.name).filter(ts.isIdentifier).map((n) => n.text)
  }
  const named = statement
  return named.name && ts.isIdentifier(named.name) ? [named.name.text] : []
}
function declaredNames(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((d) => d.name).filter(ts.isIdentifier).map((n) => n.text)
  }
  const named = statement
  return named.name && ts.isIdentifier(named.name) ? [named.name.text] : []
}
function identifiersIn(node) {
  const names = new Set()
  const visit = (c) => { if (ts.isIdentifier(c)) names.add(c.text); ts.forEachChild(c, visit) }
  visit(node)
  return names
}
function unconsumedExportsOf(sourceFile, isSeed) {
  const statements = [...sourceFile.statements]
  const exported = new Set(statements.flatMap(exportedNames))
  if (exported.size === 0) return []
  const alive = new Set([...exported].filter(isSeed))
  for (let grew = true; grew;) {
    grew = false
    for (const st of statements) {
      if (!declaredNames(st).some((n) => alive.has(n))) continue
      for (const id of identifiersIn(st)) { if (!alive.has(id)) { alive.add(id); grew = true } }
    }
  }
  return [...exported].filter((n) => !alive.has(n))
}
function scanSurface(libFiles, consumerFiles) {
  const idByFile = new Map(consumerFiles.map((f) => [f, identifiersIn(parse(f))]))
  const mentionedOutside = (name, exclude) => {
    for (const [f, ids] of idByFile) if (f !== exclude && ids.has(name)) return true
    return false
  }
  const unconsumedExports = (file) => unconsumedExportsOf(parse(file), (name) => mentionedOutside(name, file))
  const orphans = () => libFiles.flatMap((f) => unconsumedExports(f).map((n) => `${f} ${n}`))
  return { orphans }
}

const libFiles = sourceFilesUnder(LIB_DIR)
const prod = sourceFilesUnder(RENDERER_SRC)
const test = sourceFilesUnder(TEST_DIR)

const withTests = scanSurface(libFiles, [...prod, ...test]).orphans()
const prodOnly = scanSurface(libFiles, prod).orphans()

console.log('=== orphans WITH tests (current guard) ===', withTests.length)
withTests.forEach((o) => console.log('  ' + o.replace(`${RENDERER_SRC}/`, '')))
console.log('\n=== orphans PRODUCTION-ONLY (stricter guard) ===', prodOnly.length)
prodOnly.forEach((o) => console.log('  ' + o.replace(`${RENDERER_SRC}/`, '')))
