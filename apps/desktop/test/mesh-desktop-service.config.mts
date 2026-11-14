import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../packages/core/test/relay-owner-context.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const directory = resolve(process.env.AGENTMUX_MESH_DESKTOP_EVIDENCE ?? '.local/state/mesh-settings-clarity/desktop-proof')
mkdirSync(directory, { recursive: true })
const mutant = process.env.AGENTMUX_MESH_DESKTOP_MUTANT
if (mutant && mutant !== 'drop-original-core') throw Error('Unknown Desktop Mesh mutant')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/mesh-desktop-service', mutant ?? 'normal'),
  plugins: [...(base.plugins ?? []), { name: 'actual-desktop-mesh-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:packages\/core\/src\/(?:public-rpc-service|public-rpc-server)\.ts|apps\/desktop\/(?:src\/(?:main\/(?:desktop-host|desktop-rpc-exposure|mesh-network-ipc)|renderer\/src\/lib\/mesh-network-client)\.ts|test\/(?:mesh-desktop-service\.test|helpers\/mesh-desktop-service-fixture)\.ts))$/u.test(path)) return
    let source = original
    if (mutant && path === 'packages/core/src/public-rpc-service.ts') {
      const anchor = "if (this.ports.callOriginalCore) return parseMeshNetworkResult(meshMethod,"
      if (source.split(anchor).length !== 2) throw Error('Mesh forward mutant must match one loaded owner')
      source = source.replace(anchor, 'if (false) return parseMeshNetworkResult(meshMethod,')
    }
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    appendFileSync(resolve(directory, 'loaded.jsonl'), JSON.stringify({ path, originalSHA256: hash(original), servedSHA256: hash(source), ...(source === original ? {} : { mutant }) }) + '\n')
    return source === original ? undefined : { code: source, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/mesh-desktop-service.test.ts'], testTimeout: 90000, hookTimeout: 30000, passWithNoTests: false } })
