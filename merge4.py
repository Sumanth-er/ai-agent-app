import pandas as pd
import numpy as np
import os
import sys
import sqlite3
import json
import re
from datetime import datetime
from collections import defaultdict
from typing import Dict, Optional

try:
    from fuzzywuzzy import fuzz, process
except Exception:
    fuzz = None
    process = None

##############################################################################
# CONFIGURATION
##############################################################################
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
SQLITE_DB_FILE = os.path.join(BASE_DIR, "eeee.db")
SQLITE_TABLE_NAME = "employee_master_data"

REFINED_SKILL_COLUMN = "refined_skill"
LAST_UPDATED_COLUMN = "last_updated"

SKILL_COLUMNS_FOR_REFINED = [
    "Skill",
    "Current Skillset",
    "Primary Competency",
    "Secondary Competency",
]

SKILL_REVERSE_JSON_CANDIDATES = [
    "sqllite_db_code/skills_intent_reverse.json",
    "sqllite_db_code/skill_intents_reverse.json",
]

FUZZY_MATCH_THRESHOLD = 80
ENABLE_REFINED_SKILL_LOGS = True

##############################################################################
# EMPLOYEE ID NORMALIZATION
##############################################################################
def normalize_emp_id(emp_id):
    """
    Convert Employee ID into a consistent string format.
    Example: 12345.0 / "12345" -> "12345"
    """
    if pd.isna(emp_id):
        return None
    try:
        return str(int(float(emp_id)))
    except Exception:
        return str(emp_id).strip()

##############################################################################
# FINAL OUTPUT SCHEMA
##############################################################################
# Columns that come directly (via renaming) from source files, merged per
# employee. These are the fields actually carried in master_records.
SOURCE_TARGET_COLUMNS = [
    "Employee Number", "Employee Name", "Contact", "Grade", "Person Type",
    "Skill", "Current Skillset", "Primary Competency", "Secondary Competency",
    "Relevant Exp", "Total Experience", "TCS Experience (yrs)",
    "AI/ML", "FullStack", "Python", "GenAI", "Depute Branch",
    "Parent IOU Name", "Employee Child IOU", "Location Country",
    "Allocation Status", "Unallocated Reason", "No Of Days Unallocated",
    "Release Date", "Last Project Group Client", "Last Project Type",
    "Overall", "Senior Profiles",
]

# Full final column order in the output (adds the 4 computed columns).
FINAL_COLUMN_ORDER = [
    "Employee Number", "Employee Name", "Contact", "Grade", "Person Type",
    "Skill", "Current Skillset", "Primary Competency", "Secondary Competency",
    "Relevant Exp", "Total Experience", "TCS Experience (yrs)",
    "AI/ML", "FullStack", "Python", "GenAI", "Depute Branch",
    "Parent IOU Name", "Employee Child IOU", "Location Country",
    "Allocation Status", "Available to take Project (Yes/No)",
    "Unallocated Reason", "No Of Days Unallocated",
    "New_Available_Addition", "Future_Release", "Release Date",
    "Last Project Group Client", "Last Project Type",
    "Overall", "Senior Profiles", REFINED_SKILL_COLUMN, LAST_UPDATED_COLUMN, "Source_Files",
]

##############################################################################
# RENAME MAP -- every source column variant seen so far, mapped to its
# target name. Anything not listed here is intentionally dropped (it isn't
# part of the requested consolidated schema).
##############################################################################
RENAME_MAP = {
    "Employee Number": "Employee Number",
    "EMP ID": "Employee Number",

    "Employee Name": "Employee Name",
    "Full Name": "Employee Name",

    "Contact": "Contact",
    "Present Phone No.": "Contact",
    "Phone Number": "Contact",

    "Grade": "Grade",
    "Employee Grade": "Grade",
    "TechSS HC.Employee Grade": "Grade",

    "Person Type": "Person Type",
    "Derived Person Type": "Person Type",

    "Skill": "Skill",
    "Skills": "Skill",
    "Primary Skills": "Skill",

    "Current Skillset": "Current Skillset",
    "Current Skill Set": "Current Skillset",

    "Primary Competency": "Primary Competency",
    "Secondary Competency": "Secondary Competency",

    "Relevant Exp": "Relevant Exp",
    "Relevant Experience": "Relevant Exp",

    "Total Experience": "Total Experience",
    "Total Experience (yrs)": "Total Experience",
    "Total Experience (Yrs)": "Total Experience",
    "Prev Total Exp(in yrs)": "Total Experience",

    "TCS Experience (yrs)": "TCS Experience (yrs)",
    "TCS Exp(in yrs)": "TCS Experience (yrs)",

    "AI/ML": "AI/ML",
    "FullStack": "FullStack",
    "Python": "Python",
    "GenAI": "GenAI",

    "Depute Branch": "Depute Branch",
    "Employee Depute Branch": "Depute Branch",

    "Parent IOU Name": "Parent IOU Name",
    "Employee Parent IOU": "Parent IOU Name",
    "TechSS HC.PIOU Head": "Parent IOU Name",

    "Employee Child IOU": "Employee Child IOU",
    "TechSS HC.SUB IOU head": "Employee Child IOU",

    "Location Country": "Location Country",
    "Base Country Code": "Location Country",
    "Employee Base Country": "Location Country",

    "Allocation Status": "Allocation Status",
    "Unallocated Reason": "Unallocated Reason",
    "No Of Days Unallocated": "No Of Days Unallocated",

    "Release Date": "Release Date",

    "Last Project Group Client": "Last Project Group Client",
    "Last Project Customer": "Last Project Group Client",
    "Group Client Name": "Last Project Group Client",

    "Last Project Type": "Last Project Type",
    "Project Type": "Last Project Type",

    "Overall": "Overall",
    "Senior Profiles": "Senior Profiles",
}

MERGE_COLUMNS = {
    "Skill",
    "Primary Competency",
    "Secondary Competency",
    "Current Skillset",
    "Parent IOU Name",
    "Employee Child IOU",
    "Allocation Status",
    "Unallocated Reason",
    "Location Country",
    "Last Project Group Client",
    "Last Project Type",
}

NUMERIC_COLUMNS = [
    "No Of Days Unallocated",
    "Total Experience",
    "TCS Experience (yrs)",
    "Relevant Exp",
    "Overall",
    "Senior Profiles",
    "AI/ML",
    "FullStack",
    "Python",
    "GenAI",
]


def clean_value(value):
    if pd.isna(value):
        return np.nan
    if isinstance(value, str):
        value = value.strip()
        if value == "":
            return np.nan
    return value


def normalize_text(text):
    if text is None:
        return ""

    text = str(text).strip().lower()
    text = re.sub(r"[-_/]+", " ", text)
    text = re.sub(r"[^a-z0-9+#.\s]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _resolve_reverse_json_path():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    for rel_path in SKILL_REVERSE_JSON_CANDIDATES:
        candidate = os.path.join(base_dir, rel_path)
        if os.path.exists(candidate):
            return candidate
    return None


def load_reverse_skill_mapping():
    mapping = {}
    json_path = _resolve_reverse_json_path()

    if not json_path:
        print("Reverse skill mapping JSON not found; unmatched skills will use LLM fallback.")
        return mapping

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        for alias, canonical_skill in data.items():
            normalized_alias = normalize_text(alias)
            if normalized_alias:
                mapping[normalized_alias] = str(canonical_skill).strip()

        print(f"Loaded {len(mapping):,} reverse skill mappings from {json_path}")
    except Exception as e:
        print(f"Failed loading reverse skill mapping JSON: {e}")

    return mapping


def log_refined_skill(message):
    if ENABLE_REFINED_SKILL_LOGS:
        print(message)


def get_skill_key_llm():
    try:
        llm_gateway_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "llm_gateway")
        if llm_gateway_path not in sys.path:
            sys.path.append(llm_gateway_path)
        from llm_models import LLM
        return LLM.ollama_ubuntu()
    except Exception as e:
        print(f"LLM initialization failed for refined_skill fallback: {e}")
        return None


def generate_skill_key_with_llm(raw_skill, llm):
    if llm is None:
        return None

    prompt = f"""
You are a skill-normalization assistant.
Return only one concise canonical skill key for this skill text.
Rules:
- Output must be plain text only, no explanation.
- Prefer lowercase.
- Keep it short (1 to 4 words).
- Do not include punctuation except +, #, or . when needed (example: c++, .net).

Skill text: {raw_skill}
""".strip()

    try:
        response = llm.invoke(prompt)
        content = getattr(response, "content", str(response))
        content = str(content).strip()
        if not content:
            return None

        content = content.splitlines()[0].strip()
        content = re.sub(r"^[a-z_\- ]{0,20}:\s*", "", content, flags=re.IGNORECASE)
        content = content.strip("`\"' ")
        normalized = normalize_text(content)
        return normalized if normalized else None
    except Exception as e:
        print(f"LLM fallback failed for skill '{raw_skill}': {e}")
        return None


def fuzzy_lookup_skill_key(normalized_skill, reverse_mapping, reverse_aliases):
    if not normalized_skill or not reverse_aliases:
        return None, None, None

    if process is None or fuzz is None:
        return None, None, None

    try:
        best = process.extractOne(
            normalized_skill,
            reverse_aliases,
            scorer=fuzz.token_sort_ratio,
        )
    except Exception:
        return None, None, None

    if not best:
        return None, None, None

    matched_alias, score = best[0], best[1]
    if score >= FUZZY_MATCH_THRESHOLD:
        return reverse_mapping.get(matched_alias), matched_alias, score

    return None, matched_alias, score


import sys
sys.path.append(os.path.join(BASE_DIR, "sqllite_db_code", "postgresdbb"))
from dbb import resolve_skill, get_postgres_connection

def build_refined_skill_value(
    row,
    cursor,
    skill_resolution_cache: Dict[str, Optional[str]],
):
    refined_values = []
    seen = set()

    employee_number = str(
        row.get("Employee Number", "UNKNOWN")
    )

    for column in SKILL_COLUMNS_FOR_REFINED:
        if column not in row.index:
            continue

        value = row[column]

        if pd.isna(value):
            continue

        parts = re.split(r"[,;/|]", str(value))

        for part in parts:
            raw_skill = part.strip()

            if not raw_skill:
                continue

            normalized_input = normalize_text(raw_skill)
            if not normalized_input:
                continue

            if normalized_input in skill_resolution_cache:
                skill_key = skill_resolution_cache[normalized_input]
            else:
                resolution = resolve_skill(cursor, raw_skill)
                if resolution and resolution.get("canonical"):
                    skill_key = resolution["canonical"]
                    log_refined_skill(
                        f"[{resolution['method'].upper()}] "
                        f"Employee={employee_number} | "
                        f"Raw='{raw_skill}' | "
                        f"Canonical='{skill_key}' | "
                        f"Score={resolution.get('score', 0)}"
                    )
                else:
                    skill_key = None
                    log_refined_skill(
                        f"[MISS] Employee={employee_number} "
                        f"| Raw='{raw_skill}'"
                    )
                skill_resolution_cache[normalized_input] = skill_key

            if skill_key:

                dedupe_key = skill_key.strip().lower()

                if (
                    dedupe_key
                    and dedupe_key not in seen
                ):
                    seen.add(dedupe_key)
                    refined_values.append(
                        skill_key.strip()
                    )

    if refined_values:
        refined = ", ".join(refined_values)

        log_refined_skill(
            f"[REFINED] Employee={employee_number} "
            f"| refined_skill='{refined}'"
        )

        return refined

    log_refined_skill(
        f"[REFINED-EMPTY] Employee={employee_number} "
        f"| refined_skill=NULL"
    )

    return np.nan
# def build_refined_skill_value(row, reverse_mapping, reverse_aliases, llm, llm_cache):
    # refined_values = []
    # seen = set()
    # employee_number = str(row.get("Employee Number", "UNKNOWN"))

    # for column in SKILL_COLUMNS_FOR_REFINED:
    #     if column not in row.index:
    #         continue

    #     value = row[column]
    #     if pd.isna(value):
    #         continue

    #     parts = re.split(r"[,;/|]", str(value))
    #     for part in parts:
    #         raw_skill = part.strip()
    #         if not raw_skill:
    #             continue

    #         normalized_input = normalize_text(raw_skill)
    #         if not normalized_input:
    #             continue

    #         skill_key = reverse_mapping.get(normalized_input)

    #         if skill_key:
    #             log_refined_skill(
    #                 f"[EXACT] Employee={employee_number} | Raw='{raw_skill}' | Key='{skill_key}'"
    #             )

    #         if not skill_key:
    #             fuzzy_key, matched_alias, score = fuzzy_lookup_skill_key(
    #                 normalized_input,
    #                 reverse_mapping,
    #                 reverse_aliases,
    #             )
    #             if fuzzy_key:
    #                 skill_key = fuzzy_key
    #                 log_refined_skill(
    #                     f"[FUZZY] Employee={employee_number} | Raw='{raw_skill}' | Alias='{matched_alias}' | Score={score} | Key='{skill_key}'"
    #                 )
    #             else:
    #                 log_refined_skill(
    #                     f"[FUZZY-MISS] Employee={employee_number} | Raw='{raw_skill}' | BestAlias='{matched_alias}' | Score={score}"
    #                 )

    #         if not skill_key:
    #             if normalized_input in llm_cache:
    #                 skill_key = llm_cache[normalized_input]
    #                 log_refined_skill(
    #                     f"[LLM-CACHE] Employee={employee_number} | Raw='{raw_skill}' | Key='{skill_key}'"
    #                 )
    #             else:
    #                 llm_key = generate_skill_key_with_llm(raw_skill, llm)
    #                 skill_key = llm_key if llm_key else normalized_input
    #                 llm_cache[normalized_input] = skill_key
    #                 log_refined_skill(
    #                     f"[LLM] Employee={employee_number} | Raw='{raw_skill}' | Key='{skill_key}'"
    #                 )

    #         dedupe_key = str(skill_key).strip().lower()
    #         if dedupe_key and dedupe_key not in seen:
    #             seen.add(dedupe_key)
    #             refined_values.append(str(skill_key).strip())
            
            

    # if refined_values:
    #     refined = ", ".join(refined_values)
    #     log_refined_skill(
    #         f"[REFINED] Employee={employee_number} | refined_skill='{refined}'"
    #     )
    #     return refined

    # log_refined_skill(
    #     f"[REFINED-EMPTY] Employee={employee_number} | refined_skill=NULL"
    # )
    # return np.nan





def add_refined_skill_column(master_df, touched_employee_ids=None):
    if master_df.empty:
        master_df[REFINED_SKILL_COLUMN] = np.nan
        return master_df

    if REFINED_SKILL_COLUMN not in master_df.columns:
        master_df[REFINED_SKILL_COLUMN] = np.nan

    if touched_employee_ids is not None:
        # Only recompute for employees that came from the current upload.
        # All others keep whatever value they already have (from the DB).
        in_upload = master_df["Employee Number"].astype(str).isin(touched_employee_ids)
        needs_compute = in_upload
        skip_count = (~in_upload).sum()
        print(f"[refined_skill] {in_upload.sum()} employees from upload will be computed, "
              f"{skip_count} existing DB employees skipped.")
    else:
        # Fallback (e.g. called directly): only compute rows with no value
        needs_compute = master_df[REFINED_SKILL_COLUMN].isna() | (
            master_df[REFINED_SKILL_COLUMN].astype(str).str.strip() == ""
        )
        print(f"[refined_skill] {needs_compute.sum()} employees need computation "
              f"(no touched_ids provided, falling back to null-check).")

    if not needs_compute.any():
        return master_df

    conn = get_postgres_connection()
    cursor = conn.cursor()
    skill_resolution_cache: Dict[str, Optional[str]] = {}

    try:
        computed = master_df[needs_compute].apply(
            lambda row: build_refined_skill_value(
                row=row,
                cursor=cursor,
                skill_resolution_cache=skill_resolution_cache,
            ),
            axis=1,
        )
    finally:
        try:
            cursor.close()
        finally:
            conn.close()

    master_df.loc[needs_compute, REFINED_SKILL_COLUMN] = computed
    print(f"[refined_skill] cache hits+computed entries: {len(skill_resolution_cache)} unique normalized skills.")
    return master_df


def merge_text_values(old_value, new_value):
    """Combine two text values into a de-duplicated, sorted, comma joined string."""
    old_empty = pd.isna(old_value) or (isinstance(old_value, str) and old_value.strip() == "")
    new_empty = pd.isna(new_value) or (isinstance(new_value, str) and new_value.strip() == "")

    if old_empty:
        return new_value
    if new_empty:
        return old_value

    merged = {}
    for value in [old_value, new_value]:
        tokens = (
            str(value)
            .replace(";", ",")
            .replace("/", ",")
            .replace("|", ",")
            .split(",")
        )
        for token in tokens:
            token = token.strip()
            if token:
                merged[token.lower()] = token

    return ", ".join(sorted(merged.values()))


def standardize_columns(df):
    """
    1. Drop 'Unnamed' junk columns.
    2. Rename every recognized source column to its target name via RENAME_MAP.
    3. Drop any column not part of the requested consolidated schema.
    4. If two different original columns in the SAME file map to the same
       target name, merge them instead of one silently overwriting the other.
    """
    valid_original_cols = [c for c in df.columns if not str(c).startswith("Unnamed")]
    df = df[valid_original_cols].copy()

    result = {}

    for original_col in valid_original_cols:
        clean_name = str(original_col).strip()

        if clean_name not in RENAME_MAP:
            continue  # not part of the requested consolidated schema

        target_name = RENAME_MAP[clean_name]
        current_series = df[original_col]

        if target_name not in result:
            result[target_name] = current_series.copy()
        else:
            if target_name in MERGE_COLUMNS:
                result[target_name] = result[target_name].combine(current_series, func=merge_text_values)
            elif target_name in NUMERIC_COLUMNS:
                def numeric_combine(a, b):
                    b_num = pd.to_numeric(pd.Series([b]), errors="coerce").iloc[0]
                    return a if pd.isna(b_num) else b
                result[target_name] = result[target_name].combine(current_series, func=numeric_combine)
            else:
                result[target_name] = result[target_name].combine(current_series, func=merge_text_values)

    out_df = pd.DataFrame(result)

    for col in NUMERIC_COLUMNS:
        if col in out_df.columns:
            out_df[col] = pd.to_numeric(out_df[col], errors="coerce")

    return out_df


##############################################################################
# LOAD EXISTING DATA FROM SQLITE (so new uploads enrich, not duplicate)
##############################################################################
def load_existing_data(db_path, table_name):
    master_records = {}
    employee_sources = defaultdict(set)
    new_addition_employees = set()
    future_release_employees = set()

    if not os.path.exists(db_path):
        return master_records, employee_sources, new_addition_employees, future_release_employees

    conn = sqlite3.connect(db_path)
    try:
        existing_tables = pd.read_sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            conn,
            params=(table_name,),
        )
        if existing_tables.empty:
            return master_records, employee_sources, new_addition_employees, future_release_employees

        existing_df = pd.read_sql(f'SELECT * FROM "{table_name}"', conn)
    finally:
        conn.close()

    if "Employee Number" not in existing_df.columns:
        return master_records, employee_sources, new_addition_employees, future_release_employees

    for _, row in existing_df.iterrows():
        emp_no = normalize_emp_id(row.get("Employee Number"))
        if emp_no is None:
            continue

        record = {"Employee Number": emp_no}
        for col in SOURCE_TARGET_COLUMNS:
            if col == "Employee Number" or col not in existing_df.columns:
                continue
            value = clean_value(row[col])
            if not pd.isna(value):
                record[col] = value
        # Preserve existing refined_skill so it is NOT recomputed on next upload
        if REFINED_SKILL_COLUMN in existing_df.columns:
            existing_rs = clean_value(row[REFINED_SKILL_COLUMN])
            if not pd.isna(existing_rs):
                record[REFINED_SKILL_COLUMN] = existing_rs
        if LAST_UPDATED_COLUMN in existing_df.columns:
            existing_last_updated = clean_value(row[LAST_UPDATED_COLUMN])
            if not pd.isna(existing_last_updated):
                record[LAST_UPDATED_COLUMN] = existing_last_updated
        master_records[emp_no] = record

        src = row.get("Source_Files") if "Source_Files" in existing_df.columns else None
        if isinstance(src, str) and src.strip():
            for f in src.split(","):
                f = f.strip()
                if f:
                    employee_sources[emp_no].add(f)

        if str(row.get("New_Available_Addition", "")).strip().lower() == "yes":
            new_addition_employees.add(emp_no)
        if str(row.get("Future_Release", "")).strip().lower() == "yes":
            future_release_employees.add(emp_no)

    return master_records, employee_sources, new_addition_employees, future_release_employees


##############################################################################
# MERGE A SINGLE UPLOADED FILE INTO THE SHARED STATE (mutates in place)
##############################################################################
def process_single_file(file_path, master_records, employee_sources,
                         new_addition_employees, future_release_employees):
    """Returns the set of employee IDs that were touched by this file."""
    touched_ids = set()
    file_name = os.path.basename(file_path)
    print(f"Processing: {file_name}")

    try:
        raw_df = pd.read_excel(file_path)
        raw_df["last_update"] = datetime.now().strftime("%d-%m-%Y")
    except Exception as e:
        print(f"Failed reading {file_name}: {e}")
        return

    df = standardize_columns(raw_df)

    if "Employee Number" not in df.columns:
        print(f"Skipping {file_name} - Employee Number not found after standardization")
        return touched_ids

    emp_id_str_series = df["Employee Number"].apply(normalize_emp_id)

    if "Delta Available Pool" in file_name:
        new_addition_employees.update(emp_id_str_series.dropna().tolist())
    if "Future Releases" in file_name:
        future_release_employees.update(emp_id_str_series.dropna().tolist())

    for row_idx in df.index:
        row = df.loc[row_idx]
        emp_no = normalize_emp_id(row.get("Employee Number"))
        if emp_no is None:
            continue

        touched_ids.add(emp_no)
        employee_sources[emp_no].add(file_name)

        if emp_no not in master_records:
            master_records[emp_no] = {}

        employee_record = master_records[emp_no]
        employee_record["Employee Number"] = emp_no

        for column in df.columns:
            new_value = clean_value(row[column])
            if pd.isna(new_value):
                continue

            if column not in employee_record:
                employee_record[column] = new_value
                continue

            old_value = employee_record[column]

            if column in MERGE_COLUMNS:
                employee_record[column] = merge_text_values(old_value, new_value)
                continue

            old_missing = pd.isna(old_value) or (
                isinstance(old_value, str) and old_value.strip() == ""
            )
            if old_missing:
                employee_record[column] = new_value
                continue

            if column in NUMERIC_COLUMNS:
                try:
                    float(old_value)
                    float(new_value)
                    employee_record[column] = new_value  # latest numeric value wins
                except (ValueError, TypeError):
                    if str(old_value).strip() != str(new_value).strip():
                        employee_record[column] = new_value
            else:
                if str(old_value).strip() != str(new_value).strip():
                    employee_record[column] = new_value

    return touched_ids


##############################################################################
# BUILD FINAL DATAFRAME (derived columns + column order)
##############################################################################
def build_master_dataframe(master_records, employee_sources,
                            new_addition_employees, future_release_employees,
                            touched_employee_ids=None):
    master_df = pd.DataFrame.from_dict(master_records, orient="index")
    master_df.reset_index(drop=True, inplace=True)

    if "Employee Number" in master_df.columns:
        master_df["Employee Number"] = master_df["Employee Number"].astype(str)

        master_df["New_Available_Addition"] = (
            master_df["Employee Number"].isin(new_addition_employees).map({True: "Yes", False: "No"})
        )
        master_df["Future_Release"] = (
            master_df["Employee Number"].isin(future_release_employees).map({True: "Yes", False: "No"})
        )
    else:
        master_df["New_Available_Addition"] = "No"
        master_df["Future_Release"] = "No"

    if "Allocation Status" in master_df.columns:
        def check_availability(status_string):
            if pd.isna(status_string) or str(status_string).strip() == "":
                return "No"
            statuses = [
                s.strip()
                for s in str(status_string).lower().replace(";", ",").replace("/", ",").replace("|", ",").split(",")
            ]
            available_keywords = {"available", "buffer", "bench", "unallocated"}
            return "Yes" if any(s in available_keywords for s in statuses) else "No"

        master_df["Available to take Project (Yes/No)"] = master_df["Allocation Status"].apply(check_availability)
    else:
        master_df["Available to take Project (Yes/No)"] = "No"

    if "Employee Number" in master_df.columns:
        master_df["Source_Files"] = master_df["Employee Number"].astype(str).apply(
            lambda emp_id: ", ".join(sorted(employee_sources.get(emp_id, [])))
        )
    else:
        master_df["Source_Files"] = ""

    master_df = add_refined_skill_column(master_df, touched_employee_ids=touched_employee_ids)

    if LAST_UPDATED_COLUMN not in master_df.columns:
        master_df[LAST_UPDATED_COLUMN] = np.nan

    if "Employee Number" in master_df.columns and touched_employee_ids is not None:
        touched_set = {str(emp_id) for emp_id in touched_employee_ids}
        if touched_set:
            upload_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            touched_mask = master_df["Employee Number"].astype(str).isin(touched_set)
            master_df.loc[touched_mask, LAST_UPDATED_COLUMN] = upload_time

    for col in FINAL_COLUMN_ORDER:
        if col not in master_df.columns:
            master_df[col] = np.nan

    return master_df[FINAL_COLUMN_ORDER]


##############################################################################
# SAVE TO SQLITE WITH A REAL PRIMARY KEY ON Employee Number
##############################################################################
def save_to_sqlite(master_df, db_path, table_name):
    conn = sqlite3.connect(db_path)
    try:
        cursor = conn.cursor()
        staging_table = f"{table_name}__staging"

        master_df.to_sql(staging_table, conn, if_exists="replace", index=False)

        columns_def = ", ".join(
            f'"{col}" TEXT PRIMARY KEY' if col == "Employee Number" else f'"{col}" TEXT'
            for col in master_df.columns
        )
        cursor.execute(f'DROP TABLE IF EXISTS "{table_name}"')
        cursor.execute(f'CREATE TABLE "{table_name}" ({columns_def})')

        col_names = ", ".join(f'"{c}"' for c in master_df.columns)
        cursor.execute(
            f'INSERT INTO "{table_name}" ({col_names}) SELECT {col_names} FROM "{staging_table}"'
        )
        cursor.execute(f'DROP TABLE "{staging_table}"')
        conn.commit()
    finally:
        conn.close()


##############################################################################
# ENTRY POINT
##############################################################################
def merge_employee_files(file_paths, db_path=SQLITE_DB_FILE, table_name=SQLITE_TABLE_NAME, output_excel=None):

    print(file_paths)
    print("*"*40)
    """
    Main entry point.

    file_paths   : a single file path (str) or a list of Excel file paths
                   (as uploaded from the UI).
    db_path      : path to the SQLite database. If it already contains data,
                   new files are merged into existing employee rows using
                   Employee Number as the key -- missing fields get filled
                   in, enrichment columns get combined, and no duplicate
                   Employee Number rows are ever created.
    table_name   : SQLite table name.
    output_excel : optional path to also write the consolidated result as
                   an .xlsx file.

    Returns the consolidated master DataFrame.
    """
    if isinstance(file_paths, str):
        file_paths = [file_paths]

    master_records, employee_sources, new_addition_employees, future_release_employees = (
        load_existing_data(db_path, table_name)
    )

    touched_employee_ids = set()
    for file_path in file_paths:
        ids = process_single_file(
            file_path, master_records, employee_sources,
            new_addition_employees, future_release_employees,
        )
        if ids:
            touched_employee_ids.update(ids)

    print(f"[upload] {len(touched_employee_ids)} unique employees touched by uploaded file(s).")

    master_df = build_master_dataframe(
        master_records, employee_sources, new_addition_employees, future_release_employees,
        touched_employee_ids=touched_employee_ids,
    )

    save_to_sqlite(master_df, db_path, table_name)
    print(f"Upserted {len(master_df)} employee records into {db_path} (table: {table_name})")

    if output_excel:
        master_df.to_excel(output_excel, index=False)
        print(f"Saved consolidated Excel file: {output_excel}")

    return master_df


if __name__ == "__main__":
    # Example usage: python merge_employee_master.py file1.xlsx file2.xlsx ...
    uploaded_files = sys.argv[1:]

    if not uploaded_files:
        # No CLI args given (e.g. running from VS Code's Run button) -- fall
        # back to a hardcoded test list instead of exiting, so the script is
        # still runnable directly. Replace these paths with your own, or just
        # run from the terminal with real arguments to skip this branch.
        print("No command-line file paths given -- using hardcoded test paths.")
        uploaded_files = [
            os.path.join(BASE_DIR, "data", "Future Releases - 12-Jun-26 (1).xlsb"),
        ]

    merge_employee_files(uploaded_files, output_excel="Consolidated2.xlsx")