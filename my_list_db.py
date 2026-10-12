"""
my_list_db.py
---------------------------------------------------------------------------
Storage for the "My List" panel of the Pool Resource Data UI.

Tables (all created with CREATE TABLE IF NOT EXISTS in the master DB):

    my_list                    one row per "Add to my list" click
                               (owner, query, generated SQL, columns, time)
    my_list_items              employees added by that click + their state
                               in that list (Shortlisted / Interviewed)
    employee_interview_status  ONE row per employee: current status, last
                               interviewed time, interview count. Shared by
                               all users.
    my_list_views              saved filter / column views per owner

merge_employee_files() only drops and recreates employee_master_data, so
these tables survive new uploads.

How employee_interview_status is updated:
    Add to my list      -> status = Shortlisted (last_interviewed kept)
    Mark interviewed    -> status = Interviewed, last_interviewed = now,
                           interview_count + 1
    Remove / delete     -> only if status is Shortlisted and the employee is
                           not pending in any other list:
                           Interviewed if interviewed before, else Removed

The same information is copied onto employee_master_data as two columns,
so the chat / SQL agent can query it:

    "Interview Status"  Not Interviewed | Shortlisted | Interviewed
    "Last Interviewed"  'YYYY-MM-DD HH:MM:SS' (local time) or NULL

merge_employee_files rebuilds employee_master_data on every upload, which
drops those two columns; sync_master_interview_columns() puts them back
(merge_fixes.apply_merge_fixes calls it automatically after each upload).
---------------------------------------------------------------------------
"""

import os
import re
import json
import sqlite3
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Dict, List, Optional

##############################################################################
# CONFIGURATION
##############################################################################
BASE_DIR = os.path.abspath(os.path.dirname(__file__))

# Point this at your master DB (the same eeee.db used by the SQL agent and
# merge_employee_files), or set the MASTER_DB_PATH environment variable.
MASTER_DB_PATH = os.environ.get("MASTER_DB_PATH", os.path.join(BASE_DIR, "eeee.db"))

STATUS_SHORTLISTED = "Shortlisted"
STATUS_INTERVIEWED = "Interviewed"
STATUS_REMOVED = "Removed"

# Interview columns kept up to date on the main employee table.
MASTER_TABLE = "employee_master_data"
MASTER_STATUS_COLUMN = "Interview Status"
MASTER_LAST_INTERVIEWED_COLUMN = "Last Interviewed"
MASTER_NOT_INTERVIEWED = "Not Interviewed"

# Header names (lower-cased, "_" / "." -> space) that identify the employee
# id / name column in a query result. Mirrored in App.jsx.
EMPLOYEE_ID_HEADERS = {
    "employee number", "employee no", "employee id",
    "emp id", "emp no", "emp number", "empid",
}
EMPLOYEE_NAME_HEADERS = {"employee name", "full name", "name"}

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS my_list (
    list_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    owner         TEXT NOT NULL,
    query_text    TEXT,
    sql_text      TEXT,
    columns_json  TEXT NOT NULL,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_my_list_owner ON my_list (owner);

CREATE TABLE IF NOT EXISTS my_list_items (
    item_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id          INTEGER NOT NULL REFERENCES my_list (list_id) ON DELETE CASCADE,
    employee_number  TEXT NOT NULL,
    employee_name    TEXT,
    row_json         TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'Shortlisted',
    added_at         TEXT NOT NULL,
    interviewed_at   TEXT,
    UNIQUE (list_id, employee_number)
);
CREATE INDEX IF NOT EXISTS idx_my_list_items_list ON my_list_items (list_id);
CREATE INDEX IF NOT EXISTS idx_my_list_items_emp ON my_list_items (employee_number);

CREATE TABLE IF NOT EXISTS employee_interview_status (
    employee_number   TEXT PRIMARY KEY,
    employee_name     TEXT,
    status            TEXT NOT NULL,
    last_interviewed  TEXT,
    interview_count   INTEGER NOT NULL DEFAULT 0,
    last_query        TEXT,
    first_added_at    TEXT,
    updated_at        TEXT NOT NULL,
    updated_by        TEXT
);

CREATE TABLE IF NOT EXISTS my_list_views (
    view_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    owner        TEXT NOT NULL,
    name         TEXT NOT NULL,
    config_json  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE (owner, name)
);
"""

_UPSERT_SHORTLISTED = """
INSERT INTO employee_interview_status
    (employee_number, employee_name, status, last_query, first_added_at, updated_at, updated_by)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (employee_number) DO UPDATE SET
    employee_name  = COALESCE(excluded.employee_name, employee_interview_status.employee_name),
    status         = excluded.status,
    last_query     = excluded.last_query,
    first_added_at = COALESCE(employee_interview_status.first_added_at, excluded.first_added_at),
    updated_at     = excluded.updated_at,
    updated_by     = excluded.updated_by
"""

_UPSERT_INTERVIEWED = """
INSERT INTO employee_interview_status
    (employee_number, employee_name, status, last_interviewed, interview_count,
     first_added_at, updated_at, updated_by)
VALUES (?, ?, ?, ?, 1, ?, ?, ?)
ON CONFLICT (employee_number) DO UPDATE SET
    employee_name    = COALESCE(excluded.employee_name, employee_interview_status.employee_name),
    status           = excluded.status,
    last_interviewed = excluded.last_interviewed,
    interview_count  = employee_interview_status.interview_count + 1,
    updated_at       = excluded.updated_at,
    updated_by       = excluded.updated_by
"""

# Runs after an item is removed: a Shortlisted employee that is no longer
# pending in any list falls back to Interviewed (if ever interviewed) or
# Removed. Interview history is never erased.
_RELEASE_EMPLOYEE = """
UPDATE employee_interview_status
SET status = CASE WHEN last_interviewed IS NOT NULL THEN ? ELSE ? END,
    updated_at = ?,
    updated_by = ?
WHERE employee_number = ?
  AND status = ?
  AND NOT EXISTS (
      SELECT 1 FROM my_list_items WHERE employee_number = ? AND status = ?
  )
"""


##############################################################################
# CONNECTION / INIT
##############################################################################
def now_iso() -> str:
    """Local time with UTC offset, e.g. 2026-10-12T09:14:05+05:30."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


@contextmanager
def get_conn():
    conn = sqlite3.connect(MASTER_DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_my_list_tables():
    """
    Create the My List tables in the master DB if they don't exist and
    (re)fill the interview columns on employee_master_data.
    """
    if not os.path.exists(MASTER_DB_PATH):
        print(
            f"[my_list] WARNING: {MASTER_DB_PATH} does not exist, so a new empty database "
            f"will be created. If your eeee.db lives elsewhere, set MASTER_DB_PATH in my_list_db.py."
        )
    with get_conn() as conn:
        conn.executescript(SCHEMA_SQL)
        synced = sync_master_interview_columns(conn)
    if synced is None:
        print(f"[my_list] {MASTER_TABLE} not found yet; interview columns are added after the first upload.")


##############################################################################
# HELPERS
##############################################################################
def normalize_header(name) -> str:
    return " ".join(str(name).replace("_", " ").replace(".", " ").lower().split())


def find_column(columns: List[str], headers: set) -> int:
    for idx, col in enumerate(columns):
        if normalize_header(col) in headers:
            return idx
    return -1


def normalize_emp_id(value) -> Optional[str]:
    """Same normalisation as merge_employee_files: "12345.0" -> "12345"."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null"}:
        return None
    if re.fullmatch(r"\d+(\.0+)?", text):
        return str(int(text.split(".")[0]))
    return text


def _clean_name(value) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text if text and text.lower() not in {"nan", "none", "null"} else None


def _owned_items(conn, owner: str, where_sql: str, params: tuple):
    return conn.execute(
        f"""
        SELECT i.* FROM my_list_items i
        JOIN my_list l ON l.list_id = i.list_id
        WHERE l.owner = ? AND {where_sql}
        """,
        (owner, *params),
    ).fetchall()


def _require_list(conn, owner: str, list_id: int):
    row = conn.execute(
        "SELECT list_id FROM my_list WHERE list_id = ? AND owner = ?",
        (list_id, owner),
    ).fetchone()
    if row is None:
        raise LookupError(f"List {list_id} not found.")


def _release_employee(conn, owner: str, employee_number: str, ts: str):
    conn.execute(
        _RELEASE_EMPLOYEE,
        (
            STATUS_INTERVIEWED, STATUS_REMOVED, ts, owner,
            employee_number, STATUS_SHORTLISTED,
            employee_number, STATUS_SHORTLISTED,
        ),
    )


def _mark_interviewed(conn, owner: str, item_rows, ts: str):
    for row in item_rows:
        conn.execute(
            "UPDATE my_list_items SET status = ?, interviewed_at = ? WHERE item_id = ?",
            (STATUS_INTERVIEWED, ts, row["item_id"]),
        )
        conn.execute(
            _UPSERT_INTERVIEWED,
            (row["employee_number"], row["employee_name"], STATUS_INTERVIEWED, ts, ts, ts, owner),
        )


##############################################################################
# INTERVIEW COLUMNS ON THE MAIN TABLE
##############################################################################
def _table_exists(conn, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone() is not None


def _master_values(status: Optional[str], last_interviewed: Optional[str]):
    """(Interview Status, Last Interviewed) as written to employee_master_data."""
    if status is None or status == STATUS_REMOVED:
        status = MASTER_NOT_INTERVIEWED
    if last_interviewed:
        try:
            last_interviewed = (
                datetime.fromisoformat(last_interviewed).astimezone().strftime("%Y-%m-%d %H:%M:%S")
            )
        except ValueError:
            pass
    return status, last_interviewed


def sync_master_interview_columns(conn=None, employee_numbers=None) -> Optional[int]:
    """
    Copy status / last interviewed from employee_interview_status onto the
    "Interview Status" / "Last Interviewed" columns of employee_master_data,
    adding the columns if they are missing.

    conn             : an open connection to reuse (e.g. inside the upload's
                       save transaction). None opens and commits its own.
    employee_numbers : only update these employees; None updates everyone.

    Returns the number of rows written, or None if employee_master_data
    doesn't exist yet.
    """
    if conn is None:
        with get_conn() as own_conn:
            return sync_master_interview_columns(own_conn, employee_numbers)

    if not _table_exists(conn, MASTER_TABLE):
        return None

    existing = {row[1] for row in conn.execute(f'PRAGMA table_info("{MASTER_TABLE}")')}
    for col in (MASTER_STATUS_COLUMN, MASTER_LAST_INTERVIEWED_COLUMN):
        if col not in existing:
            conn.execute(f'ALTER TABLE "{MASTER_TABLE}" ADD COLUMN "{col}" TEXT')

    statuses = {}
    if _table_exists(conn, "employee_interview_status"):
        for emp_no, status, last in conn.execute(
            "SELECT employee_number, status, last_interviewed FROM employee_interview_status"
        ):
            statuses[emp_no] = (status, last)

    wanted = None
    if employee_numbers is not None:
        wanted = {normalize_emp_id(e) for e in employee_numbers}

    updates = []
    for rowid, emp in conn.execute(f'SELECT rowid, "Employee Number" FROM "{MASTER_TABLE}"').fetchall():
        emp_no = normalize_emp_id(emp)
        if wanted is not None and emp_no not in wanted:
            continue
        updates.append((*_master_values(*statuses.get(emp_no, (None, None))), rowid))

    conn.executemany(
        f'UPDATE "{MASTER_TABLE}" '
        f'SET "{MASTER_STATUS_COLUMN}" = ?, "{MASTER_LAST_INTERVIEWED_COLUMN}" = ? '
        f"WHERE rowid = ?",
        updates,
    )
    return len(updates)


def _sync_master_safe(conn, employee_numbers):
    # employee_interview_status is the source of truth; if the main table is
    # busy or missing, the next full sync (startup / upload) catches up.
    try:
        sync_master_interview_columns(conn, employee_numbers)
    except sqlite3.Error as e:
        print(f"[my_list] could not update {MASTER_TABLE}: {e}")


def _load_state(conn, owner: str) -> Dict[str, Any]:
    """Every list (newest first) with its items, plus the status table."""
    list_rows = conn.execute(
        "SELECT * FROM my_list WHERE owner = ? ORDER BY list_id DESC",
        (owner,),
    ).fetchall()
    item_rows = _owned_items(conn, owner, "1 = 1", ())

    items_by_list = defaultdict(list)
    for r in sorted(item_rows, key=lambda r: r["item_id"]):
        items_by_list[r["list_id"]].append({
            "item_id": r["item_id"],
            "employee_number": r["employee_number"],
            "employee_name": r["employee_name"],
            "row": json.loads(r["row_json"]),
            "status": r["status"],
            "added_at": r["added_at"],
            "interviewed_at": r["interviewed_at"],
        })

    lists = [
        {
            "list_id": r["list_id"],
            "query": r["query_text"],
            "sql": r["sql_text"],
            "columns": json.loads(r["columns_json"]),
            "created_at": r["created_at"],
            "items": items_by_list.get(r["list_id"], []),
        }
        for r in list_rows
    ]

    employee_status = {
        r["employee_number"]: dict(r)
        for r in conn.execute("SELECT * FROM employee_interview_status").fetchall()
    }

    return {"lists": lists, "employee_status": employee_status}


def _load_views(conn, owner: str) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM my_list_views WHERE owner = ? ORDER BY name COLLATE NOCASE",
        (owner,),
    ).fetchall()
    return [
        {
            "view_id": r["view_id"],
            "name": r["name"],
            "config": json.loads(r["config_json"]),
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        }
        for r in rows
    ]


##############################################################################
# LISTS
##############################################################################
def get_my_list(owner: str) -> Dict[str, Any]:
    with get_conn() as conn:
        return _load_state(conn, owner)


def create_list(owner: str, query: Optional[str], sql: Optional[str],
                columns: List[str], rows: List[List[Any]]) -> Dict[str, Any]:
    """
    Save a query result (or the selected rows of it) as a new list.
    Rows without an Employee Number, or repeated in the same result, are
    skipped.
    """
    columns = [str(c) for c in columns]
    id_idx = find_column(columns, EMPLOYEE_ID_HEADERS)
    if id_idx == -1:
        raise ValueError("This result has no Employee Number column, so it can't be added to My List.")
    name_idx = find_column(columns, EMPLOYEE_NAME_HEADERS)

    items, seen, skipped = [], set(), 0
    for row in rows:
        emp_no = normalize_emp_id(row[id_idx]) if id_idx < len(row) else None
        if emp_no is None or emp_no in seen:
            skipped += 1
            continue
        seen.add(emp_no)
        record = {col: (row[i] if i < len(row) else None) for i, col in enumerate(columns)}
        name = _clean_name(row[name_idx]) if 0 <= name_idx < len(row) else None
        items.append((emp_no, name, record))

    if not items:
        raise ValueError("None of the selected rows has an Employee Number.")

    ts = now_iso()
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO my_list (owner, query_text, sql_text, columns_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (owner, query, sql, json.dumps(columns), ts),
        )
        list_id = cur.lastrowid

        for emp_no, name, record in items:
            conn.execute(
                """
                INSERT INTO my_list_items
                    (list_id, employee_number, employee_name, row_json, status, added_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (list_id, emp_no, name, json.dumps(record, default=str), STATUS_SHORTLISTED, ts),
            )
            conn.execute(
                _UPSERT_SHORTLISTED,
                (emp_no, name, STATUS_SHORTLISTED, query, ts, ts, owner),
            )

        _sync_master_safe(conn, [emp_no for emp_no, _, _ in items])
        state = _load_state(conn, owner)

    state.update({"list_id": list_id, "added": len(items), "skipped": skipped})
    return state


def mark_item_interviewed(owner: str, item_id: int) -> Dict[str, Any]:
    with get_conn() as conn:
        rows = _owned_items(conn, owner, "i.item_id = ?", (item_id,))
        if not rows:
            raise LookupError(f"List item {item_id} not found.")
        pending = [r for r in rows if r["status"] != STATUS_INTERVIEWED]
        _mark_interviewed(conn, owner, pending, now_iso())
        _sync_master_safe(conn, [r["employee_number"] for r in pending])
        return _load_state(conn, owner)


def mark_list_interviewed(owner: str, list_id: int,
                          item_ids: Optional[List[int]] = None) -> Dict[str, Any]:
    """Mark every pending item of a list (or only `item_ids`) as interviewed."""
    with get_conn() as conn:
        _require_list(conn, owner, list_id)
        rows = _owned_items(
            conn, owner, "i.list_id = ? AND i.status != ?", (list_id, STATUS_INTERVIEWED)
        )
        if item_ids is not None:
            wanted = set(item_ids)
            rows = [r for r in rows if r["item_id"] in wanted]
        _mark_interviewed(conn, owner, rows, now_iso())
        _sync_master_safe(conn, [r["employee_number"] for r in rows])
        state = _load_state(conn, owner)

    state["marked"] = len(rows)
    return state


def remove_item(owner: str, item_id: int) -> Dict[str, Any]:
    with get_conn() as conn:
        rows = _owned_items(conn, owner, "i.item_id = ?", (item_id,))
        if not rows:
            raise LookupError(f"List item {item_id} not found.")
        row = rows[0]

        conn.execute("DELETE FROM my_list_items WHERE item_id = ?", (item_id,))
        # A list with no candidates left is removed as well.
        conn.execute(
            """
            DELETE FROM my_list
            WHERE list_id = ?
              AND NOT EXISTS (SELECT 1 FROM my_list_items WHERE list_id = ?)
            """,
            (row["list_id"], row["list_id"]),
        )
        _release_employee(conn, owner, row["employee_number"], now_iso())
        _sync_master_safe(conn, [row["employee_number"]])
        return _load_state(conn, owner)


def delete_list(owner: str, list_id: int) -> Dict[str, Any]:
    with get_conn() as conn:
        _require_list(conn, owner, list_id)
        employee_numbers = [
            r["employee_number"]
            for r in conn.execute(
                "SELECT employee_number FROM my_list_items WHERE list_id = ?", (list_id,)
            ).fetchall()
        ]
        conn.execute("DELETE FROM my_list_items WHERE list_id = ?", (list_id,))
        conn.execute("DELETE FROM my_list WHERE list_id = ?", (list_id,))

        ts = now_iso()
        for emp_no in employee_numbers:
            _release_employee(conn, owner, emp_no, ts)
        _sync_master_safe(conn, employee_numbers)
        return _load_state(conn, owner)


def get_employee_status(employee_number: str) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM employee_interview_status WHERE employee_number = ?",
            (normalize_emp_id(employee_number),),
        ).fetchone()
        return dict(row) if row else None


##############################################################################
# SAVED VIEWS
##############################################################################
def get_views(owner: str) -> Dict[str, Any]:
    with get_conn() as conn:
        return {"views": _load_views(conn, owner)}


def save_view(owner: str, name: str, config: Dict[str, Any]) -> Dict[str, Any]:
    """Create a view, or overwrite the owner's view with the same name."""
    name = (name or "").strip()
    if not name:
        raise ValueError("View name is required.")

    ts = now_iso()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO my_list_views (owner, name, config_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (owner, name) DO UPDATE SET
                config_json = excluded.config_json,
                updated_at  = excluded.updated_at
            """,
            (owner, name, json.dumps(config), ts, ts),
        )
        view_id = conn.execute(
            "SELECT view_id FROM my_list_views WHERE owner = ? AND name = ?",
            (owner, name),
        ).fetchone()["view_id"]
        return {"views": _load_views(conn, owner), "view_id": view_id}


def delete_view(owner: str, view_id: int) -> Dict[str, Any]:
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM my_list_views WHERE owner = ? AND view_id = ?",
            (owner, view_id),
        )
        if cur.rowcount == 0:
            raise LookupError(f"View {view_id} not found.")
        return {"views": _load_views(conn, owner)}


if __name__ == "__main__":
    # python my_list_db.py  -> create tables + refill the interview columns
    # (useful after running merge_data4.py from the command line).
    init_my_list_tables()
    print(f"My List tables ready in {MASTER_DB_PATH}")
    print(f"Interview columns written for {sync_master_interview_columns() or 0} employees")
