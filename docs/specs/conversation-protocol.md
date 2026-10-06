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

## Relevant observation and durable changes

`agent.conversation.watch` observes one exact Host and Session through the original Provider watcher. Notifications are source invalidations or unavailable observations, never a message log or delivery receipt. Desktop, Hosted clients and public readers share the original Session observation. Cancelling one reader leaves the others and the Run intact.

```sh
amux agent conversation watch --host HOST --session SESSION
amux agent conversation checkpoint --host HOST --session SESSION
amux agent conversation changes --input CHECKPOINT_REQUEST.json
```

The checkpoint result contains `hostId`, `agentSessionId` and `checkpoint`; it can be supplied unchanged to `changes`, with an optional `limit` from 1 to 100. SDK consumers use `conversationCheckpoint` and `readConversationChanges`. Each page retains its original source, records, next checkpoint and `more` flag. Empty bookkeeping pages can advance the checkpoint with `more: true`.

The first checkpoint cuts after the last complete persisted record. Existing history is excluded. A partial append is not consumed before its delimiter arrives. Catch-up resumes in original source order after reader or Host restart, independently of notification loss and UI reading cursors. Saved Claude and Codex sources reuse their original physical reader and Provider converter. Providers without durable catch-up report that capability as unsupported while retaining history, input and the original Run.

A checkpoint is a read continuation, never sharing or input authority. It contains no transcript path. Source replacement, truncation, changed identity or changed saved boundary returns an explicit source error and retains the original continuation. A connector must inspect and authorize a new source cut before publishing from it. Multiple sources keep independent checkpoints; their readers do not manufacture a global event order.

## Asynchronous question references

`projectConversationQuestions` projects already accepted native pages and same-source answer context. Every question reference retains the managed Session, Provider source, record, recorded turn and opaque question ID; an execution Host is included only when supplied by the caller. Missing turn identity stays missing. Each recorded answer retains its original user record and source, independently of the question's own turn.

`recordedQuestionAnswerFacts` queries only those accepted facts. A same-source answer outside the displayed window can confirm the card without rereading history, replacing the reading window or retaining a separate answer cache. Other Sessions or native sources cannot contribute answers. `questionReplyReceiptMatches` checks the original submission receipt; native answer evidence does not prove which operation delivered it, and a submitted receipt does not prove that a native answer was recorded.

The original `agent.history` and `agent.context` expose typed question and answer records. `agent.question.reply` remains the original exact reply owner, including its stable operation, Run and predecessor. Historical asynchronous questions are readable facts rather than synchronous pending requests. Client draft, in-flight and unknown reply intent remain with the existing client owner under [the original question and reading contract](../design/behavior/conversation-input.md#共同对话与原生记录); refreshing or projecting a question does not submit it.

## Mailbox consumption

The original Desktop Mailbox consumes Core input projection and `conversationItemRef` for the same Host, Session and native or captured record. Its mapper retains the original object and existing row/read-marker keys; known Agent authors and delivery status come from Core rather than another timeline interpretation. Typed native question answers retain their opaque IDs and original input-record reference. Missing original question pages do not manufacture a question target or acquire another reader. An unknown Host or incomplete source leaves the record readable without inventing a complete reference.

Inbox, original user Outbox, System notices and the original A2A journal retain [their existing owners and reading behavior](../design/behavior/conversation-input.md#统一对话阅读与简明操作). Saved or dispatched input receipts, recorded native input and local read markers remain independent facts. The original `message.pending.*` and `agent.history` paths continue to expose the same queue and history; connector publication Outbox is a separate owner and is not inserted into user Pending.

## State, change and delivery

A successful read proves what was observed in its stated range. It does not prove that a message was delivered, an input was adopted or a task completed. UI snapshots and observation cursors are not durable publishing checkpoints. External delivery must retain its own operation identity and confirmed platform mapping, and reconcile unknown effects through the original operation.

The source model and protected behavior are defined by [the conversation contract](../design/behavior/conversation-input.md#共同对话协议与外部交流入口). This page documents implemented reading, observation, catch-up and asynchronous question composition; connector capabilities are described as their owning implementations land.
