/** Shared discovery for every managed Agent, including Agents outside Talk with Agent. */
export const AGENTMUX_NOTE_GUIDE = `## Notes: read, edit, follow and inspect relationships
Notes are original Markdown .note.md files, organized by the durable Notebook catalog.
Markdown is the only saved body; the editor tree is in-memory, not another JSON document.
You can edit an authorized Note through file.read and file.write. notebook.apply changes
organization, sources and your own follow relationship, not the body. No App/page needs to be open.

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

Inline [[Page]] and [[Page #heading-or-block]] queries are accepted in ordinary Markdown.
Code, escaped wiki syntax and unfinished tokens stay literal. The original writer only binds
a unique confirmed target; repeated names or unavailable targets remain savable unbound queries.
An already bound inline occurrence is:
    [Page #Heading](note:targetNote#targetBlock)<!--amux-ref:occurrence1-->
A page target omits #targetBlock. A saved unbound occurrence is:
    [[Page #Heading]]<!--amux-ref:occurrence2-->
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
