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
never guess a target from a display title, path or quoted source. New blocks/references need new IDs.
The original file owner records trusted creation/latest-edit attribution at save time.
Do not self-report an Agent identity in provenance; unknown old authors stay unknown.

Inline wiki syntax [[Page]] and [[Page #heading-or-block]] is accepted in ordinary Note text
on the same original file.create/write path. Code, escaped syntax and unfinished tokens stay text.
The writer uses the original catalog and actual target file: only a unique confirmed target binds.
Repeated titles/headings require explicit selection; unavailable or missing queries remain savable.
The canonical node is {"type":"noteLink","attrs":{"referenceId":"stable-occurrence-id",
"text":"Page #Heading","target":{"noteId":"stable-note-id","blockId":"stable-block-id"}}}.
A page target contains only noteId. An unbound query has target:null. Preserve existing referenceIds
and targets: renaming a page or heading does not authorize looking up the label and changing IDs.
Use amux notebook resolve --query TEXT for catalog candidates without reading bodies, then
amux notebook resolve --link '[[Page #Heading]]' [--note NOTE_ID] [--block BLOCK_ID] to read
only the selected original. #^BLOCK_ID selects an exact block; bare #text checks headings and IDs
without choosing the first match. A resolve is read-only: save a chosen stable target through CAS.

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
per-file revisions/statuses, hierarchy, exact source block/resource and tagged page/block/unbound targets,
resolution and duplicateNoteIds. Per-file revisions are not a cross-file atomic snapshot.
Occurrences are stored {kind:"stored",referenceId} or derived {kind:"text",revision,from,to}.
Graph queries from old plain [[...]] text or saved target:null links reuse the same original
file observations to confirm a unique page or block, without another read or a save. Such edges
include query with the exact written inner text: resolved means confirmed for this observation,
not bound in the file. Ambiguous/missing/unknown queries retain their text and state. Existing
bound targets are checked by ID and never looked up again by label. Reading or graph inspection
never rewrites a source, changes referenceIds or allocates a persistent ID. Text positions use
the source block's inline PM offsets (UTF16 text, inline atoms count one), valid only at its revision.
completeness partial/unknown and missing/ambiguous targets must remain visible; an empty
edge list with unread sources does not prove no links. No second body or relationship store exists.

Follow yourself using amux notebook apply --revision CATALOG_REVISION --operation-id OP_ID
--change-json '{"kind":"follow","noteId":"NOTE_ID"}'; use "unfollow" to cancel yourself.
The authenticated caller is the follower; payloads cannot act for another identity. Query
followers with notebook ls/inspect. A follow is durable interest, not online presence or a
notification/message authorization. Preserve the operation ID after an unknown response and
inspect --operation-id OP_ID before retrying that same logical change.
`
