// ---------------------------------------------------------------------------
// App.jsx
//
// Required packages (install before running):
//   npm install react react-dom axios react-markdown remark-gfm keycloak-js xlsx
//
// This file intentionally contains the entire UI + logic in one component
// file, per project requirements. All endpoints / storage keys / limits live
// in ./config.js — nothing here hardcodes a URL.
//
// My List (shortlist + interview tracking) uses the endpoints in
// my_list_api.py. Add `MY_LIST: "/my-list"` to API_CONFIG in ./config.js
// (falls back to "/my-list" when absent).
// ---------------------------------------------------------------------------

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useContext,
  createContext,
} from "react";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as XLSX from "xlsx";
import { API_CONFIG, STORAGE_KEYS, APP_CONFIG, KEYCLOAK_CONFIG } from "./config";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function generateSessionId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `sess-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function tryParseTable(content) {
  let candidate = content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (
    candidate &&
    typeof candidate === "object" &&
    Array.isArray(candidate.columns) &&
    Array.isArray(candidate.rows)
  ) {
    return candidate;
  }
  return null;
}

function pythonReprToJson(input) {
  let out = "";
  let inString = false;
  let quoteChar = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (ch === "\\") {
        out += ch + (input[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === quoteChar) {
        inString = false;
        out += '"';
        continue;
      }
      if (ch === '"') {
        out += '\\"';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      quoteChar = ch;
      out += '"';
      continue;
    }
    out += ch;
  }
  return out.replace(/\bNone\b/g, "null").replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");
}

function extractQueryResultPayload(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"result"')) return null;

  const sqlMatch = trimmed.match(/"sql":\s*"([\s\S]*?)",\s*"result"/);
  const resultMatch = trimmed.match(/"result":\s*"([\s\S]*)"\s*}\s*$/);
  if (!resultMatch) return null;

  const rawResult = resultMatch[1].trim();
  let table = null;
  try {
    const parsed = JSON.parse(pythonReprToJson(rawResult));
    if (parsed && Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      table = parsed;
    }
  } catch {
    // fall through
  }

  return { sql: sqlMatch ? sqlMatch[1] : null, table, rawResult };
}

// Builds a .xlsx workbook from a { columns, rows } table and triggers a
// browser download. Runs entirely client-side via SheetJS — no backend
// endpoint required.
function downloadTableAsExcel(table, filename = "query-result") {
  const { columns, rows } = table;
  const aoa = [columns.map((c) => String(c)), ...rows.map((row) => row.map((cell) => cell))];
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Result");

  const safeName = filename.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) || "query-result";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  XLSX.writeFile(workbook, `${safeName}-${stamp}.xlsx`);
}

// ---------------------------------------------------------------------------
// My List helpers
// ---------------------------------------------------------------------------

const MY_LIST_PATH = API_CONFIG.MY_LIST || "/my-list";
const MY_LIST_ACTIVE_VIEW_KEY = "dc_my_list_active_view";

const LIST_STATUS = {
  SHORTLISTED: "Shortlisted",
  INTERVIEWED: "Interviewed",
};

// Header names (lower-cased, "_" / "." -> space) that identify the employee
// id / name column in a result. Mirrors my_list_db.py.
const EMPLOYEE_ID_HEADERS = new Set([
  "employee number", "employee no", "employee id", "emp id", "emp no", "emp number", "empid",
]);

function normalizeHeader(name) {
  return String(name).replace(/[_.]/g, " ").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function findColumnIndex(columns, headers) {
  return columns.findIndex((col) => headers.has(normalizeHeader(col)));
}

// Same normalisation as merge_employee_files / my_list_db: "12345.0" -> "12345".
function normalizeEmpId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || ["nan", "none", "null"].includes(text.toLowerCase())) return null;
  return /^\d+(\.0+)?$/.test(text) ? String(parseInt(text, 10)) : text;
}

// Interview columns that my_list_db keeps on employee_master_data. Rows in a
// list are snapshots from when they were added, so these two are shown live.
const MASTER_STATUS_COLUMN = "Interview Status";
const MASTER_LAST_INTERVIEWED_COLUMN = "Last Interviewed";

// Same format as the "Last Interviewed" column in the DB: YYYY-MM-DD HH:MM:SS.
function formatSqlDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function itemCellValue(item, column, employeeStatus) {
  if (column === MASTER_STATUS_COLUMN) {
    const status = employeeStatus[item.employee_number];
    return !status || status.status === "Removed" ? "Not Interviewed" : status.status;
  }
  if (column === MASTER_LAST_INTERVIEWED_COLUMN) {
    return formatSqlDateTime(employeeStatus[item.employee_number]?.last_interviewed);
  }
  return item.row?.[column];
}

// { columns, rows } for downloadTableAsExcel: the visible data columns plus
// list / interview tracking columns, for the entries currently shown.
function buildListExportTable(entries, dataColumns, employeeStatus) {
  const columns = [
    ...dataColumns,
    "List Query",
    "Added On",
    "Status In List",
    "Interviewed On",
    "Last Interviewed (any list)",
    "Interview Count",
  ];
  const rows = [];
  entries.forEach(({ list, items }) =>
    items.forEach((item) => {
      const status = employeeStatus[item.employee_number];
      rows.push([
        ...dataColumns.map((col) => {
          const value = itemCellValue(item, col, employeeStatus);
          return value === null || value === undefined ? "" : value;
        }),
        list.query || "",
        formatSqlDateTime(list.created_at),
        item.status,
        formatSqlDateTime(item.interviewed_at),
        formatSqlDateTime(status?.last_interviewed),
        status?.interview_count ?? 0,
      ]);
    })
  );
  return { columns, rows };
}

function findPreviousQuestion(messages, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function formatDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString([], {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function errorDetail(err, fallback) {
  const detail = err?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d?.msg).filter(Boolean).join("; ") || fallback;
  return err?.message || fallback;
}

// Badge for an employee's row in employee_interview_status.
function describeEmployeeStatus(status) {
  if (!status) return null;
  if (status.status === LIST_STATUS.INTERVIEWED) {
    return { tone: "done", label: `Interviewed · ${formatDate(status.last_interviewed)}` };
  }
  if (status.status === LIST_STATUS.SHORTLISTED) {
    return {
      tone: "accent",
      label: status.last_interviewed
        ? `Shortlisted · last interviewed ${formatDate(status.last_interviewed)}`
        : "Shortlisted",
    };
  }
  return null;
}

function statusTooltip(status) {
  if (!status) return undefined;
  return [
    `Status: ${status.status}`,
    status.last_interviewed && `Last interviewed: ${formatDateTime(status.last_interviewed)}`,
    `Interviews: ${status.interview_count ?? 0}`,
    status.updated_by && `Updated by: ${status.updated_by}`,
    status.updated_at && `Updated: ${formatDateTime(status.updated_at)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// --- Filters / saved views ---------------------------------------------------

const QUERY_FIELD = "__query__";

const FILTER_OPERATORS = [
  { value: "contains", label: "contains" },
  { value: "contains_any", label: "contains any of" },
  { value: "not_contains", label: "does not contain" },
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "starts_with", label: "starts with" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "empty", label: "is empty" },
  { value: "not_empty", label: "is not empty" },
];

const VALUELESS_OPERATORS = new Set(["empty", "not_empty"]);

const NUMERIC_OPERATORS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
};

const EMPTY_LIST_CONFIG = {
  search: "",
  statusFilter: "all",
  match: "all",
  conditions: [],
  hiddenColumns: [],
};

// Always returns the same key order so configs can be compared as JSON.
function normalizeListConfig(config) {
  const c = config || {};
  return {
    search: typeof c.search === "string" ? c.search : "",
    statusFilter: ["all", "pending", "interviewed"].includes(c.statusFilter) ? c.statusFilter : "all",
    match: c.match === "any" ? "any" : "all",
    conditions: Array.isArray(c.conditions) ? c.conditions : [],
    hiddenColumns: Array.isArray(c.hiddenColumns) ? c.hiddenColumns : [],
  };
}

function newCondition(column = "") {
  return {
    id: `cond-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    column,
    operator: "contains",
    value: "",
  };
}

function isConditionComplete(cond) {
  if (!cond?.column) return false;
  return VALUELESS_OPERATORS.has(cond.operator) || String(cond.value ?? "").trim() !== "";
}

function isBlankCell(text) {
  return text === "" || ["nan", "none", "null"].includes(text.toLowerCase());
}

function matchesCondition(rawValue, { operator, value }) {
  const cell = rawValue === null || rawValue === undefined ? "" : String(rawValue).trim();
  const hay = cell.toLowerCase();
  const needle = String(value ?? "").trim().toLowerCase();

  if (NUMERIC_OPERATORS[operator]) {
    const a = parseFloat(cell);
    const b = parseFloat(value);
    return !Number.isNaN(a) && !Number.isNaN(b) && NUMERIC_OPERATORS[operator](a, b);
  }

  switch (operator) {
    case "contains":
      return hay.includes(needle);
    case "contains_any":
      return needle
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .some((part) => hay.includes(part));
    case "not_contains":
      return !hay.includes(needle);
    case "equals":
      return hay === needle;
    case "not_equals":
      return hay !== needle;
    case "starts_with":
      return hay.startsWith(needle);
    case "empty":
      return isBlankCell(cell);
    case "not_empty":
      return !isBlankCell(cell);
    default:
      return true;
  }
}

function itemMatchesConfig(item, list, config, employeeStatus) {
  const interviewed = item.status === LIST_STATUS.INTERVIEWED;
  if (config.statusFilter === "pending" && interviewed) return false;
  if (config.statusFilter === "interviewed" && !interviewed) return false;

  const search = config.search.trim().toLowerCase();
  if (search) {
    const haystack = [list.query, ...Object.values(item.row || {})].join(" \u0001 ").toLowerCase();
    if (!haystack.includes(search)) return false;
  }

  const active = config.conditions.filter(isConditionComplete);
  if (active.length === 0) return true;
  const test = (cond) =>
    matchesCondition(
      cond.column === QUERY_FIELD ? list.query : itemCellValue(item, cond.column, employeeStatus),
      cond
    );
  return config.match === "any" ? active.some(test) : active.every(test);
}

function describeCondition(cond) {
  const op = FILTER_OPERATORS.find((o) => o.value === cond.operator)?.label ?? cond.operator;
  const col = cond.column === QUERY_FIELD ? "Query" : cond.column;
  return VALUELESS_OPERATORS.has(cond.operator) ? `${col} ${op}` : `${col} ${op} "${cond.value}"`;
}

function rememberActiveView(viewId) {
  try {
    if (viewId === null || viewId === undefined) localStorage.removeItem(MY_LIST_ACTIVE_VIEW_KEY);
    else localStorage.setItem(MY_LIST_ACTIVE_VIEW_KEY, String(viewId));
  } catch {
    // storage unavailable — view just isn't remembered
  }
}

function readRememberedView() {
  try {
    return localStorage.getItem(MY_LIST_ACTIVE_VIEW_KEY);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Presentational sub-components
// ---------------------------------------------------------------------------

function Spinner({ size = 16 }) {
  return (
    <span
      className="dc-spinner"
      style={{ width: size, height: size, borderWidth: Math.max(2, size / 8) }}
      aria-label="Loading"
    />
  );
}

// Provides My List actions + employee status to result tables in the chat.
const MyListContext = createContext(null);

function DataTable({ table, filename, meta }) {
  const { columns, rows } = table;
  const myList = useContext(MyListContext);
  const empIdx = useMemo(() => findColumnIndex(columns, EMPLOYEE_ID_HEADERS), [columns]);
  const trackable = Boolean(myList) && empIdx !== -1;

  const [selected, setSelected] = useState(() => new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [addNotice, setAddNotice] = useState(null);

  useEffect(() => {
    if (!addNotice) return;
    const t = setTimeout(() => setAddNotice(null), 6000);
    return () => clearTimeout(t);
  }, [addNotice]);

  const allSelected = rows.length > 0 && selected.size === rows.length;

  const toggleRow = (ri) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ri)) next.delete(ri);
      else next.add(ri);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((_, i) => i)));
  };

  // Adds the selected rows, or every row when nothing is selected.
  const handleAddToList = async () => {
    const picked = selected.size > 0 ? rows.filter((_, i) => selected.has(i)) : rows;
    setIsAdding(true);
    setAddNotice(null);
    try {
      const res = await myList.addToList({
        query: meta?.question || "",
        sql: meta?.sql || null,
        columns: columns.map((c) => String(c)),
        rows: picked,
      });
      const skipped = res?.skipped ? ` · ${res.skipped} skipped (duplicate / no Employee Number)` : "";
      setAddNotice({ type: "success", message: `Added ${res?.added ?? picked.length} to My List${skipped}` });
      setSelected(new Set());
    } catch (err) {
      setAddNotice({ type: "error", message: err.message });
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div>
      <div className="dc-table-toolbar">
        {addNotice && (
          <span className={`dc-add-notice dc-add-notice-${addNotice.type}`}>
            {addNotice.type === "success" ? "✓" : "!"} {addNotice.message}
            {addNotice.type === "success" && (
              <button type="button" className="dc-link-btn" onClick={myList.openList}>
                Open list
              </button>
            )}
          </span>
        )}
        {myList && (
          <button
            type="button"
            className="dc-btn dc-btn-ghost dc-addlist-btn"
            onClick={handleAddToList}
            disabled={!trackable || isAdding || rows.length === 0}
            title={
              trackable
                ? "Add the selected rows (or all rows if none are selected) to My List"
                : "This result has no Employee Number column"
            }
          >
            {isAdding ? <Spinner size={12} /> : "＋"}{" "}
            {selected.size > 0 ? `Add ${selected.size} to my list` : "Add to my list"}
          </button>
        )}
        <button
          type="button"
          className="dc-btn dc-btn-ghost dc-excel-btn"
          onClick={() => downloadTableAsExcel(table, filename)}
          title="Download this result as an Excel file"
        >
          ⬇ Excel
        </button>
      </div>
      <div className="dc-table-wrap">
        <table className="dc-table">
          <thead>
            <tr>
              {trackable && (
                <th className="dc-sel-col">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && !allSelected;
                    }}
                    onChange={toggleAll}
                    aria-label="Select all rows"
                  />
                </th>
              )}
              {columns.map((col, i) => (
                <th key={i}>{String(col)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => {
              const status = trackable ? myList.employeeStatus[normalizeEmpId(row[empIdx])] : null;
              const badge = describeEmployeeStatus(status);
              return (
                <tr key={ri} className={selected.has(ri) ? "dc-row-selected" : undefined}>
                  {trackable && (
                    <td className="dc-sel-col">
                      <div className="dc-sel-cell">
                        <input
                          type="checkbox"
                          checked={selected.has(ri)}
                          onChange={() => toggleRow(ri)}
                          aria-label={`Select row ${ri + 1}`}
                        />
                        {badge && (
                          <span className={`dc-chip dc-chip-${badge.tone}`} title={statusTooltip(status)}>
                            {badge.label}
                          </span>
                        )}
                      </div>
                    </td>
                  )}
                  {row.map((cell, ci) => (
                    <td key={ci}>{String(cell)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MessageContent({ content, meta }) {
  const table = tryParseTable(content);
  if (table) return <DataTable table={table} filename="query-result" meta={meta} />;

  const queryPayload = extractQueryResultPayload(content);
  if (queryPayload && (queryPayload.table || queryPayload.sql)) {
    return (
      <div>
        {queryPayload.sql && (
          <details className="dc-sql-details">
            <summary>View generated SQL</summary>
            <pre className="dc-sql-block">
              <code>{queryPayload.sql}</code>
            </pre>
          </details>
        )}
        {queryPayload.table ? (
          <DataTable
            table={queryPayload.table}
            filename="query-result"
            meta={{ ...meta, sql: queryPayload.sql || meta?.sql }}
          />
        ) : (
          <div className="dc-markdown">
            <p>{queryPayload.rawResult || "No results returned."}</p>
          </div>
        )}
      </div>
    );
  }

  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);

  return (
    <div className="dc-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ node, ...props }) => (
            <div className="dc-table-wrap">
              <table className="dc-table" {...props} />
            </div>
          ),
          a: ({ node, ...props }) => <a target="_blank" rel="noreferrer" {...props} />,
          img: ({ node, ...props }) => <img className="dc-md-img" {...props} alt={props.alt || ""} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ChatBubble({ message, question }) {
  const isUser = message.role === "user";
  const isError = message.role === "error";
  return (
    <div className={`dc-bubble-row ${isUser ? "dc-row-user" : "dc-row-assistant"}`}>
      <div
        className={
          "dc-bubble " +
          (isUser ? "dc-bubble-user" : isError ? "dc-bubble-error" : "dc-bubble-assistant")
        }
      >
        {/* Show SQL query in a collapsible section for assistant messages */}
        {!isUser && message.sql && (
          <details className="dc-sql-details">
            <summary>View SQL Query</summary>
            <pre className="dc-sql-block">
              <code>{message.sql}</code>
            </pre>
          </details>
        )}
        <MessageContent content={message.content} meta={{ question, sql: message.sql }} />
        {message.timestamp && <div className="dc-timestamp">{formatTime(message.timestamp)}</div>}
      </div>
    </div>
  );
}

function EmptyChatState() {
  return (
    <div className="dc-empty-state">
      <div className="dc-empty-mark">§</div>
      <p className="dc-empty-title">No conversation yet</p>
      <p className="dc-empty-sub">Ask a question to get started.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My List — data hook
// ---------------------------------------------------------------------------

// Every My List endpoint returns the fresh state ({ lists, employee_status }
// or { views }), so each call simply replaces the local copy.
function useMyList(owner) {
  const [lists, setLists] = useState([]);
  const [employeeStatus, setEmployeeStatus] = useState({});
  const [views, setViews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const request = useCallback(
    async (method, path, body, fallbackMessage) => {
      try {
        const { data } = await axios({
          method,
          url: `${API_CONFIG.BASE_URL}${MY_LIST_PATH}${path}`,
          data: body,
          headers: { "X-User": encodeURIComponent(owner) },
        });
        if (Array.isArray(data?.lists)) setLists(data.lists);
        if (data?.employee_status) setEmployeeStatus(data.employee_status);
        if (Array.isArray(data?.views)) setViews(data.views);
        setError(null);
        return data;
      } catch (err) {
        throw new Error(errorDetail(err, fallbackMessage));
      }
    },
    [owner]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const results = await Promise.allSettled([
      request("get", "", undefined, "Could not load My List."),
      request("get", "/views", undefined, "Could not load saved views."),
    ]);
    const failed = results.find((r) => r.status === "rejected");
    setError(failed ? failed.reason.message : null);
    setLoading(false);
  }, [request]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const totals = useMemo(() => {
    let total = 0;
    let interviewed = 0;
    lists.forEach((list) =>
      list.items.forEach((item) => {
        total += 1;
        if (item.status === LIST_STATUS.INTERVIEWED) interviewed += 1;
      })
    );
    return { total, interviewed, pending: total - interviewed };
  }, [lists]);

  return useMemo(
    () => ({
      lists,
      employeeStatus,
      views,
      loading,
      error,
      totals,
      refresh,
      addToList: (payload) => request("post", "", payload, "Could not add to My List."),
      removeItem: (itemId) =>
        request("delete", `/items/${itemId}`, undefined, "Could not remove the candidate."),
      markItemInterviewed: (itemId) =>
        request("post", `/items/${itemId}/interviewed`, undefined, "Could not mark as interviewed."),
      markListInterviewed: (listId, itemIds = null) =>
        request("post", `/${listId}/interviewed`, { item_ids: itemIds }, "Could not mark the list as interviewed."),
      deleteList: (listId) => request("delete", `/${listId}`, undefined, "Could not delete the list."),
      saveView: (name, config) => request("post", "/views", { name, config }, "Could not save the view."),
      deleteView: (viewId) => request("delete", `/views/${viewId}`, undefined, "Could not delete the view."),
    }),
    [lists, employeeStatus, views, loading, error, totals, refresh, request]
  );
}

// ---------------------------------------------------------------------------
// My List — presentational pieces
// ---------------------------------------------------------------------------

function ListCells({ item, columns, employeeStatus }) {
  return columns.map((col) => {
    const value = itemCellValue(item, col, employeeStatus);
    const text = value === null || value === undefined ? "" : String(value);
    return (
      <td key={col} title={text.length > 30 ? text : undefined}>
        {text}
      </td>
    );
  });
}

function MyListCard({
  list,
  items,
  hiddenColumns,
  filterActive,
  employeeStatus,
  collapsed,
  onToggleCollapsed,
  expandedItems,
  onToggleExpanded,
  busyKey,
  onMarkItem,
  onRemoveItem,
  onMarkAll,
  onDeleteList,
  onDownload,
}) {
  const columns = (list.columns || []).filter((c) => !hiddenColumns.includes(c));
  const total = list.items.length;
  const interviewedCount = list.items.filter((i) => i.status === LIST_STATUS.INTERVIEWED).length;
  const pendingTargets = items.filter((i) => i.status !== LIST_STATUS.INTERVIEWED);
  const progress = total ? Math.round((interviewedCount / total) * 100) : 0;
  const listBusy = busyKey === `list-${list.list_id}`;

  return (
    <article className="dc-li-card">
      <header className="dc-li-card-head">
        <button
          type="button"
          className="dc-li-collapse"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand list" : "Collapse list"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <div className="dc-li-title">
          <p className="dc-li-query" title={list.query || ""}>
            {list.query ? `“${list.query}”` : "Untitled query"}
          </p>
          <p className="dc-li-meta">
            <span>Added {formatDateTime(list.created_at)}</span>
            <span>· {total} candidate{total === 1 ? "" : "s"}</span>
            <span>· {interviewedCount} interviewed</span>
            {filterActive && <span>· {items.length} shown</span>}
          </p>
        </div>
        <div className="dc-li-card-actions">
          <button
            type="button"
            className="dc-btn dc-btn-soft dc-tool-btn"
            onClick={() => onMarkAll(list, pendingTargets)}
            disabled={pendingTargets.length === 0 || listBusy}
            title={filterActive ? "Marks the pending candidates currently shown" : "Marks every pending candidate in this list"}
          >
            {listBusy ? <Spinner size={12} /> : "✓"} Mark all interviewed
          </button>
          <button
            type="button"
            className="dc-btn dc-btn-ghost dc-excel-btn"
            onClick={() => onDownload(list, items, columns)}
            disabled={items.length === 0}
            title={filterActive ? "Download the candidates shown (filter applied)" : "Download this list as an Excel file"}
          >
            ⬇ Excel
          </button>
          <button
            type="button"
            className="dc-btn dc-btn-ghost dc-tool-btn dc-danger-text"
            onClick={() => onDeleteList(list)}
            disabled={listBusy}
            title="Delete this list (interview history is kept)"
          >
            Delete list
          </button>
        </div>
      </header>
      <div className="dc-li-progress" title={`${interviewedCount} of ${total} interviewed`}>
        <div style={{ width: `${progress}%` }} />
      </div>

      {!collapsed && (
        <div className="dc-li-card-body">
          {list.sql && (
            <details className="dc-sql-details">
              <summary>View SQL Query</summary>
              <pre className="dc-sql-block">
                <code>{list.sql}</code>
              </pre>
            </details>
          )}
          <div className="dc-table-wrap dc-li-table-wrap">
            <table className="dc-table dc-li-table">
              <thead>
                <tr>
                  <th className="dc-li-actions-col">Actions</th>
                  {columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const busy = busyKey === `item-${item.item_id}` || listBusy;
                  const empStatus = employeeStatus[item.employee_number];

                  if (item.status === LIST_STATUS.INTERVIEWED) {
                    const expanded = expandedItems.has(item.item_id);
                    return (
                      <React.Fragment key={item.item_id}>
                        <tr className="dc-li-row-collapsed">
                          <td colSpan={columns.length + 1}>
                            <div className="dc-li-collapsed-bar">
                              <button
                                type="button"
                                className="dc-li-expand"
                                onClick={() => onToggleExpanded(item.item_id)}
                                aria-expanded={expanded}
                                title={expanded ? "Hide details" : "Show details"}
                              >
                                {expanded ? "▾" : "▸"}
                              </button>
                              <span className="dc-li-done-mark">✓</span>
                              <span className="dc-li-collapsed-name">{item.employee_name || "Unknown"}</span>
                              <span className="dc-li-collapsed-id">#{item.employee_number}</span>
                              <span className="dc-li-collapsed-when" title={statusTooltip(empStatus)}>
                                Interviewed {formatDateTime(item.interviewed_at)}
                              </span>
                              <button
                                type="button"
                                className="dc-li-btn dc-li-btn-remove"
                                onClick={() => onRemoveItem(item)}
                                disabled={busy}
                              >
                                Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="dc-li-row-done">
                            <td className="dc-li-actions-col">
                              <span className="dc-chip dc-chip-done">Interviewed</span>
                            </td>
                            <ListCells item={item} columns={columns} employeeStatus={employeeStatus} />
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  }

                  return (
                    <tr key={item.item_id}>
                      <td className="dc-li-actions-col">
                        <div className="dc-li-actions">
                          <button
                            type="button"
                            className="dc-li-btn dc-li-btn-done"
                            onClick={() => onMarkItem(item)}
                            disabled={busy}
                          >
                            {busy ? <Spinner size={10} /> : "✓"} Mark interviewed
                          </button>
                          <button
                            type="button"
                            className="dc-li-btn dc-li-btn-remove"
                            onClick={() => onRemoveItem(item)}
                            disabled={busy}
                          >
                            Remove
                          </button>
                        </div>
                        {empStatus?.last_interviewed && (
                          <span className="dc-chip dc-chip-warn" title={statusTooltip(empStatus)}>
                            Last interviewed {formatDate(empStatus.last_interviewed)}
                          </span>
                        )}
                      </td>
                      <ListCells item={item} columns={columns} employeeStatus={employeeStatus} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// My List — panel (separate from the chat)
// ---------------------------------------------------------------------------

function MyListPanel({ myList, maximized, onToggleMaximize, onClose }) {
  const { lists, employeeStatus, views, loading, error, totals } = myList;

  // `config` is what is applied; the filter builder edits a draft until
  // "Apply filter" is pressed. Search / status / columns apply instantly.
  const [config, setConfig] = useState(EMPTY_LIST_CONFIG);
  const [draftConditions, setDraftConditions] = useState([]);
  const [draftMatch, setDraftMatch] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [activeViewId, setActiveViewId] = useState(null);
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState("");
  const [expandedItems, setExpandedItems] = useState(() => new Set());
  const [collapsedLists, setCollapsedLists] = useState(() => new Set());
  const [busyKey, setBusyKey] = useState(null);
  const [notice, setNotice] = useState(null);
  const restoredViewRef = useRef(false);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // Union of columns across all lists, in first-seen order.
  const allColumns = useMemo(() => {
    const seen = new Set();
    const out = [];
    lists.forEach((list) =>
      (list.columns || []).forEach((col) => {
        if (!seen.has(col)) {
          seen.add(col);
          out.push(col);
        }
      })
    );
    return out;
  }, [lists]);

  const activeConditions = config.conditions.filter(isConditionComplete);
  const filterActive =
    activeConditions.length > 0 || config.search.trim() !== "" || config.statusFilter !== "all";

  const visibleLists = useMemo(
    () =>
      lists
        .map((list) => ({
          list,
          items: list.items.filter((item) => itemMatchesConfig(item, list, config, employeeStatus)),
        }))
        .filter(({ items }) => !filterActive || items.length > 0),
    [lists, config, filterActive, employeeStatus]
  );
  const shownCount = visibleLists.reduce((n, v) => n + v.items.length, 0);

  const activeView = views.find((v) => v.view_id === activeViewId) || null;
  const viewDirty = activeView
    ? JSON.stringify(normalizeListConfig(activeView.config)) !== JSON.stringify(config)
    : false;
  const draftDirty =
    draftMatch !== config.match ||
    JSON.stringify(draftConditions.filter(isConditionComplete)) !== JSON.stringify(config.conditions);
  const hiddenCount = config.hiddenColumns.filter((c) => allColumns.includes(c)).length;

  const applyView = useCallback((view) => {
    const next = normalizeListConfig(view?.config);
    setConfig(next);
    setDraftConditions(next.conditions);
    setDraftMatch(next.match);
    setActiveViewId(view ? view.view_id : null);
    rememberActiveView(view ? view.view_id : null);
  }, []);

  // Re-open the last used view once views have loaded.
  useEffect(() => {
    if (restoredViewRef.current || views.length === 0) return;
    restoredViewRef.current = true;
    const stored = readRememberedView();
    const view = views.find((v) => String(v.view_id) === stored);
    if (view) applyView(view);
  }, [views, applyView]);

  const runAction = async (key, action, successMessage) => {
    setBusyKey(key);
    try {
      const result = await action();
      if (successMessage) {
        setNotice({
          type: "success",
          message: typeof successMessage === "function" ? successMessage(result) : successMessage,
        });
      }
      return result;
    } catch (err) {
      setNotice({ type: "error", message: err.message });
      return null;
    } finally {
      setBusyKey(null);
    }
  };

  // --- Row / list actions ----------------------------------------------------
  const handleMarkItem = (item) =>
    runAction(`item-${item.item_id}`, () => myList.markItemInterviewed(item.item_id));

  const handleRemoveItem = (item) =>
    runAction(`item-${item.item_id}`, () => myList.removeItem(item.item_id));

  const handleMarkAll = (list, pendingItems) => {
    const n = pendingItems.length;
    if (n === 0) return;
    const scope = filterActive
      ? `the ${n} pending candidate${n === 1 ? "" : "s"} shown`
      : `all ${n} pending candidate${n === 1 ? "" : "s"}`;
    if (!window.confirm(`Mark ${scope} in this list as interviewed?`)) return;
    runAction(
      `list-${list.list_id}`,
      () => myList.markListInterviewed(list.list_id, filterActive ? pendingItems.map((i) => i.item_id) : null),
      (res) => `Marked ${res?.marked ?? n} as interviewed.`
    );
  };

  // Downloads exactly what is on screen: filtered rows, visible columns.
  const exportName = activeView ? `my-list-${activeView.name}` : "my-list";

  const handleDownloadAll = () => {
    const columns = allColumns.filter((c) => !config.hiddenColumns.includes(c));
    downloadTableAsExcel(buildListExportTable(visibleLists, columns, employeeStatus), exportName);
  };

  const handleDownloadList = (list, items, columns) => {
    downloadTableAsExcel(
      buildListExportTable([{ list, items }], columns, employeeStatus),
      `${exportName}-${list.query || "list"}`
    );
  };

  const handleDeleteList = (list) => {
    const n = list.items.length;
    if (!window.confirm(`Delete this list (${n} candidate${n === 1 ? "" : "s"})? Interview history is kept.`)) return;
    runAction(`list-${list.list_id}`, () => myList.deleteList(list.list_id), "List deleted.");
  };

  const toggleInSet = (setter) => (id) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleExpanded = toggleInSet(setExpandedItems);
  const toggleCollapsed = toggleInSet(setCollapsedLists);

  // --- Filter builder --------------------------------------------------------
  const toggleFilterBuilder = () => {
    if (!filterOpen && draftConditions.length === 0) {
      setDraftConditions([newCondition(allColumns[0] || "")]);
    }
    setFilterOpen((v) => !v);
  };

  const updateDraft = (id, patch) =>
    setDraftConditions((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const applyFilter = () => {
    const conditions = draftConditions.filter(isConditionComplete);
    setDraftConditions(conditions);
    setConfig((prev) => ({ ...prev, conditions, match: draftMatch }));
  };

  const clearFilter = () => {
    setDraftConditions([]);
    setDraftMatch("all");
    setConfig((prev) => ({ ...prev, search: "", statusFilter: "all", match: "all", conditions: [] }));
  };

  const removeAppliedCondition = (id) => {
    setConfig((prev) => ({ ...prev, conditions: prev.conditions.filter((c) => c.id !== id) }));
    setDraftConditions((prev) => prev.filter((c) => c.id !== id));
  };

  const toggleColumn = (col) =>
    setConfig((prev) => ({
      ...prev,
      hiddenColumns: prev.hiddenColumns.includes(col)
        ? prev.hiddenColumns.filter((c) => c !== col)
        : [...prev.hiddenColumns, col],
    }));

  // --- Saved views -----------------------------------------------------------
  const handleSaveView = async (name) => {
    const title = (name ?? viewName).trim();
    if (!title) return;
    // Saving also applies whatever is in the filter builder.
    const toSave = { ...config, conditions: draftConditions.filter(isConditionComplete), match: draftMatch };
    setConfig(toSave);
    setDraftConditions(toSave.conditions);
    const res = await runAction("view", () => myList.saveView(title, toSave), `View "${title}" saved.`);
    if (res?.view_id) {
      setActiveViewId(res.view_id);
      rememberActiveView(res.view_id);
      setSavingView(false);
      setViewName("");
    }
  };

  const handleDeleteView = async () => {
    if (!activeView) return;
    if (!window.confirm(`Delete view "${activeView.name}"?`)) return;
    const res = await runAction("view", () => myList.deleteView(activeView.view_id), `View "${activeView.name}" deleted.`);
    if (res) {
      setActiveViewId(null);
      rememberActiveView(null);
    }
  };

  // ---------------------------------------------------------------------------
  return (
    <section className="dc-list-panel" aria-label="My List">
      <div className="dc-chat-header dc-list-header">
        <div>
          <h2 className="dc-panel-title">My List</h2>
          <p className="dc-panel-sub">
            {totals.total} candidate{totals.total === 1 ? "" : "s"} · {totals.interviewed} interviewed ·{" "}
            {lists.length} list{lists.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="dc-list-header-actions">
          <button
            type="button"
            className="dc-btn dc-btn-ghost dc-icon-btn"
            onClick={myList.refresh}
            disabled={loading}
            title="Refresh"
          >
            {loading ? <Spinner size={12} /> : "↻"}
          </button>
          <button
            type="button"
            className="dc-btn dc-btn-ghost dc-icon-btn"
            onClick={onToggleMaximize}
            title={maximized ? "Show chat alongside" : "Expand to full width"}
          >
            {maximized ? "⇤" : "⤢"}
          </button>
          <button type="button" className="dc-btn dc-btn-ghost dc-icon-btn" onClick={onClose} title="Close My List">
            ×
          </button>
        </div>
      </div>

      <div className="dc-list-toolbar">
        {/* Saved views */}
        <div className="dc-list-toolbar-row">
          <label className="dc-field-label" htmlFor="dc-view-select">
            View
          </label>
          <select
            id="dc-view-select"
            className="dc-select dc-view-select"
            value={activeViewId ?? ""}
            onChange={(e) => applyView(views.find((v) => String(v.view_id) === e.target.value) || null)}
          >
            <option value="">All candidates</option>
            {views.map((v) => (
              <option key={v.view_id} value={v.view_id}>
                {v.name}
              </option>
            ))}
          </select>
          {viewDirty && <span className="dc-view-dirty">modified</span>}
          {activeView && viewDirty && !savingView && (
            <button
              type="button"
              className="dc-btn dc-btn-ghost dc-tool-btn"
              onClick={() => handleSaveView(activeView.name)}
              disabled={busyKey === "view"}
            >
              Save changes
            </button>
          )}
          {savingView ? (
            <form
              className="dc-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleSaveView();
              }}
            >
              <input
                autoFocus
                className="dc-text-input"
                placeholder="View name"
                value={viewName}
                maxLength={80}
                onChange={(e) => setViewName(e.target.value)}
              />
              <button
                type="submit"
                className="dc-btn dc-btn-primary dc-tool-btn"
                disabled={!viewName.trim() || busyKey === "view"}
              >
                Save
              </button>
              <button
                type="button"
                className="dc-btn dc-btn-ghost dc-tool-btn"
                onClick={() => {
                  setSavingView(false);
                  setViewName("");
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" className="dc-btn dc-btn-ghost dc-tool-btn" onClick={() => setSavingView(true)}>
              Save as view
            </button>
          )}
          {activeView && !savingView && (
            <button
              type="button"
              className="dc-btn dc-btn-ghost dc-tool-btn dc-danger-text"
              onClick={handleDeleteView}
              disabled={busyKey === "view"}
            >
              Delete view
            </button>
          )}
        </div>

        {/* Search, status, filter, columns */}
        <div className="dc-list-toolbar-row">
          <input
            type="search"
            className="dc-text-input dc-list-search"
            placeholder="Search name, skill, query…"
            value={config.search}
            onChange={(e) => setConfig((prev) => ({ ...prev, search: e.target.value }))}
          />
          <div className="dc-segmented" role="group" aria-label="Interview status">
            {[
              ["all", "All"],
              ["pending", "Pending"],
              ["interviewed", "Interviewed"],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={config.statusFilter === value ? "dc-seg-active" : ""}
                onClick={() => setConfig((prev) => ({ ...prev, statusFilter: value }))}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`dc-btn dc-btn-ghost dc-tool-btn ${filterOpen ? "dc-tool-active" : ""}`}
            onClick={toggleFilterBuilder}
          >
            Filter{activeConditions.length ? ` (${activeConditions.length})` : ""} {filterOpen ? "▴" : "▾"}
          </button>
          <button
            type="button"
            className={`dc-btn dc-btn-ghost dc-tool-btn ${columnsOpen ? "dc-tool-active" : ""}`}
            onClick={() => setColumnsOpen((v) => !v)}
          >
            Columns{hiddenCount ? ` (${allColumns.length - hiddenCount}/${allColumns.length})` : ""}{" "}
            {columnsOpen ? "▴" : "▾"}
          </button>
          <button
            type="button"
            className="dc-btn dc-btn-ghost dc-excel-btn dc-list-excel"
            onClick={handleDownloadAll}
            disabled={shownCount === 0}
            title={
              filterActive
                ? `Download the ${shownCount} candidates shown (filters applied)`
                : "Download every candidate in My List"
            }
          >
            ⬇ Excel{filterActive && shownCount > 0 ? ` (${shownCount})` : ""}
          </button>
        </div>

        {filterOpen && (
          <div className="dc-filter-builder">
            <div className="dc-filter-head">
              <span>Show candidates matching</span>
              <select className="dc-select" value={draftMatch} onChange={(e) => setDraftMatch(e.target.value)}>
                <option value="all">all conditions</option>
                <option value="any">any condition</option>
              </select>
            </div>
            {draftConditions.length === 0 && <p className="dc-muted-note">No conditions yet.</p>}
            {draftConditions.map((cond) => (
              <div className="dc-filter-row" key={cond.id}>
                <select
                  className="dc-select"
                  value={cond.column}
                  onChange={(e) => updateDraft(cond.id, { column: e.target.value })}
                >
                  <option value="" disabled>
                    Column…
                  </option>
                  <option value={QUERY_FIELD}>Query (list)</option>
                  {allColumns.map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </select>
                <select
                  className="dc-select"
                  value={cond.operator}
                  onChange={(e) => updateDraft(cond.id, { operator: e.target.value })}
                >
                  {FILTER_OPERATORS.map((op) => (
                    <option key={op.value} value={op.value}>
                      {op.label}
                    </option>
                  ))}
                </select>
                <input
                  className="dc-text-input"
                  value={cond.value}
                  disabled={VALUELESS_OPERATORS.has(cond.operator)}
                  placeholder={
                    VALUELESS_OPERATORS.has(cond.operator)
                      ? "—"
                      : cond.operator === "contains_any"
                      ? "python, genai, …"
                      : "Value"
                  }
                  onChange={(e) => updateDraft(cond.id, { value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyFilter();
                  }}
                />
                <button
                  type="button"
                  className="dc-file-remove"
                  onClick={() => setDraftConditions((prev) => prev.filter((c) => c.id !== cond.id))}
                  aria-label="Remove condition"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="dc-filter-footer">
              <button
                type="button"
                className="dc-link-btn"
                onClick={() => setDraftConditions((prev) => [...prev, newCondition(allColumns[0] || "")])}
              >
                + Add condition
              </button>
              <div className="dc-filter-footer-actions">
                {draftDirty && <span className="dc-muted-note">Not applied yet</span>}
                <button type="button" className="dc-btn dc-btn-ghost dc-tool-btn" onClick={clearFilter}>
                  Clear
                </button>
                <button type="button" className="dc-btn dc-btn-primary dc-tool-btn" onClick={applyFilter}>
                  Apply filter
                </button>
              </div>
            </div>
          </div>
        )}

        {columnsOpen && (
          <div className="dc-column-picker">
            <div className="dc-column-picker-head">
              <span>Visible columns</span>
              <button
                type="button"
                className="dc-link-btn"
                onClick={() => setConfig((prev) => ({ ...prev, hiddenColumns: [] }))}
              >
                Show all
              </button>
              <button
                type="button"
                className="dc-link-btn"
                onClick={() => setConfig((prev) => ({ ...prev, hiddenColumns: [...allColumns] }))}
              >
                Hide all
              </button>
            </div>
            {allColumns.length === 0 ? (
              <p className="dc-muted-note">Add candidates to choose columns.</p>
            ) : (
              <div className="dc-column-grid">
                {allColumns.map((col) => (
                  <label key={col} className="dc-column-option" title={col}>
                    <input
                      type="checkbox"
                      checked={!config.hiddenColumns.includes(col)}
                      onChange={() => toggleColumn(col)}
                    />
                    <span>{col}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {activeConditions.length > 0 && (
          <div className="dc-filter-chips">
            <span className="dc-muted-note">{config.match === "any" ? "Any of:" : "All of:"}</span>
            {activeConditions.map((cond) => (
              <span key={cond.id} className="dc-filter-chip">
                {describeCondition(cond)}
                <button type="button" onClick={() => removeAppliedCondition(cond.id)} aria-label="Remove filter">
                  ×
                </button>
              </span>
            ))}
            <button type="button" className="dc-link-btn" onClick={clearFilter}>
              Clear all
            </button>
          </div>
        )}
      </div>

      {notice && (
        <div className={`dc-notice dc-notice-${notice.type} dc-list-notice`}>
          {notice.type === "success" ? "✓" : "!"} {notice.message}
        </div>
      )}
      {error && <div className="dc-notice dc-notice-error dc-list-notice">! {error}</div>}

      <div className="dc-list-body">
        {loading && lists.length === 0 ? (
          <div className="dc-empty-state">
            <Spinner size={20} />
          </div>
        ) : lists.length === 0 ? (
          <div className="dc-empty-state">
            <div className="dc-empty-mark">☰</div>
            <p className="dc-empty-title">Your list is empty</p>
            <p className="dc-empty-sub">Run a query in the chat, then click “Add to my list” on a result table.</p>
          </div>
        ) : visibleLists.length === 0 ? (
          <div className="dc-empty-state">
            <p className="dc-empty-title">No candidates match</p>
            <p className="dc-empty-sub">
              <button type="button" className="dc-link-btn" onClick={clearFilter}>
                Clear the filter
              </button>{" "}
              to see everyone.
            </p>
          </div>
        ) : (
          <>
            {filterActive && (
              <p className="dc-list-count">
                Showing {shownCount} of {totals.total} candidates
              </p>
            )}
            {visibleLists.map(({ list, items }) => (
              <MyListCard
                key={list.list_id}
                list={list}
                items={items}
                hiddenColumns={config.hiddenColumns}
                filterActive={filterActive}
                employeeStatus={employeeStatus}
                collapsed={collapsedLists.has(list.list_id)}
                onToggleCollapsed={() => toggleCollapsed(list.list_id)}
                expandedItems={expandedItems}
                onToggleExpanded={toggleExpanded}
                busyKey={busyKey}
                onMarkItem={handleMarkItem}
                onRemoveItem={handleRemoveItem}
                onMarkAll={handleMarkAll}
                onDeleteList={handleDeleteList}
                onDownload={handleDownloadList}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main application
// ---------------------------------------------------------------------------

export default function App() {
  // --- Keycloak auth (manual OAuth2 — no Web Crypto needed) ------------------
  const [authenticated, setAuthenticated] = useState(() => {
    return !!sessionStorage.getItem("kc_access_token");
  });
  const [userName, setUserName] = useState(() => {
    return sessionStorage.getItem("kc_username") || "";
  });
  const initCalled = useRef(false);

  useEffect(() => {
    if (initCalled.current) return;
    initCalled.current = true;

    // Check if returning from Keycloak with an authorization code
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");

    if (code) {
      // Exchange code for tokens
      const tokenUrl = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/token`;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: KEYCLOAK_CONFIG.clientId,
        code: code,
        redirect_uri: window.location.origin + "/",
      });

      fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.access_token) {
            sessionStorage.setItem("kc_access_token", data.access_token);
            // Decode JWT payload to get username
            try {
              const payload = JSON.parse(atob(data.access_token.split(".")[1]));
              const name = payload.preferred_username || payload.name || payload.email || "User";
              sessionStorage.setItem("kc_username", name);
              setUserName(name);
            } catch { /* ignore decode error */ }
            setAuthenticated(true);
          }
          // Clean URL params
          window.history.replaceState({}, document.title, window.location.pathname);
        })
        .catch((err) => {
          console.error("Token exchange failed:", err);
          window.history.replaceState({}, document.title, window.location.pathname);
        });
    }
  }, []);

  const handleLogin = () => {
    const params = new URLSearchParams({
      client_id: KEYCLOAK_CONFIG.clientId,
      redirect_uri: window.location.origin + "/",
      response_type: "code",
      scope: "openid",
    });
    window.location.href = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/auth?${params}`;
  };

  const handleLogout = () => {
    sessionStorage.removeItem("kc_access_token");
    sessionStorage.removeItem("kc_username");
    setAuthenticated(false);
    setUserName("");
    const params = new URLSearchParams({
      client_id: KEYCLOAK_CONFIG.clientId,
      post_logout_redirect_uri: window.location.origin + "/",
    });
    window.location.href = `${KEYCLOAK_CONFIG.url}/realms/${KEYCLOAK_CONFIG.realm}/protocol/openid-connect/logout?${params}`;
  };

  // --- Session ---------------------------------------------------------------
  const [sessionId] = useState(() => {
    const existing = sessionStorage.getItem(STORAGE_KEYS.SESSION_ID);
    if (existing) return existing;
    const fresh = generateSessionId();
    sessionStorage.setItem(STORAGE_KEYS.SESSION_ID, fresh);
    return fresh;
  });

  // --- Upload panel state (collapsed by default) ----------------------------
  const [uploadExpanded, setUploadExpanded] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadNotice, setUploadNotice] = useState(null);
  const fileInputRef = useRef(null);

  // --- Chat panel state ------------------------------------------------------
  const [messages, setMessages] = useState(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEYS.CHAT_HISTORY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  // --- My List (shortlist + interview tracking) ------------------------------
  const myList = useMyList(userName || "default");
  const [listOpen, setListOpen] = useState(false);
  const [listMaximized, setListMaximized] = useState(false);
  const myListContextValue = useMemo(
    () => ({ ...myList, openList: () => setListOpen(true) }),
    [myList]
  );

  // Persist chat history on every change.
  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEYS.CHAT_HISTORY, JSON.stringify(messages));
  }, [messages]);

  // Auto-scroll to latest message.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isSending]);

  // Auto-dismiss upload notices.
  useEffect(() => {
    if (!uploadNotice) return;
    const t = setTimeout(() => setUploadNotice(null), 5000);
    return () => clearTimeout(t);
  }, [uploadNotice]);

  // --- Upload handlers -------------------------------------------------------
  const handleFilePick = (e) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length === 0) return;
    setSelectedFiles((prev) => {
      const merged = [...prev];
      for (const f of picked) {
        const isDup = merged.some((m) => m.name === f.name && m.size === f.size);
        if (!isDup) merged.push(f);
      }
      return merged.slice(0, APP_CONFIG.MAX_FILES_PER_UPLOAD);
    });
    e.target.value = "";
  };

  const removeSelectedFile = (index) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUploadAll = async () => {
    if (selectedFiles.length === 0) return;
    const tooBig = selectedFiles.find(
      (f) => f.size > APP_CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024
    );
    if (tooBig) {
      setUploadNotice({
        type: "error",
        message: `"${tooBig.name}" exceeds the ${APP_CONFIG.MAX_FILE_SIZE_MB}MB limit.`,
      });
      return;
    }

    const formData = new FormData();
    selectedFiles.forEach((file) => formData.append(APP_CONFIG.UPLOAD_FIELD_NAME, file));
    formData.append(APP_CONFIG.SESSION_FIELD_NAME, sessionId);

    setIsUploading(true);
    setUploadProgress(0);
    setUploadNotice(null);

    try {
      const { data } = await axios.post(
        `${API_CONFIG.BASE_URL}${API_CONFIG.FILE_UPLOAD}`,
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" },
          onUploadProgress: (evt) => {
            if (evt.total) {
              setUploadProgress(Math.round((evt.loaded * 100) / evt.total));
            }
          },
        }
      );
      console.log(data);
      setUploadedFiles((prev) => [...prev, ...selectedFiles.map((f) => f.name)]);
      setUploadNotice({
        type: "success",
        message: `Uploaded ${selectedFiles.length} file${selectedFiles.length > 1 ? "s" : ""} successfully.`,
      });
      setSelectedFiles([]);
    } catch (err) {
      const detail =
        err?.response?.data?.detail || err?.message || "Upload failed. Please try again.";
      setUploadNotice({ type: "error", message: detail });
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  // --- Chat handlers ---------------------------------------------------------
  const sendMessage = useCallback(async () => {
    const query = input.trim();
    if (!query || isSending) return;

    const userMessage = { role: "user", content: query, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setChatError(null);
    setIsSending(true);

    try {
      const { data } = await axios.post(`${API_CONFIG.BASE_URL}${API_CONFIG.CHAT}`, {
        question: query,
        session_id: sessionId,
      });

      console.log("API Response:", data);

      const assistantMessage = {
        role: "assistant",
        content: data?.answer ?? "The assistant returned an empty response.",
        sql: data?.sql ?? null,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      const detail =
        err?.response?.data?.detail || err?.message || "Something went wrong reaching the assistant.";
      setChatError(detail);
      setMessages((prev) => [
        ...prev,
        { role: "error", content: detail, timestamp: Date.now() },
      ]);
    } finally {
      setIsSending(false);
    }
  }, [input, isSending, sessionId]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearHistory = () => {
    setMessages([]);
    sessionStorage.removeItem(STORAGE_KEYS.CHAT_HISTORY);
  };

  // ---------------------------------------------------------------------------
  return (
    <div className="dc-app">
      <style>{styles}</style>

      {/* ---- Header ---- */}
      <header className="dc-header">
        <div className="dc-brand">
          {/* <span className="dc-brand-mark">§</span> */}
          <span className="dc-brand-name">Pool Resource Data</span>
        </div>
        <div className="dc-header-actions">
          <button
            className={`dc-btn dc-btn-ghost dc-mylist-toggle ${listOpen ? "dc-mylist-toggle-active" : ""}`}
            onClick={() => setListOpen((v) => !v)}
            title={`${myList.totals.total} candidates · ${myList.totals.pending} pending interview`}
          >
            ☰ My List
            {myList.totals.total > 0 && <span className="dc-upload-badge">{myList.totals.total}</span>}
          </button>
          <div className="dc-session-tag" title="Session identifier">
            SESSION · {sessionId.slice(0, 8)}
          </div>
          {authenticated ? (
            <button className="dc-btn dc-btn-ghost dc-btn-auth" onClick={handleLogout}>
              Logout{userName ? ` (${userName})` : ""}
            </button>
          ) : (
            <button className="dc-btn dc-btn-primary dc-btn-auth" onClick={handleLogin}>
              Login
            </button>
          )}
        </div>
      </header>

      {/* ---- Main ---- */}
      <main className="dc-main">
        {/* Collapsible upload section — visible only when authenticated */}
        {authenticated && (
          <div className={`dc-upload-section ${uploadExpanded ? "dc-upload-expanded" : ""}`}>
            <button
              className="dc-upload-toggle"
              onClick={() => setUploadExpanded((v) => !v)}
            >
              <span className="dc-toggle-chevron">{uploadExpanded ? "▾" : "▸"}</span>
              <span className="dc-toggle-label">Documents</span>
              {uploadedFiles.length > 0 && (
                <span className="dc-upload-badge">{uploadedFiles.length}</span>
              )}
            </button>

            {uploadExpanded && (
              <div className="dc-upload-body">
                <label className="dc-dropzone">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFilePick}
                    hidden
                  />
                  <span className="dc-dropzone-icon">+</span>
                  <span>Click to choose files</span>
                  <span className="dc-dropzone-hint">
                    Multiple files supported · up to {APP_CONFIG.MAX_FILE_SIZE_MB}MB each
                  </span>
                </label>

                {selectedFiles.length > 0 && (
                  <ul className="dc-file-list">
                    {selectedFiles.map((file, i) => (
                      <li className="dc-file-card" key={`${file.name}-${file.size}-${i}`}>
                        <span className="dc-file-index">{String(i + 1).padStart(2, "0")}</span>
                        <div className="dc-file-meta">
                          <span className="dc-file-name" title={file.name}>{file.name}</span>
                          <span className="dc-file-size">{formatBytes(file.size)}</span>
                        </div>
                        <button
                          className="dc-file-remove"
                          onClick={() => removeSelectedFile(i)}
                          aria-label={`Remove ${file.name}`}
                          disabled={isUploading}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <button
                  className="dc-btn dc-btn-primary dc-upload-btn"
                  onClick={handleUploadAll}
                  disabled={selectedFiles.length === 0 || isUploading}
                >
                  {isUploading ? (
                    <>
                      <Spinner size={14} /> Uploading… {uploadProgress}%
                    </>
                  ) : (
                    `Upload ${selectedFiles.length > 0 ? `(${selectedFiles.length})` : ""}`
                  )}
                </button>

                {isUploading && (
                  <div className="dc-progress-track">
                    <div className="dc-progress-fill" style={{ width: `${uploadProgress}%` }} />
                  </div>
                )}

                {uploadNotice && (
                  <div className={`dc-notice dc-notice-${uploadNotice.type}`}>
                    {uploadNotice.type === "success" ? "✓" : "!"} {uploadNotice.message}
                  </div>
                )}

                {uploadedFiles.length > 0 && (
                  <div className="dc-uploaded-block">
                    <p className="dc-uploaded-title">In this session ({uploadedFiles.length})</p>
                    <ul className="dc-uploaded-list">
                      {uploadedFiles.map((name, i) => (
                        <li key={`${name}-${i}`}>
                          <span className="dc-uploaded-dot" /> {name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Workspace — chat (full width) + optional My List panel beside it */}
        <MyListContext.Provider value={myListContextValue}>
          <div
            className={
              "dc-workspace" +
              (listOpen ? " dc-list-open" : "") +
              (listOpen && listMaximized ? " dc-list-max" : "")
            }
          >
            <section className="dc-chat-panel">
              <div className="dc-chat-header">
                <div>
                  <h2 className="dc-panel-title">Assistant</h2>
                  <p className="dc-panel-sub">Ask questions about the documents you've uploaded.</p>
                </div>
                {messages.length > 0 && (
                  <button className="dc-btn dc-btn-ghost" onClick={clearHistory}>
                    Clear chat
                  </button>
                )}
              </div>

              <div className="dc-messages">
                {messages.length === 0 ? (
                  <EmptyChatState />
                ) : (
                  messages.map((m, i) => (
                    <ChatBubble message={m} question={findPreviousQuestion(messages, i)} key={i} />
                  ))
                )}

                {isSending && (
                  <div className="dc-bubble-row dc-row-assistant">
                    <div className="dc-bubble dc-bubble-assistant dc-bubble-typing">
                      <Spinner size={14} /> <span>Thinking…</span>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {chatError && (
                <div className="dc-notice dc-notice-error dc-chat-error">! {chatError}</div>
              )}

              <div className="dc-composer">
                <textarea
                  ref={textareaRef}
                  className="dc-input"
                  placeholder="Ask about your documents… (Enter to send, Shift+Enter for a new line)"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={isSending}
                />
                <button
                  className="dc-btn dc-btn-primary dc-send-btn"
                  onClick={sendMessage}
                  disabled={!input.trim() || isSending}
                >
                  {isSending ? <Spinner size={14} /> : "Send"}
                </button>
              </div>
            </section>

            {listOpen && (
              <MyListPanel
                myList={myList}
                maximized={listMaximized}
                onToggleMaximize={() => setListMaximized((v) => !v)}
                onClose={() => setListOpen(false)}
              />
            )}
          </div>
        </MyListContext.Provider>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --dc-bg: #F1F4F2;
  --dc-surface: #FFFFFF;
  --dc-border: #DDE3DF;
  --dc-ink: #1C2B29;
  --dc-muted: #5B6B66;
  --dc-accent: #2F6F62;
  --dc-accent-hover: #24564B;
  --dc-accent-soft: #E7F0EC;
  --dc-error: #B3261E;
  --dc-error-soft: #FDECEA;
  --dc-success: #1F7A4D;
  --dc-success-soft: #E8F5EE;
  --dc-warn: #8A5A00;
  --dc-warn-soft: #FFF3D6;
}

* { box-sizing: border-box; }

html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
}

.dc-app {
  height: 100vh;
  overflow: hidden;
  background: var(--dc-bg);
  color: var(--dc-ink);
  font-family: 'Inter', system-ui, sans-serif;
  display: flex;
  flex-direction: column;
}

/* ---- Header ---- */
.dc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
  border-bottom: 1px solid var(--dc-border);
  background: var(--dc-surface);
  flex-shrink: 0;
}

.dc-brand { display: flex; align-items: center; gap: 8px; }
.dc-brand-mark {
  font-family: 'Fraunces', serif;
  font-size: 22px;
  color: var(--dc-accent);
}
.dc-brand-name {
  font-family: 'Fraunces', serif;
  font-weight: 600;
  font-size: 19px;
  letter-spacing: 0.01em;
}

.dc-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dc-session-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--dc-muted);
  background: var(--dc-accent-soft);
  border: 1px solid var(--dc-border);
  padding: 5px 10px;
  border-radius: 5px;
}

.dc-btn-auth {
  font-size: 13px;
  padding: 7px 16px;
}

/* ---- Main layout (single column) ---- */
.dc-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 16px 24px;
  width: 100%;
  gap: 12px;
}

/* ---- Collapsible upload section ---- */
.dc-upload-section {
  background: var(--dc-surface);
  border: 1px solid var(--dc-border);
  border-radius: 12px;
  flex-shrink: 0;
  overflow: hidden;
}

.dc-upload-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  background: none;
  border: none;
  cursor: pointer;
  font-family: 'Fraunces', serif;
  font-size: 15px;
  font-weight: 600;
  color: var(--dc-ink);
  text-align: left;
  transition: background 0.15s ease;
}
.dc-upload-toggle:hover {
  background: var(--dc-accent-soft);
}

.dc-toggle-chevron {
  font-size: 12px;
  color: var(--dc-accent);
  width: 16px;
  text-align: center;
}

.dc-toggle-label {
  flex: 1;
}

.dc-upload-badge {
  background: var(--dc-accent);
  color: #fff;
  font-family: 'Inter', sans-serif;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  min-width: 20px;
  text-align: center;
}

.dc-upload-body {
  padding: 0 16px 16px 16px;
  border-top: 1px solid var(--dc-border);
}

/* ---- Chat panel (takes remaining space) ---- */
.dc-chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--dc-surface);
  border: 1px solid var(--dc-border);
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(28,43,41,0.04), 0 8px 24px rgba(28,43,41,0.03);
  overflow: hidden;
  min-height: 0;
}

.dc-chat-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 20px 12px 20px;
  flex-shrink: 0;
}

.dc-panel-title {
  font-family: 'Fraunces', serif;
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 2px 0;
}
.dc-panel-sub {
  font-size: 12.5px;
  color: var(--dc-muted);
  margin: 0;
}

/* ---- Messages (scrollable) ---- */
.dc-messages {
  flex: 1;
  overflow-y: auto;
  padding: 4px 20px 12px 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  scroll-behavior: smooth;
  min-height: 0;
}

.dc-bubble-row { display: flex; width: 100%; margin: 6px 0; }
.dc-row-user { justify-content: flex-end; }
.dc-row-assistant { justify-content: flex-start; }

.dc-bubble {
  max-width: 78%;
  padding: 11px 14px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.5;
  position: relative;
}
.dc-bubble-user { background: var(--dc-accent); color: #fff; border-bottom-right-radius: 4px; }
.dc-bubble-assistant { background: var(--dc-accent-soft); color: var(--dc-ink); border-bottom-left-radius: 4px; max-height: 60vh; overflow-y: auto; overflow-x:auto; }
.dc-bubble-error { background: var(--dc-error-soft); color: var(--dc-error); border-bottom-left-radius: 4px; }
.dc-bubble-typing { display: flex; align-items: center; gap: 8px; color: var(--dc-muted); }

.dc-timestamp { font-size: 10px; opacity: 0.65; margin-top: 4px; text-align: right; }

/* ---- Composer (fixed at bottom) ---- */
.dc-composer {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  border-top: 1px solid var(--dc-border);
  padding: 12px 20px;
  flex-shrink: 0;
  background: var(--dc-surface);
}

.dc-input {
  flex: 1;
  resize: none;
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  padding: 10px 12px;
  font-family: 'Inter', sans-serif;
  font-size: 14px;
  max-height: 140px;
  outline: none;
}
.dc-input:focus { border-color: var(--dc-accent); box-shadow: 0 0 0 3px var(--dc-accent-soft); }
.dc-send-btn { flex-shrink: 0; min-width: 76px; height: 40px; }

.dc-chat-error { margin: 0 20px 8px 20px; flex-shrink: 0; }

/* ---- Upload UI elements ---- */
.dc-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
  border: 1.5px dashed var(--dc-border);
  border-radius: 10px;
  padding: 18px 12px;
  cursor: pointer;
  color: var(--dc-muted);
  font-size: 13px;
  transition: border-color 0.15s ease, background 0.15s ease;
  margin-top: 12px;
}
.dc-dropzone:hover { border-color: var(--dc-accent); background: var(--dc-accent-soft); }
.dc-dropzone-icon {
  font-family: 'Fraunces', serif;
  font-size: 22px;
  color: var(--dc-accent);
  line-height: 1;
  margin-bottom: 2px;
}
.dc-dropzone-hint { font-size: 11px; color: var(--dc-muted); opacity: 0.85; }

.dc-file-list {
  list-style: none;
  margin: 12px 0 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 160px;
  overflow-y: auto;
}

.dc-file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--dc-border);
  border-left: 3px solid var(--dc-accent);
  border-radius: 8px;
  padding: 6px 10px;
  background: #FBFCFB;
  min-width: 200px;
  flex: 0 0 auto;
}
.dc-file-index {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--dc-accent);
  opacity: 0.8;
}
.dc-file-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dc-file-name {
  font-size: 12.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dc-file-size { font-size: 10.5px; color: var(--dc-muted); }
.dc-file-remove {
  border: none;
  background: transparent;
  color: var(--dc-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.dc-file-remove:hover { background: var(--dc-error-soft); color: var(--dc-error); }
.dc-file-remove:disabled { opacity: 0.4; cursor: not-allowed; }

.dc-upload-btn { width: 100%; margin-top: 12px; }

.dc-progress-track {
  height: 6px;
  border-radius: 4px;
  background: var(--dc-border);
  margin-top: 10px;
  overflow: hidden;
}
.dc-progress-fill {
  height: 100%;
  background: var(--dc-accent);
  transition: width 0.2s ease;
}

.dc-notice {
  margin-top: 10px;
  font-size: 12.5px;
  padding: 9px 12px;
  border-radius: 8px;
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.dc-notice-success { background: var(--dc-success-soft); color: var(--dc-success); }
.dc-notice-error { background: var(--dc-error-soft); color: var(--dc-error); }

.dc-uploaded-block { margin-top: 14px; border-top: 1px solid var(--dc-border); padding-top: 10px; }
.dc-uploaded-title { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dc-muted); margin: 0 0 6px 0; }
.dc-uploaded-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; max-height: 100px; overflow-y: auto; }
.dc-uploaded-list li { font-size: 12px; color: var(--dc-ink); display: flex; align-items: center; gap: 6px; }
.dc-uploaded-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dc-success); flex-shrink: 0; }

/* ---- Buttons ---- */
.dc-btn {
  border: none;
  border-radius: 9px;
  font-size: 13.5px;
  font-weight: 600;
  padding: 10px 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.15s ease, transform 0.05s ease;
}
.dc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dc-btn-primary { background: var(--dc-accent); color: #fff; }
.dc-btn-primary:hover:not(:disabled) { background: var(--dc-accent-hover); }
.dc-btn-primary:active:not(:disabled) { transform: scale(0.98); }
.dc-btn-ghost { background: transparent; color: var(--dc-muted); font-weight: 500; padding: 6px 10px; }
.dc-btn-ghost:hover { color: var(--dc-ink); background: var(--dc-accent-soft); }

/* ---- Markdown / content ---- */
.dc-markdown p { margin: 0 0 8px 0; }
.dc-markdown p:last-child { margin-bottom: 0; }
.dc-markdown h1, .dc-markdown h2, .dc-markdown h3 {
  font-family: 'Fraunces', serif;
  margin: 10px 0 6px 0;
}
.dc-markdown ul, .dc-markdown ol { margin: 6px 0; padding-left: 20px; }
.dc-markdown blockquote {
  border-left: 3px solid var(--dc-accent);
  margin: 8px 0;
  padding: 2px 12px;
  color: var(--dc-muted);
  font-style: italic;
}
.dc-markdown code {
  font-family: 'JetBrains Mono', monospace;
  background: rgba(0,0,0,0.06);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12.5px;
}
.dc-markdown pre {
  background: #1C2B29;
  color: #EAF3EF;
  padding: 12px 14px;
  border-radius: 8px;
  max-height: 320px;
  overflow: auto;
  margin: 8px 0;
}
.dc-markdown pre code { background: transparent; color: inherit; padding: 0; }
.dc-markdown a { color: inherit; text-decoration: underline; }
.dc-md-img { max-width: 100%; border-radius: 8px; margin: 6px 0; }

/* ---- SQL details (collapsible in chat bubbles) ---- */
.dc-sql-details { margin: 0 0 10px 0; }
.dc-sql-details summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--dc-accent);
  margin-bottom: 6px;
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dc-sql-details summary::before {
  content: '▸';
  font-size: 10px;
  transition: transform 0.15s ease;
}
.dc-sql-details[open] summary::before {
  transform: rotate(90deg);
}
.dc-sql-details summary::-webkit-details-marker { display: none; }
.dc-sql-block {
  background: #1C2B29;
  color: #EAF3EF;
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- Tables ---- */
.dc-table-toolbar { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
.dc-excel-btn {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--dc-border);
  background: var(--dc-accent-soft);
  color: var(--dc-accent);
}
.dc-excel-btn:hover { background: var(--dc-accent); color: #fff; }

.dc-table-wrap {
  max-height: 320px;
  overflow: auto;
  margin: 8px 0;
  border: 1px solid var(--dc-border);
  border-radius: 8px;
}
.dc-table { border-collapse: collapse; width: 100%; font-size: 13px; }
.dc-table th, .dc-table td { padding: 7px 10px; border-bottom: 1px solid var(--dc-border); text-align: left; white-space: nowrap; }
.dc-table th { background: var(--dc-accent-soft); font-weight: 600; }
.dc-table tr:last-child td { border-bottom: none; }

/* ---- Empty state ---- */
.dc-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--dc-muted);
  padding: 40px 20px;
}
.dc-empty-mark { font-family: 'Fraunces', serif; font-size: 34px; color: var(--dc-accent); margin-bottom: 6px; }
.dc-empty-title { font-weight: 600; color: var(--dc-ink); margin: 0 0 4px 0; font-size: 14.5px; }
.dc-empty-sub { font-size: 12.5px; margin: 0; max-width: 280px; }

/* ---- Spinner ---- */
.dc-spinner {
  display: inline-block;
  border-style: solid;
  border-color: currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: dc-spin 0.7s linear infinite;
  opacity: 0.9;
}
@keyframes dc-spin { to { transform: rotate(360deg); } }

/* ---- Add to my list (chat result tables) ---- */
.dc-addlist-btn {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--dc-accent);
  background: var(--dc-surface);
  color: var(--dc-accent);
  font-weight: 600;
}
.dc-addlist-btn:hover:not(:disabled) { background: var(--dc-accent); color: #fff; }
.dc-add-notice { font-size: 11.5px; display: inline-flex; align-items: center; gap: 6px; }
.dc-add-notice-success { color: var(--dc-success); }
.dc-add-notice-error { color: var(--dc-error); }

.dc-table .dc-sel-col {
  width: 1%;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--dc-accent-soft);
  box-shadow: 1px 0 0 var(--dc-border);
}
.dc-sel-cell { display: flex; align-items: center; gap: 6px; }
.dc-sel-col input[type="checkbox"], .dc-column-option input[type="checkbox"] { accent-color: var(--dc-accent); cursor: pointer; }
.dc-table tr.dc-row-selected td { background: #D9EAE3; }

.dc-chip {
  display: inline-flex;
  align-items: center;
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
  line-height: 1.4;
}
.dc-chip-accent { background: var(--dc-surface); color: var(--dc-accent); border: 1px solid var(--dc-border); }
.dc-chip-done { background: var(--dc-success-soft); color: var(--dc-success); }
.dc-chip-warn { background: var(--dc-warn-soft); color: var(--dc-warn); }

.dc-link-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: var(--dc-accent);
  text-decoration: underline;
  cursor: pointer;
}

/* ---- Header toggle ---- */
.dc-mylist-toggle { font-size: 13px; padding: 6px 12px; border: 1px solid var(--dc-border); }
.dc-mylist-toggle-active { background: var(--dc-accent-soft); color: var(--dc-accent); border-color: var(--dc-accent); }

/* ---- Workspace: chat + My List side by side ---- */
.dc-workspace { flex: 1; display: flex; gap: 12px; min-height: 0; }
.dc-workspace > .dc-chat-panel { min-width: 0; }
.dc-list-panel {
  flex: 0 0 50%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dc-surface);
  border: 1px solid var(--dc-border);
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(28,43,41,0.04), 0 8px 24px rgba(28,43,41,0.03);
  overflow: hidden;
}
.dc-workspace.dc-list-max > .dc-chat-panel { display: none; }
.dc-workspace.dc-list-max > .dc-list-panel { flex: 1 1 auto; }

.dc-list-header { align-items: center; }
.dc-list-header-actions { display: flex; gap: 4px; }
.dc-icon-btn { font-size: 16px; padding: 4px 9px; min-width: 32px; }

.dc-list-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 16px 10px 16px;
  border-bottom: 1px solid var(--dc-border);
  flex-shrink: 0;
}
.dc-list-toolbar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dc-field-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dc-muted); }

.dc-select, .dc-text-input {
  border: 1px solid var(--dc-border);
  border-radius: 8px;
  padding: 6px 9px;
  font-family: 'Inter', sans-serif;
  font-size: 12.5px;
  color: var(--dc-ink);
  background: var(--dc-surface);
  outline: none;
  min-width: 0;
}
.dc-select:focus, .dc-text-input:focus { border-color: var(--dc-accent); box-shadow: 0 0 0 3px var(--dc-accent-soft); }
.dc-text-input:disabled { background: var(--dc-bg); }
.dc-view-select { max-width: 220px; }
.dc-list-search { flex: 1 1 180px; }
.dc-list-excel { font-size: 12.5px; padding: 6px 10px; }
.dc-li-card-actions .dc-excel-btn { padding: 6px 10px; }
.dc-view-dirty { font-size: 11px; color: var(--dc-warn); background: var(--dc-warn-soft); padding: 2px 7px; border-radius: 999px; }
.dc-inline-form { display: inline-flex; gap: 6px; align-items: center; }

.dc-tool-btn { font-size: 12.5px; padding: 6px 10px; border: 1px solid var(--dc-border); }
.dc-btn-primary.dc-tool-btn { border-color: transparent; }
.dc-tool-active { background: var(--dc-accent-soft); color: var(--dc-accent); border-color: var(--dc-accent); }
.dc-btn-soft { background: var(--dc-accent-soft); color: var(--dc-accent); }
.dc-btn-soft:hover:not(:disabled) { background: var(--dc-accent); color: #fff; }
.dc-btn-ghost.dc-danger-text { color: var(--dc-error); }
.dc-btn-ghost.dc-danger-text:hover:not(:disabled) { background: var(--dc-error-soft); color: var(--dc-error); }

.dc-segmented { display: inline-flex; border: 1px solid var(--dc-border); border-radius: 8px; overflow: hidden; }
.dc-segmented button {
  border: none;
  background: var(--dc-surface);
  padding: 6px 10px;
  font-family: 'Inter', sans-serif;
  font-size: 12.5px;
  color: var(--dc-muted);
  cursor: pointer;
}
.dc-segmented button + button { border-left: 1px solid var(--dc-border); }
.dc-segmented button:hover { color: var(--dc-ink); background: var(--dc-accent-soft); }
.dc-segmented button.dc-seg-active { background: var(--dc-accent); color: #fff; }

.dc-filter-builder, .dc-column-picker {
  border: 1px solid var(--dc-border);
  border-radius: 10px;
  padding: 10px;
  background: #FBFCFB;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dc-filter-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--dc-muted); }
.dc-filter-row {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1.3fr) auto;
  gap: 6px;
  align-items: center;
}
.dc-filter-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 12.5px; }
.dc-filter-footer-actions { display: flex; align-items: center; gap: 6px; }
.dc-muted-note { font-size: 11.5px; color: var(--dc-muted); margin: 0; }

.dc-filter-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; }
.dc-filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--dc-accent-soft);
  color: var(--dc-accent);
  border: 1px solid var(--dc-border);
  border-radius: 999px;
  padding: 2px 4px 2px 10px;
  font-size: 11.5px;
  font-weight: 500;
}
.dc-filter-chip button {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
  border-radius: 999px;
}
.dc-filter-chip button:hover { background: var(--dc-surface); }

.dc-column-picker-head { display: flex; align-items: center; gap: 12px; font-size: 12.5px; color: var(--dc-muted); }
.dc-column-picker-head span { flex: 1; }
.dc-column-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 4px 12px;
  max-height: 180px;
  overflow-y: auto;
}
.dc-column-option { display: flex; align-items: center; gap: 6px; font-size: 12.5px; cursor: pointer; min-width: 0; }
.dc-column-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dc-list-notice { margin: 8px 16px 0 16px; flex-shrink: 0; }
.dc-list-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.dc-list-count { font-size: 12px; color: var(--dc-muted); margin: 0; }

/* ---- My List cards ---- */
.dc-li-card {
  border: 1px solid var(--dc-border);
  border-radius: 12px;
  background: var(--dc-surface);
  flex-shrink: 0;
  overflow: hidden;
}
.dc-li-card-head { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px 8px 8px; flex-wrap: wrap; }
.dc-li-collapse {
  border: none;
  background: none;
  color: var(--dc-accent);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
}
.dc-li-collapse:hover { background: var(--dc-accent-soft); }
.dc-li-title { flex: 1 1 220px; min-width: 0; }
.dc-li-query {
  margin: 0;
  font-family: 'Fraunces', serif;
  font-size: 14.5px;
  font-weight: 600;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dc-li-meta { margin: 3px 0 0 0; font-size: 11.5px; color: var(--dc-muted); display: flex; flex-wrap: wrap; gap: 4px; }
.dc-li-card-actions { display: flex; gap: 6px; flex-shrink: 0; }
.dc-li-progress { height: 3px; background: var(--dc-border); margin: 0 12px; border-radius: 2px; overflow: hidden; }
.dc-li-progress > div { height: 100%; background: var(--dc-success); transition: width 0.3s ease; }
.dc-li-card-body { padding: 10px 12px 12px 12px; }
.dc-li-table-wrap { max-height: 380px; margin: 0; }

.dc-li-table thead th { position: sticky; top: 0; z-index: 2; }
.dc-li-table td { max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
.dc-li-table .dc-li-actions-col {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--dc-surface);
  box-shadow: 1px 0 0 var(--dc-border);
  max-width: none;
  overflow: visible;
}
.dc-li-table thead th.dc-li-actions-col { z-index: 3; background: var(--dc-accent-soft); }
.dc-li-actions { display: flex; gap: 4px; }
.dc-li-actions-col .dc-chip { margin-top: 4px; }

.dc-li-btn {
  border: 1px solid var(--dc-border);
  background: var(--dc-surface);
  border-radius: 7px;
  padding: 3px 8px;
  font-family: 'Inter', sans-serif;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.dc-li-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dc-li-btn-done { color: var(--dc-success); }
.dc-li-btn-done:hover:not(:disabled) { background: var(--dc-success-soft); border-color: var(--dc-success); }
.dc-li-btn-remove { color: var(--dc-muted); }
.dc-li-btn-remove:hover:not(:disabled) { background: var(--dc-error-soft); color: var(--dc-error); border-color: var(--dc-error); }

/* Interviewed rows collapse into a single tracking line */
.dc-table tr.dc-li-row-collapsed td {
  background: var(--dc-success-soft);
  padding: 4px 8px;
  max-width: none;
  overflow: visible;
}
.dc-li-collapsed-bar {
  position: sticky;
  left: 8px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  animation: dc-fade-in 0.25s ease;
}
.dc-li-expand {
  border: none;
  background: none;
  color: var(--dc-success);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 4px;
}
.dc-li-expand:hover { background: var(--dc-surface); }
.dc-li-done-mark { color: var(--dc-success); font-weight: 700; }
.dc-li-collapsed-name { font-weight: 600; color: var(--dc-ink); }
.dc-li-collapsed-id { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--dc-muted); }
.dc-li-collapsed-when { color: var(--dc-success); }
.dc-table tr.dc-li-row-done td { color: var(--dc-muted); background: #F6FAF8; }
.dc-table tr.dc-li-row-done td.dc-li-actions-col { background: #F6FAF8; }

@keyframes dc-fade-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }

/* ---- Responsive ---- */
@media (max-width: 1100px) {
  .dc-workspace.dc-list-open > .dc-chat-panel { display: none; }
  .dc-workspace.dc-list-open > .dc-list-panel { flex: 1 1 auto; }
}

@media (max-width: 860px) {
  .dc-main { padding: 12px 12px; }
  .dc-messages { padding: 4px 12px 12px 12px; }
  .dc-composer { padding: 12px; }
  .dc-chat-header { padding: 12px; }
  .dc-list-toolbar { padding: 0 12px 10px 12px; }
  .dc-list-body { padding: 12px; }
  .dc-filter-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
`;
