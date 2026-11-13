import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

// The fixed-source gate trusts only this guard to keep a live workspace file out of its compiled graph.
const root = resolve(import.meta.dirname, '../../..'), configPath = join(root, 'packages/core/test/vitest.a2a-idle-input.config.mts')
async function plugin(sourceRoot) {
  const previous = process.env.AGENTMUX_IDLE_INPUT_SOURCE_ROOT
  process.env.AGENTMUX_IDLE_INPUT_SOURCE_ROOT = sourceRoot
  try { return (await import(pathToFileURL(configPath).href + '?fixed=' + encodeURIComponent(sourceRoot))).default.plugins[0] }
  finally { if (previous === undefined) delete process.env.AGENTMUX_IDLE_INPUT_SOURCE_ROOT; else process.env.AGENTMUX_IDLE_INPUT_SOURCE_ROOT = previous }
}

test('a fixed-source run redirects live workspace imports and refuses to compile a live product file', async () => {
  const sourceRoot = await realpath(await mkdtemp(join(tmpdir(), 'amx-fixed-config-')))
  try {
    for (const name of ['core', 'identity']) {
      await mkdir(join(sourceRoot, 'packages', name, 'src'), { recursive: true })
      await writeFile(join(sourceRoot, 'packages', name, 'package.json'), '{"exports":{".":{"import":"./dist/index.js"}}}\n')
    }
    const guard = await plugin(sourceRoot), resolved = []
    const context = { resolve: async id => { resolved.push(id); return { id } } }
    const importer = join(root, 'packages/core/test/a2a-idle-input.test.ts')
    assert.deepEqual(await guard.resolveId.call(context, '../src/client.js', importer), { id: join(sourceRoot, 'packages/core/src/client.js') })
    assert.deepEqual(await guard.resolveId.call(context, join(root, 'packages/identity/src/index.ts'), importer), { id: join(sourceRoot, 'packages/identity/src/index.ts') })
    assert.equal(await guard.resolveId.call(context, '@agentmux/identity', importer), join(sourceRoot, 'packages/identity/src/index.ts'))
    assert.equal(await guard.resolveId.call(context, './helpers/fixture-values.js', importer), undefined, 'Harness helpers stay in the checkout')
    assert.deepEqual(resolved, [join(sourceRoot, 'packages/core/src/client.js'), join(sourceRoot, 'packages/identity/src/index.ts')])
    for (const live of ['packages/core/src/client.ts', 'packages/core/package.json', 'packages/identity/src/index.ts', 'packages/relay/src/index.ts'])
      assert.throws(() => guard.transform('export {}', join(root, live)), /loaded a live workspace file/u, live)
    assert.equal(guard.transform('export {}', join(root, 'packages/core/test/helpers/fixture-values.ts')), undefined)
    assert.equal(guard.transform('export {}', join(sourceRoot, 'packages/core/src/client.ts')), undefined)
  } finally { await rm(sourceRoot, { recursive: true, force: true }) }
})
