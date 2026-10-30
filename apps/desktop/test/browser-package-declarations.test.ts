import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { afterEach, expect, it } from 'vitest'

const file = 'apps/desktop/scripts/package-macos.mjs', original = readFileSync(resolve(file), 'utf8')
const source = process.env.AGENTMUX_BROWSER_SOURCE_ROOT ? readFileSync(resolve(process.env.AGENTMUX_BROWSER_SOURCE_ROOT, file), 'utf8') : original
if (process.env.AGENTMUX_BROWSER_LOADED_LOG) appendFileSync(process.env.AGENTMUX_BROWSER_LOADED_LOG, JSON.stringify({ file, original: createHash('sha256').update(original).digest('hex'), loaded: createHash('sha256').update(source).digest('hex') }) + '\n')
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const names = ['assert', 'pathExists', 'plistReplace', 'plistRemove', 'plistValue', 'brandApplication', 'verifyIdentity']
const functions = names.map(name => {
  const matches = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name)
  if (matches.length !== 1) throw new Error(`Expected one original package owner ${name}`)
  return matches[0]!.getText(ast).replace(/^export /u, '')
}).join('\n')
const execute = promisify(execFile), roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const { brandApplication, verifyIdentity } = new Function('run', 'join', 'rename', 'cp', 'rm', 'lstat', 'desktopRoot', 'PRODUCT_NAME', 'BUNDLE_ID', 'manifest', `${functions}; return { brandApplication, verifyIdentity }`)(
  async (command: string, args: string[]) => execute(command, args), join, rename, cp, rm, lstat, resolve('apps/desktop'), 'AgentMux', 'dev.agentmux.desktop', { version: '0.1.0' }
) as { brandApplication(app: string): Promise<void>; verifyIdentity(app: string): Promise<void> }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-browser-plist-')); roots.push(root)
  const app = join(root, 'AgentMux.app'), contents = join(app, 'Contents')
  const base = { CFBundleDisplayName: 'Electron', CFBundleName: 'Electron', CFBundleIdentifier: 'com.example.electron', CFBundleExecutable: 'Electron', CFBundleIconFile: 'electron.icns', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '0.1.0', NSAppTransportSecurity: {}, NSAudioCaptureUsageDescription: '', NSBluetoothAlwaysUsageDescription: '', NSBluetoothPeripheralUsageDescription: '', NSCameraUsageDescription: '', NSMicrophoneUsageDescription: '' }
  async function bundle(path: string, executable: string) { await mkdir(join(path, 'Contents/MacOS'), { recursive: true }); await writeFile(join(path, 'Contents/MacOS', executable), 'private empty executable fixture'); await writeFile(join(path, 'Contents/Info.plist'), JSON.stringify(base)); await execute('/usr/bin/plutil', ['-convert', 'xml1', join(path, 'Contents/Info.plist')]) }
  await bundle(app, 'Electron'); await mkdir(join(contents, 'Resources'), { recursive: true })
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) await bundle(join(contents, 'Frameworks', `Electron Helper${suffix}.app`), `Electron Helper${suffix}`)
  return app
}
it.runIf(process.platform === 'darwin')('real branding and package checks declare HTML/XHTML Viewer while retaining amux/http/https and exact bundle identity', async () => {
  const app = await fixture(); await brandApplication(app); await verifyIdentity(app)
  const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]); const plist = JSON.parse(stdout)
  expect(plist.CFBundleIdentifier).toBe('dev.agentmux.desktop')
  expect(plist.CFBundleURLTypes.flatMap((row: any) => row.CFBundleURLSchemes)).toEqual(['amux', 'http', 'https'])
  expect(plist.CFBundleDocumentTypes).toEqual([{ CFBundleTypeRole: 'Viewer', LSItemContentTypes: ['public.html'] }, { CFBundleTypeRole: 'Viewer', LSItemContentTypes: ['public.xhtml'] }])
})
it.runIf(process.platform === 'darwin')('real package verification rejects a missing or false webpage viewing declaration', async () => {
  const app = await fixture(); await brandApplication(app); const plist = join(app, 'Contents/Info.plist')
  await execute('/usr/bin/plutil', ['-replace', 'CFBundleDocumentTypes.1.LSItemContentTypes.0', '-string', 'public.plain-text', plist])
  await expect(verifyIdentity(app)).rejects.toThrow('Viewer declarations are wrong')
  await execute('/usr/bin/plutil', ['-remove', 'CFBundleDocumentTypes', plist])
  await expect(verifyIdentity(app)).rejects.toThrow()
})
