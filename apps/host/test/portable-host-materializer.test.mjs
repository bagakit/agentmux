import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { inspectPackageClosure, materializePackageClosure } from '../../../scripts/package-dependencies.mjs'

const exec = promisify(execFile)
const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
test('the installed closure preserves two runtime versions and npm publication files in a relocatable consumer', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-packages-')))
  try {
    const host = join(root, 'source'), core = join(host, 'node_modules/@agentmux/core')
    const manifest = async (path, name, version, dependencies = {}) => put(join(path, 'package.json'), JSON.stringify({ name, version, type: 'module', files: ['dist'], dependencies }))
    await manifest(host, '@agentmux/host', '1.0.0', { '@agentmux/core': '1.0.0', leaf: '1.0.0' })
    await manifest(core, '@agentmux/core', '1.0.0', { leaf: '2.0.0' })
    for (const [path, version] of [[join(host, 'node_modules/leaf'), '1.0.0'], [join(core, 'node_modules/leaf'), '2.0.0']]) {
      await manifest(path, 'leaf', version); await put(join(path, 'dist/index.js'), `export default ${JSON.stringify(version)}`)
      await put(join(path, 'package.json'), JSON.stringify({ name: 'leaf', version, type: 'module', main: 'dist/index.js', files: ['dist'] }))
    }
    await put(join(core, 'dist/index.js'), 'export { default } from "leaf"')
    await put(join(core, 'package.json'), JSON.stringify({ name: '@agentmux/core', version: '1.0.0', type: 'module', main: 'dist/index.js', files: ['dist'], dependencies: { leaf: '2.0.0' } }))
    await put(join(host, 'dist/index.js'), 'import local from "leaf";import nested from "@agentmux/core";console.log(JSON.stringify([local,nested]))')
    await put(join(host, 'source-private.txt'), 'must not enter published runtime')
    const closure = await inspectPackageClosure(host), candidate = join(root, 'candidate')
    const packages = await materializePackageClosure(closure, candidate)
    assert.equal(packages.length, 4)
    const result = await exec(process.execPath, [join(candidate, 'node_modules/@agentmux/host/dist/index.js')], { env: { ...process.env, NODE_PATH: '' } })
    assert.deepEqual(JSON.parse(result.stdout), ['1.0.0', '2.0.0'], 'The actual installed consumer must retain each original runtime dependency version')
    await assert.rejects(readFile(join(candidate, packages[0].path, 'source-private.txt')), { code: 'ENOENT' })
    assert.ok((await realpath(join(candidate, 'node_modules/@agentmux/host'))).startsWith(candidate + '/'))
    const relocated = join(root, 'relocated')
    await rename(candidate, relocated)
    assert.deepEqual(JSON.parse((await exec(process.execPath, [join(relocated, 'node_modules/@agentmux/host/dist/index.js')])).stdout), ['1.0.0', '2.0.0'])
    assert.equal(await readFile(join(host, 'source-private.txt'), 'utf8'), 'must not enter published runtime')
  } finally { await rm(root, { recursive: true, force: true }) }
})
