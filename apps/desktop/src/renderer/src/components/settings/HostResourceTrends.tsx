import { useEffect, useRef, useState } from 'react'
import { readResolvedTheme, observeResolvedTheme } from '@agentmux/client-ui/theme'
import { createVegaPreview } from '@agentmux/editor-extensions/engines/vega-worker'
import type { NodeTrendPoint } from './node-resource-view'

/** Presentation only: one visible Vega View, fixed inline data, no Workspace or external resources. */
export function HostResourceTrends({ points, active }: { points: NodeTrendPoint[]; active: boolean }) {
  const container=useRef<HTMLDivElement>(null),chart=useRef<ReturnType<typeof createVegaPreview>|null>(null)
  const [url,setUrl]=useState<string>(),[error,setError]=useState('')
  const current=useRef(points);current.current=points
  const [theme,setTheme]=useState(()=>JSON.stringify(readResolvedTheme()))
  useEffect(()=>observeResolvedTheme(value=>setTheme(JSON.stringify(value))),[])
  useEffect(()=>{
    if(!active||!container.current)return
    const controller=new AbortController(),element=container.current,style=getComputedStyle(element)
    const color=(name:string,fallback:string)=>style.getPropertyValue(name).trim()||fallback
    const ink=color('--text-2','#aebbb5'),grid=color('--line-soft','#334039'),mint=color('--focus-line','#7fcba4'),secondary=color('--text-3','#8c9e95')
    const xScale={name:'x',type:'time',domain:{data:'samples',field:'at'},range:'width',nice:false,zero:false}
    const line=(field:string,scale:string,stroke:string,dash?:number[])=>({type:'line',from:{data:'samples'},encode:{update:{x:{scale:'x',field:'at'},y:{scale,field},defined:{signal:`isValid(datum.${field})`},stroke:{value:stroke},strokeWidth:{value:1.8},...(dash?{strokeDash:{value:dash}}:{})}}})
    const group=(y:number,title:string,fields:string[],unit:string,lines:unknown[])=>({type:'group',encode:{update:{x:{value:40},y:{value:y},width:{signal:'width-52'},height:{value:92}}},scales:[{...xScale},{name:'y',type:'linear',domain:{data:'samples',fields},range:[92,0],zero:true,nice:true}],axes:[{orient:'left',scale:'y',tickCount:3,grid:true,labelColor:ink,domain:false,tickColor:grid,gridColor:grid,labelFontSize:10,format:'.1~f',title:unit,titleColor:ink,titleFontSize:10},{orient:'bottom',scale:'x',tickCount:3,format:'%H:%M:%S',labelColor:ink,domainColor:grid,tickColor:grid,labelFontSize:10}],marks:[{type:'text',encode:{update:{x:{value:0},y:{value:-14},text:{value:title},fill:{value:ink},fontSize:{value:11}}}},...lines,...fields.map((field,index)=>({type:'symbol',from:{data:'samples'},encode:{update:{x:{scale:'x',field:'at'},y:{scale:'y',field},opacity:{signal:`isValid(datum.${field}) ? .9 : 0`},size:{value:16},fill:{value:index?secondary:mint}}}}))]})
    const spec={width:300,height:480,padding:0,signals:[{name:'width',update:'containerSize()[0]'}],data:[{name:'samples',values:[]}],marks:[group(28,'Core CPU · one logical core = 100%',['coreCpu'],'%', [line('coreCpu','y',mint)]),group(190,'Core resident memory · RSS',['coreMiB'],'MiB',[line('coreMiB','y',mint)]),group(352,'Core I/O · read — / write ⋯',['ioRead','ioWrite'],'ops/s',[line('ioRead','y',mint),line('ioWrite','y',secondary,[4,3])])]}
    let objectUrl:string|undefined
    const deny=async()=>{throw Error('Service charts use inline samples only.')}
    setError('')
    let view: ReturnType<typeof createVegaPreview>
    try { view=createVegaPreview(JSON.stringify(spec),'vega',{load:deny,sanitize:deny,http:deny,file:deny},controller.signal,{snapshot(snapshot){if(controller.signal.aborted)return;const next=URL.createObjectURL(new Blob([snapshot.svg],{type:'image/svg+xml'}));if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=next;setUrl(next)},error(cause){setError(cause.message)}}) } catch(cause) { setError(cause instanceof Error ? cause.message : String(cause)); return }
    chart.current=view;view.replaceData('samples',current.current.map(point=>({...point,coreMiB:point.coreGiB===null?null:point.coreGiB*1024})))
    const observer=new ResizeObserver(entries=>{if(entries[0]?.contentRect.width)view.resize(entries[0].contentRect.width,480)})
    observer.observe(element)
    return()=>{controller.abort();view.dispose();observer.disconnect();chart.current=null;if(objectUrl)URL.revokeObjectURL(objectUrl);setUrl(undefined)}
  },[active,theme])
  useEffect(()=>{chart.current?.replaceData('samples',points.map(point=>({...point,coreMiB:point.coreGiB===null?null:point.coreGiB*1024})))},[points])
  return <div ref={container} className="host-resource-trends" data-node-trends>{error?<p className="host-runtime__issue" role="status">Chart unavailable. Measurements and sample table remain available. {error}</p>:url?<img src={url} alt="Recent serving Core CPU, resident memory and I/O operations per second (solid read, dashed write). Full values are available in the sample table below."/>:<p className="host-runtime__sample">Preparing the recent-sample charts…</p>}</div>
}
