import { fixturePath as _hygiene_fixturePath } from "../../scripts/lib/fixture-values.mjs"
import ts from 'typescript'
import { declarationOf, importedModuleOf, parseModule, type ParsedModule } from './ts-binding.js'

type Registration = { channel: string; params: number; via: 'event' }

function nodes<T extends ts.Node>(root: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const result: T[] = []
  const visit = (node: ts.Node): void => {
    if (matches(node)) result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return result
}

function variable(module: ParsedModule, name: string): ts.VariableDeclaration | null {
  const declarations = nodes(module.sourceFile, ts.isVariableDeclaration)
    .filter(node => ts.isIdentifier(node.name) && node.name.text === name)
  return declarations.length === 1 ? declarations[0]! : null
}

function propertyBinding(module: ParsedModule, object: ts.ObjectLiteralExpression, name: string): ts.Declaration | null {
  const properties = object.properties.filter(node =>
    (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
    ts.isIdentifier(node.name) && node.name.text === name)
  if (properties.length !== 1) return null
  const property = properties[0]!
  if (ts.isShorthandPropertyAssignment(property)) {
    return module.checker.getShorthandAssignmentValueSymbol(property)?.declarations?.[0] ?? null
  }
  return ts.isPropertyAssignment(property) ? declarationOf(module, property.initializer) : null
}

function receiverIs(module: ParsedModule, expression: ts.Expression, method: string, owner: ts.Declaration | undefined): boolean {
  return owner !== undefined && ts.isPropertyAccessExpression(expression) && expression.name.text === method &&
    declarationOf(module, expression.expression) === owner
}

/**
 * Follow the actual imported registration call into its finite leaf. No channel list is copied here.
 * Unknown/restructured shapes fail closed in this test oracle; they must never silently skip an audit.
 * Binding checks distinguish an original wrapper/guard from a same-named local shadow or a no-op.
 */
export function deviceManagementIpcSource(ipcSource: string, leafSource: string) {
  const ipc = parseModule(ipcSource, _hygiene_fixturePath("audit/ipc.ts"))
  const leaf = parseModule(leafSource, _hygiene_fixturePath("audit/device-management-ipc.ts"))
  const roots = nodes(ipc.sourceFile, ts.isCallExpression).filter(call => {
    const declaration = declarationOf(ipc, call.expression)
    return declaration !== null && ts.isImportSpecifier(declaration) &&
      importedModuleOf(declaration) === './device-management-ipc.js' &&
      (declaration.propertyName ?? declaration.name).text === 'registerDeviceManagementIpc'
  })
  const root = roots.length === 1 ? roots[0] : undefined
  const options = root?.arguments[0]
  const wrapper = variable(ipc, 'handleWithEvent')
  const guard = variable(ipc, 'requireTrustedSender')
  const rootWrapperBinding = wrapper !== null && options !== undefined && ts.isObjectLiteralExpression(options) &&
    propertyBinding(ipc, options, 'handleWithEvent') === wrapper
  const rootGuardBinding = guard !== null && options !== undefined && ts.isObjectLiteralExpression(options) &&
    propertyBinding(ipc, options, 'assertTrusted') === guard

  const exports = nodes(leaf.sourceFile, ts.isFunctionDeclaration).filter(fn =>
    fn.name?.text === 'registerDeviceManagementIpc' && fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
  const exported = exports.length === 1 ? exports[0] : undefined
  const register = variable(leaf, 'register')
  const arrow = register?.initializer
  const calls = exported?.body && register ? nodes(exported.body, ts.isCallExpression)
    .filter(call => declarationOf(leaf, call.expression) === register) : []
  const installs = arrow && ts.isArrowFunction(arrow) ? nodes(arrow.body, ts.isCallExpression)
    .filter(call => receiverIs(leaf, call.expression, 'handleWithEvent', exported?.parameters[0])) : []
  const install = installs.length === 1 ? installs[0] : undefined
  const listener = install?.arguments[1]
  const isListener = listener !== undefined && (ts.isArrowFunction(listener) || ts.isFunctionExpression(listener))
  const leafRegistrationShape = exported !== undefined && register !== null && arrow !== undefined && ts.isArrowFunction(arrow) &&
    register.parent.parent.parent === exported.body && calls.length > 0 && installs.length === 1 && isListener &&
    install !== undefined && install.arguments.length === 2 &&
    install.arguments[0] !== undefined && declarationOf(leaf, install.arguments[0]) === arrow.parameters[0] &&
    calls.every(call => call.arguments.length === 2 && ts.isStringLiteralLike(call.arguments[0]!) && ts.isStringLiteralLike(call.arguments[1]!))
  const discovered = leafRegistrationShape ? calls.map(call => ({
    channel: (call.arguments[0] as ts.StringLiteralLike).text,
    params: isListener ? listener.parameters.length : -1,
    via: 'event' as const
  })) : []
  const channelsUnique = new Set(discovered.map(item => item.channel)).size === discovered.length
  const first = isListener && ts.isBlock(listener.body) ? listener.body.statements[0] : undefined
  const firstCall = first && ts.isExpressionStatement(first) && ts.isCallExpression(first.expression) ? first.expression : undefined
  const leafFirstGuard = arrow !== undefined && ts.isArrowFunction(arrow) && isListener && firstCall !== undefined &&
    receiverIs(leaf, firstCall.expression, 'assertTrusted', exported?.parameters[0]) && firstCall.arguments.length === 2 &&
    firstCall.arguments[0] !== undefined && declarationOf(leaf, firstCall.arguments[0]) === arrow.parameters[0] &&
    firstCall.arguments[1] !== undefined && declarationOf(leaf, firstCall.arguments[1]) === listener.parameters[0]
  const registrations: Registration[] = roots.length === 1 && rootWrapperBinding && leafRegistrationShape && channelsUnique ? discovered : []
  return {
    rootCalls: roots.length, rootWrapperBinding, rootGuardBinding, leafRegistrationShape, channelsUnique, leafFirstGuard,
    discovered, registrations,
    guardedChannels: rootGuardBinding && leafFirstGuard ? registrations.map(item => item.channel) : []
  }
}

/** Same finite imported-wrapper check for the existing Toolkit leaf, including its literal for-of. */
export function toolkitIpcSource(ipcSource: string, leafSource: string) {
  const ipc = parseModule(ipcSource, _hygiene_fixturePath("audit/ipc.ts"))
  const leaf = parseModule(leafSource, _hygiene_fixturePath("audit/toolkit-ipc.ts"))
  const roots = nodes(ipc.sourceFile, ts.isCallExpression).filter(call => {
    const declaration = declarationOf(ipc, call.expression)
    return declaration !== null && ts.isImportSpecifier(declaration) &&
      importedModuleOf(declaration) === './toolkit-ipc.js' &&
      (declaration.propertyName ?? declaration.name).text === 'registerToolkitIpc'
  })
  const wrapper = variable(ipc, 'handleWithEvent')
  const rootWrapperBinding = roots.length === 1 && wrapper !== null && roots[0]!.arguments[1] !== undefined &&
    declarationOf(ipc, roots[0]!.arguments[1]!) === wrapper
  const exports = nodes(leaf.sourceFile, ts.isFunctionDeclaration).filter(fn =>
    fn.name?.text === 'registerToolkitIpc' && fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
  const exported = exports.length === 1 ? exports[0] : undefined
  const installs = exported?.body ? nodes(exported.body, ts.isCallExpression)
    .filter(call => declarationOf(leaf, call.expression) === exported.parameters[1]) : []
  function strings(expression: ts.Expression | undefined): string[] | null {
    if (!expression) return null
    if (ts.isStringLiteralLike(expression)) return [expression.text]
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = strings(expression.left), right = strings(expression.right)
      return left && right ? left.flatMap(a => right.map(b => a + b)) : null
    }
    if (ts.isIdentifier(expression)) {
      const declaration = declarationOf(leaf, expression)
      if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent) ||
          !ts.isForOfStatement(declaration.parent.parent)) return null
      const loop = declaration.parent.parent
      // Only an enclosing loop supplies this value; no global name or unrelated loop substitution.
      let enclosing: ts.Node | undefined = expression.parent
      while (enclosing && enclosing !== loop) enclosing = enclosing.parent
      if (!enclosing) return null
      const iterable = ts.isAsExpression(loop.expression) ? loop.expression.expression : loop.expression
      if (!ts.isArrayLiteralExpression(iterable)) return null
      const values = iterable.elements.map(element => ts.isStringLiteralLike(element) ? element.text : null)
      return values.every(value => value !== null) ? values as string[] : null
    }
    return null
  }
  const discovered = installs.map(call => {
    const channels = strings(call.arguments[0]), listener = call.arguments[1]
    return channels && listener && (ts.isArrowFunction(listener) || ts.isFunctionExpression(listener))
      ? channels.map(channel => ({ channel, params: listener.parameters.length, via: 'event' as const })) : null
  })
  const leafRegistrationShape = exported !== undefined && installs.length > 0 && discovered.every(item => item !== null)
  const registrations = rootWrapperBinding && leafRegistrationShape ? discovered.flatMap(item => item ?? []) : []
  return { rootCalls: roots.length, rootWrapperBinding, leafRegistrationShape, registrations }
}
