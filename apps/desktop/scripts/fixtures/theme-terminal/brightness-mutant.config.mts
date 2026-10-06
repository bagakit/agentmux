import {defineConfig,mergeConfig} from 'vitest/config'
import base from './vitest.config.mts'
export default mergeConfig(base,defineConfig({plugins:[{name:'startup-host-brightness-mutant',enforce:'pre',transform(code,id){
 if(id.endsWith('/main/terminal-theme.ts')){const before="  native.on('updated', update)\n  update()";if(code.split(before).length!==2)throw Error('Expected one native startup sampling edge');return code.replace(before,"  native.on('updated', update)")}
}}]}))
