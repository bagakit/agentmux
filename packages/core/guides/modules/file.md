---
summary: "Exact file resources, editor presentation, saves, uploads and builds"
roles: "Agents reading, editing or presenting files"
when: "Read/write a file or open its editor workface"
---

# file

<!-- amux:content -->
The file owner holds resource reads/writes, save/upload/build receipts and editor state.
Identify the original Host, Zone/workspace and literal path independently from the intended
display Tab/Region. file read/ls access resources; file open/view access presentation. Opening
does not save or overwrite a file. Inspect the original view and preserve unsaved user drafts.

Use file stat --input FILE|- to observe one exact entry or absence. JSON is
{zoneId,path,expectedResource:{hostId,workspaceId,workspacePath},spaceId?,includeRevision?}. It returns the
complete original resource, root/parent witnesses, entry kind and helper implementation.
Default stat does not read bodies or freeze directory children. To obtain a regular file revision
without returning its body, including large binary files, explicitly use --revision or JSON
includeRevision:true. The same Native FD is hashed in fixed-size blocks and its exact entry/scope
is checked before returning observation.revision={status:"observed",revision:"sha256:..."}.
Directories, symlinks, other entries and absence return {status:"not-applicable"}; a failed requested
observation remains unknown. Unrequested stats never hash. This does not relax Note body retention
limits; file read still supplies editable body/revision pairs. When available, document.readIdentity
contains the entry from the same body FD and its ordered parent-to-Workspace-root witnesses.
It describes this read's source, not current pathname existence, write authority or a mutation ACK.
Missing provenance leaves the body readable; successful writes do not carry it forward to a new inode.
Explicit hashing is a cold operation with IO proportional to file size. A finite request waits
for its original owner result; cancellation or transport failure leaves this observation unknown
and does not authorize deletion or stop an Agent.

For one direct directory use file mkdir --input FILE|- with
{operationId,zoneId,path,expectedResource:COMPLETE_STAT_RESOURCE,expectedAbsent:true,
expected:{root:STAT_ROOT_WITNESS,parent:STAT_PARENT_WITNESS},spaceId?}. Preserve the
original JSON. Select the original Host Core endpoint through the existing --endpoint routing;
this operation never falls back to an SSH shell. No missing parent or later occupant is replaced.
Directory scope CAS pins device/inode/birth generation, not a frozen listing of all children.
A null birthtimeNs reports missing native generation; implementation.mkdir then says
generation-unavailable. Only that exact mutation is unavailable; ordinary reads remain usable.
The original Host supplies actor/caller scope; JSON cannot supply actor.

Use file move --input FILE|- for one exact entry on the same original Host/Workspace/filesystem.
Read both source and destination with file stat. JSON is
{operationId,zoneId,path,expectedResource:COMPLETE_SOURCE_RESOURCE,
expected:{root:SOURCE_ROOT,parent:SOURCE_PARENT,entry:SOURCE_ENTRY},
destination:{zoneId,path,expectedResource:COMPLETE_DESTINATION_RESOURCE,expectedAbsent:true,
expected:{root:DESTINATION_ROOT,parent:DESTINATION_PARENT}},spaceId?}.
Source entry must be present; the destination must be absent. Move pins the original source
inode/birth generation, claims that entry without replacement, and publishes without replacing
later occupants. There is no copy/delete or SSH shell fallback. A changed/moved parent may
leave the original object in its pinned scope and report unknown; preserve its claim and request.
Original execution/recovery cwd references, including physical aliases, prevent moving their
ancestor. This cold-path check reads same-Host directory metadata, not Run bodies or every input.
It never stops or rewrites a Run. Core new launch/recovery admissions share the same short
physical-effect scope. A finite same-OS Files producer retains the original semantic owner lease
until actual child close, including parent crash; no lease is exported to SSH clients or long Runs.
Name audit and Note metadata use their original owners. Note IDs, block creators, original
history/event IDs and Markdown bytes are retained. Filesystem, durability, name audit and Note
metadata are separate result stages; a confirmed move does not certify an unconfirmed metadata save.
Any relative file can have registered Note metadata, regardless of extension. This explicit cold
path reads its compact original relocation plan under the existing Notes write lease through rename;
an empty plan does not write the Note root. Ordinary content reads/writes keep their original path.
Moved receipts must identify the original source device/inode/birth generation, including inspection;
a mismatched reply is a protocol failure. Keep the original request and query without replaying.

Use file delete --input FILE|- with
{operationId,zoneId,path,expectedResource:COMPLETE_STAT_RESOURCE,
expected:{root:STAT_ROOT,parent:STAT_PARENT,entry:STAT_ENTRY},expectedRevision?,recursive?,spaceId?}.
Regular files require the exact original revision from file read or explicit file stat --revision.
A directory defaults to empty-only;
recursive:true authorizes the exact original subtree, without freezing all child bytes or names.
Symlinks delete their entry without following targets. Root, primary Mote and execution/recovery
directory ancestors stay protected. Before Note unlink, the original history owner retains its exact
current body, revision and deletion actor; unreadable or conflicting Note identity retains the claim.
The catalog, original creators and history remain. A missing prior-history source reference grants
no source/actor/undo authority. Physical deletion does not authorize discarding client drafts.

Discover saved bodies after recursive deletion with file delete snapshots --input FILE|- using
{operationId,zoneId,path,expectedResource:COMPLETE_ORIGINAL_STAT_RESOURCE,spaceId?,limit?,cursor?}.
No child Note ID is required. Pages default to 25 references, at most 50, and examine at most 100
original metadata objects without reading bodies or Runs. An empty page with hasMore:true is an
intermediate page; continue its cursor. A changed Notebook root returns unknown and keeps that cursor;
explicitly restart from the first page to observe its new generation. This is a cold metadata query,
not a producer replay or acknowledgement of a lost deletion reply. It does not create a batch index.
Each reference separates originalResource from currentHistoryResource, with its original event ID,
batch and saved status. An available historyQuery supplies the exact current real Zone/resource:
use file history --zone QUERY.zoneId --path QUERY.path --resource QUERY.expectedResource --note REF.noteId
--event-id REF.eventId --content. If historyUnavailable is present, keep the stable reference and use
the original Source resource discovery/registration to recover its current mapping; never invent a Zone.
The ordinary deletion fingerprint checks retained history correlation only; Native still requires its
original six-field generation, held FD and body hash. No query supplies undo or draft-discard approval.

After a missing/unknown mkdir, move or delete reply use file mutation inspect --input FILE|- with
{operationId,zoneId,path,expectedResource:COMPLETE_ORIGINAL_STAT_RESOURCE,spaceId?}.
The query returns the retained original request and separate filesystem/durability observations.
It does not rerun the producer, infer a delete from absence, or turn a current read into an old ACK.
A managed Agent reads only its own original actor/Host operation. Repeating the exact original
mkdir/move/delete only joins or observes its original record; it never republishes an unconfirmed action.
An existing private admission with a missing/corrupt request member stays unconfirmed; missing
member bytes never authorize a new producer. Keep the original admission for recovery.
Changing input/target/actor under that same operation ID is refused. Keep all original IDs and
bytes; observation failure does not remove views, alter drafts or stop healthy Runs.

Import ordinary attachment bytes with file import at an exactly read absent destination; use its
original resource, operation ID, byte length and SHA-256. This is separate from Session upload and
never writes a Note draft. After unknown, read that same target; current bytes do not prove a lost
operation receipt. Remote byte writes remain unsupported. Keep the source and never replay blindly.

Pin file write/create to the original resource and observed revision; retain the original result. A save
request is not a confirmed disk write. Partial results certify only their explicitly confirmed
stages; unknown stages remain unconfirmed. Upload
and build operations have their own retained identities and inspect/cancel paths. Inspect the
same upload/build after a lost reply instead of issuing a new logical operation. Formatting
and build output do not certify a user's acceptance. Wrong targets reject only that request;
unavailable resource reads never authorize removing a view, replacing content or stopping a Run.

file open paths are relative to the Zone's real directory. Opening a directory does not open
Explorer; media and binary files use their preview, and bookmark files open as source. The
receipt reports resource, placement, data, navigation and save separately. file view
source|diff|preview belongs to one exact File Region, while agent view terminal|activity applies
to every presentation of a Session; omitting --mode only reads, and supportedModes is null
when unknown.

For concurrent .note.md edits and save/conflict receipts, read amux file write --help.
For first reuse as a shared Markdown entity, read amux file share --help. Stage the source
and surviving include occurrence without creating a file on copy/paste. Explicit save uses
file.share for exclusive shared creation, original source replacement and destination save.
Keep each original operation and bytes after unknown; file share inspect reads the original
per-file history and current observations separately. A current matching file cannot certify
an earlier lost receipt. Never manufacture a second body/relationship store.
For removing saved shared include occurrences while preserving ordinary draft edits, read
amux file share undo --help, then the shared-content section of amux notebook --help for partial
undo results and for combining new promotions with removed uses in one file.share save.
For saved-version recovery or actor-batch undo, read amux file restore --help or amux file undo --help.
Only for Note links, attribution or history, read amux notebook --skill. Unknown edits never authorize automatic replay.

Before opening or moving an editor workface, read amux space --skill for placement and focus.
Use the exact file action's --help for its arguments, original revision and receipt contract.
