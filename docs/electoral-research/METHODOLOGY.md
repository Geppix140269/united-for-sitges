# Methodology: Sitges programme comparison

United for Sitges is an independent, nonpartisan civic information project. This document explains how the programme comparison on `/programmes.html` is researched, structured and published. It is the editorial rulebook; `scripts/validate_programmes_data.py` enforces the parts that can be checked automatically.

## 1. Scope

The comparison covers the political parties and local movements relevant to the Sitges municipal elections:

- the 13 candidatures officially recorded for the 28 May 2023 election (BOE-A-2023-18101, Junta Electoral Central, BOE no. 187 of 7 August 2023, page 116996);
- any organisation that verifiably announces a candidature for the 23 May 2027 election (added when evidence exists).

Being listed does not mean an organisation will stand in 2027. Official 2027 candidatures only exist once the electoral authorities publish them.

## 2. Types of evidence (never silently combined)

| Evidence type | Label in the data (`evidence_label`) | Year | Typical source |
|---|---|---|---|
| Proposal in a 2023 election programme | `HISTORICAL_PROPOSAL` | 2023 | Party programme PDF or web page |
| Proposal in a verified 2027 election programme | `VERIFIED_PROGRAMME_PROPOSAL` | 2027 | Party programme |
| Attributable public policy statement | `VERIFIED_PUBLIC_POLICY_STATEMENT` | year of statement | Party website, signed statement, official record |
| Proposal known only through media reporting | `SECONDARY_REPORTING` | year of report | Local media (e.g. Ràdio Maricel, Eix Diari) |
| Claim not yet checked | `NOT_YET_VERIFIED` | any | Never shown as a proposal |
| Searched and nothing found | `NO_VERIFIED_INFORMATION_FOUND` | any | Party-level status |

Additional source types catalogued in `data/programmes.json` (`document_type`): `election_programme`, `web_programme`, `government_agreement`, `official_record`, `party_statement`, `media_report`.

Rules:

1. A 2023 programme is historical evidence. It is never presented as a 2027 position.
2. A party's `programme_2027_status` stays `not_verified` until a 2027 programme document is catalogued.
3. Media reports are labelled as secondary on every item and never relabelled as programme proposals.
4. Government agreements, council motions and voting records are separate evidence types and, if added, must be catalogued as their own sources.
5. Where two sources conflict, both are kept and the conflict is recorded in `review_notes` and in `RESEARCH_STATUS.md`.

## 3. Taxonomy

All organisations are classified with the same 16 categories in `data/taxonomy.json` (01 Economic development to 16 Other local priorities). A proposal can carry several categories; the first is its primary category. Proposals are not forced into a category that does not fit; category 16 holds documented areas not covered elsewhere (for example animal welfare).

Each proposal also records:

- `commitment_type`: `commitment` (a stated action), `study` (a commitment to study or review), or `aspiration` (a general aim or a position reported by media);
- `competence`: `municipal`, `shared` or `external`, with a `competence_note` when the measure depends on the Generalitat, the Spanish state or another body. Competence notes describe who formally decides; they are not a judgement on feasibility.

## 4. Writing summaries

Each summary is an original, short editorial description in English. It must:

- be faithful to the source and preserve numbers, amounts and dates exactly;
- distinguish a commitment from an aim or a study ("study", "aim to", "reported support for");
- attribute party claims about their own record to the party ("the party states");
- avoid loaded or emotive words, value judgements, endorsements and invented details;
- not use em dashes (house style).

A short verbatim excerpt in the original language (maximum 45 words) is stored in `excerpt_original` so readers can check the wording. Complete programmes are never reproduced; readers are linked to the original.

Every excerpt in the first release was checked by script against the text of the source (PDF page text or archived article text) on the page stated in `source_page`.

## 5. Selection

Programmes are long. The dataset records a representative selection of concrete, checkable proposals per party and subject, favouring specific measures over general statements. The coverage table on the page shows exactly what has been recorded. A zero in the table means "not recorded", never "the party has no position" or "the party opposes it".

The same selection rules apply to every party. Parties with longer programmes may have more items recorded; this reflects the length of their documents, not editorial preference.

## 6. Neutral presentation

- Default order is alphabetical. An optional order by 2023 votes is labelled as a historical fact.
- All parties share the same neutral visual treatment (same monogram style, no party colours or logos).
- No scores, rankings, matching quizzes or voting advice.
- Missing information is labelled in one consistent way: "No 2023 programme located" or "No proposal on this subject recorded".

## 7. Languages

The interface is available in English, Catalan, Spanish, Italian, French, German and Dutch. Proposal summaries are in English only in this release; every proposal shows the original Catalan or Spanish excerpt and links to the original. Summaries are not machine-translated, to avoid changing the substance of commitments. Party names and document titles are never translated.

## 8. Corrections

Parties, candidates and residents can send corrections to the project contact address (shown on the page). A correction is applied only when supported by a verifiable source. Every change is recorded in `RESEARCH_STATUS.md` (change log). No party is contacted by the project without the organiser's approval.

## 9. Legal and copyright

Programme documents are linked, not republished. Reference copies downloaded during research are kept outside the repository; their SHA-256 hashes are recorded in `data/programmes.json` so that the exact version consulted can be identified later.
