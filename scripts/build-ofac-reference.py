#!/usr/bin/env python3
"""Build reference/ofac-sdn-NN.yml (SanctionsListShard records) from an OFAC SDN XML export.

Usage:
    scripts/build-ofac-reference.py ~/Downloads/sdn.xml

Download sdn.xml from https://www.treasury.gov/ofac/downloads/sdn.xml (or the
Sanctions List Service). Re-run whenever OFAC publishes, then refresh the realm:
shards are keyed on shardId, so re-seeding replaces rather than duplicating.

Parsing mirrors OfacSanctionsXmlProvider in the meta-agent kycdemo: names, aliases,
countries (address + id countries), addresses, identifiers, date of birth, programs.
Two deliberate differences:
- primary names come from the entry's OWN firstName/lastName, not the first
  descendant (which could be an alias's);
- country names are normalized to ISO 3166 alpha-2 here, once, so the handler
  compares codes rather than display names.
"""
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

SOURCE_URL = "https://ofac.treasury.gov/sanctions-list-service"
OUT_DIR = Path(__file__).resolve().parent.parent / "reference"
SHARD_ENTRIES = 50  # ~35KB per shard; see build_shards for why the list is sharded at all

# Must match NOISE_WORDS in wasm/handlers.js (ScreeningMatchingPolicy.noiseWords).
NOISE_WORDS = {"limited", "ltd", "inc", "corp", "corporation", "company", "co", "plc", "llc"}

# OFAC country spellings -> ISO 3166-1 alpha-2. Anything unmapped (e.g. "REGION: CRIMEA")
# is kept in `countries` but contributes no code.
COUNTRY_CODES = {
    "AFGHANISTAN": "AF", "ALBANIA": "AL", "ALGERIA": "DZ", "ANGOLA": "AO", "ANTIGUA AND BARBUDA": "AG",
    "ARGENTINA": "AR", "ARMENIA": "AM", "ARUBA": "AW", "AUSTRALIA": "AU", "AUSTRIA": "AT",
    "AZERBAIJAN": "AZ", "BAHAMAS, THE": "BS", "BAHAMAS": "BS", "BAHRAIN": "BH", "BANGLADESH": "BD",
    "BARBADOS": "BB", "BELARUS": "BY", "BELGIUM": "BE", "BELIZE": "BZ", "BENIN": "BJ", "BERMUDA": "BM",
    "BOLIVIA": "BO", "BOSNIA AND HERZEGOVINA": "BA", "BRAZIL": "BR", "BULGARIA": "BG",
    "BURKINA FASO": "BF", "BURMA": "MM", "MYANMAR": "MM", "CABO VERDE": "CV", "CAMBODIA": "KH",
    "CAMEROON": "CM", "CANADA": "CA", "CAYMAN ISLANDS": "KY", "CENTRAL AFRICAN REPUBLIC": "CF",
    "CHAD": "TD", "CHILE": "CL", "CHINA": "CN", "COLOMBIA": "CO", "COMOROS": "KM",
    "CONGO, DEMOCRATIC REPUBLIC OF THE": "CD", "CONGO, REPUBLIC OF THE": "CG", "COSTA RICA": "CR",
    "COTE D IVOIRE": "CI", "CROATIA": "HR", "CUBA": "CU", "CYPRUS": "CY", "CZECH REPUBLIC": "CZ",
    "CZECHIA": "CZ", "DENMARK": "DK", "DJIBOUTI": "DJ", "DOMINICA": "DM", "DOMINICAN REPUBLIC": "DO",
    "ECUADOR": "EC", "EGYPT": "EG", "EL SALVADOR": "SV", "EQUATORIAL GUINEA": "GQ", "ERITREA": "ER",
    "ESTONIA": "EE", "ETHIOPIA": "ET", "FIJI": "FJ", "FINLAND": "FI", "FRANCE": "FR", "GEORGIA": "GE",
    "GERMANY": "DE", "GHANA": "GH", "GIBRALTAR": "GI", "GREECE": "GR", "GUATEMALA": "GT",
    "GUINEA": "GN", "GUINEA-BISSAU": "GW", "GUYANA": "GY", "HAITI": "HT", "HONDURAS": "HN",
    "HONG KONG": "HK", "HUNGARY": "HU", "ICELAND": "IS", "INDIA": "IN", "INDONESIA": "ID",
    "IRAN": "IR", "IRAQ": "IQ", "IRELAND": "IE", "ISRAEL": "IL", "ITALY": "IT", "JAMAICA": "JM",
    "JAPAN": "JP", "JERSEY": "JE", "JORDAN": "JO", "KAZAKHSTAN": "KZ", "KENYA": "KE",
    "KOREA, NORTH": "KP", "KOREA, SOUTH": "KR", "KOSOVO": "XK", "KUWAIT": "KW", "KYRGYZSTAN": "KG",
    "LAOS": "LA", "LATVIA": "LV", "LEBANON": "LB", "LIBERIA": "LR", "LIBYA": "LY",
    "LIECHTENSTEIN": "LI", "LITHUANIA": "LT", "LUXEMBOURG": "LU", "MACAU": "MO", "MALAYSIA": "MY",
    "MALDIVES": "MV", "MALI": "ML", "MALTA": "MT", "MAN, ISLE OF": "IM", "MARSHALL ISLANDS": "MH",
    "MAURITANIA": "MR", "MAURITIUS": "MU", "MEXICO": "MX", "MOLDOVA": "MD", "MONACO": "MC",
    "MONGOLIA": "MN", "MONTENEGRO": "ME", "MOROCCO": "MA", "MOZAMBIQUE": "MZ", "NAMIBIA": "NA",
    "NETHERLANDS": "NL", "NETHERLANDS ANTILLES": "AN", "NEW ZEALAND": "NZ", "NICARAGUA": "NI",
    "NIGER": "NE", "NIGERIA": "NG", "NORTH MACEDONIA, THE REPUBLIC OF": "MK", "NORTH MACEDONIA": "MK",
    "NORWAY": "NO", "OMAN": "OM", "PAKISTAN": "PK", "PALAU": "PW", "PALESTINIAN": "PS", "PANAMA": "PA",
    "PARAGUAY": "PY", "PERU": "PE", "PHILIPPINES": "PH", "POLAND": "PL", "PORTUGAL": "PT",
    "QATAR": "QA", "ROMANIA": "RO", "RUSSIA": "RU", "RWANDA": "RW", "SAINT KITTS AND NEVIS": "KN",
    "SAINT VINCENT AND THE GRENADINES": "VC", "SAMOA": "WS", "SAN MARINO": "SM",
    "SAUDI ARABIA": "SA", "SENEGAL": "SN", "SERBIA": "RS", "SEYCHELLES": "SC", "SIERRA LEONE": "SL",
    "SINGAPORE": "SG", "SLOVAKIA": "SK", "SLOVENIA": "SI", "SOMALIA": "SO", "SOUTH AFRICA": "ZA",
    "SOUTH SUDAN": "SS", "SPAIN": "ES", "SRI LANKA": "LK", "SUDAN": "SD", "SURINAME": "SR",
    "SWEDEN": "SE", "SWITZERLAND": "CH", "SYRIA": "SY", "TAIWAN": "TW", "TAJIKISTAN": "TJ",
    "TANZANIA": "TZ", "THAILAND": "TH", "THE GAMBIA": "GM", "GAMBIA": "GM", "TOGO": "TG",
    "TRINIDAD AND TOBAGO": "TT", "TUNISIA": "TN", "TURKEY": "TR", "TURKIYE": "TR",
    "TURKMENISTAN": "TM", "UGANDA": "UG", "UKRAINE": "UA", "UNITED ARAB EMIRATES": "AE",
    "UNITED KINGDOM": "GB", "UNITED STATES": "US", "URUGUAY": "UY", "UZBEKISTAN": "UZ",
    "VANUATU": "VU", "VENEZUELA": "VE", "VIETNAM": "VN", "VIRGIN ISLANDS, BRITISH": "VG",
    "WEST BANK": "PS", "YEMEN": "YE", "ZAMBIA": "ZM", "ZIMBABWE": "ZW",
}

ID_TYPES = {
    "passport": "PASSPORT",
    "national id": "NATIONAL_ID", "national_id": "NATIONAL_ID", "nationalid": "NATIONAL_ID",
    "tax id": "TAX_ID", "tax_id": "TAX_ID", "taxid": "TAX_ID",
    "registration number": "COMPANY_REGISTRATION_NUMBER", "registration_number": "COMPANY_REGISTRATION_NUMBER",
    "company registration number": "COMPANY_REGISTRATION_NUMBER", "registration id": "COMPANY_REGISTRATION_NUMBER",
    "certificate of incorporation number": "COMPANY_REGISTRATION_NUMBER",
}


def local(tag):
    return tag.rsplit("}", 1)[-1]


def child(el, name):
    for c in el:
        if local(c.tag) == name:
            return c
    return None


def text(el, name):
    c = child(el, name) if el is not None else None
    return c.text.strip() if c is not None and c.text and c.text.strip() else None


def descendants_text(el, name):
    return [d.text.strip() for d in el.iter() if local(d.tag) == name and d.text and d.text.strip()]


def full_name(el):
    return " ".join(x for x in (text(el, "firstName"), text(el, "lastName")) if x).strip()


def name_tokens(name):
    s = unicodedata.normalize("NFD", name)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9\s]+", " ", s)
    return [t for t in s.split() if t and t not in NOISE_WORDS]


def parse_entry(e, publish_date):
    primary = full_name(e)
    if not primary:
        return None
    uid = text(e, "uid")
    aliases = []
    for aka in e.iter():
        if local(aka.tag) == "aka":
            n = full_name(aka)
            if n and n != primary and n not in aliases:
                aliases.append(n)
    tokens = []
    norm_names = []
    for n in [primary] + aliases:
        name_toks = []
        for t in name_tokens(n):
            if t not in name_toks:
                name_toks.append(t)
            if t not in tokens:
                tokens.append(t)
        norm_names.append(" ".join(name_toks))
    countries = sorted({c.upper() for c in descendants_text(e, "country") + descendants_text(e, "idCountry")})
    codes = sorted({COUNTRY_CODES[c] for c in countries if c in COUNTRY_CODES})
    addresses = []
    for a in e.iter():
        if local(a.tag) == "address":
            parts = [text(a, f) for f in ("address1", "address2", "address3", "city", "stateOrProvince", "postalCode", "country")]
            line = ", ".join(p for p in parts if p)
            if line and line not in addresses:
                addresses.append(line)
    identifiers = []
    for i in e.iter():
        if local(i.tag) == "id":
            value = text(i, "idNumber")
            if not value:
                continue
            id_type = ID_TYPES.get((text(i, "idType") or "").lower(), "OTHER")
            country = COUNTRY_CODES.get((text(i, "idCountry") or "").upper(), (text(i, "idCountry") or "").upper())
            identifiers.append(f"{id_type}:{country}:{re.sub(r'[^A-Z0-9]', '', value.upper())}")
    dobs = descendants_text(e, "dateOfBirth")
    sdn_type = text(e, "sdnType") or ""
    return {
        "entryId": f"OFAC:{uid}",
        "source": "OFAC_SANCTIONS",
        "sourceRecordId": uid,
        "name": primary,
        "sdnType": sdn_type,
        "subjectType": "LEGAL_ENTITY" if sdn_type.lower() == "entity" else "PERSON",
        "aliases": " | ".join(aliases),
        "nameTokens": " " + " ".join(tokens) + " ",
        # Each name (primary first, then aliases) already tokenized exactly as the matcher does it,
        # so screening ~10k records skips Unicode normalization for every one of them.
        "normNames": "|".join(norm_names),
        "countries": " | ".join(countries),
        "countryCodes": " ".join(codes),
        "addresses": " | ".join(addresses),
        "identifiers": " ".join(identifiers),
        "dateOfBirth": dobs[0] if dobs else "",
        "programs": " ".join(descendants_text(e, "program")),
        "sourceUrl": SOURCE_URL,
        "listPublished": publish_date,
    }


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = ET.parse(sys.argv[1]).getroot()
    publish = next((d.text.strip() for d in root.iter() if local(d.tag) == "Publish_Date" and d.text), "")
    records = [r for e in root if local(e.tag) == "sdnEntry" for r in [parse_entry(e, publish)] if r]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("ofac-sdn*.yml"):
        old.unlink()
    shards = build_shards(records, publish)
    # One file per few shards keeps each YAML file well under the host loader's size limit.
    per_file = 20
    files = [shards[i:i + per_file] for i in range(0, len(shards), per_file)]
    for n, chunk in enumerate(files, 1):
        with (OUT_DIR / f"ofac-sdn-{n:02d}.yml").open("w") as f:
            f.write(f"# GENERATED by scripts/build-ofac-reference.py from OFAC SDN list published {publish}\n")
            f.write(f"# (file {n} of {len(files)}). Do not edit by hand; re-run the script against a newer sdn.xml.\n")
            yaml.safe_dump(chunk, f, sort_keys=False, allow_unicode=True, width=10_000)
    by_type = {}
    for r in records:
        by_type[r["subjectType"]] = by_type.get(r["subjectType"], 0) + 1
    print(f"wrote {len(records)} entries ({by_type}) as {len(shards)} shards in {len(files)} files under {OUT_DIR}, "
          f"list published {publish}; largest shard {max(len(s['data']['entriesJson']) for s in shards):,} bytes")


def build_shards(records, publish):
    """Group entries into SanctionsListShard records.

    Why shards and not one node per entry: the appliance upserts a reference record with a
    label scan, so 19k entry nodes seed quadratically (~an hour, repeated on every world
    rebuild), while a few hundred shard nodes seed in seconds. The screening lens reads every
    shard of the subject's type, so shard size only affects seeding, never what is screened.
    `tokens` (the union of the shard's name tokens) is kept for ad-hoc Cypher over the list.
    """
    shards = []
    for subject_type in ("LEGAL_ENTITY", "PERSON"):
        group = [r for r in records if r["subjectType"] == subject_type]
        for i in range(0, len(group), SHARD_ENTRIES):
            entries = group[i:i + SHARD_ENTRIES]
            tokens = sorted({t for e in entries for t in e["nameTokens"].split()})
            n = len([s for s in shards if s["data"]["subjectType"] == subject_type]) + 1
            shards.append({
                "type": "SanctionsListShard",
                "data": {
                    "shardId": f"OFAC:{subject_type}:{n:02d}",
                    "source": "OFAC_SANCTIONS",
                    "subjectType": subject_type,
                    "listPublished": publish,
                    "entryCount": len(entries),
                    "tokens": " " + " ".join(tokens) + " ",
                    "entriesJson": json.dumps([{k: v for k, v in e.items() if k != "nameTokens"} for e in entries],
                                              separators=(",", ":"), ensure_ascii=False),
                },
            })
    return shards

if __name__ == "__main__":
    main()
