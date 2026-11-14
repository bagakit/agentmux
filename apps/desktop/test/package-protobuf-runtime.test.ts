import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
// @ts-expect-error The native ESM packaging script has no TypeScript declarations.
import { inspectRuntimeApplicationPayload, copyRuntimeFiles } from '../scripts/runtime-application-payload.mjs'

it('ships the external protobuf dependency consumed by the production Main storage inventory', async () => {
  const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
  const payload = await inspectRuntimeApplicationPayload(repository)
  const copies = payload.copies.filter((item: { target: string }) => item.target.startsWith('node_modules/@bufbuild/protobuf/'))
  const temporary = await mkdtemp(join(tmpdir(), 'amux-package-protobuf-'))
  try {
    const resources = join(temporary, 'AgentMux.app/Contents/Resources/app'), main = join(resources, 'out/main')
    await copyRuntimeFiles(copies, resources)
    await mkdir(main, { recursive: true })
    await writeFile(join(resources, 'package.json'), '{"type":"module"}')
    const desktopRequire = createRequire(join(desktop, 'package.json'))
    const build = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { resolveConfig } from ${JSON.stringify(pathToFileURL(desktopRequire.resolve('electron-vite')).href)}
      import { build } from ${JSON.stringify(pathToFileURL(desktopRequire.resolve('vite')).href)}
      const { config } = await resolveConfig({ root: ${JSON.stringify(desktop)}, configFile: ${JSON.stringify(join(desktop, 'electron.vite.config.ts'))} }, 'build', 'production')
      if (!config?.main) throw new Error('Production Main configuration is absent')
      await build({ ...config.main, root: ${JSON.stringify(desktop)}, configFile: false, logLevel: 'silent',
        build: { ...config.main.build, outDir: ${JSON.stringify(main)}, emptyOutDir: false,
          rollupOptions: { ...config.main.build?.rollupOptions,
            input: { inventory: ${JSON.stringify(join(desktop, 'src/main/browser-profile-storage-inventory.ts'))} },
            output: { format: 'es', entryFileNames: 'inventory.js' } } } })
    `], { cwd: desktop, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000 })
    expect(build.error).toBeUndefined()
    expect(build.status, build.stderr).toBe(0)
    expect(await readFile(join(main, 'inventory.js'), 'utf8')).toMatch(/from ["']@bufbuild\/protobuf["']/u)
    // No ancestor modules or injected loader may supply an omitted package.
    for (let directory = temporary; ; directory = dirname(directory)) {
      await expect(lstat(join(directory, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
      if (directory === dirname(directory)) break
    }
    const origin = 'https://private.invalid/', profile = join(temporary, 'profile')
    const bucket = join(profile, 'Service Worker/CacheStorage', createHash('sha1').update('https_private.invalid_0').digest('hex'))
    await mkdir(bucket, { recursive: true })
    // CacheStorageIndex origin, storage_key, bucket_id and is_default fields.
    const bytes = Buffer.from(origin)
    await writeFile(join(bucket, 'index.txt'), Buffer.concat([Buffer.from([18, bytes.length]), bytes,
      Buffer.from([26, bytes.length]), bytes, Buffer.from([32, 1, 40, 1])]))
    const entry = join(main, 'consume.mjs')
    await writeFile(entry, `import { inspectBrowserProfileStorage } from './inventory.js';
      console.log(JSON.stringify(await inspectBrowserProfileStorage(process.argv[2], 'original-profile', 'original-revision')))`)
    const child = spawnSync(process.execPath, [entry, profile], { cwd: temporary, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000 })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({ profileId: 'original-profile', profileRevision: 'original-revision',
      sites: [{ origin: 'https://private.invalid', storageKeys: [origin] }], issues: [] })
    expect(copies.length).toBeGreaterThan(0)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}, 45_000)
