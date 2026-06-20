#!/usr/bin/env python3
"""
Fetch NAEP (National Assessment of Educational Progress) data from the
NAEP Data Service API and produce JSON files for the neighborhood map.

Data sources:
  - NAEP Data Service API: https://www.nationsreportcard.gov/api_documentation.aspx
  - Subjects: Mathematics, Reading, Science (where available at state level)
  - Grades: 4, 8
  - StatTypes: Mean scores, achievement level percentages, percentiles

Output: data/naep_states.json — all-state NAEP data with modality scores
"""

import json
import sys
import time
import urllib.request
import urllib.error

BASE_URL = "https://www.nationsreportcard.gov/DataService/GetAdhocData.aspx"

ALL_STATES = (
    "AL,AK,AZ,AR,CA,CO,CT,DE,DC,FL,GA,HI,ID,IL,IN,IA,KS,KY,LA,ME,"
    "MD,MA,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,"
    "SC,SD,TN,TX,UT,VT,VA,WA,WV,WI,WY"
)

TUDA_DISTRICTS = (
    "XQ,XA,XU,XM,XB,XT,XC,XX,XV,XS,XY,XR,XW,XE,XZ,XF,XG,XO,XH,"
    "XJ,XL,XI,XK,XN,XP,XD,YA"
)

# Queries to run: (label, subject, grade, subscale, year, stattype)
QUERIES = [
    # Grade 8 Math & Reading 2024
    ("math_8_2024_mean", "mathematics", 8, "MRPCM", 2024, "MN:MN"),
    ("reading_8_2024_mean", "reading", 8, "RRPCM", 2024, "MN:MN"),
    # Grade 4 Math & Reading 2024
    ("math_4_2024_mean", "mathematics", 4, "MRPCM", 2024, "MN:MN"),
    ("reading_4_2024_mean", "reading", 4, "RRPCM", 2024, "MN:MN"),
    # Achievement level distributions - Grade 8
    ("math_8_2024_below_basic", "mathematics", 8, "MRPCM", 2024, "ALC:BB"),
    ("math_8_2024_at_above_prof", "mathematics", 8, "MRPCM", 2024, "ALC:AP"),
    ("reading_8_2024_below_basic", "reading", 8, "RRPCM", 2024, "ALC:BB"),
    ("reading_8_2024_at_above_prof", "reading", 8, "RRPCM", 2024, "ALC:AP"),
    # Achievement level distributions - Grade 4
    ("math_4_2024_below_basic", "mathematics", 4, "MRPCM", 2024, "ALC:BB"),
    ("math_4_2024_at_above_prof", "mathematics", 4, "MRPCM", 2024, "ALC:AP"),
    ("reading_4_2024_below_basic", "reading", 4, "RRPCM", 2024, "ALC:BB"),
    ("reading_4_2024_at_above_prof", "reading", 4, "RRPCM", 2024, "ALC:AP"),
    # Percentiles for Grade 8 - shows distribution shape
    ("math_8_2024_p10", "mathematics", 8, "MRPCM", 2024, "PC:P1"),
    ("math_8_2024_p90", "mathematics", 8, "MRPCM", 2024, "PC:P9"),
    ("reading_8_2024_p10", "reading", 8, "RRPCM", 2024, "PC:P1"),
    ("reading_8_2024_p90", "reading", 8, "RRPCM", 2024, "PC:P9"),
    # Science Grade 8 (2019 is last year with state data)
    ("science_8_2019_mean", "science", 8, "SRPUV", 2019, "MN:MN"),
    # Historical for trend: Grade 8 Math 2019
    ("math_8_2019_mean", "mathematics", 8, "MRPCM", 2019, "MN:MN"),
    ("reading_8_2019_mean", "reading", 8, "RRPCM", 2019, "MN:MN"),
]


def fetch(subject, grade, subscale, jurisdiction, stattype, year, variable="TOTAL"):
    params = {
        "type": "data",
        "subject": subject,
        "grade": grade,
        "subscale": subscale,
        "variable": variable,
        "jurisdiction": jurisdiction,
        "stattype": stattype,
        "Year": year,
    }
    query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{BASE_URL}?{query}"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = json.loads(resp.read().decode())
                if data.get("status") == 200:
                    return data.get("result", [])
                return []
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  Retry {attempt+1}/3: {e}", file=sys.stderr)
            time.sleep(2)
    return []


def main():
    all_data = {}

    for label, subject, grade, subscale, year, stattype in QUERIES:
        print(f"Fetching {label}...")
        # Fetch states
        results = fetch(subject, grade, subscale, f"NT,NP,{ALL_STATES}", stattype, year)
        time.sleep(0.5)

        for r in results:
            jur = r["jurisdiction"]
            val = r["value"]
            # Skip suppressed data (999.0)
            if val == 999.0 or not r.get("isStatDisplayable"):
                continue
            if jur not in all_data:
                all_data[jur] = {"jurisdiction": jur, "label": r["jurisLabel"]}
            all_data[jur][label] = round(val, 2)

    # Fetch TUDA district data for math and reading
    print("Fetching TUDA district data...")
    for label, subject, grade, subscale, year, stattype in QUERIES[:4]:
        tuda_label = label.replace("_mean", "_tuda_mean")
        results = fetch(subject, grade, subscale, TUDA_DISTRICTS, stattype, year)
        time.sleep(0.5)
        for r in results:
            jur = r["jurisdiction"]
            val = r["value"]
            if val == 999.0 or not r.get("isStatDisplayable"):
                continue
            if jur not in all_data:
                all_data[jur] = {"jurisdiction": jur, "label": r["jurisLabel"]}
            all_data[jur][label] = round(val, 2)

    # Write output
    output = {
        "metadata": {
            "source": "NAEP Data Service API",
            "url": "https://www.nationsreportcard.gov/api_documentation.aspx",
            "fetched": time.strftime("%Y-%m-%d"),
            "description": "NAEP state and district level assessment data for Natural Learning Modality analysis",
        },
        "states": all_data,
    }

    outpath = "data/naep_states.json"
    with open(outpath, "w") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {len(all_data)} jurisdictions to {outpath}")


if __name__ == "__main__":
    main()
