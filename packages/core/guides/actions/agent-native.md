# agent native

<!-- amux:content -->
Discover original Provider conversations with agent native ls --host HOST --executor EXECUTOR.
Query a retained Agent's inputs with agent history --host HOST --session SESSION --source captured|native
--kind user-message --query TEXT. Queries are literal and case-sensitive; --limit counts matches,
--scan-limit counts examined original records. A zero-match page with nextCursor is not an empty history.
Follow that cursor with the same Host, Agent, source and query. Current appends do not move this window.
The typed userMessages retain original source/author/channel facts; Native role=user does not prove Terminal.
Read complete text resources with the original recorded resource API before copying or reusing their full text.
Query leases are bounded readonly snapshots, not a new history ledger. Expiry asks for a fresh first page;
it never removes the Agent or input. Raw non-query history and its exact fragment protocol stay available.
Use --workspace-path PATH to filter their original execution directory; listing starts no Run.
Read saved conversation details with agent native history --input FILE|- using JSON containing
hostId, executorId and that exact source; limit and cursor page the original Provider history.
Follow nextCursor with the same source. Reading and cancellation operate no Session or Run.
Use agent native history resource --input FILE|- for a recorded resource, preserving nativeSource,
source, recordId, turnId, partIndex and expectedReference from that exact page.
For an image inside original public assistant Markdown text, the same resource commands accept markdownImage
{index, textSha256} with representation: image. Use markdownImageReferences on the complete original
text to select its node; keep the signed text reference, or compare the original node URL for plain text.
The original record must be assistant speech with public purpose, excluding tool/reasoning parts.
Signed text is rechecked against that original record. Sharing user text does not grant file reads.
A changed text revision or a code example does not authorize a resource read.
For raster bytes use representation: image; for self-contained recorded file bytes use representation: file.
Keep the same outer signed reference and omit offsetBytes. Files never authorize path or URL reads.
File results retain recorded MIME and optional label; those metadata do not verify file format or sharing.
Omitting representation preserves the original exact JSON fragment reads and offsets. Binary maxBytes
only reduces the fixed image budget. Local read permission and external sharing eligibility are separate.
Keep partial issues and unsupported availability visible. A managed candidate names the original
AgentMux Session, Executor and Run. Inspect and reuse that Session: attach its healthy Run,
recover its active identity, or agent reopen its exact retired identity. Do not create a duplicate.
For an unmanaged candidate, save only its exact source {nativeHandle,workspacePath,revision}
to FILE and use agent open --executor EXECUTOR --native-source FILE at a discovered destination.
Select --execution-workspace WORKSPACE when display and execution differ. Its Host, directory
and Provider must match the source; presentation placement never changes execution cwd.
Omit --prompt when only continuing the conversation: no user request is invented.
Keep the same --operation-id after an unknown result and inspect space inspect --operation-id ID;
do not relaunch or replay input with new identities. A refused source retains existing work.
