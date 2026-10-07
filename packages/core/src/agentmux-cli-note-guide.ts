/** Shared discovery for every managed Agent, including Agents outside Talk with Agent. */
export const AGENTMUX_NOTE_GUIDE = `## Notes: read, edit, follow and inspect relationships
Notes are original Markdown .note.md files, organized by the durable Notebook catalog.
Markdown is the only saved body; the editor tree is in-memory, not another JSON document.
You can edit an authorized Note through file.read and file.write. notebook.apply changes
organization, sources and your own follow relationship. A rename-page writes the original
file's title header first and then publishes its catalog projection. No App/page needs to be open.

Start with amux notebook ls, then amux notebook inspect --note NOTE_ID --content.
The content observation gives the exact resource, saved Markdown, revision, stable blockIds
and noteProvenance from the original SQLite metadata owner. recorded/unconfirmed describes
metadata for this exact body revision; nullable authors remain unknown. A body with
unanchoredBlockCount > 0 is readable but its unassigned blocks are not confirmed link targets.
An inspect without --content reads the directory/history and committed resourceChanges.
--max-bytes N is an optional per-file byte cap. Missing/unknown/invalid/identity-mismatch
never authorizes a replacement Note or proves there are no relationships.

A minimal Note body is:
    ---
    schema: agentmux.note.md.v1
    note-id: stable-note-id
    title: Original knowledge
    ---

    Original text. ^block1

Preserve the note-id, existing block anchors, occurrence IDs and exact bound targets.
A paragraph or heading has a trailing ^blockID; code, quotation containers and rules use
a separate ^blockID line after the original block. A list item has its own
<!--amux-item:itemID--> marker as well as its child paragraph's anchor. Empty paragraphs
use <!--amux-empty:blockID-->. IDs in markers and note: targets use URI component encoding;
encode -- inside comment fields too, and decode once. Never derive identity from names or content.
Ordinary new paragraphs may omit an anchor: reading does not mint IDs; the original writer
allocates missing stable block IDs only when you explicitly save. Duplicated IDs are ambiguous,
not permission to pick one copy. A block stays inside its original file when referenced;
extracting an independent Note is a separate explicit content operation.
The readable title belongs in this original header; it is not derived from the filename.
An existing file title wins over an older catalog projection. A rename changes only this
header, preserving body bytes and block authors. Inspect notebook --operation-id OP_ID after
an unknown rename: committed file history, current file title and catalog projection are
separate facts. Retrying an old committed B rename after C must keep C, not rewrite B.

Inline [[Page]] and [[Page #heading-or-block]] queries are accepted in ordinary Markdown.
Code, escaped wiki syntax and unfinished tokens stay literal. The original writer only binds
a unique confirmed target; repeated names or unavailable targets remain savable unbound queries.
An already bound inline occurrence is:
    [[Page #Heading]]<!--amux-ref:occurrence1;query=Page%20%23Heading;target=note:targetNote#targetBlock-->
A page target omits #targetBlock. A saved unbound occurrence is:
    [[Page #Heading]]<!--amux-ref:occurrence2-->
Bound wiki text is ordinary editable text too. Edit the visible query to retarget it; its
query snapshot mismatch releases the old target, so its old ID cannot lock your new text.
Preserve the occurrence marker; let the original writer resolve the new query. An unchanged
query retains its exact bound target through renames. The editor uses ordinary click to edit
and Ctrl/Command-click to open the original target. Deleting wiki syntax retains plain text.
Original [label](note:ID#block) bindings remain readable; a canonical save writes the wiki form.
Structural reference and embed blocks use leaf directives:
    ::note-ref{#sourceBlock ref="occurrence3" target="note:targetNote#targetBlock"}
    ::note-embed{#sourceEmbed ref="occurrence4" target="note:targetNote#targetBlock"}
These IDs are examples: use unique IDs for genuinely new objects and preserve originals on edits.
Do not look up an existing binding's display label again after a rename or a name collision.
Use amux notebook resolve --query TEXT for catalog candidates without reading bodies, then
amux notebook resolve --link '[[Page #Heading]]' [--note NOTE_ID] [--block BLOCK_ID].
#^BLOCK_ID selects an exact block. A heading query cannot grant a fake unique match when
unanchored headings remain unconfirmed. Resolution is read-only; save the chosen stable target by CAS.

To save, discover the Note workface and exact Zone mapping with notebook inspect and space inspect.
Run amux file read --zone ZONE --path ZONE_RELATIVE_PATH --host HOST --workspace WORKSPACE
--workspace-path WORKSPACE_PATH. Use its returned resource and revision, never a guessed workspace.
Pipe the complete edited Markdown to amux file write --zone ZONE --path ZONE_RELATIVE_PATH
--resource RESOURCE_JSON --expected-revision REVISION. The original Files owner keeps CAS.
A written receipt can return canonical content, noteAttribution and noteProvenance. Adopt its
saved content/revision as the baseline while preserving newer unsaved input. The owner may add
missing block/occurrence IDs and bind confirmed queries. Authors never come from body declarations.
Trusted actor identity comes from the authenticated caller; creation/latest-edit records stay
in the original SQLite metadata. External plain-text edits leave latest authors unconfirmed.
If the body is written but metadata recording fails, status remains written with attribution
unconfirmed. Read the same Note/revision to reconcile; do not write the body again merely to retry metadata.
A conflict requires reading the original and merging. An unknown write requires inspecting
that exact original before another save; do not blindly resend or switch to a new file.

Read durable body history with amux file history --zone ZONE --path ZONE_RELATIVE_PATH
--resource RESOURCE_JSON --note NOTE_ID --limit 50. Keep the exact resource returned by file.read.
Entries are newest first; when hasMore is true, use the oldest returned sequence as --before.
The timeline returns metadata. Select one immutable --event-id EVENT_ID and add --content to
read its beforeContent/content for comparison; content reads require this exact event selection.
An oversized body pair is explicitly unavailable through this RPC frame; the same event without
--content remains readable. Saved bodies are not truncated and ordinary file reads/saves remain usable.
Activity batches group reading without deleting revisions. A paginated batch lists only events
in that window, not necessarily the entire batch. eventId identifies an edit, not its content hash;
returning to identical bytes does not reuse an old event or its latest author. parentEventId is
the confirmed parent when known; null keeps uncertainty. originalResource retains the original
event location, while resource follows the confirmed current mapping after a file or directory move.
A Note write can return noteHistory separately from its body result. prepared/unconfirmed events
do not prove that a body write committed, even if its bytes match. Keep the original eventId and
inspect that same event plus file.read; never replay a body merely to repair history metadata.
Unknown/unconfirmed history is a partial receipt, not a confirmed empty timeline. A missing
history owner affects this query only. This read-only query does not restore or undo a version.

Restore one whole saved after-body with amux file restore --zone ZONE --path PATH
--resource RESOURCE_JSON --note NOTE_ID --expected-revision CURRENT_REVISION
--event-id EVENT_ID --operation-id NEW_OP_ID. This explicitly replaces the whole saved body,
preserving its exact historical bytes and all recovery points; it does not merge a whole restore.
Undo a selected edit activity with amux file undo using the same exact target/current revision
and --batch BATCH_ID --batch-last-event LAST_EVENT_ID --operation-id NEW_OP_ID.
The original owner checks complete batch membership, its trusted actor and selected tail;
never treat one paginated window as the full batch. Inverse merging keeps later nonconflicting
edits, while overlap, block identity or invalid merged structure keeps all three bodies and
does not write. Undoing a confirmed creation activity empties its content while preserving
the original Note identity, current title and catalog; it does not delete the page.
Both actions create their own restore/undo history event with the selected source, require
no stdin/body/actor claims, and share original Files permission, lease and CAS. Keep each
operation ID for an unknown/replayed outcome. A committed retry returns its original receipt
without overwriting later content; a prepared/unconfirmed action is never replayed from matching bytes.
An oversized written Note receipt can keep written/revision/history with contentUnavailable.
Retain that known result and later local drafts, then read the same original revision to
recover canonical content. Never substitute your submitted bytes for unavailable canonical content.

Use amux notebook graph --note NOTE_ID, --notebook NOTEBOOK_ID or --all for saved relationships.
The original owner scans the durable catalog for incoming sources, including closed pages.
Results include catalogRevision, per-file status/revision, hierarchy, exact source block/resource,
tagged page/block/unbound targets, resolution and duplicateNoteIds. They are not an atomic
cross-file snapshot. Occurrences are stored {kind:"stored",referenceId} or derived
{kind:"text",revision,from,to}; text positions are source-block inline PM UTF16 offsets,
not Markdown file byte positions, and are valid only at that exact saved revision.
Raw wiki and saved unbound queries may be confirmed for one observation without being saved
as bindings. Such edges retain query and their original occurrence. Existing targets stay by ID.
Reading never rewrites a source or allocates persistent IDs. Unanchored blocks make the graph
partial; an empty edge list with unread or unassigned sources does not prove no links.
Graph/search indexes are derived from Markdown, never a second body or relationship authority.

Rebuild knowledge from original files without a catalog using amux notebook scan --workspace
WORKSPACE_ID --path DIRECTORY [--query TEXT]. Read the exact CLI help for optional budgets.
The original Files owner includes ignored
files, skips symlinks, and reports per-file status, revisions, titles, duplicate identities,
outline, references, backlinks, graph and full-text hits from the same Markdown parser.
An unanchored text hit has blockId:null; it is searchable but not a confirmed stable target.
complete/partial/unknown describes this physical observation. A missing title, duplicate ID,
unread file or budget exhaustion cannot establish a unique name target or absence of links.
Default limits are 200 files, 200 directories and 4 MiB of accepted source bytes; max limits
are 20000 files/directories and 64 MiB. Cancellation and budgets stop subsequent reads;
they cannot cancel a directory listing already in progress. Scanning never registers pages,
rewrites files or restores catalog organization, followers, authors or history from body text.

Existing JSON Notes and the old catalog are explicit one-time conversion inputs. The original
storage owner keeps backups, exact IDs, authors, followers and committed resourceChanges with
conversion.sourceRevision/targetRevision. Normal read/write does not keep a JSON body fallback.
Use the exact committed mapping to locate the same Note after conversion. Preserve old drafts
and unknown attempted bytes/revisions; never replace their revision and automatically replay them.

Follow yourself using amux notebook apply --revision CATALOG_REVISION --operation-id OP_ID
--change-json '{"kind":"follow","noteId":"NOTE_ID"}'; use "unfollow" to cancel yourself.
The authenticated caller is the follower; payloads cannot act for another identity. Query
followers with notebook ls/inspect. A follow is durable interest, not online presence or
notification authorization. Preserve the operation ID after an unknown response and inspect
--operation-id OP_ID before retrying that same logical change.
`
