import {defineConfig,mergeConfig} from 'vitest/config'
import mobile from '../../../../mobile/vitest.config'
export default mergeConfig(mobile,defineConfig({root:new URL('../../../../mobile/',import.meta.url).pathname,plugins:[{name:'local-workspace-terminal-mutant',enforce:'pre',transform(code,id){
 if(id.endsWith('/appearance/useHostAppearance.ts')){const target="if (terminalChoice.current === 'workspace') setTerminalPalette(workspaceTerminalPalette(theme))";if(code.split(target).length!==2)throw Error('Expected one original local Root consumption edge');return code.replace(target,'if (false) setTerminalPalette(workspaceTerminalPalette(theme))')}
}}],test:{include:['test/host-appearance.test.tsx']}}))
