# AgentMux connectors

`@agentmux/connectors` connects AgentMux Agent conversations to external chat apps. It ships two built-in adapters: `feishu`, which serves both Feishu (`open.feishu.cn`) and Lark (`open.larksuite.com`), and `discord`. A Host that composes this package can:

- receive group and direct messages, authenticate them, store each event durably before acknowledging the platform, and submit messages from authorized members as Agent input;
- publish the Agent's shared conversation to each bound group as native cards: Agent replies and progress, user messages from the App and from other groups, questions and permission requests, images and files, and Mermaid diagrams rendered to PNG;
- let authorized members answer the Agent's questions and decide permission requests from the chat;
- create groups, issue join links, bind a group to one Agent Session, and manage per-member and per-application access;
- create and configure a Feishu bot application through a QR login to the developer console, and keep its public profile in sync;
- route a bot's direct chats to a Mote;
- let an Agent call the platform's native API with the application identity it is bound to.

Core does not depend on this package. Core consumes it through the `ConnectionPort` that a Host injects as `AgentMuxRpcServiceOptions.connections`, so the SDK, the `amux connection` CLI and Desktop Settings all reach the same owners.

| Question | Where it is answered |
| --- | --- |
| Method semantics, caller authorization, operation receipts | [Connection protocol](../../docs/specs/connection-protocol.md); field types in `packages/core/src/*-contract.ts` |
| Required product behavior (sharing, triggers, access, pause, delivery) | [External conversation channels](../../docs/design/behavior/conversation-channels.md) |
| Connector on/off switches and the Settings entry | [External conversation app setup](../../docs/design/behavior/settings-and-observation.md#外部对话应用接入) |
| How to operate connections | `amux connection --skill` ([connection guide](../core/guides/modules/connection.md)); exact flags come from the running version's `--help` |
| Credential storage | [Host credential storage](../../apps/host/credential-storage.md) |

## Embedding

The product's [independent Host](../../apps/host/src/connections.ts) opens everything through `createConnectionServices({ directory, ... })`. It creates the connection directory with mode `0700`, opens one SQLite database there (WAL journal, `synchronous=FULL`), and composes the owners below on that database. Services that receive or publish take an OS lock on `connections.owner.lock`, so a second live process for the same directory fails with `CONNECTION_OWNER_BUSY` instead of receiving or sending twice. A storage failure stays inside the connection service; Core and healthy Agents keep running, and the next operation on the same directory retries.

A minimal headless embedding injects the configuration owner into an existing semantic Runtime:

```ts
import { ConnectionHost } from '@agentmux/connectors'
import { startHeadlessAgentMux } from '@agentmux/core/headless-runtime'

const connections = new ConnectionHost({ databasePath, secrets: secureResolver, adapters })
const runtime = await startHeadlessAgentMux({ service: { connections } })
// The embedding owns both lifetimes. Stop the Runtime, then close its connections.
await runtime.stop()
connections.close()
```

Pass `database` instead of `databasePath` to share one Host database with other connector owners. Each owner keeps its own tables; Agent history, input, permissions and runtime state stay in Core. Owners record an operation's intent before any asynchronous Core read, then recheck the exact target inside a synchronous transaction that saves the result and receipt together. No SQL transaction spans an `await`, and nothing assumes atomicity between the connector database and Core.

| Owner | Responsibility | Public methods |
| --- | --- | --- |
| [`ConnectionHost`](src/connection-host.ts) | Saved applications, configuration receipts, adapter registry, service policy, Channel metadata storage | `connection.ls/inspect/configure/test/delete`, `connection.service.*`, `connection.metadata.*` |
| [`ConnectionSecrets`](src/connection-secrets.ts) | Credentials, resolved only for the executing adapter | `connection.credential.*` |
| [`RoomProvisioningHost`](src/room-provisioning.ts) | Group creation and member invitation | `connection.room.create/inspect` |
| [`RoomBindingHost`](src/room-binding.ts), [`ApplicationAccessHost`](src/application-access.ts) | Group-to-Session Bindings, member grants, application-level access rules | `connection.bind`, `connection.binding.*`, `connection.grant`, `connection.application.access.*` |
| [`DurableIngressHost`](src/durable-ingress.ts), [`ConnectionReceivers`](src/connection-receivers.ts) | Authenticated intake, claims, Core input, receiver lifetimes | `connection.ingress.*`, `connection.receiver.*` |
| [`PublicationHost`](src/publication-host.ts) | Outbox, platform effects, delivery receipts | `connection.delivery.*` |
| [`ConnectionApiHost`](src/connection-api.ts) | Native API requests under a bound identity | `connection.api.*` |
| Enrollment, Setup and Profile owners ([`connection-enrollment.ts`](src/connection-enrollment.ts), [`connection-setup.ts`](src/connection-setup.ts), [`connection-profile.ts`](src/connection-profile.ts)) | Bot creation, console management, profile writes | `connection.enrollment.*`, `connection.setup.*`, `connection.profile.*` |
| [`MoteChatHost`](src/mote-chat.ts) | Routing an application's direct chats to one Mote | `space.mote.chat.*` |

## Writing an adapter

A [`ConnectionAdapter`](src/connection-host.ts) declares its `adapterId` and may contribute any of the leaves below. Platform SDKs, origins, authentication and native error mapping stay inside the adapter; Core and clients never see platform-specific fields. Adapter exceptions are reduced to safe stage reasons, because raw platform errors can contain credentials.

- **Ingress.** An `IngressAuthenticator` verifies the adapter's private transport proof and returns normalized actor, event, message, body and addressing facts. A `ConnectionIngressTransport.start({ config, credential, signal, receive })` returns a receiver with `close()` and a typed `observation()`. The `receive` callback is bound to that one connection; an event cannot name another connection, Session or execution Host.
- **Publication.** A `PublicationAdapter` prepares a bounded request synchronously inside the claim transaction, after the predecessor mapping is known. `dispatch` and `inspect` also receive the durable platform mapping (message and optional thread ID) as a read-only last argument, so updates and withdrawals need no adapter-local record cache; the mapping never goes into credentials, request bodies or request keys.
- **Groups.** `RoomProvisioningAdapter.create` and `addMembers` are independent effects. Each receives a detached copy of the configuration, the operation and its own attempt ID, with credentials as a separate argument; an abort signal can reach the SDK request. Creation returns a room ID, an authoritative not-applied, or unknown, and member results must cover every requested member. Cancelling an effect that was already claimed keeps the durable operation and any confirmed room or member results.

The adapter decides what its platform's deduplication keys, failures and partial results mean; tests against controlled ports establish only the generic Host boundary.

## Conversation capability ownership

This map locates each conversation capability's implementation and the tests that consume it. Product requirements are in [External conversation channels](../../docs/design/behavior/conversation-channels.md#共同来源与双向交付).

| Boundary | Owner and consumer | Consumer tests |
| --- | --- | --- |
| Native intake, author and input | [Durable ingress](src/durable-ingress.ts), Core input and the Binding/Grant owners | [Feishu post intake](test/feishu-post-intake-consumer.test.ts), [Discord channel](test/discord-channel.test.ts) |
| Shared conversation, source eligibility and no echo | [Publication content](src/publication-content.ts) reads the Core conversation; [PublicationHost](src/publication-host.ts) keeps each audience and effect | [Conversation completeness](test/group-conversation-completeness-consumer.test.ts) |
| Display profiles in clients | [Channel metadata](#channel-display-metadata), the shared [profile hook](../../apps/desktop/src/renderer/src/lib/use-connector-room-name.ts) and [avatar component](../client-ui/src/components/ChannelProfileAvatar.tsx); each client owns its image policy | [Profile refresh](../../apps/desktop/test/connector-profile-refresh.test.tsx) |
| Public author presentation | [Speaker projection](src/publication-speaker.ts) and adapter rendering | [Human author](../../apps/host/test/author-profile-publication-consumer.test.ts), [A2A](test/a2a-publication-consumer.test.ts) |
| App image attachments | [Composer attachment producer](../../apps/desktop/src/renderer/src/lib/use-composer-attachments.ts), the Core input resource and [input image publication](src/publication-input-images.ts) | [App image recovery](../core/test/vitest.input-image-recovery.config.mts), [input resource cases](../../apps/host/test/input-image-publication-consumer.test.ts) |
| Recorded images, files and diagrams | The recorded Core resource and [durable publication](#durable-publication); adapter upload and message receipts | [Recorded image](test/recorded-image-publication-consumer.test.ts), [recorded file](test/recorded-file-publication-consumer.test.ts) |
| Questions, permissions and feedback | Core question and interaction responders with independent grants; adapter actions and the Outbox | [Question actions](test/feishu-question-actions.test.ts), [permission actions](test/feishu-permission-actions.test.ts), [query feedback](test/feishu-query-feedback.test.ts) |
| Reply metrics and durable effects | Source turn metrics, [reply metadata](src/publication-reply-metadata.ts), the [Outbox](#durable-publication) | [Reply metadata](test/publication-reply-metadata-consumer.test.ts), [reply footer](test/feishu-reply-footer.test.ts), [worker](test/publication-worker-consumer.test.ts) |

Current gaps, which do not change the product requirements:

- Inbound resources: Feishu intake accepts `text` and `post` messages; image nodes inside a post are not turned into resources. Discord messages with attachments, embeds or stickers are refused as unsupported content.
- [Discord rendering](src/adapters/discord/render.ts) shows the author's name and role but not `speaker.avatar`, and Discord declares neither automatic query feedback nor reply metrics.
- [External speaker projection](src/publication-speaker.ts) keeps the `external` role when a message is relayed to another group but does not carry the external author's profile.

## Durable external intake

[`DurableIngressHost`](src/durable-ingress.ts) owns everything between a platform event and Core input:

- **Authentication.** Each adapter registers an `IngressAuthenticator`. Only a proof minted inside the adapter's own SDK callback is accepted; copying a JSON payload, an App ID or `authenticated: true` cannot produce one, and proofs are never stored or returned over RPC. No caller can declare an event authenticated or turn body text into an author.
- **Custody before ACK.** `receive` commits the complete raw event and its normalized facts (actor, conversation, message, body, addressing) in one transaction, then lets the transport ACK. A failed commit is not acknowledged, so the platform redelivers it. Event and message identities include the issuer domain and App ID, so aliases of one application share identities and unrelated applications never collide. A redelivered event reuses the original intake only when body, actor, conversation and addressing match; the same text in two messages stays two inputs. Identity fields follow Core's per-field limits, which never truncate the raw event or the message body.
- **Claim before Core.** Before any call that could reach Core, dispatch checks the current Binding and member grant and saves a claim with the Host, Session, Run and stable operation and message IDs. A claimed intake may already have reached Core, so later calls and restarts only inspect it; a missing receipt never authorizes replay, a new target or a new ID. Core receives the external author through its message envelope and checks the claim against its frozen input before admission. A stored author is attribution, not a grant; external actors are never treated as local people, devices or Agents, and a Region's position never routes the input. Core's message and input queues remain the only Agent delivery owners: intake records are transport facts, separate from the publication Outbox, local pending drafts, read markers and native adoption.
- **Actions.** Card buttons and forms arrive as `kind: 'action'` intakes. An authorized question answer goes to Core's `replySessionQuestion` and a permission decision to `respondAgentInteraction`; both recheck current authority against the frozen intent digest before dispatch. Unsupported actions are refused with `INGRESS_ACTION_UNSUPPORTED`.
- **Replies and context.** A platform parent reference is kept as a fact. After custody, the adapter can confirm whether the parent is this application's message (`qualifyReply`); a failed or late lookup leaves the addressing `unknown` and cannot claim input. When a message is admitted, the Host reads the platform history since the previous admitted input (or since the first observed message) up to this message and attaches it as a bounded [channel transcript quote](../core/src/channel-quote.ts) with explicit coverage and gaps, so the Agent sees the intervening discussion without old messages being replayed.
- **Unsupported content** is kept with its full private payload and refused with `INGRESS_CONTENT_UNSUPPORTED` before ACK; its empty text projection is never submitted.
- **Recovery.** [`ConnectionReceivers`](src/connection-receivers.ts) starts receivers only for enabled configurations with a registered transport and closes a receiver when its configuration revision changes. It returns from the transport callback before Core input starts, so Core and reply lookups do not consume the platform's ACK budget. Retained `received` records are retried in bounded pages per connection; claimed or unknown input is never queued again.
- **Remote execution.** Local execution uses the Host's own Core client; remote execution borrows the Hosted transport through `createHostedIngressCorePort`. The product Node Host injects its [local authority adapter](../../apps/host/src/external-input-authority.ts) as Core's `AgentExternalInputAuthorityPort`, which reads the claim and current grants straight from this owner without reading Core receipts or opening another store.

## Durable publication

[`PublicationHost`](src/publication-host.ts) reads the Core conversation through `createPublicationConversationPort` and publishes it to each Binding. Source notifications only wake a durable catch-up; they are not the message log.

- **Outbox.** Each accepted source page commits its platform effects, explicit skips and the source frontier together. A source revision that shortens a message produces explicit withdrawal operations for the surplus fragments.
- **Frozen requests.** The adapter prepares a bounded request inside the claim transaction. That transaction freezes the request, render version, audience and platform key before dispatch; credentials are resolved outside the prepared data. A compatible retry sends the same frozen request.
- **Independent lanes.** Each Binding has its own read and effect lane. An unknown effect holds only its own projection and mapping dependencies, so later independent messages still go out and a slow inspection never delays them. A late receipt settles only the attempt it belongs to.
- **Images and files.** Public PNG, JPEG, GIF and WebP parts are read through the Core resource API, validated, and kept with their bytes, digest and dimensions in the Outbox. An upload and its chat message are separate effects; a confirmed asset key is saved before the message request is frozen, so reopening never uploads twice. A failed upload does not hold back independent text from the same message. For a deferred image part, the Host asks Core for `representation: 'image'` with the same outer reference and lets Core verify and decode it; the Host never unwraps an inner reference itself.
- **Mermaid diagrams** in public Agent text are rendered by the official Mermaid engine in a private headless browser (an installed Chrome, or `PUPPETEER_EXECUTABLE_PATH`) and published as images in their original position. The page cannot load external or local resources, each render has a 30-second window, and a missing browser or invalid diagram leaves a named gap while neighboring text is delivered. No browser is downloaded.
- **Rate limits and retries.** [`publication-rate-limit.ts`](src/publication-rate-limit.ts) turns a native no-effect rate-limit response into the cooldown that the Store checks when it claims work, and the Store accepts at most one continuation per failed source. Upload, retry, cooldown and `wait` semantics are defined in the [Connection protocol](../../docs/specs/connection-protocol.md#投递).
- **Query feedback.** For Feishu, the Host manages only the waiting and input-delivered reactions on a user's request; processing and result reactions are the Agent's own choice through the native API. A missing reaction permission leaves an inspectable delivery failure while input and ordinary replies continue.

## Feishu and Lark adapter

[`FeishuAdapter`](src/adapters/feishu/index.ts) (`@agentmux/connectors/adapters/feishu`) uses the pinned official `@larksuiteoapi/node-sdk` at its low level: `Client`, `WSClient` and `EventDispatcher`, without the SDK's high-level channel, in-memory deduplication or chat queues. The handler is awaited before the SDK builds its ACK, and handler failure produces a failed ACK. A [pnpm patch](../../patches/@larksuiteoapi__node-sdk@1.76.0.patch) keeps the SDK's pong watchdog from being reset by each outbound ping.

- **Loading.** The generic entry and `createBuiltinConnectionAdapters()` load the SDK lazily, only when a Feishu connection is tested or started. One SDK client is shared per connection, application and credential; rotating either replaces it.
- **Endpoints.** The application hostname is `open.feishu.cn` or `open.larksuite.com`; the adapter accepts only the TLS WebSocket endpoint returned by its authenticated discovery and no caller-supplied host override. Bot identity comes from `bot/v3/info`. A second local receiver for the same application fails explicitly.
- **Intake.** User messages in groups and direct chats are received; bot senders are ignored. A mention counts only when the typed mention ID equals this bot's `open_id`. Group updates (`im.chat.updated_v1`) refresh that group's display metadata.
- **Card actions.** `card.action.trigger` callbacks carry question-form answers and permission decisions into durable intake. The callback response acknowledges custody, not completion; a refused question submission returns a warning toast.
- **Publication.** Messages use the [native card renderer](src/adapters/feishu/publication.ts) with author data, complete body blocks and optional reply metrics. The `uuid` deduplication field carries the base64url SHA-256 (43 characters) of the operation ID; the platform's one-hour deduplication window does not authorize retrying an unknown create. Updates use PATCH (or the card entity's ordered sequence), withdrawals use DELETE, and reconciliation reads the exact message back. Images go through `im.image.create` and appear as image cards in their fragment position. The final encoded request, envelope included, is checked against the platform limit; an oversized one stays pending with a diagnostic, and source text is never clipped to fit.
- **Card width (platform limit).** Card JSON 2.0 offers only three widths in `config.width_mode`: `default` (at most 600px on wide desktop and iPad), `compact` (fixed 400px) and `fill` (the full chat width). The [role card](src/adapters/feishu/role-card.ts) sets `fill` for user messages and leaves every other card at `default`; `compact` is not used. The platform has no field to shrink a short card to its content or to turn off the card's outer border, so neither is claimed. Source: [card JSON 2.0 structure](https://open.larkoffice.com/document/feishu-cards/card-json-v2-structure.md).
- **Groups.** Listing returns the groups the bot has joined; search also covers groups visible to the application. The member API returns user accounts and leaves out bots; members who joined in the same batch can exceed `page_size`, and that page is kept whole without cropping or inventing another cursor. Partial group information keeps its unknown fields. Group creation uses `im.chat.create`; invitations batch at most 50 users or 5 bots per request. Invalid or nonexistent members are reported as not applied, members awaiting approval stay unknown, and a failed batch keeps the members already confirmed. Join links use `chat.link` with weekly validity and keep the platform's expiry.
- **Bot creation and management.** Enrollment and Setup drive the developer console through a QR login. Console redirects are followed only through the fixed Feishu account hosts, account bootstrap is accepted only at `open.feishu.cn` or `open.larkoffice.com`, and console pages are parsed without executing their JavaScript. New setups request `im:message.reactions:write_only` along with the message scopes; existing applications are not changed automatically. A profile update sets the name for every configured locale but changes the description only in the primary locale, keeping other translations, and publishing keeps the application's current included and excluded audience.
- **Logging.** SDK log arguments are contained and SDK exceptions are reduced to safe codes, because both can include credentials or raw payloads.

## Discord adapter

[`DiscordAdapter`](src/adapters/discord/index.ts) (`@agentmux/connectors/adapters/discord`) uses `@discordjs/ws` for the Gateway and `@discordjs/rest` with application retries disabled. Desktop configures it under Settings → Conversation Channels → Discord with the application ID and a bot token.

- **Intake.** Gateway intents cover guilds, guild and direct messages and Message Content; the application must enable the matching privileged intent. The Gateway resume cursor advances only after durable custody. Own-bot, webhook and bot messages never become input. Channel, thread and direct-channel IDs are exact conversation identities; a thread is not its parent's audience. Native channel permissions still govern View Channel, Send Messages, Read Message History, Attach Files and sending in threads. A visible channel or profile never establishes those permissions or an AgentMux member grant.
- **Rendering.** Messages use Components V2 with automatic mentions disabled. Permission buttons reference the original request; question buttons open native modals that submit typed answers, one option or free text per question. A question or shared permission request longer than the 4000-character display limit goes into a text attachment in the same message, and the card says the full text is attached. The attachment carries only the frozen public question text and recorded answers, or the shared permission title, context and option labels; transport state, credentials, action references and unavailable reasons never enter it, and the adapter never rereads raw Hook payloads beyond Core's 8 KiB tool-context projection.
- **Effects.** Images and files go out as one multipart message within Core's 16 MiB recorded-binary budget. A stable nonce with `enforce_nonce` uses the platform's short deduplication window; it is not a delivery proof. Text edits can be reconciled by reading the message back; attachment edits and deletions without a confirming read stay unknown.
- **Groups.** The room catalog lists guild text and announcement channels. Guild members are not reported as channel members; `room.members` reports the gap.

## Mote private chat

[`MoteChatHost`](src/mote-chat.ts) routes one application's direct chats to one Mote. Each private conversation runs as a lane of Agents created through the Mote's preparation port; each new Agent receives the lane's recent Agents as context, and a quota decision survives exhaustion and rollover. An application that already routes to one Mote cannot be assigned to another until that route is disabled. Behavior is defined in [Mote private chat](../../docs/design/behavior/motes-and-coordination.md#外部私聊与会话更新).

## Channel display metadata

[`ChannelStorage`](src/channel-storage.ts) keeps member and group display names and avatars per adapter, platform domain and application, separate from the bot's own profile and from the immutable authors on recorded messages. Adapters choose the metadata keys and freshness. The Feishu adapter refreshes a member or group after durable intake and on `im.chat.updated_v1`; a failed platform read keeps the last confirmed value as stale. `ConnectionServices.onChannelMetadataChanged` tells local clients which subject to reread. Missing metadata never blocks intake, input or publication. Method semantics are in the [Connection protocol](../../docs/specs/connection-protocol.md#channel-展示资料).
