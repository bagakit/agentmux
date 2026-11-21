import {createRendererSessionEvents} from '../../../src/renderer/src/lib/session-events'
import {SOURCE_AGENT_LOCATIONS_UNSUPPORTED} from '../../../src/shared/space-mount'

/** Only the original Host event/transport leaves are controlled. Recovery,
 * shared reader custody, retained source projection and notice are production. */
export function prepareSourceConnection({api,snapshot,opening,useAppStore}) {
 const watch=api.spaceMounts.watch,sessions=api.spaceMounts.sessions,call=api.spaceMounts.call
 const spaceListeners=new Set(),sessionListeners=new Set(),hostListeners=new Set()
 let checking=false,reads=0,releases=[]
 const locationReads={},unsupported=new Set()
 api.sessions.onEvent=createRendererSessionEvents(listener=>{hostListeners.add(listener);return()=>hostListeners.delete(listener)})
 const gate=()=>checking?new Promise(done=>releases.push(done)):Promise.resolve()
 api.spaceMounts.watch=async(target,emit,signal)=>{reads++;await gate();const reply=await watch(target,emit,signal);spaceListeners.add(emit);return{...reply,dispose(){spaceListeners.delete(emit);reply.dispose()}}}
 api.spaceMounts.sessions=async(target,emit,signal)=>{reads++;await gate();const reply=await sessions(target,emit,signal);sessionListeners.add(emit);return{...reply,dispose(){sessionListeners.delete(emit);reply.dispose()}}}
 const ready=hostId=>{for(const emit of hostListeners)emit({type:'core',hostId,event:{type:'session-observation-state',observation:{state:'ready',hasSnapshot:true},evidence:{source:'agentmux',observedAt:Date.now()}}})}
 window.sourceConnectionProof={reads:()=>reads,
  lose(){const error={code:'HOST_SERVICE_UNCONFIRMED',message:'The platform service was registered but its original endpoint is not yet confirmed. Reconnect to the same namespace; its Runs were retained.'};for(const emit of spaceListeners)emit({type:'error',error});for(const emit of sessionListeners)emit({type:'error',error})},
  recover(){checking=true;ready('local')},
  finish(){checking=false;for(const release of releases.splice(0))release()},
  transport(hostId,state){
   useAppStore.setState(current=>({hostTransports:{...current.hostTransports,[hostId]:{
    state,transport:'ssh',establishedAt:Date.now()-5000,observedAt:Date.now(),fallback:false
   }}}))
  },
  layout(value){useAppStore.getState().setFocusTaskLayout(value)},
  unmounted(){
   const hosts=[{id:'original-mini-route',kind:'ssh',hostname:'mini.invalid',label:'Review Mac',runtimeId:'original-mini-runtime'},
    {id:'original-build-route',kind:'ssh',hostname:'build.invalid',label:'Build Host',runtimeId:'original-build-runtime'},
    {id:'original-lab-route',kind:'ssh',hostname:'lab.invalid',label:'Worker Linux'}]
   for(const host of hosts)if(host.runtimeId)unsupported.add(host.id)
   api.spaceMounts.call=async(method,input,signal)=>{
    const host=hosts.find(host=>host.id===input.hostId)
    if(method==='agentLocations'&&host){
     locationReads[input.hostId]=(locationReads[input.hostId]??0)+1
     await gate()
     if(unsupported.has(host.id))throw Object.assign(Error('The original Host Core does not provide Agent location lookup.'),{code:SOURCE_AGENT_LOCATIONS_UNSUPPORTED,detail:host.runtimeId})
     if(!host.runtimeId)throw Error('The original Worker Linux connection timed out.')
     return {runtimeId:host.runtimeId,locations:[]}
    }
    return await call(method,input,signal)
   }
   const current=useAppStore.getState(),seed=current.sessions.find(session=>session.kind==='agent')
   const remote=hosts.map(host=>({...seed,id:host.id+'-task',hostId:host.id,label:'Retained task · '+host.label,control:{...seed.control,hostId:host.id,agentSessionId:host.id+'-task'}}))
   useAppStore.setState({sessions:[...remote,...current.sessions],config:{...current.config,hosts:[...current.config.hosts,...hosts]}})
  },
  ready,
  confirmLocations(hostId){unsupported.delete(hostId);ready(hostId)},
  holdLocations(){checking=true}, locationReads:()=>locationReads,
  reference:snapshot.reference,source:opening.source
 }
}
