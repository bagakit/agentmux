import {defineConfig} from 'vitest/config'
import {appendFileSync} from 'node:fs'
import {relative,resolve} from 'node:path'
import assert from 'node:assert/strict'
import type {Alias} from 'vite'
import original from './vitest.mailbox-collaboration.config.mts'
import {radixOverlayAliases} from '../scripts/radix-overlay-aliases'
const root=resolve(import.meta.dirname,'../../..'),component='apps/desktop/src/renderer/src/components/LaunchOptionControls.tsx'
const changes={
 description:[component,"...(item.description ? { description: item.description } : {})","...{}"],
 default:[component,"value || null","value === 'default' ? null : value || null"],
 unset:[component,"selection[option.id] ?? ''","selection[option.id] ?? option.choices[0]?.id ?? ''"],
 unknown:[component,"value={selection[option.id] ?? ''}","value={choice?.id ?? ''}"],
 draft:['apps/desktop/src/renderer/src/components/NewTabSurface.tsx','optionsByProvider[selectedProviderId] ?? EMPTY_LAUNCH_OPTION_SELECTION','Object.values(optionsByProvider)[0] ?? EMPTY_LAUNCH_OPTION_SELECTION'],
 caller:['apps/desktop/src/renderer/src/components/NewTabSurface.tsx','options={launchOptions}','options={[]}'],
 metadata:['packages/core/src/agent-launch-option.ts',"description: 'Highest reasoning effort; can use substantially more tokens.',",'']
} as const
export default defineConfig({...original,resolve:{...original.resolve,dedupe:['react','react-dom'],alias:[...(original.resolve!.alias as Alias[]),{find:'react',replacement:resolve(root,'apps/desktop/node_modules/react')},{find:'react-dom',replacement:resolve(root,'apps/desktop/node_modules/react-dom')},...Object.entries(radixOverlayAliases).map(([find,replacement])=>({find,replacement}))]},
 plugins:[{name:'launch-choice-details-mutations',enforce:'pre',transform(source,id){const m=process.env.LAUNCH_DETAILS_MUTATION as keyof typeof changes|undefined;if(!m)return;assert.ok(changes[m]);const [path,needle,replacement]=changes[m];if(relative(root,id)!==path)return;assert.equal(source.split(needle).length-1,1);if(process.env.LAUNCH_DETAILS_HITS)appendFileSync(process.env.LAUNCH_DETAILS_HITS,m+'\n');return{code:source.replace(needle,replacement),map:null}}}],
 test:{...original.test,server:{deps:{inline:[/@radix-ui\//]}},include:['apps/desktop/test/launch-option-controls.test.tsx','apps/desktop/test/launch-choice-details.test.tsx','packages/core/test/agent-launch-option.test.ts'],passWithNoTests:false}})
