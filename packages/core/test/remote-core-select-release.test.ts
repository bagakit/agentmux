import { fixturePath } from './helpers/fixture-values.js'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SELECT_CORE_RELEASE } from '../src/remote-core-upgrade-programs.js'

// The actual remote program, run with this Node: it is the only writer of the restart pointer.
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const digest = (letter: string) => letter.repeat(64)
function select(stateDirectory: string, value: string, operationId = 'operation') {
  return spawnSync(process.execPath, ['-e', SELECT_CORE_RELEASE], { input: JSON.stringify({ stateDirectory, digest: value, operationId }), encoding: 'utf8' })
}
async function release(stateDirectory: string, value: string, recorded = value) {
  await mkdir(join(stateDirectory, 'core-releases', value), { recursive: true })
  await writeFile(join(stateDirectory, 'core-releases', value, 'deployment.json'), JSON.stringify({ digest: recorded, files: [] }))
}

it('names a staged release and atomically replaces the previous pointer', async () => {
  const state = await mkdtemp(fixturePath('tmp/amux-select-release-')); roots.push(state)
  await release(state, digest('a')); await release(state, digest('b'))
  expect(JSON.parse(select(state, digest('a')).stdout)).toEqual({ current: digest('a') })
  expect(await readlink(join(state, 'core-releases', 'current'))).toBe(digest('a'))
  expect(JSON.parse(select(state, digest('b'), 'later').stdout)).toEqual({ current: digest('b') })
  // A relative target keeps the pointer valid wherever the state directory is mounted.
  expect(await readlink(join(state, 'core-releases', 'current'))).toBe(digest('b'))
})

it.each([
  ['a missing release', async (state: string) => {}],
  ['a release whose deployment names another digest', async (state: string) => { await release(state, digest('c'), digest('d')) }]
])('refuses %s and keeps the existing pointer', async (_name, prepare) => {
  const state = await mkdtemp(fixturePath('tmp/amux-select-refuse-')); roots.push(state)
  await release(state, digest('a')); expect(select(state, digest('a')).status).toBe(0)
  await prepare(state)
  const refused = select(state, digest('c'))
  expect(refused.status).not.toBe(0)
  expect(await readlink(join(state, 'core-releases', 'current'))).toBe(digest('a'))
})

it('refuses a digest that is not a release identity', async () => {
  const state = await mkdtemp(fixturePath('tmp/amux-select-invalid-')); roots.push(state)
  expect(select(state, '../escape').status).not.toBe(0)
})
