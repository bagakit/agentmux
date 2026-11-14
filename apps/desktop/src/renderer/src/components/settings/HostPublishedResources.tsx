import { useEffect, useRef, useState } from 'react'
import type { NodePublication, NodeFileList, NodeFileRead, NodePublishedRoot } from '@agentmux/core/node-publishing'
import type { HostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { NodeShareAddress } from './NodeShareAddress'

/** Browses only the original Node policy interface, including on this device. Never raw file fallback. */
export function HostPublishedResources({host,committed,active}:{host:HostConfig;committed?:HostConfig|undefined;active:boolean}) {
  const [publication,setPublication]=useState<NodePublication>(),[folder,setFolder]=useState<NodeFileList>(),[file,setFile]=useState<NodeFileRead>()
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0)
  const originalRoute = ({label:_label,...value}:HostConfig) => value
  const current=useRef<AbortController|null>(null),readerOwner=useRef<object|undefined>(undefined),target=JSON.stringify(committed&&originalRoute(committed)),saved=Boolean(committed&&configValuesEqual(originalRoute(host),originalRoute(committed)))
  const observedTarget=useRef(target)
  function failure(cause:unknown) {
    const code=(cause as {code?:unknown}|null)?.code
    if(code==='NODE_PATH_DENIED')setFile(undefined)
    if(['NODE_POLICY_CHANGED','NODE_ROOT_UNPUBLISHED','NODE_ROOT_MISMATCH','NODE_RUNTIME_MISMATCH'].includes(String(code))){setFolder(undefined);setFile(undefined);setPublication(undefined)}
    setError(cause instanceof Error?cause.message:String(cause))
  }
  const route={hostId:host.id,...(host.kind==='ssh'&&host.runtimeId?{expectedRuntimeId:host.runtimeId}:{})}
  useEffect(()=>{
    const owner={};readerOwner.current=owner
    if(observedTarget.current!==target){setPublication(undefined);setFolder(undefined);setFile(undefined);setError('');observedTarget.current=target}
    if(!active||!saved){setBusy(false);return}
    const controller=new AbortController();current.current=controller;setBusy(true)
    void api.nodePublishing.call('node.inspect',route,controller.signal).then(value=>{
      if(controller.signal.aborted)return
      setPublication(previous=>{if(previous&&previous.policyRevision!==value.policyRevision){setFolder(undefined);setFile(undefined)}return value})
    }).catch(cause=>{if(!controller.signal.aborted)failure(cause)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)})
    return()=>{controller.abort();if(readerOwner.current===owner){current.current?.abort();current.current=null;readerOwner.current=undefined}}
  },[active,saved,target,revision])
  async function readFolder(root:NodePublishedRoot['root'],path:string,more=false){
    current.current?.abort();const controller=new AbortController();current.current=controller;setBusy(true);setError('');setFile(undefined)
    const previous=more?folder:undefined
    try{const next=await api.nodePublishing.call('node.files.list',{...route,root,path,limit:100,...(previous?{offset:previous.nextOffset!,expectedRevision:previous.revision}:{})},controller.signal)
      if(!controller.signal.aborted)setFolder(previous?{...next,entries:[...previous.entries,...next.entries]}:next)
    }catch(cause){if(!controller.signal.aborted)failure(cause)}finally{if(!controller.signal.aborted)setBusy(false)}
  }
  async function readFile(root:NodePublishedRoot['root'],path:string,previous?:NodeFileRead){
    current.current?.abort();const controller=new AbortController();current.current=controller;setBusy(true);setError('')
    try{const next=await api.nodePublishing.call('node.files.read',{...route,root,path,maxBytes:64*1024,...(previous?{offset:previous.nextOffset!,expectedRevision:previous.revision}:{})},controller.signal);if(!controller.signal.aborted)setFile(next)}
    catch(cause){if(!controller.signal.aborted)failure(cause)}finally{if(!controller.signal.aborted)setBusy(false)}
  }
  let text=''
  if(file)try{text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(file.data),char=>char.charCodeAt(0)));if(text.includes('\0'))text='Binary content. A text preview is unavailable.'}catch{text='Binary content. A text preview is unavailable.'}
  return <section className="host-published-resources" aria-label="Published Node folders">
    <header><strong>Shared folders</strong><button type="button" className="small-button" disabled={busy||!saved||!active} onClick={()=>setRevision(value=>value+1)}>Refresh folders</button></header>
    {publication ? <NodeShareAddress node={publication.node} /> : null}
    {!saved?<p className="field-hint">Save this connection before browsing published folders.</p>:null}
    {publication?<><p className="host-runtime__sample">Only folders published by {publication.node.alias||host.label}. Owner file access remains separate.</p><div className="host-published-resources__roots">{publication.roots.map(item=><button type="button" className="small-button" key={item.root.rootId} disabled={busy} onClick={()=>void readFolder(item.root,'')}>{item.label}</button>)}{publication.landing?<button type="button" className="small-button" disabled={busy} onClick={()=>void readFolder(publication.landing!.root,publication.landing!.path)}>Open landing folder</button>:null}</div>{!publication.roots.length?<p className="field-hint">This node has no published folders.</p>:null}</>:busy?<p role="status">Reading published folders…</p>:null}
    {folder?<><div className="host-published-resources__path"><code>{publication?.roots.find(item=>item.root.rootId===folder.root.rootId)?.label??'Published root'}/{folder.path}</code>{folder.path?<button type="button" className="small-button" disabled={busy} onClick={()=>void readFolder(folder.root,folder.path.split('/').slice(0,-1).join('/'))}>Parent folder</button>:null}</div><ul>{folder.entries.map(item=><li key={item.name}><button type="button" disabled={busy||item.kind==='other'} onClick={()=>{const path=[folder.path,item.name].filter(Boolean).join('/');void(item.kind==='directory'?readFolder(folder.root,path):readFile(folder.root,path))}}><span>{item.name}</span><small>{item.kind}</small></button></li>)}</ul>{folder.nextOffset!==null?<button type="button" className="small-button" disabled={busy} onClick={()=>void readFolder(folder.root,folder.path,true)}>Load more entries</button>:null}</>:null}
    {file?<div className="host-published-resources__file"><strong>{file.path}</strong><span>Bytes {file.offset}–{file.nextOffset??file.totalBytes} of {file.totalBytes}</span><pre>{text}</pre>{file.nextOffset!==null?<button type="button" className="small-button" disabled={busy} onClick={()=>void readFile(file.root,file.path,file)}>Read next chunk</button>:null}</div>:null}
    {error?<p className="network-node-feedback" role="status">{error}</p>:null}
  </section>
}
