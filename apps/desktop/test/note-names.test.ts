import { fixtureCivil as _hygiene_fixtureCivil, fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { NOTE_FILE_EXTENSION, NOTE_NAME_ATTEMPTS, createNoteWithAvailableName, noteNameCandidates, noteStemForDate } from '../src/renderer/src/lib/note-names'
describe('canonical Note naming and content',()=>{
  const day=new Date(_hygiene_fixtureYear,8,3,14,30)
  it('names structured Notes with an actual collision suffix',()=>{
    expect(noteNameCandidates(day,3)).toEqual([("note-" + _hygiene_fixtureCivil(9, 3) + ".note.json"),("note-" + _hygiene_fixtureCivil(9, 3) + "-2.note.json"),("note-" + _hygiene_fixtureCivil(9, 3) + "-3.note.json")])
    expect(NOTE_FILE_EXTENSION).toBe('.note.json'); expect(noteNameCandidates(day)).toHaveLength(NOTE_NAME_ATTEMPTS)
  })
  for(const [zone,hour] of [['Asia/Tokyo',0],['America/Los_Angeles',23]] as const) it(`uses the local calendar in ${zone}`,()=>{
    const original=process.env.TZ;process.env.TZ=zone
    try {const moment=new Date(_hygiene_fixtureYear,8,3,hour,30);expect(moment.getUTCDate()).not.toBe(moment.getDate());expect(noteStemForDate(moment)).toBe(("note-" + _hygiene_fixtureCivil(9, 3)))} finally {if(original===undefined) delete process.env.TZ;else process.env.TZ=original}
  })
  it('advances only confirmed collisions and preserves the final typed revision',async()=>{
    const paths:string[]=[]
    const result=await createNoteWithAvailableName(day,async path=>{paths.push(path);return paths.length===1?{status:'conflict',observedRevision:'occupied'}:{status:'written',revision:'new'}})
    expect(paths).toEqual([("note-" + _hygiene_fixtureCivil(9, 3) + ".note.json"),("note-" + _hygiene_fixtureCivil(9, 3) + "-2.note.json")]);expect(result).toEqual({path:paths[1],result:{status:'written',revision:'new'}})
  })
  it.each(['EACCES','ENOSPC','REMOTE_WORKSPACE_FILE_WRITE_UNSUPPORTED'])('does not replay typed %s',async code=>{
    let count=0;const result=await createNoteWithAvailableName(day,async()=>{count++;return{status:'error',code,message:'failure'}})
    expect(count).toBe(1);expect(result).toEqual({path:("note-" + _hygiene_fixtureCivil(9, 3) + ".note.json"),result:{status:'error',code,message:'failure'}})
  })
  it('retains one exact candidate when transport returns no verdict',async()=>{
    let count=0;const result=await createNoteWithAvailableName(day,async()=>{count++;throw new Error('transport missing')})
    expect(count).toBe(1);expect(result).toEqual({path:("note-" + _hygiene_fixtureCivil(9, 3) + ".note.json"),result:{status:'unknown',code:'NOTE_CREATE_TRANSPORT_UNKNOWN',message:'transport missing'}})
  })

})
