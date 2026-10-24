import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.connector-header-status.config.mts'
import source from '../../../packages/connectors/test/vitest.feishu-reply.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'member-action-lost': ['apps/desktop/src/renderer/src/lib/connector-group-status.ts', "if (code === 'INGRESS_ACTOR_NOT_AUTHORIZED')", "if (false && code === 'INGRESS_ACTOR_NOT_AUTHORIZED')"],
  'content-navigation-lost': ['apps/desktop/src/renderer/src/components/ConnectorDeliveryDetails.tsx', "content: () => showOriginal('content')", 'content: () => {}']
} as const
const mutant = process.env.GROUP_ACTIVITY_MUTANT as keyof typeof variants | undefined
if (mutant && !(mutant in variants)) throw Error('Unknown group activity mutation')
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/group-activity-actions'), plugins: [...base.plugins!, { name: 'group-activity-original-consumer', enforce: 'pre',
 resolveId(id, importer) {
  const pkg = id === '@agentmux/host' || id.startsWith('@agentmux/host/') ? 'apps/host' : id === '@agentmux/client-ui' || id.startsWith('@agentmux/client-ui/') ? 'packages/client-ui' : undefined
  if (pkg) {
   const exports = JSON.parse(readFileSync(resolve(root, pkg, 'package.json'), 'utf8')).exports
   const key = id.split('/').length > 2 ? './' + id.split('/').slice(2).join('/') : '.'
   const pattern = Object.keys(exports).sort((a, b) => b.length - a.length).find(value => value.includes('*') && key.startsWith(value.split('*')[0]!) && key.endsWith(value.split('*')[1]!))
   const entry = exports[key] ?? (pattern ? exports[pattern] : undefined)
   let path = typeof entry === 'string' ? entry : entry?.browser ?? entry?.import
   if (pattern && !exports[key]) path = path?.replace('*', key.slice(pattern.split('*')[0]!.length, pattern.split('*')[1] ? -pattern.split('*')[1]!.length : undefined))
   if (path?.startsWith('./src/')) return resolve(root, pkg, path)
   if (path?.startsWith('./dist/')) { const file = resolve(root, pkg, 'src', path.slice('./dist/'.length).replace(/\.js$/u, '.ts')); return existsSync(file) ? file : file.replace(/\.ts$/u, '.tsx') }
  }
  return (source.plugins![0] as any).resolveId(id, importer)
 },
 transform(source, id) {
  const path = relative(base.root!, id.split('?')[0]!)
  if (!/^(?:apps\/(?:desktop|host)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
  let code = source; const selected = mutant && variants[mutant]
  if (selected && selected[0] === path) { if (source.split(selected[1]).length !== 2) throw Error('The original activity mutation must match one expression'); code = source.replace(selected[1], selected[2]) }
  if (process.env.GROUP_ACTIVITY_LOADED) {
   const sha = (text: string) => createHash('sha256').update(text).digest('hex')
   const row = { path, originalSHA256: sha(source), loadedSHA256: sha(code), ...(source === code ? {} : { mutant }) }
   code = "import {appendFileSync as __groupActivityLoaded} from 'node:fs'; __groupActivityLoaded(" + JSON.stringify(process.env.GROUP_ACTIVITY_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code
  }
  return source === code ? undefined : { code, map: null }
 }
 }], test: { ...base.test, globalSetup: [], setupFiles: ['vitest.setup.ts'], include: ['apps/desktop/test/group-activity-actions.test.tsx', 'apps/desktop/test/connector-header-status.test.tsx'], testNamePattern: mutant ? 'exposes one-click member access' : 'exposes one-click member access|the actual header diagnoses a source gap|actual recorded refusal and waiting|the actual header explains an unsupported message' } })
