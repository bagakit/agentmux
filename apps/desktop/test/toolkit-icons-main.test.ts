import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeMain, oneCli, record } from './toolkit-main.fixture.js'

it('round-trips new icon values through the registered Main handlers and actual public CLI', async () => {
  const main = await nativeMain(), input = join(main.directory, 'icon-tool.json')
  const value = { name: 'Disk tool', icon: 'hard-drive', enabled: false, statusBar: 'icon',
    workspacePath: join(main.directory, 'work'), script: 'console.log("not executed by icon editing")', args: [] }
  await writeFile(input, JSON.stringify(value))
  expect((await oneCli('toolkit', 'create', 'icon-tool', '--input', input)).result.definition).toMatchObject(value)
  expect((await oneCli('toolkit', 'inspect', 'icon-tool')).result.snapshot).toMatchObject({ definition: { icon: 'hard-drive' }, admission: null })
  await writeFile(input, JSON.stringify({ changes: { icon: 'devices-network' }, expected: { icon: 'hard-drive' } }))
  expect((await oneCli('toolkit', 'update', 'icon-tool', '--input', input)).result.definition).toMatchObject({ icon: 'devices-network' })
  const tools = (await oneCli('toolkit', 'ls')).result.tools
  expect(tools.find((tool: { toolId: string }) => tool.toolId === 'icon-tool')).toMatchObject({ icon: 'devices-network' })
  const packagePath = join(main.directory, 'icon-package')
  await mkdir(packagePath)
  await writeFile(join(packagePath, 'manifest.json'), JSON.stringify({ schema: 'agentmux.toolkit.package.v1', name: 'Note tool', icon: 'note-page', entry: 'entry.mjs' }))
  await writeFile(join(packagePath, 'entry.mjs'), 'console.log("not executed by installation")')
  expect((await oneCli('toolkit', 'install', 'icon-package', '--path', packagePath)).result.definition).toMatchObject({ kind: 'package' })
  expect((await oneCli('toolkit', 'inspect', 'icon-package')).result.snapshot).toMatchObject({ definition: { icon: 'note-page' }, admission: null })
  const catalog = (await oneCli('settings', 'themes', 'ls')).result.iconCatalog
  expect(catalog.icons.find((icon: { id: string }) => icon.id === 'object.disk')).toMatchObject({ label: 'Disk', defaultGlyph: 'hard-drive' })
  expect(catalog.glyphs).toContain('hard-drive')
  expect(await main.core.listRuns()).toEqual([])
  await record('toolkit-icons-public-chain', { inline: 'devices-network', package: 'note-page', discovered: 'object.disk', runs: [] })
})
