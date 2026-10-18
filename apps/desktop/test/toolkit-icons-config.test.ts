import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('../../../packages/core/node_modules/esbuild')
vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))
import { DEFAULT_CONFIG, toolkitToolSchema } from '../src/main/config-store'
import { ConfigOwner } from '../src/main/config-owner'
import { executeToolkitConfig, prepareToolkitConfig } from '../src/main/toolkit-config'
import { captureToolkitPackage, readToolkitPackageMetadata } from '../src/main/toolkit-package'
import { TOOLKIT_ICON_IDS } from '../src/shared/toolkit-preferences'
import type { AppConfig } from '../src/shared/contracts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

it('keeps the shared choices data-only when loaded by Main', async () => {
  const result = await build({ entryPoints: ['apps/desktop/src/shared/toolkit-preferences.ts'], bundle: true, write: false, platform: 'node', metafile: true })
  expect(Object.keys(result.metafile!.inputs)).toEqual(['apps/desktop/src/shared/toolkit-preferences.ts'])
  expect(result.outputFiles[0]!.text).not.toContain('react')
})

it('accepts all choices in inline persistence and package capture without changing their stored values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolkit-icons-')); directories.push(directory)
  await writeFile(join(directory, 'entry.mjs'), 'console.log("original content")')
  let config: AppConfig = structuredClone(DEFAULT_CONFIG)
  const owner = new ConfigOwner({ read: () => config, prepare: (before, next) => prepareToolkitConfig(before, next, async () => {}),
    save: async next => next, publish: next => { config = next } })
  const fields = { name: 'Icon tool', icon: 'hard-drive', enabled: false, statusBar: 'icon' as const, workspacePath: directory, script: 'console.log("original content")', args: [] }
  const created = await executeToolkitConfig({ operation: 'toolkit.add', toolId: 'icons', value: fields }, owner).catch(cause => ({ error: cause.code }))
  expect(created).toMatchObject({ definition: { icon: 'hard-drive' } })
  for (const icon of TOOLKIT_ICON_IDS) {
    const result = await executeToolkitConfig({ operation: 'toolkit.update', toolId: 'icons', changes: { icon } }, owner)
    expect(result).toMatchObject({ definition: { icon, script: fields.script, enabled: false } })
    expect(toolkitToolSchema.parse(config.toolkit!.tools![0])).toMatchObject({ icon })
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schema: 'agentmux.toolkit.package.v1', name: 'Icon package', icon, entry: 'entry.mjs' }))
    const record = { kind: 'package' as const, id: 'package', revision: 'original', packagePath: directory, enabled: false, statusBar: 'icon' as const, workspacePath: directory, args: [] }
    expect(await readToolkitPackageMetadata(record)).toMatchObject({ icon, warning: null })
    expect(await captureToolkitPackage(record)).toMatchObject({ definition: { icon }, warning: null })
  }
  const saved = structuredClone(config)
  await expect(executeToolkitConfig({ operation: 'toolkit.update', toolId: 'icons', changes: { icon: 'unknown-tool-icon' } }, owner))
    .rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
  expect(config).toEqual(saved)
})
