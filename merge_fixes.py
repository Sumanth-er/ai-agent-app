"""
merge_fixes.py
---------------------------------------------------------------------------
Fixes for merge_data4.py (merge_employee_files), applied ON TOP of it so the
original file stays untouched. Call once at startup in app.py:

    import merge_data4
    import my_list_db
    from merge_fixes import apply_merge_fixes
    apply_merge_fixes(merge_data4, after_save=my_list_db.sync_master_interview_columns)

What it fixes (each one reproduced against merge_data4 first):

1. Phone numbers / numbers stored as garbage like b'\\x03|\\x82J\\x02\\x00...'
   pandas hands numpy integers (np.int64) to sqlite3, which stores them as
   raw bytes (BLOB). clean_value() now turns numpy values into plain Python
   values and 9840000003.0 into 9840000003. Broken values already in the DB
   are decoded on the next upload (or right away with repair_master_data).
   Same root cause: one blank Employee ID row in a file made every ID in it
   a decimal ("101.0"), which also wiped those employees' Source_Files and
   New_Available_Addition. Fixed by the same change.

2. A failed save left employee_master_data EMPTY: save_to_sqlite() dropped
   the table (committed at once) before inserting the rows back. The
   replacement does drop + create + insert in ONE transaction, so a failure
   leaves the previous table untouched.

3. Numeric columns were all TEXT, so SQL like "Total Experience" > 4.5
   compared text ('12' < '4.5') and silently missed people with 10+ years.
   merge_data4.NUMERIC_COLUMNS are now created with NUMERIC affinity.

4. after_save(conn) runs inside that same transaction. my_list_db uses it to
   put back the "Interview Status" / "Last Interviewed" columns that the
   rebuild drops.

One-time clean-up of an existing DB (makes a .bak copy first):

    python merge_fixes.py                      # eeee.db next to this file
    python merge_fixes.py D:\\path\\other.db     # any other SQLite file
    python merge_fixes.py D:\\path\\other.db some_table
---------------------------------------------------------------------------
"""

import os
import re
import sys
import sqlite3
from datetime import datetime
from typing import Callable, Iterable, Optional

import numpy as np
import pandas as pd

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

DEFAULT_TABLE = "employee_master_data"

# Same list as merge_data4.NUMERIC_COLUMNS (used when repairing a DB without
# importing merge_data4, which needs the Postgres skill resolver).
DEFAULT_NUMERIC_COLUMNS = [
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

# Columns whose text values "101.0" / "9840000003.0" are turned back into
# "101" / "9840000003".
ID_LIKE_COLUMNS = ("Employee Number", "Contact")

_INTEGRAL_TEXT = re.compile(r"^-?\d+\.0+$")


##############################################################################
# VALUE CLEANING
##############################################################################
def to_python_value(value):
    """
    numpy scalar -> Python value, 9840000003.0 -> 9840000003, and decode
    the 4/8-byte integer BLOBs that sqlite3 wrote for numpy integers.
    """
    if isinstance(value, (bytes, bytearray)) and len(value) in (4, 8):
        return int.from_bytes(value, "little", signed=True)
    if isinstance(value, np.generic) and not isinstance(value, (np.datetime64, np.timedelta64)):
        value = value.item()
    if isinstance(value, float) and value.is_integer() and abs(value) < 2 ** 53:
        return int(value)
    return value


def _is_missing(value) -> bool:
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def clean_master_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Every cell as a plain Python value (or None) in object columns."""
    cleaned = {}
    for col in df.columns:
        values = []
        for value in df[col].tolist():
            if _is_missing(value):
                values.append(None)
                continue
            value = to_python_value(value)
            if isinstance(value, datetime):
                value = value.isoformat(sep=" ")
            if col in ID_LIKE_COLUMNS and isinstance(value, str) and _INTEGRAL_TEXT.match(value.strip()):
                value = value.strip().split(".")[0]
            values.append(value)
        # dtype=object stops pandas from turning ints + None back into floats
        cleaned[col] = pd.Series(values, index=df.index, dtype=object)
    return pd.DataFrame(cleaned, columns=list(df.columns))


##############################################################################
# ATOMIC SAVE
##############################################################################
def _column_type(col: str, numeric_columns: Iterable[str]) -> str:
    if col == "Employee Number":
        return "TEXT PRIMARY KEY"
    if col in numeric_columns:
        return "NUMERIC"
    return "TEXT"


def save_master_table(master_df: pd.DataFrame, db_path: str, table_name: str,
                      numeric_columns: Iterable[str] = DEFAULT_NUMERIC_COLUMNS,
                      after_save: Optional[Callable] = None):
    """
    Same result as merge_data4.save_to_sqlite, but the table swap is one
    transaction and numbers are stored correctly.
    """
    numeric_columns = set(numeric_columns)
    df = clean_master_frame(master_df)
    staging = f"{table_name}__staging"

    conn = sqlite3.connect(db_path, timeout=30)
    try:
        df.to_sql(staging, conn, if_exists="replace", index=False)
        if conn.in_transaction:
            conn.commit()

        columns_def = ", ".join(f'"{c}" {_column_type(c, numeric_columns)}' for c in df.columns)
        col_names = ", ".join(f'"{c}"' for c in df.columns)

        conn.execute("BEGIN IMMEDIATE")
        conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
        conn.execute(f'CREATE TABLE "{table_name}" ({columns_def})')
        conn.execute(f'INSERT INTO "{table_name}" ({col_names}) SELECT {col_names} FROM "{staging}"')
        conn.execute(f'DROP TABLE "{staging}"')
        if after_save is not None:
            after_save(conn)
        conn.commit()
    except Exception:
        if conn.in_transaction:
            conn.rollback()
        try:
            conn.execute(f'DROP TABLE IF EXISTS "{staging}"')
            conn.commit()
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


##############################################################################
# PATCH merge_data4
##############################################################################
def apply_merge_fixes(merge_module, after_save: Optional[Callable] = None):
    """
    Swap merge_data4's clean_value and save_to_sqlite for the fixed versions.
    merge_employee_files looks both up at call time, so nothing else changes.
    Safe to call more than once.
    """
    if getattr(merge_module, "_merge_fixes_applied", False):
        return

    original_clean_value = merge_module.clean_value
    numeric_columns = list(getattr(merge_module, "NUMERIC_COLUMNS", DEFAULT_NUMERIC_COLUMNS))

    def clean_value(value):
        return original_clean_value(to_python_value(value))

    def save_to_sqlite(master_df, db_path, table_name):
        save_master_table(master_df, db_path, table_name, numeric_columns, after_save)

    merge_module.clean_value = clean_value
    merge_module.save_to_sqlite = save_to_sqlite
    merge_module._merge_fixes_applied = True


##############################################################################
# ONE-TIME REPAIR OF AN EXISTING DB
##############################################################################
def repair_master_data(db_path: str, table_name: str = DEFAULT_TABLE,
                       numeric_columns: Iterable[str] = DEFAULT_NUMERIC_COLUMNS,
                       after_save: Optional[Callable] = None, backup: bool = True) -> dict:
    """
    Decode BLOB numbers, turn "101.0" ids / contacts back into "101", and
    re-create the table with numeric columns. Copies the DB to
    <db_path>.bak-<timestamp> first.
    """
    if not os.path.exists(db_path):
        raise FileNotFoundError(db_path)

    backup_path = None
    if backup:
        backup_path = f"{db_path}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        src, dst = sqlite3.connect(db_path), sqlite3.connect(backup_path)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()

    conn = sqlite3.connect(db_path)
    try:
        df = pd.read_sql(f'SELECT * FROM "{table_name}"', conn)
    finally:
        conn.close()

    blob_values = sum(
        int(col.map(lambda v: isinstance(v, (bytes, bytearray))).sum()) for _, col in df.items()
    )
    decimal_ids = sum(
        int(df[col].map(lambda v: isinstance(v, str) and bool(_INTEGRAL_TEXT.match(v.strip()))).sum())
        for col in ID_LIKE_COLUMNS if col in df.columns
    )

    df = clean_master_frame(df)
    duplicates = 0
    if "Employee Number" in df.columns:
        before = len(df)
        df = df.drop_duplicates(subset=["Employee Number"], keep="first")
        duplicates = before - len(df)

    save_master_table(df, db_path, table_name, numeric_columns, after_save)
    return {
        "rows": len(df),
        "blob_values_fixed": blob_values,
        "decimal_values_fixed": decimal_ids,
        "duplicate_ids_dropped": duplicates,
        "backup": backup_path,
    }


if __name__ == "__main__":
    target_db = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE_DIR, "eeee.db")
    target_table = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_TABLE

    sync = None
    if target_table == DEFAULT_TABLE:
        try:
            import my_list_db
            if os.path.abspath(my_list_db.MASTER_DB_PATH) == os.path.abspath(target_db):
                sync = my_list_db.sync_master_interview_columns
        except ImportError:
            pass

    result = repair_master_data(target_db, target_table, after_save=sync)
    for key, value in result.items():
        print(f"{key}: {value}")
