import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './renderer-hosting-continuation.config.mts'
const variants = {
  'drop-service-owner': ['apps/desktop/src/renderer/src/components/settings/ConnectorServiceControl.tsx', "source('connection.service.configure', input, original)", "source('connection.service.configure', input)"],
  'drop-mote-owner': ['apps/desktop/src/renderer/src/components/settings/MoteIdentityCards.tsx', 'readPreferences(input, owner!)', 'readPreferences(input)'],
  'drop-mote-lifetime-scope': ['apps/desktop/src/renderer/src/components/settings/MoteIdentityCards.tsx', "identity = JSON.stringify([hostingTarget === undefined ? 'default' : hostingTarget, targets])", 'identity = JSON.stringify(targets)']
} as const
const variant = process.env.SERVICE_HOSTING_MUTANT as keyof typeof variants | undefined
if (variant && !variants[variant]) throw Error('Unknown hosting consumer mutation')
export default defineConfig({ ...base, plugins: [...base.plugins!, { name: 'service-hosting-loaded-consumer', enforce: 'pre', transform(original, id) {
  const path = relative(base.root!, id.split('?')[0]!), selected = variant && variants[variant]
  if (!/apps\/desktop\/src\/renderer\/src\/(?:components\/settings\/(?:ConnectorServiceControl|MoteIdentityCards)\.tsx|lib\/connector-service-(?:observation|intent)\.ts)$/u.test(path)) return
  let loaded = original
  if (selected && path === selected[0]) { if (original.split(selected[1]).length !== 2) throw Error('Owning consumer mutation is not unique'); loaded = original.replace(selected[1], selected[2]) }
  if (!process.env.SERVICE_HOSTING_LOADED) return loaded === original ? undefined : loaded
  const hash = (s: string) => createHash('sha256').update(s).digest('hex'), marker = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(loaded === original ? {} : { variant }) }
  return { code: "import { appendFileSync as __serviceHostingLoaded } from 'node:fs'; __serviceHostingLoaded(" + JSON.stringify(process.env.SERVICE_HOSTING_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
} }], test: { ...base.test, include: ['apps/desktop/test/connector-service-hosting.test.tsx'], passWithNoTests: false } })
