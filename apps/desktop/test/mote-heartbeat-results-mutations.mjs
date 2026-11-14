import {appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const base='apps/desktop/src/renderer/src/',reader=base+'lib/mote-heartbeat-reading.ts',quick=base+'components/MoteQuickMode.tsx',save=base+'lib/mote-quick-mode.ts',report=base+'lib/mote-heartbeat-report.ts'
export const mutations={
 'hide-work-cycle-action':[quick,[['<button type="button" className="small-button" disabled={busy || loading} onClick={() => void adopt()}>Use updated guidance</button>','<details><summary>More</summary><button type="button" className="small-button" disabled={busy || loading} onClick={() => void adopt()}>Use updated guidance</button></details>']],'^the actual Care dialog'],
 'false-current-work-cycle':[base+'components/MoteHeartbeatStatus.tsx',[['!unavailable && guidance.adoptedRevision === guidance.availableRevision','true']],'^the actual Care dialog'],
 'adopt-on-opening':[quick,[['  const guidance = saved?.maintenance?.guidance','  const guidance = saved?.maintenance?.guidance; useLayoutEffect(() => { if (saved && !saved.pending && !busy) void adopt() }, [saved])']],'^the actual Care dialog'],

 'drop-safe-input':[reader,[["...(result.input ? { input: result.input } : {})",'...{}']],'^the actual App reads safe input'],
 'borrow-other-report':[report,[['sameInputKey(link.source.inputKey, reference.inputKey) &&','']],'^the original report summary'],
 'forget-full-request':[quick,[["...(input ? { pending: { input, phase } } : {})",'...{}']],'^explicit guidance adoption'],
 'new-adoption-operation':[save,[["let input = saved.pending","let input = undefined as typeof saved.pending"]],'^explicit guidance adoption'],
 'resume-after-close':[quick,[["retainDraft(); await checkpointLauncherState()\n      if (lifetime.current !== epoch) return\n      dispatched",'retainDraft(); await checkpointLauncherState()\n      dispatched']],'^closing while the original resume checkpoint'],
 'late-adoption-overwrites-draft':[quick,[["      if (lifetime.current !== epoch) return\n      restored.current = undefined",'      restored.current = undefined']],'^a late adoption resolve'],
 'late-adoption-error-overwrites-draft':[quick,[["} catch (error) { if (lifetime.current === epoch) { if (!saved.pending)","} catch (error) { if (true) { if (!saved.pending)"]],'^a late adoption reject'],
 'checkpoint-is-optional':[quick,[["retainDraft(input, 'not-dispatched'); await checkpointLauncherState()","retainDraft(input, 'not-dispatched')"],["retainDraft(input, 'may-have-dispatched'); await checkpointLauncherState()","retainDraft(input, 'may-have-dispatched')"]],'^a failed original checkpoint'],
 'private-schedule-details':[base+'components/MoteHeartbeatStatus.tsx',[["<dl><dt>Arrangement</dt>",'<pre>{JSON.stringify(schedule)}</pre><dl><dt>Arrangement</dt>']],'^the actual App reads safe input'],
 'quiet-hides-native-failure':[base+'lib/mote-heartbeat-notice.ts',[["if (!native && report?.report.disposition !== 'needs-attention') return null","if (report?.report.disposition !== 'needs-attention') return null"]],'^a typed failed input']
}
export const owners=new Set([reader,quick,save,report,base+'lib/launcher-state.ts',base+'lib/mote-quick-draft.ts',base+'components/MoteHeartbeatStatus.tsx',base+'lib/mote-heartbeat-notice.ts'])
export function instrument(code,file){
 if(!owners.has(file))return code
 const name=process.env.MOTE_HEARTBEAT_RESULTS_MUTATION,mutation=mutations[name];if(name&&!mutation)throw Error('Unknown heartbeat surface mutation')
 let loaded=code,edits=0
 if(mutation?.[0]===file)for(const[before,after]of mutation[1]){if(loaded.split(before).length!==2)throw Error('Exact production anchor required: '+name);loaded=loaded.replace(before,after);edits++}
 if(process.env.MOTE_HEARTBEAT_RESULTS_LOADED){const sha=x=>createHash('sha256').update(x).digest('hex');appendFileSync(process.env.MOTE_HEARTBEAT_RESULTS_LOADED,JSON.stringify({file,sourceSHA256:sha(code),loadedSHA256:sha(loaded),mutation:edits?name:null,edits})+'\n')}
 return loaded===code?null:{code:loaded,map:null}
}
