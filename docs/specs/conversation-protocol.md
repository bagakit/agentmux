# Common conversation protocol

Core owns source-qualified conversation semantics. Clients retain presentation, drafts and reading state; Providers retain native interpretation; the original history, input and interaction owners retain their durable facts.

## Reading and projection

`@agentmux/core/conversation` is browser-safe. `projectConversationRecords` projects an already accepted native history page and/or captured timeline. Each record preserves its original source and item, ordered content parts, recorded author facts and source-qualified identity. Equal text in different records remains distinct. Reading does not infer a human author, input adoption, interaction completion or task success.

The shared UI consumes this projection and adds speaker presentation. The projection creates no reader, cache, Session or Runtime. Source IO and pagination remain in the original Core history owner.

`AgentMuxClient.readAgentConversation` and public `agent.conversation.inspect` reuse that owner's bounded read envelope. Required fields are `hostId`, `agentSessionId` and `source` (`native` or `captured`); `limit`, `cursor` and `maxBytes` retain the original history contract. The envelope keeps the original source identity, revision, ordering, items and opaque continuation. Scope and bodies are not duplicated in an outer snapshot.

```sh
amux agent conversation inspect --host HOST --session SESSION --source native
```

A complete item retains the original record. An oversized item remains a sequence of exact JSON UTF-8 byte fragments with contiguous offsets and a SHA-256 digest. Reconstruct and verify the complete record before projecting it; a fragment is not a partial semantic message. A missing native source does not erase captured work. Cancelling a read releases only that reader.

## State, change and delivery

A successful read proves what was observed in its stated range. It does not prove that a message was delivered, an input was adopted or a task completed. UI snapshots and observation cursors are not durable publishing checkpoints. External delivery must retain its own operation identity and confirmed platform mapping, and reconcile unknown effects through the original operation.

The source model and protected behavior are defined by [the conversation contract](../design/behavior/conversation-input.md#共同对话协议与外部交流入口). This page documents the implemented read surface; observation, actions and connector capabilities are described only as their owning implementations land.
