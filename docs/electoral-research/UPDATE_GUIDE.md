# Update guide: adding 2027 programmes and corrections

This guide is for whoever maintains the comparison in future sessions. Read `METHODOLOGY.md` first.

## Files

| File | Contents |
|---|---|
| `data/taxonomy.json` | The 16 categories (names in 7 languages). Change rarely. |
| `data/parties.json` | One record per organisation: 2023 ballot name and result, council status, programme status per election, verified 2027 status items. `meta.last_reviewed` is the date shown on the page. |
| `data/programmes.json` | Source catalogue: every document or article used, with URL, language, pages, dates and SHA-256. |
| `data/proposals.json` | One record per proposal, linked to a party and a source. |
| `js/programmes-i18n.js` | Interface text in 7 languages. |
| `scripts/validate_programmes_data.py` | Validation. Must pass before any commit. |

## When a party publishes its 2027 programme

1. **Verify the document.** It must come from the party itself (official website, signed PDF, official social account). Download a reference copy outside the repository and compute its hash: `sha256sum file.pdf`.
2. **Catalogue it** in `data/programmes.json` with a new id, for example `junts-2027-programme-ca`, `election_year: 2027`, `document_type: "election_programme"`, `date_verified` set to today.
3. **Do not edit or delete the 2023 records.** 2023 proposals stay as historical evidence.
4. **Update the party** in `data/parties.json`: set `programme_2027_status` to `"verified"`.
5. **Extract proposals** into `data/proposals.json` with `election_year: 2027` and `evidence_label: "VERIFIED_PROGRAMME_PROPOSAL"`. Use ids like `junts-2027-001`. Follow the summary rules in `METHODOLOGY.md` section 4. Check each excerpt against the document text.
6. **Update `meta.last_reviewed`** in `data/parties.json`.
7. **Record the change** in `RESEARCH_STATUS.md` (coverage table and change log) and add the source to `SOURCES.md`.
8. **Run the validator**: `python3 scripts/validate_programmes_data.py`.

When the first 2027 programmes are added, the page will need a 2027 explorer (the current interactive views are built for the 2023 archive; the 2027 view lists verification status). The rendering functions in `js/programmes.js` already take the election year as a parameter (`proposalsFor(party, cat, year)`), so the 2027 view can reuse the subject, party and side-by-side renderers with `year = 2027`. Keep the two years in separate views.

## When a party or candidate announces something for 2027 (not a programme)

Add an item to that party's `status_2027_items` in `data/parties.json`:

```json
{
  "evidence_label": "SECONDARY_REPORTING",
  "text": { "en": "Short neutral description of the announcement." },
  "source_url": "https://...",
  "source_date": "2026-05-16"
}
```

Use `VERIFIED_PUBLIC_POLICY_STATEMENT` only when the source is the party itself. A candidacy announcement is not a programme and does not change `programme_2027_status`.

## When a new organisation appears

Add it to `data/parties.json` with `results_2023` set to zeros and a note that it did not stand in 2023. Update the validator's expected count of organisations (currently 13) and the 21-seat check only applies to 2023 results.

## When official candidatures are published (spring 2027)

The Junta Electoral publishes proclaimed candidatures in the Butlletí Oficial de la Província de Barcelona. Record the official 2027 ballot name in a new field (for example `name_2027_official`) with the BOPB reference, and do not change `name_2023_official`.

## Corrections

1. Check the evidence supplied. No source, no change.
2. If a summary is wrong, fix it and add a line to `review_notes` explaining what changed and why.
3. If a source URL breaks, keep the record, set a note in `notes_public`, and look for an official mirror. Do not delete evidence.
4. Log every correction in `RESEARCH_STATUS.md`.

## Before publishing

- `python3 scripts/validate_programmes_data.py` passes.
- Open `/programmes.html` locally (`python3 -m http.server` from the repository root) and check the subject, party and side-by-side views, the 2027 view, mobile width and at least two languages.
- Nothing is merged to `main` or deployed without the organiser's approval.
