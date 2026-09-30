import { NOTE_SCHEMA, newNoteDocument, readNoteDocument, type NoteDocument, type NoteBlockReference } from '../../../src/shared/note-document'
import type { WorkspaceFileWriteInput, WorkspaceFileWriteResult } from '../../../src/shared/contracts'
import type { NoteCreationReceipt } from '../../../src/renderer/src/lib/note-creation'
const note: NoteDocument = {schema:NOTE_SCHEMA,noteId:'note-a',content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:'block-a'},content:[{type:'text',text:'A block'}]}]}}
const reference:NoteBlockReference={referenceId:'source-occurrence',target:{noteId:note.noteId,blockId:'block-a'},mode:'embed'}
const write:WorkspaceFileWriteInput={path:'topic--a/note.note.json',content:JSON.stringify(note),expectedRevision:null}
const unknown:WorkspaceFileWriteResult={status:'unknown',code:'WORKSPACE_FILE_RESULT_UNKNOWN',message:'Read the original target before choosing another action.'}
const receipt:NoteCreationReceipt={intentId:'intent-a',createdAt:1,noteId:note.noteId,blockIds:['block-a'],draft:'A block',target:{workspaceId:'resource',hostId:'local',workspacePath:'/r',directoryPath:'/scratch/topic--a',relativeDirectory:'topic--a',zoneId:'home-zone',sourceSpaceId:'original-birth',displayWorkspaceId:'display',groupId:'group-b'},path:write.path,status:'unknown',write:unknown,revealed:false}
export const nonemptyOwningLiterals={note,reference,write,unknown,receipt,parsed:readNoteDocument(write.content),created:newNoteDocument(receipt.draft,receipt.noteId,receipt.blockIds[0]!)}
