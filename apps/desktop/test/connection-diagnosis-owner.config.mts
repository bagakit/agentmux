import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './manual-connection-owner.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.DIAGNOSIS_OWNER_MUTANT
if (mutation && mutation !== 'lose-original-host') throw Error('Unknown diagnosis owner mutation')
export default defineConfig({ ...original, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [...(original.plugins ?? []), {
  name: 'original-diagnosis-owner-consumer', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['apps/desktop/src/renderer/src/lib/connection-diagnosis.ts', 'apps/desktop/src/renderer/src/components/settings/ConnectionRequestTrace.tsx'].includes(path)) return
    let loaded = source
    if (mutation && path.endsWith('/connection-diagnosis.ts')) {
      const anchor = "api.moteConnections.call('space.mote.connection.inspect', { operationId: target.operationId }, originalHost())"
      if (source.split(anchor).length !== 2) throw Error('The original diagnosis route must load exactly once')
      loaded = source.replace(anchor, "api.moteConnections.call('space.mote.connection.inspect', { operationId: target.operationId })")
    }
    const sha = (v: string) => createHash('sha256').update(v).digest('hex')
    if (process.env.DIAGNOSIS_OWNER_LOADED) {
      const marker = { path, diskSHA256: sha(readFileSync(id.split('?')[0]!, 'utf8')), originalSHA256: sha(source), loadedSHA256: sha(loaded), ...(loaded === source ? {} : { mutation }) }
      return { code: "import { appendFileSync as __diagnosisOwnerLoaded } from 'node:fs'; __diagnosisOwnerLoaded(" + JSON.stringify(process.env.DIAGNOSIS_OWNER_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
    }
    return loaded === source ? undefined : { code: loaded, map: null }
  }, resolveId(source) {
    if (source.startsWith('@agentmux/host/')) {
      const entry = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/host/'.length)]?.import
      if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'apps/host/src', entry.slice(7).replace(/\.js$/u, '.ts'))
    }
  }
}], test: { ...original.test, include: ['apps/desktop/test/connection-complete-diagnosis.test.tsx'], testNamePattern: 'the mounted diagnosis reads the original hosting journals', passWithNoTests: false, testTimeout: 30_000 } })
