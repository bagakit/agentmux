import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../../host/test/connection-owner-consumer.config.mts'
const source = 'apps/desktop/scripts/lib/connection-credential-conversion.ts'
const variants = {
  'ignore-original-collection': ['if (originals.some(row => !same(row, byRef.get(row.ref))))', 'if (false)'],
  'ignore-backup-coverage': ['if (originals.some(row => !same(row, saved.get(row.ref))))', 'if (false)'],
  'skip-original-store-verification': ['for (const row of legacy) if (await secrets.resolve(row.ref) !== converted.get(row.ref)!.secret)', 'if (false) for (const row of legacy) if (await secrets.resolve(row.ref) !== converted.get(row.ref)!.secret)']
} as const
const mutation = process.env.CONVERSION_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown conversion mutation')
export default { ...base, plugins: [...base.plugins!, { name: 'private-conversion-owner', enforce: 'pre' as const, transform(original: string, id: string) {
  const path = relative(base.root!, id.split('?')[0]!)
  if (![source, 'packages/connectors/src/connection-secrets.ts', 'packages/connectors/src/connection-backup.ts', 'packages/connectors/src/connection-services.ts', 'apps/host/src/host.ts', 'apps/host/src/connections.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/hosted-runtime-service.ts'].includes(path)) return
  let served = original
  if (mutation && path === source) { const [from, to] = variants[mutation]; if (original.split(from).length !== 2) throw Error('Conversion mutation anchor is not unique'); served = original.replace(from, to) }
  if (!process.env.CONVERSION_LOADED) return served === original ? undefined : { code: served, map: null }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex'), row = { path, originalSHA: hash(readFileSync(id.split('?')[0]!, 'utf8')), servedSHA: hash(served), ...(served === original ? {} : { mutation }) }
  return { code: "import { appendFileSync as __conversionLoad } from 'node:fs'; __conversionLoad(" + JSON.stringify(process.env.CONVERSION_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + served, map: null }
} }], test: { ...base.test, include: ['apps/desktop/test/connection-credential-conversion.test.ts'], passWithNoTests: false } }
