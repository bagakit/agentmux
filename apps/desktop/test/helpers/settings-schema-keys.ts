import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { expect } from 'vitest'

/** Reverse the actual durable schema; an added ordinary field must acquire real CLI support. */
export async function scalarSettingsSchemaKeys(): Promise<string[]> {
  const source = ts.createSourceFile('config-store.ts', await readFile(new URL('../../src/main/config-store.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const declarations = new Map<string, ts.Expression>()
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) declarations.set(declaration.name.text, declaration.initializer)
    }
  })
  function leaves(expression: ts.Expression, prefix: string): string[] {
    if (ts.isIdentifier(expression)) {
      const definition = declarations.get(expression.text)
      expect(definition, `schema declaration ${expression.text}`).toBeDefined()
      return leaves(definition!, prefix)
    }
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return []
    const target = expression.expression.expression, method = expression.expression.name.text
    if (!ts.isIdentifier(target) || target.text !== 'z') return leaves(target, prefix)
    if (method === 'boolean' || method === 'number' || method === 'enum' || method === 'string') return [prefix]
    if (method !== 'object') return [] // Resource arrays/records and readonly version are separate capabilities.
    const shape = expression.arguments[0]
    expect(shape && ts.isObjectLiteralExpression(shape), `schema object ${prefix}`).toBe(true)
    return (shape as ts.ObjectLiteralExpression).properties.flatMap((property) => {
      expect(ts.isPropertyAssignment(property), `schema member ${prefix}`).toBe(true)
      const member = property as ts.PropertyAssignment
      const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined
      expect(name).toBeDefined()
      return leaves(member.initializer, prefix ? `${prefix}.${name}` : name!)
    })
  }
  const root = declarations.get('configSchema')
  expect(root).toBeDefined()
  const found = leaves(root!, '')
  expect(found.length).toBeGreaterThan(0)
  return found
}
