import { fixtureClock, fixtureDay, fixturePath } from '../../helpers/fixture-values.js'

/** Source-derived native shape with relative fixture time and Host-derived paths. */
export function droidNativeSessionFixture(): Buffer {
  const records = [
  {
    "type": "session_start",
    "id": "00000000-0000-4000-8000-000000000001",
    "title": "Source-derived session fixture",
    "owner": "fixture-owner",
    "version": 2,
    "cwd": fixturePath('fixture/workspace')
  },
  {
    "type": "message",
    "id": "user-1",
    "timestamp": fixtureDay(1) + 'T' + fixtureClock(0, 0, 0, '000') + 'Z',
    "seq": 0,
    "message": {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Inspect the build"
        }
      ],
      "userMessageSource": "cli_tui",
      "visibility": "both"
    }
  },
  {
    "type": "message",
    "id": "assistant-1",
    "parentId": "user-1",
    "timestamp": fixtureDay(1) + 'T' + fixtureClock(0, 0, 1, '000') + 'Z',
    "seq": 1,
    "message": {
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "I will inspect the build."
        },
        {
          "type": "thinking",
          "signature": "",
          "signatureProvider": "google",
          "thinking": "Read the build output first."
        },
        {
          "type": "tool_use",
          "id": "call-1",
          "name": "Execute",
          "input": {
            "command": "pnpm test"
          }
        }
      ]
    }
  },
  {
    "type": "message",
    "id": "tool-1",
    "parentId": "assistant-1",
    "timestamp": fixtureDay(1) + 'T' + fixtureClock(0, 0, 2, '000') + 'Z',
    "seq": 2,
    "message": {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "call-1",
          "content": [
            {
              "type": "text",
              "text": "One test failed."
            },
            {
              "type": "image",
              "source": {
                "type": "base64",
                "data": "iVBORw==",
                "media_type": "image/png"
              }
            }
          ],
          "is_error": true
        }
      ]
    }
  },
  {
    "type": "message",
    "id": "hook-1",
    "timestamp": fixtureDay(1) + 'T' + fixtureClock(0, 0, 3, '000') + 'Z',
    "seq": 3,
    "message": {
      "role": "user",
      "content": [],
      "visibility": "user_only",
      "hookEventName": "PostToolUse",
      "hookStatus": "completed",
      "hookToolCallId": "call-1",
      "hookResults": [
        {
          "exitCode": 0,
          "stdout": "audit output",
          "stderr": ""
        }
      ]
    }
  },
  {
    "type": "message",
    "id": "injection-1",
    "timestamp": fixtureDay(1) + 'T' + fixtureClock(0, 0, 4, '000') + 'Z',
    "seq": 4,
    "message": {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Provider injected context"
        }
      ],
      "visibility": "llm_only"
    }
  },
  {
    "type": "message",
    "id": "assistant-2",
    "timestamp": fixtureDay(1) + 'T' + fixtureClock(0, 0, 5, '000') + 'Z',
    "seq": 5,
    "message": {
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "The test failed."
        }
      ],
      "chatCompletionReasoningField": "reasoning_content",
      "chatCompletionReasoningContent": "Inspect the assertion."
    }
  },
  {
    "type": "agent_turn_outcome",
    "turnId": "user-1",
    "reason": "completed",
    "resultKind": "text"
  },
  {
    "type": "message",
    "id": "document-1",
    "timestamp": fixtureDay(1) + 'T' + fixtureClock(0, 0, 6, '000') + 'Z',
    "seq": 6,
    "message": {
      "role": "user",
      "content": [
        {
          "type": "document",
          "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": "",
            "parsed_data": "Parsed document excerpt",
            "name": "report.pdf",
            "path": fixturePath('fixture/report.pdf')
          }
        }
      ],
      "visibility": "both",
      "userMessageSource": "cli_tui"
    }
  },
  {
    "type": "compaction_state",
    "id": "compact-1",
    "timestamp": fixtureDay(1) + 'T' + fixtureClock(0, 0, 7, '000') + 'Z',
    "summaryText": "Native summary",
    "summaryTokens": 12,
    "summaryKind": "llm_summary",
    "removedCount": 3,
    "anchorMessage": {
      "id": "assistant-2"
    }
  }
]
  return Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n')
}
