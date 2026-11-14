import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import base from './connection-link.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.SHORT_MOBILE_MUTATION, trace = process.env.SHORT_MOBILE_LOADED
const variants = {
  'metadata-key': { file: 'packages/relay/src/connection-offer.ts', testFile: 'apps/mobile/test/short-connection-entry.test.tsx', before: 'offer.daemonPublicKeyB64 !== pin.daemonPublicKeyB64', after: 'false', target: 'fresh explicit pin refuses a substituted metadata key' },
  'digest-active': { file: 'apps/host/src/mobile-assets-owner.ts', testFile: 'apps/host/test/short-mobile-http.test.ts', before: "file = candidate.files.get(path.slice(prefix.length) || (prefix === short ? 'index.html' : ''))", after: "file = this.active!.files.get(path.slice(prefix.length) || (prefix === short ? 'index.html' : ''))", target: 'short immutable HTTP keeps the original full digest bytes' },
  'page-digest': { file: 'apps/mobile/src/mobile-web/page-identity.ts', testFile: 'apps/mobile/test/short-connection-entry.test.tsx', before: 'mobilePageNamespaceDigest(location.pathname, buildId)', after: 'null', target: 'actual main paints the original connection page' }
} as const
if (mutation && !Object.hasOwn(variants, mutation)) throw Error('Unknown short link mutation')
const variant = mutation ? variants[mutation as keyof typeof variants] : undefined
const files = new Set(['packages/relay/src/connection-offer.ts','packages/core/src/public-rpc-device.ts','packages/core/src/public-rpc-client.ts','packages/core/src/mobile-web-codec.ts','apps/host/src/host.ts','packages/core/src/device-administration.ts','apps/host/src/mobile-assets-owner.ts','apps/mobile/src/main.tsx','apps/mobile/src/connection/MobileConnectionRoot.tsx','apps/mobile/src/mobile-web/page-identity.ts','apps/mobile/test/short-connection-entry.test.tsx','apps/host/test/short-mobile-http.test.ts','apps/host/test/mobile-link.test.ts'])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base, define: { ...base.define, __AGENTMUX_MOBILE_BUILD_ID__: JSON.stringify('short-page-build') },
  plugins: [...base.plugins ?? [], { name: 'executed-short-mobile-link', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!); if (!files.has(file)) return
    let loaded = original
    if (variant?.file === file) { if (original.split(variant.before).length !== 2) throw Error('Actual mutation anchor must be unique'); loaded = original.replace(variant.before, variant.after) }
    if (!trace) return loaded === original ? undefined : { code: loaded, map: null }
    const row = { file, sourceSHA256: sha(readFileSync(resolve(root,file),'utf8')), loadedSHA256: sha(loaded), mutation: variant?.file === file ? mutation : null }
    return { code: `import {appendFileSync as __shortLinkLoaded} from 'node:fs'; __shortLinkLoaded(${JSON.stringify(resolve(root,trace))},${JSON.stringify(JSON.stringify(row)+'\n')});\n` + loaded, map: null }
  } }], test: { ...base.test, include: variant ? [variant.testFile] : ['packages/relay/test/connection-offer.test.ts','apps/mobile/test/short-connection-entry.test.tsx','apps/host/test/short-mobile-http.test.ts','apps/host/test/mobile-link.test.ts'], testNamePattern: variant?.target, testTimeout: 30000 } })
