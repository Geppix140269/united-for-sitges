# Community Agent: personal-data map, erasure and retention

Engineering record for issue #5, 20 November 2026. This is not legal advice. The lawful bases (Articles 6 and 9 GDPR), the DPIA and the DSAR response process still need qualified review before any live personal-data processing (see `COMMUNITY_AGENT_PRIVACY_REVIEW.md`).

## 1. Where personal data can be stored

All agent data lives in the private Neon schema `ufs_agent` (`neon/agent-schema.sql`). Comment text from Facebook, Instagram or the forum can reach the following places.

| Location | What may contain personal data | Erasure request | Retention (default, `settings.retention`) |
| --- | --- | --- | --- |
| `events.content_excerpt` | the comment or forum text (max 2000 chars) | set to null | redacted after `event_content_days` (90) |
| `events.author_ref` | HMAC of the commenter's platform id (pseudonymous) | set to null | as above |
| `events.permalink` | link to the comment | set to null | as above |
| `events.external_object_id`, `external_parent_id`, `idempotency_key` | platform ids of the comment and its parent | kept (see section 3) | replaced by `purged:<internal id>` after `identifier_days` (400) |
| `cases.summary` | neutral model or rule summary of the comment | `[redacted]`; open cases dismissed | redacted with the event |
| `cases.classification` | labels only (category, risk, rule signals, language) | kept: no text | kept |
| `drafts.proposed_answer` | replies, which may quote or name the person | `[redacted]`; pending or approved drafts become `rejected` | redacted with the event |
| `drafts.source_references`, `validation_notes` | registry links, validation codes | cleared | cleared with the event |
| `actions.payload_text` | reply text queued or sent | `[redacted]`; pending, in-flight, blocked or failed actions are cancelled | redacted with the event |
| `actions.external_target_id` | the commenter's comment id | kept (section 3) | `purged:<id>` after `identifier_days` |
| `actions.external_result_id` | id of OUR published reply | kept so a moderator can find and delete it on the platform | cleared after `identifier_days` |
| `audit_log.detail` of the affected event, case, drafts and actions | edited or approved reply text, moderator notes, reject reasons, comment ids | every value replaced by `[redacted]` except structural keys (case id, action id, fingerprint, category, risk, signals, status, error, attempt, reasons, actor, outcome, our reply id), plus a `_redaction` stamp | rows deleted after `audit_days` (730, never before 365) |
| `digests.body_text` (daily and weekly emails kept locally) | case summaries of high-priority incidents | the summaries are replaced by `[redacted]`, hash recomputed | whole body replaced by `[expired]` after `digest_days` (90) |
| `external_notes.summary` | moderator notes about third-party groups (guidance forbids names) | not linked to a comment; edit or ask for a manual purge | replaced by `[expired]` after `external_note_days` (365) |
| `privacy_suppressions.value` | comment id, or author HMAC for objections | created by the request (section 4) | deleted after `suppression_days` (400) |
| `privacy_requests` | accountability record: internal ids, scope, reason code, counts, timestamps; no text, no platform ids | created by the request | kept as accountability; review with counsel |

Not stored at all: commenter names, raw platform user ids, email addresses, direct messages, data from third-party groups. Editorial content, publications and metrics contain no personal data by design.

## 2. Erasure request (data subject request)

A moderator opens the case and chooses **Erase stored data: this item** or **all items by this author**, with a reason code (`data_subject_request`, `objection`, `legal_request`, `moderator_decision`) and the typed confirmation `ERASE STORED DATA`.

1. `privacy_requests` records the request (no free text).
2. `ufs_agent.process_privacy_request()` runs **in one transaction**:
   - finds the events: one item, or every event with the same author reference on the same channel;
   - inserts suppressions for those comment ids (and for the author, if the reason is an objection and "ignore future comments" was chosen);
   - calls `ufs_agent.redact_events()`, which:
     - cancels outbound actions, including one already claimed by a worker;
     - redacts actions, drafts, cases, events, audit details and digests;
   - stores the counts and writes `privacy_request_completed` to the audit log.
3. If anything fails, the transaction rolls back (nothing is half-redacted), the request is marked `failed` with an error code, and the scheduler's `privacy` job retries it (at most 5 attempts). Moderators can retry from the Privacy tab.
4. Running a completed request again returns its stored result. A new request for already-erased data finds nothing left to change.

Safeguards against races:
- A worker that already holds a reply re-reads the action immediately before the provider call and aborts if it was cancelled or redacted.
- A worker still processing an erased event cannot create a case for it, because the insert is guarded on the event not being redacted.

## 3. What stays, why, and for how long

| Kept | Why | Until |
| --- | --- | --- |
| Comment ids in `events`, `actions` | idempotency (a redelivered webhook must not be stored again) and locating our own replies | `identifier_days` (400) |
| Our reply ids (`external_result_id`) | the moderator may need to delete our reply on the platform | `identifier_days` (400) |
| Fingerprints (SHA-256) of approved texts | accountability: proves which exact text was approved, without keeping the text | with the row |
| Suppression entries | prevent re-ingestion after erasure or objection | `suppression_days` (400) |
| Request record with counts | demonstrate that the request was honoured | to be set with counsel |
| Audit row structure (who, when, what action) | security and accountability; the trigger forbids any other change | `audit_days` (730) |

Changing `identifier_days` or `suppression_days` to below the time Meta may redeliver webhooks (up to 36 hours) would weaken idempotency. Keep them well above that.

## 4. Deleting locally is not deleting on the platform

The agent has **no delete capability** on Facebook, Instagram or the forum, by design.

- **Erasure** removes our local copies only. The original comment stays on the platform under the commenter's control.
- **Our own replies** that were published (the action shows its `external_result_id` until identifier retention) must be removed manually by a moderator on the platform if the request covers them.
- **Forum content** is removed with the existing forum moderation tools. The agent's copy is erased with the request.

## 5. Audit-log rule

`audit_log` is append-only. The single exception is a one-time privacy redaction, checked by the `audit_append_only` trigger:
- only `detail` may change;
- every existing value must stay identical or become `"[redacted]"`;
- no key may be removed or added except the mandatory `_redaction` stamp;
- a row that already has the stamp cannot change again.

Deletes remain impossible for rows younger than 365 days. The worker role has `UPDATE` on `detail` only.

## 6. Retention job

The scheduler's `retention` job runs on every tick, in bounded batches (`batch_size`, default 200 events). It is idempotent: finished rows are skipped and `moreDue` reports a backlog.

1. **Events older than `event_content_days`:** the same `redact_events()` path runs with reason `retention`, so every derived copy goes with the source. Retention does not create suppressions.
2. **Identifiers older than `identifier_days`:** replaced by internal placeholders, on events and on their actions.
3. **Suppressions:** deleted after expiry.
4. **Digests and moderator notes:** replaced by `[expired]` after their retention periods.
5. **Audit rows and metrics:** deleted after `audit_days` and `metrics_days`.

## 7. Tests

`tests/agent/db/privacy.test.js` covers, against the real schema:
- item and author erasure across every table;
- idempotency;
- confirmation and reason codes;
- edits and redeliveries after erasure, and objections;
- queued and in-flight replies;
- the processing race;
- audit and draft restrictions;
- a failed erasure that rolls back and succeeds on retry;
- bounded, idempotent retention, including identifiers, suppressions, digests and notes.

CI runs it on PostgreSQL 18, Neon's major version. The issue mentions 17 because it was written before the move to Neon.

## 8. Open decisions (owner and qualified review)

1. Lawful bases (Art. 6) and the Art. 9 condition for comments that may reveal political opinions; DPIA sign-off.
2. DSAR process: identity verification of the requester, response deadline (one month), how the requester identifies their comment (link or screenshot), and whether access or export requests are also needed. Access export is not implemented.
3. Retention periods in `settings.retention`, and how long `privacy_requests` records are kept.
4. Whether erasure should also hide or delete content on the platform. This would need new Meta permissions (`pages_manage_engagement` hide or delete) and a separate review; it is not implemented.
