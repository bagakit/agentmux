import { runDirectionalIconProof } from '../../../../mobile/test/terminal-browser-fixture'
import { updateThemeSelection, GRAPHITE_THEME, themeValue } from '@agentmux/client-ui/theme'
const custom=structuredClone(GRAPHITE_THEME);custom.id='custom.key-proof';custom.name='Private directional drawing proof'
custom.icons={ 'control.key-up':{kind:'glyph',glyph:'gem'},'control.key-down':{kind:'glyph',glyph:'gem'},'control.key-left':{kind:'glyph',glyph:'gem'},'control.key-right':{kind:'glyph',glyph:'gem'} }
Object.assign(window,{ directionalIconProof:{ async run(){const result=await runDirectionalIconProof();if(document.documentElement.dataset.theme!=='custom.key-proof')updateThemeSelection({appAppearance:'light'});return result}, custom(){updateThemeSelection({themeId:custom.id,customThemes:{[custom.id]:themeValue(custom)},appAppearance:'light'})} } })
