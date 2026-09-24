import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import ts from 'typescript'

export type OverlayHostKind = 'window-overlay-host' | 'native-top-layer'
export type OverlayLayerKind = 'tooltip' | 'popover' | 'service' | 'dialog'

export interface SourceDerivedOverlayTrigger {
  file: string
  line: number
  kind: 'createPortal' | 'native-popover' | 'radix-portal'
  host: OverlayHostKind | 'unclassified'
  layer: OverlayLayerKind | 'unclassified'
  lifecycleOwner: string
  leasesNative: boolean
}

/**
 * Derives the complete inventory of renderer overlay triggers directly from source AST.
 * Contains NO hand-maintained component list or static registry: all classifications
 * are inferred from component declarations, primitive tags, and structural attributes.
 */
export function deriveOverlayInventoryFromSource(rendererSrcDir: string): SourceDerivedOverlayTrigger[] {
  const inventory: SourceDerivedOverlayTrigger[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (/\.[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        const content = readFileSync(fullPath, 'utf8')
        const relPath = relative(rendererSrcDir, fullPath)

        // Ignore overlay host/adapter definition file itself
        if (relPath.includes('WindowOverlayHost.tsx')) continue

        const sf = ts.createSourceFile(
          basename(fullPath),
          content,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX
        )

        const importedRadixPackages = new Set<string>()
        const sharedDropdownAliases = new Set<string>()
        for (const statement of sf.statements) {
          if (
            ts.isImportDeclaration(statement) &&
            statement.moduleSpecifier &&
            ts.isStringLiteral(statement.moduleSpecifier)
          ) {
            const mod = statement.moduleSpecifier.text
            if (mod.startsWith('@radix-ui/')) {
              importedRadixPackages.add(mod)
            }
            if (mod === './HoverDropdownMenu' || mod.endsWith('/HoverDropdownMenu')) {
              const clause = statement.importClause
              const binding = clause?.namedBindings
              if (binding && ts.isNamespaceImport(binding)) sharedDropdownAliases.add(binding.name.text)
            }
          }
        }

        function getEnclosingComponent(pos: number): string {
          let best: string | null = null
          function inspectNode(node: ts.Node): void {
            if (node.getStart(sf) <= pos && pos <= node.getEnd()) {
              if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) {
                best = node.name.text
              } else if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                /^[A-Z]/.test(node.name.text)
              ) {
                best = node.name.text
              }
              ts.forEachChild(node, inspectNode)
            }
          }
          inspectNode(sf)
          return best ?? basename(fullPath, extname(fullPath))
        }

        function getLineNumber(pos: number): number {
          return sf.getLineAndCharacterOfPosition(pos).line + 1
        }

        /** A retained DOM node attached to its own JSX ref slot is layout, not a floating overlay. */
        function isOwnedLayoutPortal(call: ts.CallExpression): boolean {
          const target = call.arguments[1]
          if (!target || !ts.isIdentifier(target)) return false
          let component: ts.Node | undefined = call.parent
          while (component && !ts.isFunctionDeclaration(component)) component = component.parent
          if (!component || !ts.isFunctionDeclaration(component) || !component.body) return false

          const declarations: ts.VariableDeclaration[] = []
          const calls: ts.CallExpression[] = []
          const refs: ts.JsxAttribute[] = []
          function collect(node: ts.Node): void {
            if (ts.isVariableDeclaration(node)) declarations.push(node)
            if (ts.isCallExpression(node)) calls.push(node)
            if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'ref') refs.push(node)
            ts.forEachChild(node, collect)
          }
          collect(component.body)
          const states = declarations.filter(declaration => ts.isArrayBindingPattern(declaration.name)
            && declaration.name.elements.some(element => ts.isBindingElement(element)
              && ts.isIdentifier(element.name) && element.name.text === target.text))
          const state = states.length === 1 ? states[0] : undefined
          const initialize = state?.initializer
          if (!initialize || !ts.isCallExpression(initialize) || initialize.expression.getText(sf) !== 'useState') return false
          const factory = initialize.arguments[0]
          if (!factory || !ts.isArrowFunction(factory) || !ts.isBlock(factory.body)) return false
          const factoryBody = factory.body
          const createsElement = (expression: ts.Expression | undefined): boolean => Boolean(expression
            && ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
            && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === 'document'
            && expression.expression.name.text === 'createElement')
          const created = declarations.find(declaration => declaration.parent.parent.parent === factoryBody
            && ts.isIdentifier(declaration.name) && createsElement(declaration.initializer))
          if (!created || !ts.isIdentifier(created.name) || !factoryBody.statements.some(statement => ts.isReturnStatement(statement)
            && statement.expression && ts.isIdentifier(statement.expression) && statement.expression.text === created.name.getText(sf))) return false

          function enclosingReturn(node: ts.Node): ts.Node | undefined {
            let current: ts.Node | undefined = node.parent
            while (current && !ts.isReturnStatement(current)) current = current.parent
            return current
          }
          const localRefs = new Set(declarations.flatMap(declaration => {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)
              || declaration.initializer.expression.getText(sf) !== 'useRef') return []
            const name = declaration.name.text
            return refs.some(ref => ref.initializer && ts.isJsxExpression(ref.initializer)
              && ref.initializer.expression && ts.isIdentifier(ref.initializer.expression) && ref.initializer.expression.text === name
              && enclosingReturn(ref) === enclosingReturn(call)) ? [name] : []
          }))
          return calls.some(append => {
            if (!ts.isPropertyAccessExpression(append.expression) || append.expression.name.text !== 'append'
              || !ts.isIdentifier(append.expression.expression) || append.arguments.length !== 1
              || !ts.isIdentifier(append.arguments[0]!) || append.arguments[0]!.getText(sf) !== target.text) return false
            const receiver = append.expression.expression.text
            const destination = declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === receiver)?.initializer
            if (!destination || !ts.isBinaryExpression(destination) || destination.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
              || !ts.isIdentifier(destination.left) || !ts.isPropertyAccessExpression(destination.right)
              || destination.right.name.text !== 'current' || !ts.isIdentifier(destination.right.expression)
              || !localRefs.has(destination.right.expression.text)) return false
            const explicit = declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === destination.left.getText(sf))?.initializer
            return Boolean(explicit && ts.isConditionalExpression(explicit) && explicit.whenFalse.kind === ts.SyntaxKind.NullKeyword
              && ts.isCallExpression(explicit.whenTrue) && ts.isPropertyAccessExpression(explicit.whenTrue.expression)
              && ts.isIdentifier(explicit.whenTrue.expression.expression) && explicit.whenTrue.expression.expression.text === 'document'
              && explicit.whenTrue.expression.name.text === 'getElementById')
          })
        }

        function visit(node: ts.Node): void {
          // 1. React createPortal call expression
          if (ts.isCallExpression(node)) {
            const expr = node.expression
            if (ts.isIdentifier(expr) && expr.text === 'createPortal') {
              if (isOwnedLayoutPortal(node)) {
                // Still scan nested menu/popover primitives; only the proven layout move is omitted.
                ts.forEachChild(node, visit)
                return
              }
              const line = getLineNumber(node.getStart(sf))
              const contentArg = node.arguments[0] ? node.arguments[0].getText(sf) : ''
              const targetArg = node.arguments[1] ? node.arguments[1].getText(sf) : ''

              let host: OverlayHostKind | 'unclassified' = 'unclassified'
              if (targetArg.includes('overlayHost') || targetArg.includes('WindowOverlayHost')) {
                host = 'window-overlay-host'
              } else if (targetArg.trim() === 'focusPortalTarget') {
                // Layout portal, not overlay. `createPortal(workbench, focusPortalTarget)` at
                // WorkspaceWorkbench.tsx:1323 relocates the entire Workbench region into a
                // focus target (id `focus-workspace-slot`, App.tsx). Not a z-stack overlay; sits
                // outside the overlay adoption contract. Skip: never added to inventory.
                //
                // The judge is **exact identifier equality**, not substring. A substring match
                // (`.includes('portalTarget')`) is the laundering-hole shape memory
                // [[widening-a-guard-opens-the-laundering-hole]] warns about — any future
                // `dialogPortalTarget`/`overlayPortalTarget`/`myPortalTarget` overlay would
                // silently pass through the "every createPortal must be window-overlay-host"
                // contract downstream, because a skipped row cannot fail the judge. Keep this
                // exact existing layout target; other targets require their own source-derived
                // layout-host proof above, and unexplained overlay hosts remain unclassified.
                return
              } else if (targetArg.includes('document.body') || targetArg.includes('portalHost')) {
                // Explicit body/legacy portal targets are deliberately unclassified.
                // The adoption contract must fail loudly instead of treating them as valid.
                host = 'unclassified'
              }

              let layer: OverlayLayerKind | 'unclassified' = 'unclassified'
              if (/role=["']tooltip["']|tooltip/i.test(contentArg)) {
                layer = 'tooltip'
              } else if (/role=["']dialog["']|popover|inspector/i.test(contentArg)) {
                layer = 'popover'
              }

              inventory.push({
                file: relPath,
                line,
                kind: 'createPortal',
                host,
                layer,
                lifecycleOwner: getEnclosingComponent(node.getStart(sf)),
                leasesNative: false
              })
            }
          }

          // 2. JSX Elements (native popover or Radix Portal)
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tagText = node.tagName.getText(sf)

            // Native popover attribute
            const popoverAttr = node.attributes.properties.find(
              (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'popover'
            )
            if (popoverAttr && ts.isJsxAttribute(popoverAttr)) {
              const line = getLineNumber(node.getStart(sf))
              const tagFullText = node.getText(sf)
              const host: OverlayHostKind = 'native-top-layer'
              let layer: OverlayLayerKind | 'unclassified' = 'unclassified'

              const explicitLayer = node.attributes.properties.find(
                (p) => ts.isJsxAttribute(p) && (p.name.getText(sf) === 'data-overlay-layer' || p.name.getText(sf) === 'layer')
              )
              if (
                explicitLayer &&
                ts.isJsxAttribute(explicitLayer) &&
                explicitLayer.initializer &&
                ts.isStringLiteral(explicitLayer.initializer)
              ) {
                layer = explicitLayer.initializer.text as OverlayLayerKind
              } else if (/notices|mailbox/i.test(tagFullText) || /Notice|Mailbox/i.test(relPath)) {
                layer = 'service'
              } else if (/card|context|popover/i.test(tagFullText) || /Context/i.test(relPath)) {
                layer = 'popover'
              }

              inventory.push({
                file: relPath,
                line,
                kind: 'native-popover',
                host,
                layer,
                lifecycleOwner: getEnclosingComponent(node.getStart(sf)),
                leasesNative: false
              })
            }

            // Radix Portal tags (Dialog.Portal, DropdownMenu.Portal, ContextMenu.Portal, Menu.Portal, Portal)
            if (/\bPortal$/.test(tagText)) {
              const line = getLineNumber(node.getStart(sf))
              const containerAttr = node.attributes.properties.find(
                (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'container'
              )
              const host: OverlayHostKind | 'unclassified' = containerAttr ||
                (sharedDropdownAliases.has(tagText.split('.')[0] ?? '') && tagText.endsWith('.Portal'))
                ? 'window-overlay-host'
                : 'unclassified'
              let layer: OverlayLayerKind | 'unclassified' = 'unclassified'

              const explicitLayer = node.attributes.properties.find(
                (p) => ts.isJsxAttribute(p) && (p.name.getText(sf) === 'data-overlay-layer' || p.name.getText(sf) === 'layer')
              )
              if (
                explicitLayer &&
                ts.isJsxAttribute(explicitLayer) &&
                explicitLayer.initializer &&
                ts.isStringLiteral(explicitLayer.initializer)
              ) {
                layer = explicitLayer.initializer.text as OverlayLayerKind
              } else if (
                tagText.includes('Dialog') ||
                importedRadixPackages.has('@radix-ui/react-dialog')
              ) {
                layer = 'dialog'
              } else if (
                tagText.includes('Menu') ||
                tagText.includes('Dropdown') ||
                tagText.includes('Popover') ||
                importedRadixPackages.has('@radix-ui/react-dropdown-menu') ||
                importedRadixPackages.has('@radix-ui/react-menu') ||
                importedRadixPackages.has('@radix-ui/react-context-menu') ||
                importedRadixPackages.has('@radix-ui/react-popover')
              ) {
                layer = 'popover'
              } else if (
                tagText.includes('Tooltip') ||
                importedRadixPackages.has('@radix-ui/react-tooltip')
              ) {
                layer = 'tooltip'
              }

              inventory.push({
                file: relPath,
                line,
                kind: 'radix-portal',
                host,
                layer,
                lifecycleOwner: getEnclosingComponent(node.getStart(sf)),
                leasesNative: true
              })
            }
          }

          ts.forEachChild(node, visit)
        }

        visit(sf)
      }
    }
  }

  walk(rendererSrcDir)
  return inventory
}
