# Original interaction receipts

A request, recorded reply and operation receipt answer different questions. The surface keeps the original request readable beside its current delivery result and the action that can verify it.

Use `AgentInteractionCard` for a pending permission or synchronous question. Provide the original request and connect its actions to the original run and operation. The card preserves the original details as the result changes. If a host already owns a live receipt, pass its original intent and receipt together through `observedResponse`.

Use `AgentAsyncQuestionCard` inside a conversation for a question recorded by the provider. Keep draft answers independent of a submitted reply. Submitted replies remain unconfirmed until matching native conversation evidence supplies the answer.

For queued messages, `MessageDeliveryFailure` presents existing input and stop receipts. Show saved input and a stopped wait separately. Reuse the original wait reference for inspection or stop. A stopped wait applies to one input identity and generation.

## States to verify

| What the host knows | What the surface shows |
| --- | --- |
| A request has no response yet | Original choices and the permitted response actions |
| The original input is queued or saved | The retained message and the condition still outstanding |
| The original operation reports dispatch or submission | The submitted state and the native result still outstanding |
| A matching result is unavailable | An unconfirmed state and a read-only check of the original operation |
| The owner reports refusal or non-application | The original body and the available edit, inspect or retry action |
| Matching native evidence establishes completion | A compact result with access to the original request and details |

Use a stable action during asynchronous updates. Check the same operation again after changing context or reopening the surface. Exercise a foreign receipt and a late response after switching targets. Also check that the original draft, permissions and unrelated work remain usable.
