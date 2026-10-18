import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const helper = new URL('./mutations.mjs', import.meta.url).href
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.endsWith('/scripts/icon-review/build.mjs')) return result
  const before = 'return null\n}})'
  let code = String(result.source ?? readFileSync(fileURLToPath(url), 'utf8'))
  if (code.split(before).length !== 2) throw Error('Original icon build source hook changed')
  const injected = `if(path===join(source,'app.js')) {\n    const changed=mutateIconIdentifierSource(code,process.env.AGENTMUX_ICON_ID_MUTATION);\n    appendFileSync(process.env.AGENTMUX_ICON_ID_BUILD_LOADED,JSON.stringify({path:relative(root,path),originalSHA256:sha(code),sha256:sha(changed),mutation:process.env.AGENTMUX_ICON_ID_MUTATION})+'\\n');\n    return {code:changed,map:null}\n  }\n  return null\n}})`
  code = `import {mutateIconIdentifierSource} from ${JSON.stringify(helper)};\nimport {appendFileSync} from 'node:fs';\n` + code.replace(before, injected)
  if (process.env.AGENTMUX_ICON_ID_BUILD_LOADED) appendFileSync(process.env.AGENTMUX_ICON_ID_BUILD_LOADED, JSON.stringify({ path: 'apps/desktop/scripts/icon-review/build.mjs', instrumentedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
  return { ...result, source: code }
} })
