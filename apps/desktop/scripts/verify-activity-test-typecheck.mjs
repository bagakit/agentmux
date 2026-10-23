import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { activityTestFiles } from './typecheck-activity-tests.mjs'

const owner = 'apps/desktop/src/renderer/src/components/ActivityView.tsx'
const repository = resolve(import.meta.dirname, '../../..')

async function originalConfiguration(root) {
  for (const file of ['apps/desktop/tsconfig.test.json', 'apps/desktop/tsconfig.json', 'tsconfig.base.json']) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), await readFile(join(repository, file)))
  }
}

test('actual aliased, dynamic and helper Activity callers belong to the bounded test Program', async () => {
  const root = await mkdtemp(join(tmpdir(), 'activity-signature-calls-'))
  try {
    await originalConfiguration(root)
    const configPath = join(root, 'apps/desktop/tsconfig.test.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.compilerOptions.baseUrl = '.'
    config.compilerOptions.paths = { '@fixture/reading': ['src/renderer/src/components/ActivityView.tsx'] }
    await writeFile(configPath, JSON.stringify(config))
    const files = new Map([
      [owner, await readFile(join(repository, owner), 'utf8')],
      ['apps/desktop/test/alias.test.tsx', "import { ActivityView as Reading } from '../src/renderer/src/components/ActivityView'; export const draw = () => <Reading />"],
      ['apps/desktop/test/helpers/render.tsx', "import { ActivityView } from '../../src/renderer/src/components/ActivityView.js'; export const draw = () => <ActivityView />"],
      ['apps/desktop/test/helpers/reexport.ts', "export { draw as reading } from './render'"],
      ['apps/desktop/test/calls-through-helper.test.tsx', "import { reading as draw } from './helpers/reexport'; export const reading = draw()"],
      ['apps/desktop/test/dynamic.test.tsx', "export const load = () => import('../src/renderer/src/components/ActivityView')"],
      ['apps/desktop/test/config-alias.test.tsx', "import { ActivityView as Reading } from '@fixture/reading'; export const draw = () => <Reading />"],
      ['apps/desktop/test/unrelated.test.ts', 'export const unrelated = true'],
      ['packages/client-ui/test/shared.test.tsx', "import { ActivityView as Reading } from '../../../apps/desktop/src/renderer/src/components/ActivityView'; export const draw = () => <Reading />"]
    ])
    for (const [file, source] of files) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), source)
    }
    assert.deepEqual(activityTestFiles(root).map(file => relative(root, file)), [
      'apps/desktop/test/alias.test.tsx', 'apps/desktop/test/calls-through-helper.test.tsx',
      'apps/desktop/test/config-alias.test.tsx', 'apps/desktop/test/dynamic.test.tsx', 'apps/desktop/test/helpers/reexport.ts',
      'apps/desktop/test/helpers/render.tsx', 'packages/client-ui/test/shared.test.tsx'
    ])
  } finally { await rm(root, { recursive: true }) }
})

test('a checkout without actual Activity callers fails instead of checking an empty Program', async () => {
  const root = await mkdtemp(join(tmpdir(), 'activity-signature-empty-'))
  try {
    await originalConfiguration(root)
    await mkdir(join(root, 'apps/desktop/test'), { recursive: true })
    await mkdir(join(root, 'packages/client-ui/test'), { recursive: true })
    await writeFile(join(root, 'apps/desktop/test/unrelated.test.ts'), 'export const unrelated = true\n')
    await assert.rejects(async () => activityTestFiles(root), /Actual Activity test callers must be nonempty/u)
  } finally { await rm(root, { recursive: true }) }
})
