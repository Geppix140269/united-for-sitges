# Community Agent: Editorial policy for automated publishing

Applies to scheduled editorial posts on United for Sitges channels. Draft for owner approval, 16 November 2026. Live publication stays OFF until the activation checklist is complete and the owner authorises it in writing.

## 1. Purpose and principles

United for Sitges is independent and non-partisan. Automated posts exist to share verified civic information and to invite residents to say what information they need. They never try to change how anyone votes.

Principles: accuracy over volume; neutrality; transparency about AI assistance; no invented facts, voices or events; human control at all times.

## 2. Content categories

Civic information and municipal services; how local government works; official electoral information resources; urban development, planning and public space; mobility, transport and accessibility; tourism and residents; local economy and business; safety and community wellbeing; environment and sustainability; international resident integration; platform updates; neutral invitations to share information needs.

Each category can be switched off in the console. Topics come from the human-maintained topic bank (`data/agent/editorial-topics.json`); the agent does not invent topics.

## 3. Frequency and timing

Two distinct topics per local calendar day: morning (default 09:00 Europe/Madrid, informative) and evening (default 18:00, open question). Each channel receives at most two posts per day, enforced by the database. Times are configurable. A post that misses its window (45 minutes) expires; it is never posted late. Language: English primary, with optional one-sentence Spanish and Catalan summaries per channel preference, no triple-language duplicates.

## 4. Source verification

- Only sources in the approved registry, verified by a person within the configured window (default 90 days) and retrievable at generation time.
- Priority: Ajuntament de Sitges, Generalitat de Catalunya, Spanish Government and electoral authorities (INE, Junta Electoral, BOE), then first-party United for Sitges pages.
- Every factual statement is recorded as a claim with its source and an excerpt found word for word in the retrieved page; numbers must appear in those excerpts.
- Excerpt presence does not prove the meaning of a claim. **All factual posts require explicit moderator approval against the full source** before any real outbound publication. A source-matched draft alone is not eligible for autonomous posting.
- The moderator console requires a confirmation bound to the exact content hash. Edited/replaced content requires fresh review.
- Retrieval timestamp, HTTP status, Last-Modified and a content hash are stored with each post.
- Missing, stale, unreachable or contradictory sources mean the slot is skipped or held for review.

## 5. Neutrality constraints

Never: endorse or criticise a party or candidate; mention parties or candidates in automated posts; compare programmes or candidates; give voting advice; use loaded or partisan language; target any group by political view. Comparative material about parties is only published through the separate, human-reviewed programme comparison process.

## 6. Conditions for autonomous publication

A non-factual discussion post can publish without per-post approval only if all of these hold: channel authorised, verified, not paused, publishing enabled, permissions verified, token valid; category enabled; sources verified and supporting every claim; neutrality gates passed; no personal data; no fabricated voices or human-identity claims; links only from the registry or unitedforsitges.com; not a duplicate of recent content; platform requirements met (Instagram: valid first-party JPEG card); daily and channel limits respected; emergency stop off; the slot not already published; publishing mode AUTONOMOUS with deployment authorisation.

## 7. Exceptional manual review

Held for a person (NEEDS_REVIEW): electoral wording about eligibility, deadlines, requirements or dates; primary language mismatch; model unavailable (manual content required). A moderator can edit or replace content; human content passes the same hard gates, and approval only resolves review-level gates.

## 8. Content expiry and freshness

Source verification expires (default 90 days). Topics are not repeated inside the duplicate window (default 10 days; increase together with the topic bank). Generated content is tied to its slot; skipped slots are not refilled with other topics.

## 9. Prohibited uses

Political persuasion or campaigning; micro-targeting; inferring or storing political views; fake testimonials, fictional residents or artificial conversations; claims of attending events or interviewing people; impersonating a person or institution; posting in third-party groups; direct messages or unsolicited outreach; buying promotion; using engagement data to profile individuals.

## 10. Transparency

Facebook posts carry "Prepared with AI-assisted editorial tools" (with "checked against the sources linked" when sources are cited); Instagram captions carry "Prepared with AI-assisted editorial tools". Images are static branded cards with no generated imagery of people or places.

## 11. Incident response

1. Emergency stop.
2. Remove the post manually on the platform if it is inaccurate, non-neutral or harmful, and publish a correction when appropriate.
3. Record the incident (case or audit note), identify the failed gate or source.
4. Fix the topic, source or rule; add a regression test.
5. Resume only after review. Report notable incidents in the next daily digest.
