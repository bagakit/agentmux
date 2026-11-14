import { defineConfig } from 'vitest/config'
import source from './mote-reliability.config.mts'
import { relative, resolve } from 'node:path'
import { transformMoteLinkSource } from './mote-object-links-mutations.mjs'
const root=resolve(import.meta.dirname,'../../..')
export default defineConfig({...source,plugins:[...(source.plugins??[]),{name:'original-mote-link-source',enforce:'pre',transform(code,id){const loaded=transformMoteLinkSource(code,relative(root,id.split('?')[0]!),'vitest');return loaded===code?null:{code:loaded,map:null}}}],test:{...source.test,include:['packages/core/test/space-links.test.ts','apps/desktop/test/mote-object-links.test.tsx','apps/desktop/test/amux-object-link-process-restore.test.ts','packages/core/test/sharing.test.ts','packages/core/test/control-desktop-focus.test.ts','apps/desktop/test/spatial-link-ingress.test.ts','apps/desktop/test/spatial-link-navigation.test.ts'],passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:30000}})
