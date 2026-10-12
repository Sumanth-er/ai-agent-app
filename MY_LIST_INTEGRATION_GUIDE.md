# My List: integration guide

How to move the My List feature, the interview columns on the main table, and the data-quality fixes from this folder into your full project. Nothing in your original logic is rewritten. The new code sits on top of it, plus a few added lines in `app.py`, `config.js` and `prompts.py`.

---

## 0. What's in this folder

| File here | Status | Name in your project | Put it in |
|---|---|---|---|
| `app.jsx` | Your file plus additions | `App.jsx` | your React `src/` (see step 3) |
| `my_list_db.py` | **new** | same | the folder that holds `sl_agent3.py` and `merge_data4.py` (the one `app.py` adds to `sys.path`, e.g. `new_task/`) |
| `my_list_api.py` | **new** | same | same folder |
| `merge_fixes.py` | **new** | same | same folder |
| `merge4.py` | untouched | `merge_data4.py` | no change |
| `sqlagent.py` | untouched | `sl_agent3.py` | no change (optional patch in step 7) |

No new npm packages. The Python side only uses what you already have (FastAPI, pandas, numpy, sqlite3).

---

## 1. Back up your database first

Copy `eeee.db` somewhere safe before anything else. The one-time repair in step 2.4 also makes its own backup, but have your own copy too.

---

## 2. Backend

### 2.1 Copy the three new files
Put `my_list_db.py`, `my_list_api.py` and `merge_fixes.py` **next to `sl_agent3.py` and `merge_data4.py`**.

### 2.2 Database path
`my_list_db.py` uses `eeee.db` in its own folder, which is the same file `sl_agent3.py` and `merge_data4.py` use. If your DB is elsewhere, change `MASTER_DB_PATH` at the top of `my_list_db.py` (or set the `MASTER_DB_PATH` environment variable).

At startup, it prints a **WARNING** if the file doesn't exist. If you see that warning, the path is wrong.

### 2.3 `app.py`: add these lines
Add them after your existing imports, i.e. after `from sl_agent3 import get_result`. They must come after `app = FastAPI()` and after the `sys.path.append(...)` line:

```python
from merge_data4 import merge_employee_files
from sl_agent3 import get_result

# ---- My List + merge fixes (added) ---------------------------------------
import merge_data4
import my_list_db
from merge_fixes import apply_merge_fixes
from my_list_api import router as my_list_router

apply_merge_fixes(merge_data4, after_save=my_list_db.sync_master_interview_columns)
app.include_router(my_list_router)
# ----------------------------------------------------------------------------
```

What these do:
- `include_router` adds the `/my-list` endpoints. On import, it creates the new tables (only if they don't exist) and adds the `Interview Status` / `Last Interviewed` columns to `employee_master_data`.
- `apply_merge_fixes` fixes `merge_employee_files` **without editing `merge_data4.py`** (details in step 6). It also puts the two interview columns back after every upload, because `merge_employee_files` drops and re-creates `employee_master_data`.

Your `/upload` and `/chat` endpoints stay as they are.

### 2.4 One-time repair of the existing DB
Run this once from that folder, with the server stopped:

```bash
python merge_fixes.py
```

It does four things:
- Saves a backup copy as `eeee.db.bak-<time>`.
- Turns phone numbers stored as bytes (`b'\x03|\x82J…'`) back into digits.
- Turns `101.0`-style IDs and contacts back into `101`.
- Re-creates the table with numeric columns, so `"Total Experience" > 4.5` compares numbers instead of text.

It prints how many values it fixed. To repair a different SQLite file, run `python merge_fixes.py path\to\other.db [table_name]`.

This step is **optional**. Once step 2.3 is in place, your next upload rewrites the whole table the same way, but without making a backup. Running it now gives you a backup and lets you check the result before anyone uploads.

What it does **not** change:
- your other tables;
- the column names, column order, or primary key;
- the number of rows. The only exception is if two IDs become identical after cleaning (e.g. `101` and `101.0`); it reports how many, and normally that's 0.

Any 4- or 8-byte binary value in the table is read as a number, which is safe here because this table never stores real binary data.

### 2.5 Tell the AI about the new columns (`prompts.py`)
Append this to `employee_prompt` in `prompts.py`. Without it, the LLM doesn't know how to write "not interviewed in the last 60 days".

```text
Interview tracking columns (kept up to date by the My List screen):
- "Interview Status": one of 'Not Interviewed', 'Shortlisted', 'Interviewed'.
- "Last Interviewed": text 'YYYY-MM-DD HH:MM:SS' (local time) of the most recent
  interview, NULL if the employee was never interviewed.
How to use them:
- not interviewed / never interviewed  -> "Last Interviewed" IS NULL
- not interviewed in the last N days    -> ("Last Interviewed" IS NULL OR "Last Interviewed" < datetime('now','localtime','-N days'))
- interviewed in the last N days        -> "Last Interviewed" >= datetime('now','localtime','-N days')
- shortlisted                           -> "Interview Status" = 'Shortlisted'
These are not skills: never use them for skill matching.
For numeric comparisons on experience / counts use CAST(column AS REAL), e.g. CAST("Total Experience" AS REAL) > 4.5.
```

### 2.6 Restart the API
`sl_agent3.get_table_schema()` caches the table schema until the process restarts. Restart after the repair so the AI sees the new columns.

---

## 3. Frontend

### 3.1 `config.js`
Add one key to `API_CONFIG`:

```js
MY_LIST: "/my-list",
```

(`App.jsx` falls back to `"/my-list"` if you forget.)

### 3.2 `App.jsx`
**Option A (simplest).** If your `App.jsx` is still the same as the one you shared, replace it with `app.jsx` from this folder.

**Option B.** If yours has changed since, copy these blocks across. Every change is additive; your existing logic is untouched. Line numbers refer to `app.jsx` in this folder.

| # | Where | What |
|---|---|---|
| 1 | top comment + `import React …` (11–24) | extra hooks: `useMemo, useContext, createContext` |
| 2 | right after `downloadTableAsExcel()` (153–457) | whole **"My List helpers"** block (constants, filters, export builder, date formatting) |
| 3 | replace `DataTable` (473–622) | `MyListContext` + `DataTable` with row checkboxes, **Add to my list**, status badges. The Excel button is unchanged |
| 4 | `MessageContent` (624) | new `meta` prop, passed to both `<DataTable>` uses |
| 5 | `ChatBubble` (677) | new `question` prop; passes `meta={{ question, sql: message.sql }}` |
| 6 | after `EmptyChatState` (714–1600) | `useMyList`, `ListCells`, `MyListCard`, `MyListPanel` |
| 7 | in `App()`, after `textareaRef` (1716) | `useMyList(...)`, `listOpen`, `listMaximized`, context value |
| 8 | header, before the session tag (1876) | **☰ My List** toggle button |
| 9 | the chat `<section>` (1996–) | wrapped in `MyListContext.Provider` + `dc-workspace`, `<MyListPanel>` added beside it; `ChatBubble` gets `question={findPreviousQuestion(messages, i)}` |
| 10 | styles | `--dc-warn*` tokens in `:root`; `.dc-table-toolbar` gets `flex-wrap/gap`; new blocks from `/* ---- Add to my list` to just before `/* ---- Responsive`; one extra `@media (max-width: 1100px)` block and 3 lines in the 860px block |

---

## 4. Check it works

1. **Startup log:** there should be no `[my_list] WARNING`. A note that `employee_master_data` was not found only appears on an empty DB.
2. **DB:**
   ```sql
   SELECT "Interview Status", COUNT(*) FROM employee_master_data GROUP BY 1;   -- all 'Not Interviewed' at first
   SELECT COUNT(*) FROM employee_master_data WHERE typeof("Contact") = 'blob'; -- 0 after the repair
   SELECT COUNT(*) FROM employee_master_data WHERE "Employee Number" LIKE '%.0'; -- 0 after the repair
   ```
3. **UI:**
   1. Ask a question and tick 2 rows, then click **Add to my list**.
   2. Open **☰ My List** and click **Mark interviewed** on one row. The row should collapse.
   3. Run the SQL above again: that employee now shows `Interviewed` with a time.
   4. Apply a filter, then click **⬇ Excel** in the toolbar. You should get only the rows shown, with only the visible columns.
4. **Chat:** try "employees not interviewed", "employees not interviewed in the last 60 days", and "employees with total experience above 10". The last one should now include people with 10.5 or 12 years.

---

## 5. How it fits together

```
Add to my list ─┐                              ┌─> my_list / my_list_items      (per user)
Mark interviewed ├─> /my-list API ─> my_list_db ├─> employee_interview_status    (one row per employee, shared)
Remove / delete ─┘                              └─> employee_master_data."Interview Status" / "Last Interviewed"

Upload ─> merge_employee_files (fixed by merge_fixes) ─> rebuilds employee_master_data
                                                     └─> same transaction: puts the two interview columns back
```

`employee_interview_status` is the source of truth. The two columns on `employee_master_data` are a copy, rewritten on every change and every upload. To refill them by hand (for example, after running `merge_data4.py` from the command line), run `python my_list_db.py`.

**Excel download in My List:**
- The toolbar **⬇ Excel** exports every candidate currently shown, with filters, search, status and hidden columns applied.
- Each list card has its own **⬇ Excel**.
- Both add these columns: `List Query`, `Added On`, `Status In List`, `Interviewed On`, `Last Interviewed (any list)`, `Interview Count`.

---

## 6. Phone numbers showing `\x03|\x82J…`: where it comes from and where it's fixed

**Cause (reproduced):** in `merge_data4.py`, pandas passes Excel numbers on as numpy integers (`np.int64`). `sqlite3` doesn't recognise that type and stores its raw 8 bytes as a BLOB. Your viewer then shows `b'\x03|\x82J\x02\x00\x00\x00'`, which is just 9840000003 in binary. It happens in `clean_value()` / `save_to_sqlite()`.

There is a related bug with the same cause. One row in an upload with a blank Employee ID turns every ID in that file into a decimal (`101.0`). That also wiped those employees' `Source_Files` and `New_Available_Addition` values.

**Fix:** `merge_fixes.apply_merge_fixes()` (step 2.3) swaps in fixed versions of those two functions. `merge_data4.py` itself stays untouched. Values that are already broken get fixed by the one-time `python merge_fixes.py`, or automatically on the next upload.

To fold the fix into `merge_data4.py` later, `merge_fixes.py` has drop-in versions of `clean_value` and `save_to_sqlite` (`save_master_table`).

**The other DB file you mentioned:**
- `dbb.py` (the Postgres skill lookup) doesn't touch phone numbers, so it isn't the cause.
- If another SQLite file shows the same garbage, run `python merge_fixes.py path\to\that.db table_name`.
- If another script writes to that file with pandas `to_sql`, pass the DataFrame through `merge_fixes.clean_master_frame(df)` before writing.
- If you share that file or script, I can check it.

---

## 7. Bugs found while testing

### Fixed on top (no edits to your files)
| # | Where | Problem | How it was confirmed |
|---|---|---|---|
| 1 | `merge_data4` | Numbers stored as bytes (the `\x03…` phone numbers) | Reproduced; repaired by `merge_fixes` |
| 2 | `merge_data4` | A blank-ID row turned IDs into `101.0`, and those employees lost `Source_Files` and `New_Available_Addition` | Reproduced; fixed |
| 3 | `merge_data4.save_to_sqlite` | If saving failed partway, **the table was left empty** | Forced a failure: 3 rows went to 0. Now the swap is all-or-nothing |
| 4 | Every column was TEXT | `"Total Experience" > 4.5` compared text, so people with 10+ years were silently missed | Proven in SQLite; columns are now numeric, plus the `CAST` prompt rule |

### In your original code: not changed, patches you can apply
**A. `app.py`: one chat query freezes the whole server.**
`async def chat` calls the blocking `get_result()`, so while the LLM is working, every other request waits: other users, uploads and My List clicks. Measured: 3.3 s instead of 0.3 s. The upload endpoint has the same problem.

```python
from fastapi.concurrency import run_in_threadpool

@app.post("/chat")
def chat(request: ChatRequest):            # was: async def
    ...

# in upload_files():
await run_in_threadpool(merge_employee_files, uploaded_files)   # was: merge_employee_files(uploaded_files)
```

**B. `App.jsx`: large results can blank the whole page.**
When session storage fills up (about 5 MB in Chrome, i.e. a few big result tables), the history save throws and React unmounts the app. Confirmed: the page went blank. Wrap the existing effect (around line 1725):

```js
useEffect(() => {
  try {
    sessionStorage.setItem(STORAGE_KEYS.CHAT_HISTORY, JSON.stringify(messages));
  } catch {
    // storage full: keep chatting, history just isn't saved
  }
}, [messages]);
```

**C. `app.py` upload: the file name is used as given.**
A crafted name like `..\..\x.xlsx` could write outside `uploads`. Use:

```python
file_path = os.path.join(UPLOAD_DIR, os.path.basename(file.filename))
```

**D. `sl_agent3.py`: the AI's SQL can modify the database.**
The keyword check in `validate_sql` is commented out. Now that the DB holds interview history that can't be re-uploaded, open it read-only for the agent instead. I tested this with SQLAlchemy 2.0: SELECT works and DELETE is refused.

```python
SQLITE_URI = f"sqlite:///file:{SQLITE_DB_PATH.replace(os.sep, '/')}?mode=ro&uri=true"
```

(Don't just re-enable the old keyword list. `"UPDATE" in sql` would also block every query that mentions `last_updated`.)

**E. `merge_data4`: stale availability (needs your decision).**
Allocation Status is merged rather than replaced, so someone who moves from Unallocated to Allocated becomes `"Allocated, Unallocated"` and still shows `Available = Yes`. People who leave the pool are never removed, and `New_Available_Addition` / `Future_Release` never go back to "No". Two questions:
- Should the newest file's Allocation Status replace the old one?
- Should employees missing from a new "Available Pool" file be marked unavailable?

**F. `merge_data4.build_master_dataframe`: future pandas break (minor).**
pandas warns that `master_df.loc[touched_mask, LAST_UPDATED_COLUMN] = upload_time` will become an error in a future version. Add this line just before it:

```python
master_df[LAST_UPDATED_COLUMN] = master_df[LAST_UPDATED_COLUMN].astype(object)
```

### Known limits of My List
- The user comes from the `X-User` header that the UI sends (the Keycloak username). The backend doesn't verify the token. When nobody is logged in, everyone shares one list called `default`.
- Rows in a list are a snapshot from when they were added. Only `Interview Status` and `Last Interviewed` are shown live.

---

## 8. Turning it off
- Remove the 6 lines from step 2.3 and the `MY_LIST` key.
- Go back to your old `App.jsx`.

The new tables can stay in the DB; nothing else reads them. The two extra columns disappear on the next upload.
