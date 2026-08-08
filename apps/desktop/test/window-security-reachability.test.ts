import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import ts from 'typescript'
import {
  isAllowedTopFrameNavigation,
  type TopFrameOrigin
} from '../src/main/top-frame-navigation.js'
import { windowSecurityWebPreferences } from '../src/main/window-security.js'
import { namedImportsFrom, parseModule, parseModuleFile } from './helpers/ts-binding.js'
import {
  browserWindowSites,
  PRELOAD_RELATIVE_PATH,
  WINDOW_SECURITY_MODULE,
  type SiteVerdict
} from './helpers/window-security-ast.js'

/**
 * Lane W reachability guards for the four Electron window-isolation findings.
 *
 * The four findings share one root cause: the isolation guards judged a symbol by its TEXT, so a
 * correct-looking rename (a same-named local shadow, an inline re-authored literal, a colliding path,
 * or a whole second window) defeated them while the suite stayed green. This file re-judges each one
 * so the defeating mutation dies:
 *
 *   Finding 1 — the webPreferences factory callee is judged by BINDING (does it resolve to the
 *               window-security import?), so a function-scoped shadow returning permissive prefs reds.
 *   Finding 2 — the preload `join(...)` callee is judged by BINDING (does it resolve to node:path?),
 *               so a same-named forwarding shadow that repoints the bridge reds.
 *   Finding 3 — the production `protocol !== 'file:'` gate is executed against an https URL whose path
 *               collides with the packaged document; the pure function must reject it.
 *   Finding 4 — an ALLOW-LIST over EVERY `new BrowserWindow` discovered across ALL of src/main, so a
 *               window that sits off the scan surface (the second, import window today; any future third
 *               window in a new file) can no longer escape the isolation check.
 *
 * All AST judgements go through the type checker, never text. The classifiers themselves live in
 * helpers/window-security-ast.ts — ONE implementation, shared with window-security.test.ts, because a
 * mutation that deleted the binding check had to be applied twice while each file carried its own copy.
 * What stays here is the POLICY: which shapes are acceptable, at which site. The same parse path serves
 * the real source files and the self-check fixtures, so a self-check pass is real strength, not a weaker
 * fixture-only judge.
 *
 * This file is a RUNTIME guard (vitest), not a type-level one: apps/desktop's `tsc --noEmit -p
 * tsconfig.json` includes only `src/**`, so a compile-time assertion written under `test/` is executed
 * by no gate. Every judgement below runs.
 */

const here = dirname(fileURLToPath(import.meta.url))
const MAIN_DIR = join(here, '../src/main')
const INDEX_PATH = join(MAIN_DIR, 'index.ts')
const PROFILE_MANAGER_PATH = join(MAIN_DIR, 'browser-profile-manager.ts')

// ---------------------------------------------------------------------------------------------------
// The allow-list policy (findings 1, 2 and 4 all decide acceptability through it).
// ---------------------------------------------------------------------------------------------------

/**
 * Finding 4's allow-list predicate. A BrowserWindow site is acceptable iff it is EITHER the guarded
 * factory call (its returned values are pinned behaviorally in window-security.test.ts), OR an inline
 * literal whose three isolation switches are all at their safe literal values. Anything else — a wrong
 * switch, a missing switch, a computed switch, a bare object, a factory shadow — is rejected.
 */
function isAcceptableSite(verdict: SiteVerdict): boolean {
  if (verdict.shape === 'factory-call') return verdict.importedFrom === WINDOW_SECURITY_MODULE
  if (verdict.shape === 'inline-literal') {
    return (
      verdict.contextIsolation === true &&
      verdict.sandbox === true &&
      verdict.nodeIntegration === false
    )
  }
  return false
}

// ---------------------------------------------------------------------------------------------------
// Finding 1 — the webPreferences factory callee is judged by binding, not text.
// ---------------------------------------------------------------------------------------------------
describe('finding 1: the main-window webPreferences factory is judged by BINDING', () => {
  const indexModule = parseModuleFile(INDEX_PATH)

  it('index.ts imports the webPreferences factory from window-security', () => {
    expect(namedImportsFrom(indexModule, WINDOW_SECURITY_MODULE)).toContain('windowSecurityWebPreferences')
  })

  it("the main window's webPreferences IS the factory call, bound to the window-security import", () => {
    // Text-only guards read the callee spelling and pass a same-named shadow. Binding is the fix: the
    // callee must resolve to the window-security import, not a local declaration.
    const [main] = browserWindowSites(indexModule)
    expect(main).toMatchObject({
      shape: 'factory-call',
      callee: 'windowSecurityWebPreferences',
      importedFrom: WINDOW_SECURITY_MODULE
    })
  })

  it('self-check: a function-scoped factory shadow with the identical callee text is REJECTED', () => {
    // The finding-1 exploit: the real import stays at the top, but a build-window-scoped shadow returns
    // permissive prefs. Callee text is identical; only the binding changed. importedFrom catches it.
    const shadow = parseModule(
      "import { windowSecurityWebPreferences as real } from './window-security.js'\n" +
        "import { join } from 'node:path'\n" +
        'function buildWindow() {\n' +
        '  const windowSecurityWebPreferences = (p: string) => ({ preload: p, contextIsolation: false, sandbox: false, nodeIntegration: true, webSecurity: false })\n' +
        `  return new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '${PRELOAD_RELATIVE_PATH}')) })\n` +
        '}'
    )
    const [site] = browserWindowSites(shadow)
    expect(site).toMatchObject({ shape: 'factory-call', callee: 'windowSecurityWebPreferences', importedFrom: null })
    expect(isAcceptableSite(site!)).toBe(false)
  })

  it('self-check: the honest factory shape (import present) is ACCEPTED — the guard is not vacuously red', () => {
    const honest = parseModule(
      "import { windowSecurityWebPreferences } from './window-security.js'\n" +
        "import { join } from 'node:path'\n" +
        `const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '${PRELOAD_RELATIVE_PATH}')) })`
    )
    const [site] = browserWindowSites(honest)
    expect(site).toMatchObject({ shape: 'factory-call', importedFrom: WINDOW_SECURITY_MODULE })
    expect(isAcceptableSite(site!)).toBe(true)
  })

  it('the REAL factory returns hardened switch values (the sibling attack: flipping the factory body)', () => {
    // The binding guard above catches a SHADOW of the factory, but not the factory's own return literals
    // being flipped. This behavioral assertion imports the real function and pins each returned value, so
    // finding 1 is airtight from both directions: shadow-the-callee AND rewrite-the-callee-body.
    const prefs = windowSecurityWebPreferences('/pkg/preload/index.cjs')
    expect(prefs.contextIsolation).toBe(true) // false lets page scripts reach into preload/Node
    expect(prefs.sandbox).toBe(true) // false turns a renderer RCE into a host RCE
    expect(prefs.nodeIntegration).toBe(false) // true hands injected scripts require/process/Buffer
    expect(prefs.preload).toBe('/pkg/preload/index.cjs') // the controlled bridge entry point
    expect(prefs.webSecurity ?? true).toBe(true) // absent-or-true, never false
  })
})

// ---------------------------------------------------------------------------------------------------
// Finding 2 — the preload join(...) callee is judged by binding, not text.
// ---------------------------------------------------------------------------------------------------
describe('finding 2: the preload path join(...) is judged by BINDING', () => {
  const indexModule = parseModuleFile(INDEX_PATH)

  it('the preload argument is join(import.meta.dirname, <literal>) with join bound to node:path', () => {
    const [main] = browserWindowSites(indexModule)
    expect(main).toMatchObject({
      shape: 'factory-call',
      preload: { kind: 'join-from-module-dir', relativePath: PRELOAD_RELATIVE_PATH }
    })
  })

  it('the pinned preload filename is the one electron-vite actually emits (no drift between the two)', () => {
    // The relative path is a literal here; its real SSOT is the build config. Tie them so changing one
    // without the other reds and names where to look.
    const viteConfig = readFileSync(join(here, '..', 'electron.vite.config.ts'), 'utf8')
    const emitted = /entryFileNames:\s*'([^']+)'/.exec(viteConfig)?.[1]
    expect(emitted).toBe(basename(PRELOAD_RELATIVE_PATH))
  })

  it('self-check: a function-scoped join shadow with identical text is REJECTED (bridge repoint)', () => {
    // The finding-2 exploit: the node:path import stays at the top, but a build-window-scoped
    // `const join = (_b, _r) => '/tmp/evil/preload.cjs'` shadow repoints the bridge. The base and the
    // literal are preserved, so a text-only judge still reads join-from-module-dir. Binding catches it.
    const shadow = parseModule(
      "import { windowSecurityWebPreferences } from './window-security.js'\n" +
        "import { join } from 'node:path'\n" +
        'function buildWindow() {\n' +
        "  const join = (_b: string, _r: string) => '/tmp/evil/preload.cjs'\n" +
        `  return new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '${PRELOAD_RELATIVE_PATH}')) })\n` +
        '}'
    )
    const [site] = browserWindowSites(shadow)
    expect(site).toMatchObject({ shape: 'factory-call', preload: { kind: 'join-not-from-node-path' } })
  })

  it('self-check: a repointed literal and a drifting base are REJECTED; the honest path is ACCEPTED', () => {
    const imports =
      "import { windowSecurityWebPreferences } from './window-security.js'\nimport { join } from 'node:path'\n"
    const repointed = parseModule(
      `${imports}const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '../preload/evil.cjs')) })`
    )
    expect(browserWindowSites(repointed)[0]).toMatchObject({
      preload: { kind: 'join-from-module-dir', relativePath: '../preload/evil.cjs' }
    })
    const cwdBased = parseModule(
      `${imports}const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(process.cwd(), '${PRELOAD_RELATIVE_PATH}')) })`
    )
    expect(browserWindowSites(cwdBased)[0]).toMatchObject({ preload: { kind: 'not-rooted-at-module-dir' } })
    const honest = parseModule(
      `${imports}const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '${PRELOAD_RELATIVE_PATH}')) })`
    )
    expect(browserWindowSites(honest)[0]).toMatchObject({
      preload: { kind: 'join-from-module-dir', relativePath: PRELOAD_RELATIVE_PATH }
    })
  })
})

// ---------------------------------------------------------------------------------------------------
// Finding 3 — the production protocol gate is executed, not merely present.
// ---------------------------------------------------------------------------------------------------
describe('finding 3: the top-frame protocol gate rejects a path-colliding https target', () => {
  // A packaged prod origin. The colliding https target is DERIVED from this same filePath (one source
  // of truth) so the two cannot drift; it shares the packaged document's path but carries https://.
  const PROD: TopFrameOrigin = {
    mode: 'prod',
    filePath: '/Applications/AgentMux.app/Contents/Resources/app/renderer/index.html'
  }
  const collidingHttps = `https://evil.example${PROD.filePath}`

  it('rejects an https URL whose path equals the packaged document (protocol clause under test)', () => {
    // Deleting/neutralizing `if (target.protocol !== 'file:') return false` admits this: protocol is
    // https:, but pathname decodes to the exact packaged path, so the path comparison alone returns true
    // — the top frame is navigated to an attacker https site that inherits the preload bridge.
    expect(isAllowedTopFrameNavigation(PROD, collidingHttps)).toBe(false)
  })

  it('still admits the genuine packaged file:// document (the gate is not just "always false")', () => {
    expect(isAllowedTopFrameNavigation(PROD, `file://${PROD.filePath}`)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------
// Finding 4 — an allow-list over EVERY BrowserWindow across the WHOLE main process, not just the two
// files we happen to know today. A future third window in a new file must not slip past the scan.
// ---------------------------------------------------------------------------------------------------
describe('finding 4: every BrowserWindow construction site is on the isolation allow-list', () => {
  // Scan every non-test .ts under src/main and collect (file, verdict) for every `new BrowserWindow`.
  // Enumerating the directory — rather than naming index.ts + browser-profile-manager.ts — is the actual
  // defense: the finding is a window that lives OFF the scan surface, so the scan surface must be "all of
  // main", discovered, not hard-coded.
  // Known residual blind spot (stated so it does not recur silently): the scan matches the constructor by
  // the identifier text `BrowserWindow`. A construction that renames or qualifies it — `const BW =
  // BrowserWindow; new BW(...)` or `new electron.BrowserWindow(...)` via a namespace import — is not seen.
  // Both owned files today call `new BrowserWindow(...)` with the bare imported name.
  const mainFiles = readdirSync(MAIN_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(MAIN_DIR, name))
  const sitesByFile = mainFiles.flatMap((path) =>
    browserWindowSites(parseModuleFile(path)).map((verdict) => ({ file: basename(path), verdict }))
  )

  it('the scan surface is non-empty and includes BOTH known windows (a scan typo cannot pass vacuously)', () => {
    // A guard that finds zero sites is vacuously green. Assert the discovery found sites, and specifically
    // that it reached both windows the findings name — the main window and the hidden import window.
    expect(sitesByFile.length).toBeGreaterThanOrEqual(2)
    expect(sitesByFile.some((s) => s.file === 'index.ts')).toBe(true)
    expect(sitesByFile.some((s) => s.file === 'browser-profile-manager.ts')).toBe(true)
  })

  it('the hidden import window in browser-profile-manager sets all three isolation switches safely', () => {
    // This is the second BrowserWindow — the one a first-only wiring guard never sees. It uses an inline
    // literal, so its switches are read as written and pinned here.
    const profileSites = browserWindowSites(parseModuleFile(PROFILE_MANAGER_PATH))
    expect(profileSites).toContainEqual({
      shape: 'inline-literal',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    })
  })

  it('the main window in index.ts is the guarded factory call bound to window-security', () => {
    const indexSites = browserWindowSites(parseModuleFile(INDEX_PATH))
    expect(indexSites).toContainEqual(
      expect.objectContaining({ shape: 'factory-call', importedFrom: WINDOW_SECURITY_MODULE })
    )
  })

  it('EVERY site across ALL of src/main passes the allow-list (no unguarded or permissive window)', () => {
    for (const { file, verdict } of sitesByFile) {
      expect(isAcceptableSite(verdict), `${file}: ${JSON.stringify(verdict)}`).toBe(true)
    }
  })

  it('self-check: a permissive inline literal (nodeIntegration:true) is REJECTED', () => {
    // The finding-4 mutation shape: flipping the hidden window's switches. The allow-list must red on it.
    const permissive = parseModule(
      'const w = new BrowserWindow({ show: false, webPreferences: { partition, contextIsolation: false, sandbox: false, nodeIntegration: true } })'
    )
    const [site] = browserWindowSites(permissive)
    expect(site).toMatchObject({ shape: 'inline-literal', contextIsolation: false, sandbox: false, nodeIntegration: true })
    expect(isAcceptableSite(site!)).toBe(false)
  })

  it('self-check: a missing switch and a computed switch are REJECTED (present-but-unsafe both count)', () => {
    const missing = parseModule(
      'const w = new BrowserWindow({ webPreferences: { partition, contextIsolation: true, sandbox: true } })'
    )
    expect(isAcceptableSite(browserWindowSites(missing)[0]!)).toBe(false)
    const computed = parseModule(
      'const w = new BrowserWindow({ webPreferences: { partition, contextIsolation: flag, sandbox: true, nodeIntegration: false } })'
    )
    expect(browserWindowSites(computed)[0]).toMatchObject({ shape: 'inline-literal', contextIsolation: 'non-literal' })
    expect(isAcceptableSite(browserWindowSites(computed)[0]!)).toBe(false)
  })

  it('self-check: a bare object and a factory shadow (importedFrom null) are REJECTED', () => {
    // Two more off-allow-list shapes a third window could take: no webPreferences call/literal at all,
    // and a factory-call shape whose callee does not bind to window-security.
    const bareObject = parseModule('const w = new BrowserWindow({ webPreferences: someOtherThing })')
    expect(isAcceptableSite(browserWindowSites(bareObject)[0]!)).toBe(false)
    const factoryShadow = parseModule(
      'const windowSecurityWebPreferences = (p: string) => ({ preload: p })\n' +
        "const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences('x') })"
    )
    expect(browserWindowSites(factoryShadow)[0]).toMatchObject({ shape: 'factory-call', importedFrom: null })
    expect(isAcceptableSite(browserWindowSites(factoryShadow)[0]!)).toBe(false)
  })

  it('self-check: both real shapes are ACCEPTED (factory call AND safe inline literal)', () => {
    const factory = parseModule(
      "import { windowSecurityWebPreferences } from './window-security.js'\n" +
        "import { join } from 'node:path'\n" +
        `const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '${PRELOAD_RELATIVE_PATH}')) })`
    )
    expect(isAcceptableSite(browserWindowSites(factory)[0]!)).toBe(true)
    const safeLiteral = parseModule(
      'const w = new BrowserWindow({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false } })'
    )
    expect(isAcceptableSite(browserWindowSites(safeLiteral)[0]!)).toBe(true)
  })
})
