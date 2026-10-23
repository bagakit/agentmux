import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from './renderer-hosting-continuation.config.mts'
const variants = {
 'drop-enrollment-owner': ['apps/desktop/src/renderer/src/components/settings/BotEnrollmentPane.tsx', "'connection.enrollment.begin', input, originalTarget)", "'connection.enrollment.begin', input)"],
 'drop-management-owner': ['apps/desktop/src/renderer/src/components/settings/useConnectionManagementSetup.ts', 'return call(method, input, target)', 'return call(method, input)'],
 'ignore-enrollment-local-save': ['apps/desktop/src/renderer/src/components/settings/BotEnrollmentPane.tsx', 'if (!saved.localStorageWritten) {', 'if (false) {'],
 'ignore-management-local-save': ['apps/desktop/src/renderer/src/components/settings/useConnectionManagementSetup.ts', 'if (!saved.localStorageWritten) {', 'if (false) {'],
 'invent-legacy-owner': ['apps/desktop/src/renderer/src/components/settings/BotEnrollmentPane.tsx', 'const originalTarget = locator ? locator.hostingTarget : hostingTarget', 'const originalTarget = locator?.hostingTarget ?? hostingTarget']
} as const
const mutation = process.env.GENERIC_SETUP_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown generic setup mutation')
export default defineConfig({ ...base, plugins: [...base.plugins!, { name: 'generic-original-hosting', enforce: 'pre', transform(original, id) {
 const path=relative(base.root!, id.split('?')[0]!), selected=mutation&&variants[mutation]
 if(!/^(?:apps\/(?:desktop|host)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
 let served=original
 if(selected&&selected[0]===path){if(original.split(selected[1]).length!==2)throw Error('Unique owning mutation missing');served=original.replace(selected[1],selected[2])}
 if(!process.env.GENERIC_SETUP_LOADED)return served===original?undefined:{code:served,map:null}
 const sha=(s:string)=>createHash('sha256').update(s).digest('hex'), row={path,originalSHA:sha(readFileSync(id.split('?')[0]!, 'utf8')),servedSHA:sha(served),...(served===original?{}:{mutation})}
 return {code:"import { appendFileSync as __genericSetupLoaded } from 'node:fs'; __genericSetupLoaded("+JSON.stringify(process.env.GENERIC_SETUP_LOADED)+', '+JSON.stringify(JSON.stringify(row)+'\n')+');\n'+served,map:null}
 } }], test: { ...base.test, include:process.env.GENERIC_SETUP_MAINTENANCE?['apps/desktop/test/bot-enrollment-pane.test.tsx']:['apps/desktop/test/generic-setup-hosting.test.tsx'],passWithNoTests:false } })
