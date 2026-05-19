/**
 * Bank-statement CSV importer.
 *
 * The killer feature here is meeting users where their data already lives. Most
 * banks (especially African banks where Plaid coverage is poor) export a CSV.
 * We detect the columns heuristically, normalise rows into our Transaction
 * shape, and hand back a preview the user can review before committing.
 *
 * We intentionally keep the parser dependency-free and tolerant of messy input:
 * users will paste real bank exports with mixed quoting and locale-specific
 * number formatting. Anything we can't confidently parse is surfaced as a
 * warning rather than silently dropped.
 */

const DEBIT_COLUMNS = [
  'debit', 'withdrawal', 'withdrawals', 'paid out', 'money out', 'dr',
  // Zenith Bank Nigeria
  'withdrawal dr',
  // FirstBank Nigeria
  'debit amount',
  // UBA Nigeria
  'debit (ngn)', 'debit(ngn)',
  // Access Bank Nigeria
  'withdrawals (n)',
];
const CREDIT_COLUMNS = [
  'credit', 'deposit', 'deposits', 'paid in', 'money in', 'cr',
  // Zenith Bank Nigeria
  'deposits cr',
  // FirstBank Nigeria
  'credit amount',
  // UBA Nigeria
  'credit (ngn)', 'credit(ngn)',
  // Access Bank Nigeria
  'deposits (n)',
];
const AMOUNT_COLUMNS = ['amount', 'value', 'transaction amount'];
const DATE_COLUMNS = [
  'date', 'posting date', 'posted', 'transaction date', 'value date', 'txn date', 'trans date',
  // GTBank Nigeria
  'trans. date',
];
const DESCRIPTION_COLUMNS = [
  'description', 'narration', 'details', 'memo', 'reference', 'particulars', 'transaction details',
  // Zenith Bank Nigeria
  'remarks',
  // GTBank Nigeria
  'trans. details', 'transaction narration',
  // UBA Nigeria
  'transaction remark',
];

export interface ParsedCsvRow {
  rowIndex: number;
  date: string | null;
  amount: number;
  type: 'income' | 'expense';
  description: string;
  warnings: string[];
}

export interface CsvPreview {
  rows: ParsedCsvRow[];
  detectedColumns: {
    date: number | null;
    description: number | null;
    amount: number | null;
    debit: number | null;
    credit: number | null;
  };
  totalRows: number;
  skippedRows: number;
  signConvention: 'debits-negative' | 'debits-positive';
}

/**
 * Tokenises one CSV line into fields. Handles quoted fields containing commas
 * and escaped double quotes ("" -> "). Newlines inside quoted fields are not
 * supported here — for that you'd need a streaming parser. Bank exports almost
 * never embed newlines in fields, so this trade-off is fine.
 */
const tokenizeLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

/**
 * Number parsing that handles the common formats users actually paste:
 *   "1,234.56"   -> 1234.56  (US/UK)
 *   "1.234,56"   -> 1234.56  (EU)
 *   "(123.45)"   -> -123.45  (accounting parens)
 *   "$ 50.00"    -> 50.00
 *   ""           -> NaN
 */
export const parseAmount = (raw: string): number => {
  if (!raw) return NaN;
  let s = raw.trim();
  if (!s) return NaN;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  s = s.replace(/[^0-9.,]/g, '');
  // Pick the rightmost separator as the decimal point.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastDot > lastComma) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
    }
  } else if (lastComma >= 0 && lastDot < 0) {
    // Treat lone comma as decimal only when followed by 1-2 digits at the end.
    if (/,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return negative ? -n : n;
};

const parseDate = (raw: string): string | null => {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // Try native Date for ISO + named formats.
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  // DD/MM/YYYY or MM/DD/YYYY — ambiguous, prefer ISO output when both day and
  // month are <= 12 by treating as DD/MM (more common globally outside US).
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [_, a, b, y] = m;
    let yyyy = parseInt(y!, 10);
    if (yyyy < 100) yyyy += 2000;
    const ai = parseInt(a!, 10);
    const bi = parseInt(b!, 10);
    let day = ai;
    let month = bi;
    if (ai > 12 && bi <= 12) { day = ai; month = bi; }
    else if (bi > 12 && ai <= 12) { day = bi; month = ai; }
    const iso = new Date(Date.UTC(yyyy, month - 1, day));
    if (!Number.isNaN(iso.getTime())) return iso.toISOString();
  }
  return null;
};

const findColumn = (headers: string[], candidates: string[]): number | null => {
  const normalised = headers.map((h) => h.toLowerCase().trim());
  for (const cand of candidates) {
    const idx = normalised.findIndex((h) => h === cand);
    if (idx >= 0) return idx;
  }
  // Substring fallback, but only for candidates >= 4 chars to avoid false hits
  // (e.g. "description" contains "cr" but is not a Credit column).
  for (const cand of candidates) {
    if (cand.length < 4) continue;
    const idx = normalised.findIndex((h) => h.includes(cand));
    if (idx >= 0) return idx;
  }
  return null;
};

export interface ParseOptions {
  signConvention?: 'debits-negative' | 'debits-positive';
}

export const parseCsv = (csv: string, options: ParseOptions = {}): CsvPreview => {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return {
      rows: [],
      detectedColumns: { date: null, description: null, amount: null, debit: null, credit: null },
      totalRows: 0,
      skippedRows: 0,
      signConvention: options.signConvention || 'debits-negative',
    };
  }

  const headers = tokenizeLine(lines[0]!);
  const detected = {
    date: findColumn(headers, DATE_COLUMNS),
    description: findColumn(headers, DESCRIPTION_COLUMNS),
    amount: findColumn(headers, AMOUNT_COLUMNS),
    debit: findColumn(headers, DEBIT_COLUMNS),
    credit: findColumn(headers, CREDIT_COLUMNS),
  };

  const signConvention = options.signConvention || 'debits-negative';
  const rows: ParsedCsvRow[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = tokenizeLine(lines[i]!);
    const warnings: string[] = [];

    const description = detected.description !== null ? (fields[detected.description] || '') : '';
    const dateRaw = detected.date !== null ? (fields[detected.date] || '') : '';
    const date = parseDate(dateRaw);
    if (!date && dateRaw) warnings.push(`Could not parse date "${dateRaw}"`);

    let amount = 0;
    let type: 'income' | 'expense' = 'expense';

    if (detected.debit !== null || detected.credit !== null) {
      const debitVal = detected.debit !== null ? parseAmount(fields[detected.debit] || '') : NaN;
      const creditVal = detected.credit !== null ? parseAmount(fields[detected.credit] || '') : NaN;
      if (Number.isFinite(creditVal) && creditVal > 0) {
        amount = creditVal;
        type = 'income';
      } else if (Number.isFinite(debitVal) && debitVal > 0) {
        amount = debitVal;
        type = 'expense';
      } else {
        skipped++;
        continue;
      }
    } else if (detected.amount !== null) {
      const raw = parseAmount(fields[detected.amount] || '');
      if (!Number.isFinite(raw) || raw === 0) {
        skipped++;
        continue;
      }
      const isDebit = signConvention === 'debits-negative' ? raw < 0 : raw > 0;
      amount = Math.abs(raw);
      type = isDebit ? 'expense' : 'income';
    } else {
      skipped++;
      continue;
    }

    if (!description.trim()) warnings.push('No description');

    rows.push({
      rowIndex: i,
      date,
      amount,
      type,
      description: description.trim() || '(no description)',
      warnings,
    });
  }

  return {
    rows,
    detectedColumns: detected,
    totalRows: lines.length - 1,
    skippedRows: skipped,
    signConvention,
  };
};
