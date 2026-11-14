import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import { expect, it } from 'vitest'
// @ts-expect-error The native ESM packaging script has no TypeScript declarations.
import { inspectRuntimeApplicationPayload, copyRuntimeFiles } from '../scripts/runtime-application-payload.mjs'

it('the actual App payload supplies the external ZIP reader to production extension preparation without workspace fallback', async () => {
  const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
  const selection = join(desktop, 'scripts/runtime-application-payload.mjs'), source = join(desktop, 'src/main/browser-profile-extension-package.ts')
  const payload = await inspectRuntimeApplicationPayload(repository)
  const copies = payload.copies.filter((item: { target: string }) => item.target.startsWith('node_modules/fflate/'))
  const temporary = await mkdtemp(join(tmpdir(), 'amux-package-extension-'))
  const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
  const evidence: Record<string, unknown> = { passed: false, selection, originalSelectionSHA256: sha(await readFile(selection)),
    readerSource: source, readerSourceSHA256: sha(await readFile(source)), selected: copies.map((item: { source: string; target: string }) => ({ source: item.source, target: item.target })) }
  try {
    const resources = join(temporary, 'AgentMux.app/Contents/Resources/app'), main = join(resources, 'out/main')
    // The production selection owns every byte; an omitted dependency remains omitted.
    await copyRuntimeFiles(copies, resources)
    await mkdir(main, { recursive: true }); await writeFile(join(resources, 'package.json'), JSON.stringify({ type: 'module' }))
    const desktopRequire = createRequire(join(desktop, 'package.json')), configFile = join(desktop, 'electron.vite.config.ts')
    const compiledPath = join(main, 'extension-package.js')
    const build = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { resolveConfig } from ${JSON.stringify(pathToFileURL(desktopRequire.resolve('electron-vite')).href)}
      import { build } from ${JSON.stringify(pathToFileURL(desktopRequire.resolve('vite')).href)}
      const { config } = await resolveConfig({ root: ${JSON.stringify(desktop)}, configFile: ${JSON.stringify(configFile)} }, 'build', 'production')
      if (!config?.main) throw new Error('The production Main configuration is absent')
      const main = config.main
      await build({ ...main, root: ${JSON.stringify(desktop)}, configFile: false, logLevel: 'silent',
        build: { ...main.build, outDir: ${JSON.stringify(main)}, emptyOutDir: false,
          rollupOptions: { ...main.build?.rollupOptions, input: { 'extension-package': ${JSON.stringify(source)} },
            output: { format: 'es', entryFileNames: 'extension-package.js' } } } })
    `], { cwd: desktop, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000 })
    evidence.build = { status: build.status, signal: build.signal, error: build.error?.message, stdout: build.stdout, stderr: build.stderr, configFile, configSHA256: sha(await readFile(configFile)) }
    expect(build.error).toBeUndefined(); expect(build.signal).toBeNull(); expect(build.status).toBe(0)
    const compiled = await readFile(compiledPath, 'utf8')
    expect(compiled, 'The real Main configuration must keep its ZIP dependency external').toMatch(/from ["']fflate["']/u)
    evidence.compiled = { sha256: sha(compiled), external: 'fflate' }
    if (process.env.AGENTMUX_PACKAGE_EXTENSION_EVIDENCE) await writeFile(process.env.AGENTMUX_PACKAGE_EXTENSION_EVIDENCE + '.compiled-reader.js', compiled)

    const code = "throw new Error('This private extension code must never execute during preparation')\n"
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const manifest = { manifest_version: 3, name: 'Private ZIP preparation', version: '1.0.0', key, permissions: ['storage'] }
    const zip = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'content.js': strToU8(code) })
    const zipPath = join(temporary, 'original-extension.zip'), staging = join(temporary, 'original-preparation')
    await writeFile(zipPath, zip)
    const entry = join(main, 'prepare-extension.js')
    await writeFile(entry, `
      import { readFile } from 'node:fs/promises'
      import { join } from 'node:path'
      try {
        const { prepareExtensionPackage } = await import('./extension-package.js')
        const prepared = await prepareExtensionPackage(process.argv[2], process.argv[3])
        const content = await readFile(join(prepared.directory, 'content.js'), 'utf8')
        console.log(JSON.stringify({ outcome: { state: 'prepared', name: prepared.name, version: prepared.version,
          source: prepared.source.kind, permissions: prepared.permissions.api, content }, fflate: import.meta.resolve('fflate') }))
      } catch (error) {
        console.log(JSON.stringify({ outcome: { state: 'failed', code: error.code ?? null, message: error.message } }))
      }
    `)
    // No ancestor package, NODE_PATH, NODE_OPTIONS or injected loader can supply a missing dependency.
    for (let directory = temporary; ; directory = dirname(directory)) {
      const modules = await lstat(join(directory, 'node_modules')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null })
      expect(modules).toBeNull()
      if (directory === dirname(directory)) break
    }
    const child = spawnSync(process.execPath, [entry, zipPath, staging], { cwd: temporary, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000 })
    const result = child.stdout.trim() ? JSON.parse(child.stdout) : null
    const actual = { status: child.status, signal: child.signal, error: child.error?.message ?? null, outcome: result?.outcome ?? null }
    evidence.child = { ...actual, stdout: child.stdout, stderr: child.stderr, environmentKeys: ['PATH'] }
    // A missing package is an explicit child outcome, never a test-file load error.
    expect(actual, 'The standalone App must execute the actual production reader with its copied dependency').toEqual({
      status: 0, signal: null, error: null,
      outcome: { state: 'prepared', name: manifest.name, version: manifest.version, source: 'zip', permissions: ['storage'], content: code }
    })
    const canonicalResources = await realpath(resources)
    expect(result.fflate).toMatch(new RegExp('^' + pathToFileURL(join(canonicalResources, 'node_modules/fflate/')).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    expect(copies.length).toBeGreaterThan(0)
    evidence.copied = await Promise.all(copies.map(async (item: { target: string }) => ({ target: item.target, sha256: sha(await readFile(join(resources, item.target))) })))
    evidence.passed = true
  } finally {
    if (process.env.AGENTMUX_PACKAGE_EXTENSION_EVIDENCE) await writeFile(process.env.AGENTMUX_PACKAGE_EXTENSION_EVIDENCE + '.json', JSON.stringify(evidence, null, 2))
    await rm(temporary, { recursive: true, force: true })
  }
}, 60_000)
