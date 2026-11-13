import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }))
import { CrashLog } from '../src/main/crash-log.js'
import { crashReporterOptions, registerCrashCapture } from '../src/main/crash-capture-wiring.js'
import { instanceRoleFromLock } from '../src/main/single-instance.js'

/** Execute the original early capture and primary-instance startup statements, stopping before
 * unrelated runtime/workspace owners. Electron and those unrelated owners are fixture boundaries;
 * the capture registration, ready callbacks and their local function imports are the real source.
 */
async function earlyMain(scope: Record<string, unknown>): Promise<CrashLog> {
  const location = new URL('../src/main/index.ts', import.meta.url)
  const source = await readFile(location, 'utf8')
  const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const starts = parsed.statements.findIndex(node => ts.isIfStatement(node) && node.expression.getText(parsed).includes('AGENTMUX_DISABLE_CRASH_REPORTER'))
  const role = parsed.statements.findIndex(node => ts.isIfStatement(node) && node.expression.getText(parsed).startsWith('instanceRoleFromLock('))
  const primary = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'startPrimaryInstance')
  expect(starts).toBeGreaterThanOrEqual(0)
  expect(role).toBeGreaterThan(starts)
  expect(primary?.body).toBeDefined()
  const statements = primary!.body!.statements
  const end = statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === 'scratchTopics'))
  expect(end).toBeGreaterThan(0)
  const code = parsed.statements.slice(starts, role + 1).map(node => node.getText(parsed)).join('\n') +
    `\nfunction startPrimaryInstance() {\n${statements.slice(0, end).map(node => node.getText(parsed)).join('\n')}\n}`
  expect(code).toContain('registerCrashCapture(')
  expect(code).toContain('app.whenReady()')
  // Load any extra imported callback referenced by the actual startup. An inverse that restores a
  // removed cleanup must execute its real implementation, rather than fail on a missing fixture name.
  const names = new Set<string>()
  const visit = (node: ts.Node): void => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, visit) }
  visit(ts.createSourceFile('startup.ts', code, ts.ScriptTarget.Latest, true))
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) continue
    for (const binding of node.importClause.namedBindings.elements) {
      if (!names.has(binding.name.text) || Object.hasOwn(scope, binding.name.text)) continue
      const specifier = node.moduleSpecifier.text
      const target = specifier.startsWith('.') ? new URL(specifier.replace(/\.js$/, '.ts'), location).href : specifier
      const loaded = await import(/* @vite-ignore */ target)
      scope[binding.name.text] = loaded[binding.propertyName?.text ?? binding.name.text]
    }
  }
  const compiled = ts.transpileModule(code.replaceAll('import.meta.dirname', 'mainDirectory'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true
  })
  expect(compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([])
  return new Function(...Object.keys(scope), `${compiled.outputText}\nreturn crashLog;`)(...Object.values(scope)) as CrashLog
}

it('primary Main startup preserves native report bytes while the original crash capture still records events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-native-crash-evidence-'))
  paths.userData = root
  const crashRoot = join(root, 'Crashpad'), originals = new Map<string, Buffer>()
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, requestSingleInstanceLock: () => true, exit: vi.fn(), quit: vi.fn(),
    getPath: (kind: string) => kind === 'crashDumps' ? crashRoot : root,
    whenReady: () => ({ then(callback: () => unknown) {
      const job = Promise.resolve().then(callback); readyJobs.push(job); return job
    } })
  })
  const readyJobs: Promise<unknown>[] = []
  const processOwner = Object.assign(new EventEmitter(), { env: {}, platform: process.platform })
  class PassiveOwner { dispose() {} }
  const memoryStart = vi.fn(), crashReporter = { start: vi.fn() }
  try {
    for (const directory of ['pending', 'completed', 'new']) {
      await mkdir(join(crashRoot, directory), { recursive: true })
      for (let index = 0; index < 51; index++) originals.set(`${directory}/report-${index}.dmp`, Buffer.from(`Original ${directory} report ${index}\0\xff`, 'utf8'))
    }
    originals.set('settings.dat', Buffer.from('Original reporter settings'))
    originals.set('attachments/report-0/evidence', Buffer.from('Original attachment'))
    for (const [relative, bytes] of originals) {
      await mkdir(dirname(join(crashRoot, relative)), { recursive: true })
      await writeFile(join(crashRoot, relative), bytes)
    }
    const log = await earlyMain({ app, process: processOwner, crashReporter, crashReporterOptions, CrashLog, registerCrashCapture, instanceRoleFromLock,
      join, mainDirectory: dirname(fileURLToPath(new URL('../src/main/index.ts', import.meta.url))),
      SpatialLinkIngress: PassiveOwner, WebUrlIngress: PassiveOwner, WebFileIngress: PassiveOwner,
      registerSystemWebFileEvents: () => {}, readLoadedPackageIdentity: () => null, ClientIncidentArchive: PassiveOwner,
      WorkbenchUserStateStore: PassiveOwner, PerformanceSceneOwner: PassiveOwner, RendererHeapSnapshotOwner: PassiveOwner,
      AppMemoryEvidenceOwner: class extends PassiveOwner { start = memoryStart }
    })
    await Promise.all(readyJobs)
    expect(memoryStart).toHaveBeenCalledExactlyOnceWith()
    expect(crashReporter.start).toHaveBeenCalledExactlyOnceWith({ uploadToServer: false })
    expect(originals.size).toBe(155)
    for (const [relative, bytes] of originals) expect(await readFile(join(crashRoot, relative)), relative).toEqual(bytes)
    app.emit('render-process-gone', {}, { getURL: () => '' }, { reason: 'oom', exitCode: 9 })
    await Reflect.get(log, 'writeTail')
    const records = (await readFile(join(root, 'crash-log.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ kind: 'render-process-gone', summary: 'renderer oom (exit 9)' })
    expect(app.exit).not.toHaveBeenCalled()
  } finally {
    app.removeAllListeners(); processOwner.removeAllListeners(); paths.userData = ''
    await rm(root, { recursive: true, force: true })
  }
})
