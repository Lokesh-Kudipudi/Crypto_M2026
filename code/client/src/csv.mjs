// Small CSV reader and writer (RFC 4180): quoted fields, escaped quotes, newlines in quotes.

/** Returns one object per row, keyed by the header row. Throws on unbalanced quotes. */
export function parseCsv(text) {
  const source = text.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error("A quoted value in this CSV is never closed.");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  const filled = rows.filter((r) => r.some((value) => value.trim() !== ""));
  if (!filled.length) return [];
  const headers = filled[0].map((h) => h.trim());
  return filled.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// Spreadsheets run cells starting with these as formulas, so a certificate field
// containing "=HYPERLINK(...)" could otherwise act when the export is opened.
const FORMULA_START = /^[=+\-@\t\r]/;

function escapeCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** columns: [{ key, label }] */
export function toCsv(rows, columns) {
  const lines = [columns.map((c) => escapeCell(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => escapeCell(row[c.key])).join(","));
  return lines.join("\r\n") + "\r\n";
}
