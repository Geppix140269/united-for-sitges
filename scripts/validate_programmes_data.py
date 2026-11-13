#!/usr/bin/env python3
"""Validate the Sitges programme-comparison dataset in /data.

Standard library only. Run from the repository root:

    python3 scripts/validate_programmes_data.py

Exits non-zero if any rule fails. The rules encode the editorial policy in
docs/electoral-research/METHODOLOGY.md (no mixing of election years, every
proposal tied to a catalogued source, consistent missing-information labels).
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
I18N = ROOT / "js" / "programmes-i18n.js"

LANGS = ["en", "ca", "es", "it", "fr", "de", "nl"]
YEARS = {2023, 2027}
EVIDENCE = {
    "VERIFIED_PROGRAMME_PROPOSAL", "VERIFIED_PUBLIC_POLICY_STATEMENT", "HISTORICAL_PROPOSAL",
    "SECONDARY_REPORTING", "NOT_YET_VERIFIED", "NO_VERIFIED_INFORMATION_FOUND",
}
COMMIT = {"commitment", "study", "aspiration"}
COMPETENCE = {"municipal", "shared", "external"}
DOC_TYPES = {"election_programme", "web_programme", "government_agreement", "official_record", "party_statement", "media_report"}
PROG_2023 = {"verified", "partial", "located_unverified", "not_located"}
PROG_2027 = {"verified", "not_verified"}
DATE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")
SHA = re.compile(r"^[0-9a-f]{64}$")

errors = []


def err(msg):
    errors.append(msg)


def load(name):
    with open(DATA / name, encoding="utf-8") as fh:
        return json.load(fh)


def need(obj, fields, where):
    for f in fields:
        if f not in obj or obj[f] in (None, ""):
            err(f"{where}: missing field '{f}'")


def no_em_dash(text, where):
    if "\u2014" in text:
        err(f"{where}: contains an em dash; use a comma, colon or full stop instead")


def main():
    tax = load("taxonomy.json")
    parties = load("parties.json")
    progs = load("programmes.json")
    props = load("proposals.json")

    # taxonomy
    cats = {}
    for c in tax["categories"]:
        need(c, ["id", "name"], f"taxonomy {c.get('id')}")
        for lang in LANGS:
            if not c["name"].get(lang):
                err(f"taxonomy {c['id']}: missing name in '{lang}'")
        cats[c["id"]] = c
    if sorted(cats) != [f"{i:02d}" for i in range(1, 17)]:
        err("taxonomy: categories must be exactly 01..16")

    # parties
    meta = parties.get("meta", {})
    need(meta, ["last_reviewed", "results_source_url", "valid_votes_2023"], "parties.meta")
    pmap = {}
    seats = 0
    for p in parties["parties"]:
        where = f"party {p.get('id')}"
        need(p, ["id", "short_name", "sort_name", "name_2023_official", "abbreviation_2023", "results_2023",
                 "council_status_2026", "programme_2023_status", "programme_2027_status"], where)
        if p["id"] in pmap:
            err(f"{where}: duplicate id")
        pmap[p["id"]] = p
        r = p["results_2023"]
        need(r, ["votes", "seats", "pct"], where + " results_2023")
        seats += r.get("seats", 0)
        expected_pct = round(r["votes"] / meta["valid_votes_2023"] * 100, 2)
        if abs(expected_pct - r["pct"]) > 0.005:
            err(f"{where}: pct {r['pct']} does not match votes/valid votes ({expected_pct})")
        if p["programme_2023_status"] not in PROG_2023:
            err(f"{where}: bad programme_2023_status")
        if p["programme_2027_status"] not in PROG_2027:
            err(f"{where}: bad programme_2027_status")
        for lang in ("en",):
            if not p["council_status_2026"].get(lang):
                err(f"{where}: council_status_2026 needs '{lang}'")
        for it in p.get("status_2027_items", []):
            need(it, ["evidence_label", "text", "source_url", "source_date"], where + " status_2027_item")
            if it.get("evidence_label") not in EVIDENCE:
                err(f"{where}: bad evidence_label in status_2027_items")
            no_em_dash(it["text"].get("en", ""), where)
    if seats != 21:
        err(f"parties: 2023 seats add up to {seats}, expected 21")
    if len(pmap) != 13:
        err(f"parties: expected the 13 candidatures of 2023, found {len(pmap)}")

    # sources
    smap = {}
    for s in progs["sources"]:
        where = f"source {s.get('id')}"
        need(s, ["id", "party_id", "title", "election_year", "document_type", "publisher", "url", "language",
                 "date_verified", "primary", "completeness"], where)
        if s["id"] in smap:
            err(f"{where}: duplicate id")
        smap[s["id"]] = s
        if s["party_id"] not in pmap:
            err(f"{where}: unknown party_id {s['party_id']}")
        if s["election_year"] not in YEARS:
            err(f"{where}: election_year must be 2023 or 2027")
        if s["document_type"] not in DOC_TYPES:
            err(f"{where}: bad document_type")
        if not s["url"].startswith("https://") and not s["url"].startswith("http://"):
            err(f"{where}: url must be absolute")
        if not DATE.match(s["date_verified"]):
            err(f"{where}: bad date_verified")
        if s.get("publication_date") and not DATE.match(s["publication_date"]):
            err(f"{where}: bad publication_date")
        if s.get("sha256") and not SHA.match(s["sha256"]):
            err(f"{where}: bad sha256")
        if s["completeness"] not in {"complete", "partial"}:
            err(f"{where}: completeness must be complete or partial")

    # programme status consistency
    for p in pmap.values():
        has = [s for s in smap.values() if s["party_id"] == p["id"] and s["election_year"] == 2023
               and s["document_type"] in ("election_programme", "web_programme")]
        if p["programme_2023_status"] == "located_unverified" and not p.get("unverified_leads"):
            err(f"party {p['id']}: located_unverified needs unverified_leads")
        if p["programme_2023_status"] in ("not_located", "located_unverified") and has:
            err(f"party {p['id']}: marked not_located but a 2023 programme source exists")
        if p["programme_2023_status"] in ("verified", "partial") and not has:
            err(f"party {p['id']}: marked {p['programme_2023_status']} but no 2023 programme source is catalogued")
        has27 = [s for s in smap.values() if s["party_id"] == p["id"] and s["election_year"] == 2027
                 and s["document_type"] in ("election_programme", "web_programme")]
        if (p["programme_2027_status"] == "verified") != bool(has27):
            err(f"party {p['id']}: programme_2027_status inconsistent with catalogued 2027 sources")

    # proposals
    ids = set()
    for x in props["proposals"]:
        where = f"proposal {x.get('id')}"
        need(x, ["id", "party_id", "election_year", "source_id", "categories", "title_en", "summary_en",
                 "evidence_label", "commitment_type", "competence", "date_verified", "excerpt_original",
                 "excerpt_lang"], where)
        if x["id"] in ids:
            err(f"{where}: duplicate id")
        ids.add(x["id"])
        if x["party_id"] not in pmap:
            err(f"{where}: unknown party")
        src = smap.get(x["source_id"])
        if not src:
            err(f"{where}: unknown source_id {x['source_id']}")
            continue
        if src["party_id"] != x["party_id"]:
            err(f"{where}: source belongs to another party")
        if x["election_year"] != src["election_year"]:
            err(f"{where}: election_year {x['election_year']} differs from its source ({src['election_year']})")
        is_programme = src["document_type"] in ("election_programme", "web_programme")
        if src["document_type"] == "media_report" and x["evidence_label"] != "SECONDARY_REPORTING":
            err(f"{where}: items from media reports must be labelled SECONDARY_REPORTING")
        if x["election_year"] == 2023 and is_programme and x["evidence_label"] != "HISTORICAL_PROPOSAL":
            err(f"{where}: 2023 programme items must be labelled HISTORICAL_PROPOSAL")
        if x["election_year"] == 2027 and x["evidence_label"] == "HISTORICAL_PROPOSAL":
            err(f"{where}: 2027 items cannot be HISTORICAL_PROPOSAL")
        if x["evidence_label"] not in EVIDENCE:
            err(f"{where}: bad evidence_label")
        if x["commitment_type"] not in COMMIT:
            err(f"{where}: bad commitment_type")
        if x["competence"] not in COMPETENCE:
            err(f"{where}: bad competence")
        if x["competence"] != "municipal" and not x.get("competence_note"):
            err(f"{where}: non-municipal competence needs competence_note")
        if not x["categories"] or any(c not in cats for c in x["categories"]):
            err(f"{where}: bad categories {x['categories']}")
        if len(set(x["categories"])) != len(x["categories"]):
            err(f"{where}: duplicate categories")
        if not DATE.match(x["date_verified"]):
            err(f"{where}: bad date_verified")
        if len(x["excerpt_original"].split()) > 45:
            err(f"{where}: excerpt longer than 45 words (keep quotations short)")
        if len(x["summary_en"]) > 420:
            err(f"{where}: summary longer than 420 characters")
        if not x.get("source_page") and not x.get("source_section"):
            err(f"{where}: needs source_page or source_section")
        for f in ("title_en", "summary_en"):
            no_em_dash(x[f], where)

    # every party with a catalogued programme should have at least one proposal or a review note
    for p in pmap.values():
        if p["programme_2023_status"] in ("verified", "partial"):
            n = sum(1 for x in props["proposals"] if x["party_id"] == p["id"])
            if n == 0 and not p.get("extraction_note"):
                err(f"party {p['id']}: programme located but no proposals and no extraction_note")

    # i18n key parity
    text = I18N.read_text(encoding="utf-8")
    blocks = re.split(r"\n(en|ca|es|it|fr|de|nl): \{", text)
    keys = {}
    for i in range(1, len(blocks), 2):
        keys[blocks[i]] = set(re.findall(r'(?:^[ \t]*|",[ \t]*)([A-Za-z0-9_]+): "', blocks[i + 1], re.M))
    if set(keys) != set(LANGS):
        err(f"i18n: languages found {sorted(keys)}")
    else:
        for lang in LANGS:
            missing = keys["en"] - keys[lang]
            if missing:
                err(f"i18n {lang}: missing keys {sorted(missing)}")

    n_props = len(props["proposals"])
    if errors:
        print(f"FAILED with {len(errors)} error(s):")
        for e in errors:
            print(" -", e)
        return 1
    print(f"OK: {len(pmap)} parties, {len(smap)} sources, {n_props} proposals, 16 categories, {len(LANGS)} languages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
