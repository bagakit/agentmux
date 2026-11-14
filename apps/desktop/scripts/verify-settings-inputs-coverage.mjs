import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../..')
const components = 'apps/desktop/src/renderer/src/components'
const settings = join(components, 'settings')
const mountedFields = ['SettingsPanel.tsx', 'browser/BrowserResources.tsx', 'AgentWorkModeSetup.tsx']
const platformTypes = new Set(['checkbox', 'radio', 'file', 'range', 'color', 'hidden', 'date', 'datetime-local', 'time'])
const sharedModule = '@agentmux/client-ui/input'

async function list(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  return (await Promise.all(entries.map(entry => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? list(file) : file.endsWith('.tsx') ? [file] : []
  }))).flat()
}

const locations = { shared: [], platform: [], bare: [] }
const files = [...await list(settings), ...mountedFields.map(file => join(components, file))]
for (const file of files.sort()) {
  const source = ts.createSourceFile(file, await readFile(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const inputs = new Map()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== sharedModule) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const { name, propertyName } of bindings.elements) inputs.set(name.text, propertyName?.text ?? name.text)
  }
  const inspect = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source)
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      const location = `${file}:${line}`
      if (inputs.has(tag)) locations.shared.push({ location, tag: inputs.get(tag) })
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        const attribute = node.attributes.properties.find(entry => ts.isJsxAttribute(entry) && entry.name.getText(source) === 'type')
        const type = attribute?.initializer && ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : undefined
        if (tag === 'input' && platformTypes.has(type)) locations.platform.push({ location, type })
        else locations.bare.push({ location, tag, type })
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(source)
}

assert.ok(locations.shared.length > 0, 'The Settings inventory must contain actual shared field consumers')
for (const tag of ['TextInput', 'ComposerTextarea', 'NativeSelect', 'SearchInput', 'Switch']) {
  assert.ok(locations.shared.some(value => value.tag === tag), `Expected actual Settings consumers of ${tag}`)
}
assert.deepEqual(locations.bare, [], 'Ordinary Settings fields must use a shared input component')
console.log(JSON.stringify({ passed: true, files: files.length, ...locations }, null, 2))
