// Exact leaf targets used by source tests. No full package build or installed launcher.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
const root = resolve(import.meta.dirname, '../../../../..')
async function writeChanged(path, source) {
  let current
  try { current = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (current !== source) await writeFile(path, source)
}
export async function prepareHookTransactionTargets() {
  const { bundleIdentityRuntime } = await import(resolve(root, 'packages/identity/scripts/runtime-bundle.mjs'))
  const identity = await bundleIdentityRuntime()
  await mkdir(resolve(root, 'packages/identity/dist'), { recursive: true })
  await mkdir(resolve(root, 'packages/core/dist'), { recursive: true })
  await writeChanged(resolve(root, 'packages/identity/dist/runtime-source.js'), `export const identityRuntimeSource = ${JSON.stringify(identity.source)};\n`)
  await writeChanged(resolve(root, 'packages/identity/dist/runtime-source.d.ts'), 'export declare const identityRuntimeSource: string;\n')
  const source = 'packages/core/src/control-endpoint-listener-worker.ts'
  await writeChanged(resolve(root, 'packages/core/dist/control-endpoint-listener-worker.js'),
    stripTypeScriptTypes(await readFile(resolve(root, source), 'utf8'), { mode: 'transform', sourceUrl: source }))
}
