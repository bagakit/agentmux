/** Shared discovery for every managed Agent, including Agents outside Talk with Agent. */
export const AGENTMUX_NOTE_GUIDE = `## Notes: read, edit, follow and inspect relationships
Notes are original .note.json files, organized by the durable Notebook catalog. You can edit
an authorized Note through file.read and file.write; notebook.apply edits organization,
sources and your own follow relationship, not the body. No App/page needs to be open.

Start with amux notebook ls, then amux notebook inspect --note NOTE_ID --content.
The content observation gives the exact original resource, raw saved JSON and revision;
missing/unknown/invalid/identity-mismatch is not permission to create a replacement.
An inspect without --content reads only the directory/history. --max-bytes N is an optional
per-file byte cap; a refused or unavailable body stays unknown, never an empty Note.

The minimal valid body is:
  {"schema":"agentmux.note.v1","noteId":"stable-note-id","content":{"type":"doc",
    "content":[{"type":"paragraph","attrs":{"blockId":"stable-block-id"},
      "content":[{"type":"text","text":"Original text"}]}]}}
Every semantic block needs a unique persistent blockId. Preserve noteId, existing blockIds,
referenceIds, marks, provenance and unrelated structure when editing; editing or reordering
is not copying. A block reference uses type "blockReference" with attrs {blockId,
referenceId,mode:"reference"|"embed",target:{noteId,blockId}}. Keep exact target IDs,
never infer a target from a title, path or quoted source. New blocks/references need new IDs.
The original file owner records trusted creation/latest-edit attribution at save time.
Do not self-report an Agent identity in provenance; unknown old authors stay unknown.

To save: discover the Note workface and exact Zone mapping with notebook inspect and
space inspect. Run amux file read --zone ZONE --path ZONE_RELATIVE_PATH --host HOST
--workspace WORKSPACE --workspace-path WORKSPACE_PATH. Use its returned resource object
and revision, not a draft snapshot or a guessed workspace. Then pipe the complete edited
JSON to amux file write --zone ZONE --path ZONE_RELATIVE_PATH --resource RESOURCE_JSON
--expected-revision REVISION. file.write uses CAS and the same original Files owner.
A written receipt may return canonical content alongside its revision; use that saved content
as the baseline because the owner can add trusted attribution. Preserve any newer editor draft.
A conflict requires reading the original file and merging the intended edit. An unknown write
requires inspecting that exact original file before deciding another save; do not blindly resend
or switch to a new file. An editor's unsaved draft is not the saved body and must be coordinated.

Use amux notebook graph --note NOTE_ID for incoming/outgoing block references and embeds,
--notebook NOTEBOOK_ID for relationships touching that Notebook, or --all for the catalog.
Each call explicitly scans the durable catalog to find incoming sources, including closed pages;
it does not infer a complete graph from currently open files. Results include catalogRevision,
per-file revisions/statuses, hierarchy, exact source block/resource, target block/referenceId,
resolution and duplicateNoteIds. Per-file revisions are not a cross-file atomic snapshot.
completeness partial/unknown and missing/ambiguous targets must remain visible; an empty
edge list with unread sources does not prove no links. No second body or relationship store exists.

Follow yourself using amux notebook apply --revision CATALOG_REVISION --operation-id OP_ID
--change-json '{"kind":"follow","noteId":"NOTE_ID"}'; use "unfollow" to cancel yourself.
The authenticated caller is the follower; payloads cannot act for another identity. Query
followers with notebook ls/inspect. A follow is durable interest, not online presence or a
notification/message authorization. Preserve the operation ID after an unknown response and
inspect --operation-id OP_ID before retrying that same logical change.
`
