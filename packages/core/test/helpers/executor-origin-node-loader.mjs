import '../../../../apps/host/test/mote-presence-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { instrumentOrigin } from './executor-origin-mutations.mjs'
const root=resolve(import.meta.dirname,'../../../..')
registerHooks({load(url,context,next){const result=next(url,context);if(!url.startsWith('file:')||result.source==null)return result;const source=String(result.source),loaded=instrumentOrigin(source,relative(root,fileURLToPath(url)),'node');return loaded===source?result:{...result,source:loaded}}})
