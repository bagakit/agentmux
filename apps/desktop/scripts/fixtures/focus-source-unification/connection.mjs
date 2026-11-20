import {createRendererSessionEvents} from '../../../src/renderer/src/lib/session-events'

/** Only the original Host event/transport leaves are controlled. Recovery,
 * shared reader custody, retained source projection and notice are production. */
export function prepareSourceConnection({api,snapshot,opening,useAppStore}) {
 const watch=api.spaceMounts.watch,sessions=api.spaceMounts.sessions,call=api.spaceMounts.call
 const spaceListeners=new Set(),sessionListeners=new Set(),hostListeners=new Set()
 let checking=false,reads=0,releases=[]
 const locationReads={}
 api.sessions.onEvent=createRendererSessionEvents(listener=>{hostListeners.add(listener);return()=>hostListeners.delete(listener)})
 const gate=()=>checking?new Promise(done=>releases.push(done)):Promise.resolve()
 api.spaceMounts.watch=async(target,emit,signal)=>{reads++;await gate();const reply=await watch(target,emit,signal);spaceListeners.add(emit);return{...reply,dispose(){spaceListeners.delete(emit);reply.dispose()}}}
 api.spaceMounts.sessions=async(target,emit,signal)=>{reads++;await gate();const reply=await sessions(target,emit,signal);sessionListeners.add(emit);return{...reply,dispose(){sessionListeners.delete(emit);reply.dispose()}}}
 window.sourceConnectionProof={reads:()=>reads,
  lose(){const error={code:'HOST_SERVICE_UNCONFIRMED',message:'The platform service was registered but its original endpoint is not yet confirmed. Reconnect to the same namespace; its Runs were retained.'};for(const emit of spaceListeners)emit({type:'error',error});for(const emit of sessionListeners)emit({type:'error',error})},
  recover(){checking=true;for(const emit of hostListeners)emit({type:'core',hostId:'local',event:{type:'session-observation-state',observation:{state:'ready',hasSnapshot:true},evidence:{source:'agentmux',observedAt:Date.now()}}})},
  finish(){checking=false;for(const release of releases.splice(0))release()},
  unmounted(){
   const hosts=[{id:'original-mini-route',kind:'ssh',hostname:'mini.invalid',label:'Review Mac'},
    {id:'original-lab-route',kind:'ssh',hostname:'lab.invalid',label:'Worker Linux'}]
   api.spaceMounts.call=async(method,input,signal)=>{
    if(method==='agentLocations'&&hosts.some(host=>host.id===input.hostId)){
     locationReads[input.hostId]=(locationReads[input.hostId]??0)+1
     await gate()
     throw Error(input.hostId===hosts[0].id ? 'The original Host Core does not provide Agent location lookup. Open the Host settings to check its Core version.' : 'The original Worker Linux connection timed out.')
    }
    return await call(method,input,signal)
   }
   const current=useAppStore.getState(),seed=current.sessions.find(session=>session.kind==='agent')
   const remote=hosts.map(host=>({...seed,id:host.id+'-task',hostId:host.id,label:'Retained task · '+host.label,control:{...seed.control,hostId:host.id,agentSessionId:host.id+'-task'}}))
   useAppStore.setState({sessions:[...remote,...current.sessions],config:{...current.config,hosts:[...current.config.hosts,...hosts]}})
  },
  holdLocations(){checking=true}, locationReads:()=>locationReads,
  reference:snapshot.reference,source:opening.source
 }
}
