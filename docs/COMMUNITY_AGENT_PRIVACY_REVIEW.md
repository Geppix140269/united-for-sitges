# Community Agent: Privacy and GDPR review (draft for qualified review)

Prepared 16 November 2026 for the controller. This is not legal advice. Items marked **DECISION** need the owner and, where noted, a qualified data protection adviser before live processing starts.

## 1. Processing in scope

| Activity | Data | Source | Systems |
| --- | --- | --- | --- |
| Moderation triage of Page comments | comment text excerpt (max 2000 chars), comment and post ids, permalink, HMAC of the commenter's Page-scoped id, timestamps | Meta webhooks for the project's own Page (and Instagram account if connected) | Cloudflare Workers (functions), Neon eu-central-1 Frankfurt (storage) |
| Forum triage | topic/reply/report text, HMAC of member id | existing forum tables (read through a minimal function) | as above |
| AI-assisted classification and draft replies | the excerpt above, sent to the model provider | as above | Anthropic API (if `AGENT_LLM_ENABLED`) |
| Replies (supervised) | approved reply text, target comment id | moderators | Meta Graph API |
| Editorial content | official public web pages (no personal data intended), generated posts | approved source registry | Anthropic API, Meta Graph API |
| Publication analytics | aggregate post metrics (views, reactions, comments count, shares, clicks) | Meta Insights | Neon |
| Audit log | moderator ids, decisions, approved texts | system | Neon |
| Administrative digest and alerts | counts, categories, neutral summaries, links | system | Resend |

Not collected or derived: names of commenters (dropped at ingestion), political affiliation, voting intention, sentiment scores about individuals, profiles of individuals, direct messages, data from third-party groups.

## 2. Special category data (Article 9)

Comments about elections, parties and candidates can reveal political opinions, which are special category data. Assessment:
- The agent does not seek, infer, store or use political opinions as such. Schemas contain no fields for political affiliation or sentiment; the classifier labels the *topic* of a comment (for example `political_discussion`), not the person's view, and only so that such comments are never auto-answered.
- Even so, storing the text of a political comment is processing of data that may reveal political opinions. Plausible conditions: Article 9(2)(e) (data manifestly made public by the data subject, for public Page comments) and, for the forum, explicit consent at registration or 9(2)(e) for approved public posts. **DECISION (qualified review)**: confirm the Article 9 condition for each source, especially for comments that are hidden or deleted by their authors.
- Mitigations: minimal excerpt, pseudonymised author reference, 90-day redaction, no profiling, human review for all political content, no use for targeting, no engagement-based inference.

## 3. Lawful bases (proposed, **DECISION**)

| Purpose | Proposed basis |
| --- | --- |
| Moderating comments on our own channels and keeping the community safe | Art. 6(1)(f) legitimate interests (balancing test below) |
| Answering questions (FAQ and approved replies) | Art. 6(1)(f) |
| Editorial publishing (no personal data intended) | not personal data processing in principle; Art. 6(1)(f) for incidental data |
| Aggregate analytics | Art. 6(1)(f) |
| Audit log of moderator actions | Art. 6(1)(f) and accountability (Art. 5(2)) |

Legitimate interests balancing: people commenting publicly on a civic Page reasonably expect the Page to read and moderate comments; the agent adds automation, so transparency and human review are essential; the excerpt is minimised and pseudonymised; no decision with legal or similarly significant effect is automated (no deletion, banning or hiding is automated), so Article 22 is not engaged.

## 4. International transfers

- Neon: AWS eu-central-1 (Frankfurt). Cloudflare Workers run at the edge location nearest the request (global network); confirm Cloudflare's DPA and SCCs, and consider Cloudflare's EU data localisation options only if required (**DECISION**).
- Anthropic: US-based provider. Requires a Data Processing Addendum with Standard Contractual Clauses and a transfer impact assessment, and confirmation of retention and no-training terms for API data. **DECISION**: sign the DPA before setting `AGENT_LLM_ENABLED=true`.
- Meta: the platform itself; Page operators may be joint controllers for Page Insights (Page Controller Addendum). **DECISION**: confirm acceptance of Meta's Page Insights Controller Addendum.
- Resend: US provider with EU sending region; DPA and SCCs needed. Digest content is designed to exclude personal data.

## 5. DPIA screening

Indicators present: new technology (AI classification), data that may reveal political opinions, monitoring of public interactions, a vulnerable context (election period). Indicators absent: large scale (one small Page and forum), systematic profiling, automated decisions with significant effects, combination of datasets.

Conclusion: two or more EDPB criteria are met (special category data plus innovative technology, in an electoral context), so a **full DPIA is recommended before live processing**. **DECISION (qualified review)**. A DPIA template outline: description, necessity and proportionality, risks (misclassification, chilling effect, leakage of political content, transfer risk), measures (sections 2, 6, 7), residual risk sign-off.

## 6. Data minimisation (implemented)

- Commenter names and raw ids are never stored; author reference is an HMAC with a secret pepper.
- Excerpts capped at 2000 characters; removed comments are stored without text.
- The model receives only the excerpt and channel type, never names or ids.
- Digest emails contain counts, categories and neutral summaries; summaries containing personal data patterns are replaced with a generic description.
- No engagement data at individual level is collected.

## 7. Retention (implemented defaults, configurable)

| Data | Retention | Mechanism |
| --- | --- | --- |
| Event text, author reference, permalink | 90 days | daily retention job redacts in place |
| Cases, drafts, actions (without event text) | kept for accountability | text of rejected/superseded drafts' source references cleared after 90 days |
| Audit log | 730 days (minimum 365 enforced by trigger) | daily deletion |
| Publication metrics | 400 days | daily deletion |
| Digests | until deleted manually | contains no personal data by design |

**DECISION**: confirm these periods.

## 8. Rights, human review and contestation

- Access, erasure and objection requests go to the published contact. The console offers "Redact stored text" per item (clears excerpt, author reference, permalink and summary) and the audit log records the redaction.
- Every automated reply is labelled as automated and states that a person reviews other questions.
- Anyone can ask for a human to review an automated reply; moderators can respond manually. No automated decision affects a person's account.

## 9. Proposed privacy policy amendment (to add to `privacy.html` after review)

> **AI-assisted moderation and editorial tools.** United for Sitges uses software, including an AI model provided by Anthropic, to help moderators sort public comments on our Facebook Page (and Instagram account when connected) and on this forum, to suggest replies, and to prepare informative posts from official public sources. A person reviews every reply except a small set of pre-approved answers to common questions about the platform, which are clearly marked as automated. The software never decides to delete, hide or ban, and never answers questions about voting, elections, parties or candidates by itself.
>
> **What we process.** The text of comments on our own pages (up to 2000 characters), technical identifiers of the comment, and a scrambled reference to the commenter that cannot be turned back into their identity without a secret key. We do not store commenters' names, and we never record or infer anyone's political views, voting intention or other sensitive characteristics.
>
> **Providers and transfers.** Neon (database, EU, Frankfurt), Cloudflare (hosting and server functions), Anthropic (AI model, United States, under Standard Contractual Clauses), Meta (Facebook/Instagram) and Resend (administrative email). [Confirm list after DPAs are signed.]
>
> **Retention.** Comment text is removed after 90 days. Moderation audit records are kept for up to two years. Aggregate post statistics are kept for up to 13 months.
>
> **Your rights.** You can ask us to delete the stored copy of your comment, to have a person review an automated reply, or to object to this processing, by writing to the contact address above.
>
> **AI-assisted posts.** Some of our posts are drafted with AI-assisted editorial tools from official sources and checked automatically against those sources before publication. They are marked as AI-assisted.

## 10. Decisions required before live processing

1. Lawful bases and Article 9 conditions (section 2, 3), with qualified review.
2. Full DPIA completed and signed.
3. DPAs: Anthropic, Resend, Cloudflare, Neon; Meta Page Insights Controller Addendum.
4. Whether Cloudflare's global edge processing is acceptable or EU-only processing is required.
5. Retention periods.
6. Publication of the privacy amendment and a short notice on the Facebook Page About section.
7. Who acts as moderator(s), and a response time commitment for human review.
8. Neon Auth sends verification emails from Neon's shared sender; decide on a custom sender domain.
