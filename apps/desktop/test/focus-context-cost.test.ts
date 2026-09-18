// @vitest-environment happy-dom
import {expect,it} from 'vitest'
import {api} from '../src/renderer/src/lib/api'
import {createFocusProjectionSelector} from '../src/renderer/src/lib/focus-context'
import type {AgentTimelineSnapshot} from '@agentmux/core'

it('skips unrelated Store writes and derives only one changed context at both input sizes',async()=>{
  const baseConfig=await api.config.get(), {sessions:available}=await api.sessions.snapshot(), base=available[0]!
  for(const [sessionCount,projectCount] of [[14,54],[112,432]]) {
    let pathReads=0,idReads=0
    const timelineReads:Record<string,number>={}
    const workspaces=Array.from({length:projectCount!},(_,i)=>new Proxy({id:`project-${i}`,name:`Project ${i}`,hostId:'local',path:`/focus-cost-${i}`,kind:'folder' as const},{get(target,key,receiver){if(key==='path')pathReads++;return Reflect.get(target,key,receiver)}}))
    const sessions=Array.from({length:sessionCount!},(_,i)=>new Proxy({...base,id:`session-${i}`,hostId:'local',workspacePath:'/focus-cost-0',status:{...base.status,state:'working' as const}},{get(target,key,receiver){if(key==='id')idReads++;return Reflect.get(target,key,receiver)}}))
    const timelines:Record<string,AgentTimelineSnapshot>={}
    for(let i=0;i<sessionCount!;i++)timelines[`session-${i}`]=new Proxy({agentSessionId:`session-${i}`,revision:1,items:[]},{get(target,key,receiver){if(key==='items')timelineReads[`session-${i}`]=(timelineReads[`session-${i}`]??0)+1;return Reflect.get(target,key,receiver)}})
    const input={sessions,config:{...baseConfig,workspaces},timelines,agentNames:{}}
    const select=createFocusProjectionSelector(), before=select(input)
    expect(before.contexts).toHaveLength(sessionCount!)
    pathReads=0;idReads=0;for(const id of Object.keys(timelineReads))delete timelineReads[id]
    expect(select({...input})).toBe(before)
    expect({pathReads,idReads,timelineReads}).toEqual({pathReads:0,idReads:0,timelineReads:{}})
    const renamed=select({...input,agentNames:{'session-0':'Changed only this task'}})
    expect(renamed.contexts[0]!.name).toBe('Changed only this task')
    expect(renamed.laneContexts).toBe(before.laneContexts)
    expect(renamed.contexts.slice(1)).toEqual(before.contexts.slice(1))
    expect(pathReads).toBe(0)
    expect(timelineReads).toEqual({'session-0':2})
    for(const id of Object.keys(timelineReads))delete timelineReads[id]
    const changed=select({...input,agentNames:{'session-0':'Changed only this task'},sessions:sessions.map((session,index)=>index===0?{...session,status:{...session.status,state:'done' as const}}:session)})
    expect(changed.contexts[0]!.bucket).toBe('idle')
    expect(changed.laneContexts).not.toBe(renamed.laneContexts)
    expect(changed.laneContexts.slice(1)).toEqual(renamed.laneContexts.slice(1))
    expect(pathReads).toBe(0);expect(timelineReads).toEqual({'session-0':2})
  }
})

it('keeps PMO requests separate in the same cache and invalidates actual owner changes',async()=>{
  const config=await api.config.get(),{sessions}=await api.sessions.snapshot(),base=sessions[0]!
  const workspace={id:'__scratch__',hostId:'local',name:'Topics',path:'/focus-topics',kind:'folder' as const}
  const pmo={...base,id:'pmo',hostId:'local',workspacePath:'/focus-topics/topic--launcher--leader',status:{...base.status,state:'waiting' as const}}
  const execution={...base,id:'execution',hostId:'local',workspacePath:'/focus-topics/topic--launcher--task',status:{...base.status,state:'working' as const}}
  const select=createFocusProjectionSelector(),input={sessions:[pmo,execution],config:{...config,workspaces:[workspace]},timelines:{},agentNames:{}}
  const before=select(input)
  expect(before.contexts.map(row=>row.id)).toEqual(['execution'])
  expect(before.pmoAttention).toEqual(['pmo'])
  const settled=select({...input,sessions:[{...pmo,status:{...pmo.status,state:'done' as const}},execution]})
  expect(settled.contexts).toBe(before.contexts);expect(settled.pmoAttention).toEqual([])
  const moved=select({...input,sessions:[{...pmo,workspacePath:execution.workspacePath},execution]})
  expect(moved.contexts.map(row=>row.id)).toEqual(['pmo','execution']);expect(moved.pmoAttention).toEqual([])
  const renamed=select({...input,config:{...input.config,workspaces:[{...workspace,name:'Renamed Topics'}]}})
  expect(renamed.contexts).toHaveLength(1);expect(renamed.contexts[0]!.workspaceName).toBe('Renamed Topics')
})
