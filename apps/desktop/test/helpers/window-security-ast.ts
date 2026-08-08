import ts from 'typescript'
import {
  declarationOf,
  findNewExpressions,
  importedModuleOf,
  isImportMetaDirname,
  propertyInitializer,
  type ParsedModule
} from './ts-binding.js'

/**
 * How a webContents-bearing construction site (`new BrowserWindow(...)` / `new WebContentsView(...)`)
 * configures its webPreferences — the ONE implementation.
 *
 * Why this is a shared module rather than a copy in each test file: the load-bearing criterion here is
 * the BINDING check (does this identifier resolve to the import I expect?), and a mutation that deleted
 * it had to be applied TWICE when two files each carried their own copy. Two copies means the next
 * tightening lands in one of them and the other silently keeps the weaker judge — which is precisely the
 * shape of the defect this module exists to catch. The classifiers live here; the POLICY (which shapes
 * are acceptable at which site) stays in each test file, because index.ts and browser-profile-manager.ts
 * legitimately answer to different rules.
 *
 * Declared blind spots, stated here so they do not recur silently:
 * - `findNewExpressions` resolves the constructor callee through alias/namespace/element-access/wrapper
 *   shapes (see ts-binding.ts), but it still cannot see a `super(...)` in a BrowserWindow subclass, a
 *   computed (non-literal) element-access key, or a callee that is itself a call. Those are documented at
 *   the extractor with their consequence. All three owned construction sites use the bare imported name.
 * - Binding resolution says nothing about runtime VALUES. That the factory actually returns hardened
 *   switches is a behavioral assertion, not an AST one.
 */

/**
 * Every webContents-bearing constructor the isolation scan must reach. A window is not the only surface
 * that owns a renderer: `WebContentsView` (the embedded browser in browser-view-manager.ts) is one too,
 * and its isolation switches matter for exactly the same reason. Scanning only `BrowserWindow` left that
 * view — and any future view — entirely off the allow-list surface.
 */
export const WEB_CONTENTS_CONSTRUCTORS = ['BrowserWindow', 'WebContentsView'] as const

/** The module index.ts must get its webPreferences factory and popup outcome from. */
export const WINDOW_SECURITY_MODULE = './window-security.js'
/** The module `join` must bind to — a same-named local shadow is the finding-2 exploit. */
export const NODE_PATH_MODULE = 'node:path'
/**
 * The preload path index.ts pins, relative to the PACKAGED main bundle (out/main/), not the source tree
 * — so it cannot be derived from a source path and must be a literal. Its real SSOT is the build config;
 * window-security.test.ts cross-checks the basename against electron-vite's entryFileNames.
 */
export const PRELOAD_RELATIVE_PATH = '../preload/index.cjs'

/**
 * How a preload EXPRESSION is COMPUTED — used both for the factory's first argument (the main window) and
 * for an inline `preload:` property on a webPreferences object literal (the finding-1 escape shape).
 *
 * The criterion is not "there is an argument" but "it is a relative path joined onto this module's own
 * directory, using the `join` that binds to node:path":
 * - `join-from-module-dir` + relativePath — the shape we want. `import.meta.dirname` pins the base to the
 *   packaged bundle's own directory, so the path drifts with neither cwd nor launch method.
 * - `join-not-from-node-path` — the name is `join` but it resolves elsewhere. A function-scoped
 *   `const join = (_b, _r) => '/tmp/evil/preload.cjs'` spells identically, preserves the base and the
 *   literal, and repoints the privileged bridge; a text-only judge still read `join-from-module-dir`
 *   (measured: 32 tests green, tsc exit 0). Only the binding separates them.
 * - `absent` — no preload at all. For the factory that means the bridge cannot install (a broken app);
 *   for an inline-literal window (which legitimately loads no privileged preload) that is the HONEST
 *   shape, so each caller decides whether `absent` is acceptable at its site.
 * - the rest are all unacceptable, including "value happens to be right but the base became process.cwd()".
 *
 * Why it must be judged this deep: preload IS the privileged bridge's entry point, so pointing it
 * elsewhere installs an uncontrolled bridge (the renderer gets full ipcRenderer). Measured without the
 * value check: changing the argument to '../preload/evil.cjs' left 41 tests green. Measured for the
 * inline shape: adding `preload: '/tmp/evil/preload.cjs'` to the hidden import window left 91 tests green.
 */
export type PreloadArgument =
  | { kind: 'absent' }
  | { kind: 'not-a-join' }
  | { kind: 'join-not-from-node-path' }
  | { kind: 'not-rooted-at-module-dir' }
  | { kind: 'not-a-literal-path' }
  | { kind: 'join-from-module-dir'; relativePath: string }

export function preloadExpression(module: ParsedModule, argument: ts.Expression | undefined): PreloadArgument {
  if (argument === undefined) return { kind: 'absent' }
  if (!ts.isCallExpression(argument) || !ts.isIdentifier(argument.expression) || argument.expression.text !== 'join') {
    return { kind: 'not-a-join' }
  }
  // The name `join` is not enough — it must BIND to node:path. This is the same move as judging a
  // method's receiver by where it was imported from, and it is the line whose removal a mutation proved
  // load-bearing: with it gone, a same-named shadow repointing the bridge read as the honest shape.
  if (importedModuleOf(declarationOf(module, argument.expression)) !== NODE_PATH_MODULE) {
    return { kind: 'join-not-from-node-path' }
  }
  const base = argument.arguments[0]
  if (base === undefined || !isImportMetaDirname(base)) return { kind: 'not-rooted-at-module-dir' }
  const relative = argument.arguments[1]
  if (relative === undefined || !ts.isStringLiteral(relative)) return { kind: 'not-a-literal-path' }
  return { kind: 'join-from-module-dir', relativePath: relative.text }
}

/** The preload argument handed to the webPreferences factory (its first argument). */
export function preloadArgumentOf(module: ParsedModule, call: ts.CallExpression): PreloadArgument {
  return preloadExpression(module, call.arguments[0])
}

/** A boolean isolation switch AS WRITTEN: the safe literal, the wrong literal, missing, or computed. */
export type SwitchValue = true | false | 'missing' | 'non-literal'

export function switchValue(obj: ts.ObjectLiteralExpression, name: string): SwitchValue {
  const init = propertyInitializer(obj, name)
  if (init === null) return 'missing'
  if (init.kind === ts.SyntaxKind.TrueKeyword) return true
  if (init.kind === ts.SyntaxKind.FalseKeyword) return false
  return 'non-literal'
}

/**
 * The webPreferences value of ONE construction site:
 * - `factory-call`   — a call. `importedFrom` is where the callee BINDS: a function-scoped shadow of the
 *                      factory spells the callee identically while returning permissive prefs (measured:
 *                      32 tests green, tsc exit 0), and only the binding tells them apart. `preload` is
 *                      the verdict above — read here so the allow-list can re-check it (finding 2: an
 *                      honest factory call whose preload is re-pointed).
 * - `inline-literal` — an object literal: a second copy of the switch values, so they are read AS WRITTEN.
 *                      `webSecurity` and `preload` are read too, because a non-main window can set
 *                      `webSecurity: false` and/or an inline preload while its three named switches stay
 *                      safe (finding 1), and each caller decides whether that is allowed here.
 * - `other` / `no-webprefs` / `no-object-arg` — not a recognizable window-configuration shape at all.
 */
export type SiteVerdict =
  | { shape: 'factory-call'; callee: string; importedFrom: string | null; preload: PreloadArgument }
  | {
      shape: 'inline-literal'
      contextIsolation: SwitchValue
      sandbox: SwitchValue
      nodeIntegration: SwitchValue
      webSecurity: SwitchValue
      preload: PreloadArgument
    }
  | { shape: 'other' }
  | { shape: 'no-webprefs' }
  | { shape: 'no-object-arg' }

export function classifySite(module: ParsedModule, site: ts.NewExpression): SiteVerdict {
  const arg0 = site.arguments?.[0]
  if (arg0 === undefined || !ts.isObjectLiteralExpression(arg0)) return { shape: 'no-object-arg' }
  const init = propertyInitializer(arg0, 'webPreferences')
  if (init === null) return { shape: 'no-webprefs' }
  if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
    return {
      shape: 'factory-call',
      callee: init.expression.text,
      importedFrom: importedModuleOf(declarationOf(module, init.expression)),
      preload: preloadArgumentOf(module, init)
    }
  }
  if (ts.isObjectLiteralExpression(init)) {
    return {
      shape: 'inline-literal',
      contextIsolation: switchValue(init, 'contextIsolation'),
      sandbox: switchValue(init, 'sandbox'),
      nodeIntegration: switchValue(init, 'nodeIntegration'),
      webSecurity: switchValue(init, 'webSecurity'),
      preload: preloadExpression(module, propertyInitializer(init, 'preload') ?? undefined)
    }
  }
  return { shape: 'other' }
}

/**
 * Every `new BrowserWindow(...)` site verdict in a module. An empty array means the scan found nothing
 * here. Used where the subject is specifically a window (the main window's factory wiring).
 */
export function browserWindowSites(module: ParsedModule): SiteVerdict[] {
  return findNewExpressions(module, ['BrowserWindow']).map((site) => classifySite(module, site))
}

/**
 * Every webContents-bearing construction site verdict in a module — BrowserWindow AND WebContentsView.
 * This is the scan finding 4's allow-list runs over: the escape is a renderer-owning surface that sits
 * off a window-only scan, so the scan must reach every such constructor, not just windows.
 */
export function webContentsSites(module: ParsedModule): SiteVerdict[] {
  return findNewExpressions(module, WEB_CONTENTS_CONSTRUCTORS).map((site) => classifySite(module, site))
}
