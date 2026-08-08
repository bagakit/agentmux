import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  type PreloadArgument,
  PRELOAD_RELATIVE_PATH,
  webContentsSites,
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
 *   Finding 4 — an ALLOW-LIST over EVERY webContents-bearing construction (BrowserWindow AND
 *               WebContentsView) discovered across ALL of src/main, so a renderer-owning surface that
 *               sits off a window-only scan (the embedded WebContentsView today; any future window/view
 *               in a new file) can no longer escape the isolation check.
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
const BROWSER_VIEW_MANAGER_PATH = join(MAIN_DIR, 'browser-view-manager.ts')

// ---------------------------------------------------------------------------------------------------
// The allow-list policy (findings 1, 2 and 4 all decide acceptability through it).
// ---------------------------------------------------------------------------------------------------

/**
 * A preload verdict is acceptable at a construction site iff it is EITHER the audited factory-relative
 * path (`join(import.meta.dirname, <literal>)` with `join` bound to node:path — the value check findings
 * 2 exists for), OR genuinely absent. `absent` is allowed because a non-main window/view (the embedded
 * browser, the hidden import window) legitimately installs no privileged preload; every OTHER shape — a
 * re-pointed literal, a shadowed `join`, a drifting base, a computed path — is an uncontrolled bridge and
 * is rejected. This is the same verdict for the factory's argument and for an inline `preload:` property,
 * so an honest factory call whose preload is re-pointed (finding 2) and an inline window that adds a
 * preload (finding 1) are judged by one rule.
 */
function isAcceptablePreload(preload: PreloadArgument): boolean {
  if (preload.kind === 'absent') return true
  return preload.kind === 'join-from-module-dir' && preload.relativePath === PRELOAD_RELATIVE_PATH
}

/**
 * Finding 4's allow-list predicate. A construction site is acceptable iff it is EITHER the guarded
 * factory call — bound to window-security AND whose preload argument survives {@link isAcceptablePreload}
 * (finding 2: an honest-looking factory call that re-points preload must NOT pass on `importedFrom`
 * alone) — OR an inline literal whose three isolation switches are all at their safe literal values, whose
 * `webSecurity` is absent-or-true (never false), and whose preload (if any) survives the same check
 * (finding 1: a non-main window can set `webSecurity: false` and/or an inline preload while its three
 * named switches stay safe). Anything else — a wrong switch, a missing switch, a computed switch, a bare
 * object, a factory shadow — is rejected.
 */
function isAcceptableSite(verdict: SiteVerdict): boolean {
  if (verdict.shape === 'factory-call') {
    return verdict.importedFrom === WINDOW_SECURITY_MODULE && isAcceptablePreload(verdict.preload)
  }
  if (verdict.shape === 'inline-literal') {
    return (
      verdict.contextIsolation === true &&
      verdict.sandbox === true &&
      verdict.nodeIntegration === false &&
      verdict.webSecurity !== false &&
      isAcceptablePreload(verdict.preload)
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
// Finding 4 — an allow-list over EVERY webContents-bearing construction across the WHOLE main process,
// not just the files we happen to know today. A future window/view in a new file (or a new subdirectory)
// must not slip past the scan.
// ---------------------------------------------------------------------------------------------------

/**
 * Every non-test `.ts` file under `dir`, RECURSIVELY. The scan is recursive — not a single-level
 * readdir — because the guard's own promise is "all of main": src/main has no subdirectories today, but a
 * window placed in one tomorrow must still be scanned, and a non-recursive scan whose comment claims the
 * whole tree is exactly this repo's documented over-promise failure. Recursion keeps the promise true as
 * the tree grows, with no comment to drift out of date.
 */
function collectMainTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectMainTsFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full)
  }
  return files
}

describe('finding 4: every webContents-bearing construction site is on the isolation allow-list', () => {
  // Scan every non-test .ts under src/main (recursively) and collect (file, verdict) for every
  // BrowserWindow AND WebContentsView. Discovering the files — rather than naming index.ts +
  // browser-profile-manager.ts + browser-view-manager.ts — is the actual defense: the finding is a
  // renderer-owning surface that lives OFF the scan surface, so the scan surface must be "all of main",
  // discovered, not hard-coded.
  const mainFiles = collectMainTsFiles(MAIN_DIR)
  const sitesByFile = mainFiles.flatMap((path) =>
    webContentsSites(parseModuleFile(path)).map((verdict) => ({ file: basename(path), verdict }))
  )

  it('the scan surface is non-empty and includes ALL THREE known surfaces (no vacuous pass)', () => {
    // A guard that finds zero sites is vacuously green. Assert the discovery found sites, and specifically
    // that it reached every surface the findings name — the main window, the hidden import window, and the
    // embedded WebContentsView (the one a BrowserWindow-only scan never saw).
    expect(sitesByFile.length).toBeGreaterThanOrEqual(3)
    expect(sitesByFile.some((s) => s.file === 'index.ts')).toBe(true)
    expect(sitesByFile.some((s) => s.file === 'browser-profile-manager.ts')).toBe(true)
    expect(sitesByFile.some((s) => s.file === 'browser-view-manager.ts')).toBe(true)
  })

  it('the recursive scan actually descends into subdirectories (the "whole of main" promise is kept)', () => {
    // In-scope self-check for the recursion itself: src/main has no subdirectories today, so a scan that
    // silently stopped recursing would still pass every assertion above. Plant a construction in a nested
    // directory of a throwaway tree and assert the collector reaches it — so a future refactor that drops
    // recursion reds here instead of leaving a new-subdirectory window unscanned.
    const root = mkdtempSync(join(tmpdir(), 'winsec-scan-'))
    writeFileSync(join(root, 'top.ts'), 'export const a = 1\n')
    mkdirSync(join(root, 'nested', 'deep'), { recursive: true })
    writeFileSync(join(root, 'nested', 'deep', 'window.ts'), 'const w = new BrowserWindow({})\n')
    writeFileSync(join(root, 'nested', 'skip.test.ts'), 'const w = new BrowserWindow({})\n')
    const collected = collectMainTsFiles(root).map((path) => basename(path)).sort()
    expect(collected).toEqual(['top.ts', 'window.ts'])
    const nestedSites = webContentsSites(parseModuleFile(join(root, 'nested', 'deep', 'window.ts')))
    expect(nestedSites).toHaveLength(1)
  })

  it('the hidden import window in browser-profile-manager sets all switches safely (inline literal)', () => {
    // The hidden import window — a BrowserWindow a first-only wiring guard never sees. It uses an inline
    // literal, so its switches, webSecurity, and preload are read as written and pinned here.
    const profileSites = webContentsSites(parseModuleFile(PROFILE_MANAGER_PATH))
    expect(profileSites).toContainEqual({
      shape: 'inline-literal',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: 'missing',
      preload: { kind: 'absent' }
    })
  })

  it('the embedded WebContentsView in browser-view-manager sets all switches safely (inline literal)', () => {
    // The finding-4 escape surface: a WebContentsView owns a renderer just like a window, but sits off any
    // BrowserWindow-only scan. It loads arbitrary user/agent URLs, so its isolation switches matter most.
    const viewSites = webContentsSites(parseModuleFile(BROWSER_VIEW_MANAGER_PATH))
    expect(viewSites).toContainEqual({
      shape: 'inline-literal',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: 'missing',
      preload: { kind: 'absent' }
    })
  })

  it('the main window in index.ts is the guarded factory call bound to window-security', () => {
    const indexSites = webContentsSites(parseModuleFile(INDEX_PATH))
    expect(indexSites).toContainEqual(
      expect.objectContaining({ shape: 'factory-call', importedFrom: WINDOW_SECURITY_MODULE })
    )
  })

  it('EVERY site across ALL of src/main passes the allow-list (no unguarded or permissive surface)', () => {
    for (const { file, verdict } of sitesByFile) {
      expect(isAcceptableSite(verdict), `${file}: ${JSON.stringify(verdict)}`).toBe(true)
    }
  })

  it('self-check: a permissive inline literal (nodeIntegration:true) is REJECTED', () => {
    // The finding-4 mutation shape: flipping a hidden surface's switches. The allow-list must red on it.
    const permissive = parseModule(
      'const w = new BrowserWindow({ show: false, webPreferences: { partition, contextIsolation: false, sandbox: false, nodeIntegration: true } })'
    )
    const [site] = webContentsSites(permissive)
    expect(site).toMatchObject({ shape: 'inline-literal', contextIsolation: false, sandbox: false, nodeIntegration: true })
    expect(isAcceptableSite(site!)).toBe(false)
  })

  it('self-check: an inline webSecurity:false is REJECTED even when the three named switches are safe (finding 1)', () => {
    // The finding-1 escape: a non-main window keeps contextIsolation/sandbox/nodeIntegration safe but adds
    // webSecurity:false. The three-switch-only allow-list passed it; reading webSecurity is the fix.
    const insecure = parseModule(
      'const w = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: false } })'
    )
    const [site] = webContentsSites(insecure)
    expect(site).toMatchObject({ shape: 'inline-literal', webSecurity: false })
    expect(isAcceptableSite(site!)).toBe(false)
    // Absent webSecurity (the Electron default of true) stays acceptable — the criterion is "never false",
    // not "must be present", so an honest window that omits it is not a false red.
    const omitted = parseModule(
      'const w = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false } })'
    )
    expect(webContentsSites(omitted)[0]).toMatchObject({ webSecurity: 'missing' })
    expect(isAcceptableSite(webContentsSites(omitted)[0]!)).toBe(true)
  })

  it('self-check: an inline re-pointed preload is REJECTED even when every switch is safe (finding 1)', () => {
    // The finding-1 escape, preload half: a non-main window keeps all switches safe but adds an inline
    // preload pointing anywhere. Reading the preload property (not just the three switches) is the fix.
    const repointed = parseModule(
      "const w = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, preload: '/tmp/evil/preload.cjs' } })"
    )
    const [site] = webContentsSites(repointed)
    expect(site).toMatchObject({ shape: 'inline-literal', preload: { kind: 'not-a-join' } })
    expect(isAcceptableSite(site!)).toBe(false)
  })

  it('self-check: a factory call whose preload argument is re-pointed is REJECTED (finding 2)', () => {
    // The finding-2 escape: an honest factory call (callee bound to window-security) whose preload argument
    // is re-pointed. importedFrom alone passed it; re-checking the preload argument in the allow-list is
    // the fix — the allow-list, not only the main-window wiring guard, must reject a re-pointed bridge.
    const repointed = parseModule(
      "import { windowSecurityWebPreferences } from './window-security.js'\n" +
        "import { join } from 'node:path'\n" +
        "const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '../preload/evil.cjs')) })"
    )
    const [site] = webContentsSites(repointed)
    expect(site).toMatchObject({
      shape: 'factory-call',
      importedFrom: WINDOW_SECURITY_MODULE,
      preload: { kind: 'join-from-module-dir', relativePath: '../preload/evil.cjs' }
    })
    expect(isAcceptableSite(site!)).toBe(false)
  })

  it('self-check: a missing switch and a computed switch are REJECTED (present-but-unsafe both count)', () => {
    const missing = parseModule(
      'const w = new BrowserWindow({ webPreferences: { partition, contextIsolation: true, sandbox: true } })'
    )
    expect(isAcceptableSite(webContentsSites(missing)[0]!)).toBe(false)
    const computed = parseModule(
      'const w = new BrowserWindow({ webPreferences: { partition, contextIsolation: flag, sandbox: true, nodeIntegration: false } })'
    )
    expect(webContentsSites(computed)[0]).toMatchObject({ shape: 'inline-literal', contextIsolation: 'non-literal' })
    expect(isAcceptableSite(webContentsSites(computed)[0]!)).toBe(false)
  })

  it('self-check: an aliased and a namespace-qualified constructor are STILL scanned (finding 4 shapes)', () => {
    // The declared blind spots the previous scan had — a renamed or qualified constructor — are now
    // resolved by binding. A window hidden behind `const BW = BrowserWindow` or `electron.WebContentsView`
    // is enumerated and its permissive switches rejected, so those are no longer escape routes.
    const aliased = parseModule(
      'const BW = BrowserWindow\n' +
        'const w = new BW({ webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: true } })'
    )
    expect(webContentsSites(aliased)).toHaveLength(1)
    expect(isAcceptableSite(webContentsSites(aliased)[0]!)).toBe(false)
    const qualified = parseModule(
      'const w = new electron.WebContentsView({ webPreferences: { nodeIntegration: true } })'
    )
    expect(webContentsSites(qualified)).toHaveLength(1)
    expect(isAcceptableSite(webContentsSites(qualified)[0]!)).toBe(false)
  })

  it('self-check: a bare object and a factory shadow (importedFrom null) are REJECTED', () => {
    // Two more off-allow-list shapes a new surface could take: no webPreferences call/literal at all,
    // and a factory-call shape whose callee does not bind to window-security.
    const bareObject = parseModule('const w = new BrowserWindow({ webPreferences: someOtherThing })')
    expect(isAcceptableSite(webContentsSites(bareObject)[0]!)).toBe(false)
    const factoryShadow = parseModule(
      'const windowSecurityWebPreferences = (p: string) => ({ preload: p })\n' +
        "const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences('x') })"
    )
    expect(webContentsSites(factoryShadow)[0]).toMatchObject({ shape: 'factory-call', importedFrom: null })
    expect(isAcceptableSite(webContentsSites(factoryShadow)[0]!)).toBe(false)
  })

  it('self-check: both real shapes are ACCEPTED (factory call AND safe inline literal) — not vacuously red', () => {
    const factory = parseModule(
      "import { windowSecurityWebPreferences } from './window-security.js'\n" +
        "import { join } from 'node:path'\n" +
        `const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '${PRELOAD_RELATIVE_PATH}')) })`
    )
    expect(isAcceptableSite(webContentsSites(factory)[0]!)).toBe(true)
    const safeLiteral = parseModule(
      'const w = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false } })'
    )
    expect(isAcceptableSite(webContentsSites(safeLiteral)[0]!)).toBe(true)
  })
})
