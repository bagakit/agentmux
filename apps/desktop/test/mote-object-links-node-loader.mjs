import '../../../apps/host/test/mote-watchlamp-pause-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformMoteLinkSource } from './mote-object-links-mutations.mjs'
const root=resolve(import.meta.dirname,'../../..')
registerHooks({load(url,context,next){const result=next(url,context);if(!url.startsWith('file:')||result.source==null)return result;const source=String(result.source),loaded=transformMoteLinkSource(source,relative(root,fileURLToPath(url)),'node');return source===loaded?result:{...result,source:loaded}}})
