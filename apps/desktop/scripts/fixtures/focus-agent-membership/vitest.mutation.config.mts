import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from './vitest.owning.config.mts'
const mutations = {
 'eligibility': ['lib/focus-context.ts', "if (session.kind !== 'agent') continue", ''],
 'hover-only': ['components/FocusNavigationPreview.tsx', 'const selectContexts = useMemo(createFocusProjectionSelector, [])', "const selectContexts = useMemo(() => { const project = createFocusProjectionSelector(); let previous: unknown; let contexts: ReturnType<ReturnType<typeof createFocusProjectionSelector>>['contexts'] = []; return (state: Parameters<ReturnType<typeof createFocusProjectionSelector>>[0]) => { const base = project(state); if (previous !== state.sessions) { previous = state.sessions; contexts = [...base.contexts, ...state.sessions.filter(session => session.kind === 'terminal').map(session => ({ ...base.contexts[0]!, id: session.id, name: session.label }))]; } return { ...base, contexts }; }; }, [])"],
 'workspace-cleared': ['components/GlobalFocusSurface.tsx', '(state) => executionFocusSessionId(state.agentFocus)', '(state) => executionRows.some(row => row.id === executionFocusSessionId(state.agentFocus)) ? executionFocusSessionId(state.agentFocus) : null'],
 'empty-set': ['lib/focus-context.ts', 'return createFocusProjectionCache()', 'const project = createFocusProjectionCache(); return (input: Inputs) => { const projected = project(input); return { ...projected, contexts: [], laneContexts: [] } }']
} as const
const key=process.env.AGENTMUX_FOCUS_MEMBERSHIP_MUTATION as keyof typeof mutations
if(!Object.hasOwn(mutations,key))throw new Error('Select an actual Focus membership mutation')
const [file,from,to]=mutations[key]
export default defineConfig({...original,plugins:[{name:'actual-focus-membership-mutation',enforce:'pre',transform(code,id){
 if(!id.replaceAll('\\','/').endsWith('/'+file))return
 if(code.indexOf(from)<0||code.indexOf(from)!==code.lastIndexOf(from))throw new Error('Expected one actual owning expression')
 const changed=code.replace(from,to),sha=(text:string)=>createHash('sha256').update(text).digest('hex')
 const log=process.env.AGENTMUX_FOCUS_MEMBERSHIP_MUTATION_LOG;if(!log)throw new Error('Loaded Source log is required')
 appendFileSync(log,JSON.stringify({mutation:key,id,from,to,originalSha:sha(code),transformedSha:sha(changed)})+'\n');return{code:changed,map:null}
}}]})
