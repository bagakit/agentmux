import { readdirSync, readFileSync } from 'node:fs'
import ts from 'typescript'
const RENDERER_SRC = '/Users/bytedance/proj/priv/bagakit/agentmux/apps/desktop/src/renderer/src'
const LIB_DIR = `${RENDERER_SRC}/lib`
const TEST_DIR = '/Users/bytedance/proj/priv/bagakit/agentmux/apps/desktop/test'
const files = (root) => readdirSync(root, { recursive: true }).map(String).filter((e) => /\.tsx?$/u.test(e)).map((e) => `${root}/${e}`)
const parse = (f) => ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function exportedNames(s) {
  const isExported = (s.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) return s.exportClause.elements.map((e) => e.name.text)
  if (!isExported) return []
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.map((d) => d.name).filter(ts.isIdentifier).map((n) => n.text)
  return s.name && ts.isIdentifier(s.name) ? [s.name.text] : []
}
function declaredNames(s) {
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.map((d) => d.name).filter(ts.isIdentifier).map((n) => n.text)
  return s.name && ts.isIdentifier(s.name) ? [s.name.text] : []
}
function identifiersIn(n) { const out = new Set(); const v = (c) => { if (ts.isIdentifier(c)) out.add(c.text); ts.forEachChild(c, v) }; v(n); return out }
const libFiles = files(LIB_DIR)
const consumerFiles = [...files(RENDERER_SRC), ...files(TEST_DIR)]
const byFile = new Map(consumerFiles.map((f) => [f, identifiersIn(parse(f))]))
const mentionedOutside = (name, exclude) => { for (const [f, ids] of byFile) if (f !== exclude && ids.has(name)) return true; return false }
// classify a name as type-ish or value-ish by the statement that declares it
function kindOf(statements, name) {
  for (const s of statements) {
    if (!exportedNames(s).includes(name)) continue
    if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) return 'type'
    if (ts.isVariableStatement(s) || ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) return 'value'
    return 'other'
  }
  return 'other'
}
let naive = [], fixpoint = []
for (const file of libFiles) {
  const sf = parse(file); const statements = [...sf.statements]
  const exported = new Set(statements.flatMap(exportedNames))
  if (exported.size === 0) continue
  const seeds = [...exported].filter((n) => mentionedOutside(n, file))
  for (const n of exported) if (!seeds.includes(n)) naive.push([file, n, kindOf(statements, n)])
  const alive = new Set(seeds)
  for (let grew = true; grew;) { grew = false; for (const s of statements) { if (!declaredNames(s).some((n) => alive.has(n))) continue; for (const id of identifiersIn(s)) if (!alive.has(id)) { alive.add(id); grew = true } } }
  for (const n of exported) if (!alive.has(n)) fixpoint.push([file, n, kindOf(statements, n)])
}
const rescued = naive.filter(([f, n]) => !fixpoint.some(([g, m]) => g === f && n === m))
console.log('lib modules:', libFiles.length)
console.log('total exports:', libFiles.reduce((s, f) => s + new Set(parse(f).statements.flatMap(exportedNames)).size, 0))
console.log('naive orphans:', naive.length)
console.log('fixpoint orphans:', fixpoint.length, fixpoint.map(([f,n])=>`${f.slice(RENDERER_SRC.length+1)} ${n}`))
console.log('rescued by closure:', rescued.length)
const t = rescued.filter(([,,k]) => k === 'type').length, v = rescued.filter(([,,k]) => k === 'value').length, o = rescued.filter(([,,k]) => k === 'other').length
console.log(`  type=${t} value=${v} other=${o}`)
console.log('MAX_STEP_SUMMARY_LENGTH mentionedOutside:', mentionedOutside('MAX_STEP_SUMMARY_LENGTH', `${LIB_DIR}/activity-step-summary.ts`))
