// Hardcoded (no-AI) parsers that turn raw OCR/PDF text into structured data.
// Deliberately conservative: a receipt/invoice that doesn't match any of
// these patterns should come back empty rather than guess wildly, since a
// wrong number silently recorded is worse than an explicit "couldn't find it".

const KNOWN_CATEGORIES = [
  'Food & Dining', 'Transportation', 'Utilities', 'Office Supplies',
  'Software & Services', 'Professional Services', 'Marketing', 'Equipment',
  'Rent', 'Insurance', 'Sales', 'Other',
];

const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/food|dining|restaurant|cafe|coffee|grocery/i, 'Food & Dining'],
  [/transport|fuel|uber|taxi|fare|bus fare/i, 'Transportation'],
  [/electricity|utility|utilities|water bill|phone bill|internet bill/i, 'Utilities'],
  [/office supplies|stationery|printer/i, 'Office Supplies'],
  [/software|subscription|saas|license/i, 'Software & Services'],
  [/consulting|professional services|legal fees|accounting/i, 'Professional Services'],
  [/marketing|advertising|ads\b/i, 'Marketing'],
  [/equipment|machinery|hardware/i, 'Equipment'],
  [/\brent\b/i, 'Rent'],
  [/insurance/i, 'Insurance'],
  [/\bsales\b/i, 'Sales'],
];

const CURRENCY_MAP: Array<[RegExp, string]> = [
  [/NGN|₦/i, 'NGN'],
  [/USD|\$/i, 'USD'],
  [/GBP|£/i, 'GBP'],
  [/EUR|€/i, 'EUR'],
];

const numberFrom = (raw: string): number => Number(raw.replace(/,/g, ''));

const AMOUNT_PATTERN = '(?:NGN|USD|GBP|EUR|\\$|£|€|₦)?\\s*([\\d,]+(?:\\.\\d{1,2})?)';

const findLabeledAmount = (text: string, labels: string[]): number | null => {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:\\-]?\\s*${AMOUNT_PATTERN}`, 'i');
    const match = text.match(re);
    if (match?.[1]) {
      const value = numberFrom(match[1]);
      if (value > 0) return value;
    }
  }
  return null;
};

const findLabeledText = (text: string, labels: string[]): string | null => {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:\\-]\\s*(.+)`, 'i');
    const match = text.match(re);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return null;
};

const findDate = (text: string, labels: string[]): string | null => {
  const datePattern = '(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|\\d{1,2}\\s+[A-Za-z]{3,}\\s+\\d{2,4})';
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:\\-]?\\s*${datePattern}`, 'i');
    const match = text.match(re);
    if (match?.[1]) return match[1];
  }
  return null;
};

const largestCurrencyLikeNumber = (text: string): number | null => {
  const matches = [...text.matchAll(/\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/g)]
    .map((m) => numberFrom(m[0]))
    .filter((n) => n > 0);
  if (matches.length === 0) return null;
  return Math.max(...matches);
};

const detectCurrency = (text: string): string => {
  for (const [pattern, code] of CURRENCY_MAP) {
    if (pattern.test(text)) return code;
  }
  return 'other';
};

const detectCategory = (text: string): string => {
  const labeled = findLabeledText(text, ['category']);
  if (labeled) {
    const exact = KNOWN_CATEGORIES.find((c) => c.toLowerCase() === labeled.toLowerCase());
    if (exact) return exact;
  }
  for (const [pattern, category] of CATEGORY_KEYWORDS) {
    if (pattern.test(text)) return category;
  }
  return 'Other';
};

export interface ParsedTransaction {
  amount: number;
  type: 'income' | 'expense';
  description: string;
  category: string;
}

export interface ParsedTransactionResult {
  transactions: ParsedTransaction[];
  vendorName: string | null;
  documentDate: string | null;
}

const firstMeaningfulLine = (text: string): string | null => {
  const skip = /^(receipt|invoice|voucher|receipt\s*\/\s*invoice\s*voucher)$/i;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !skip.test(trimmed) && trimmed.length > 2) return trimmed;
  }
  return null;
};

export const parseTransactionText = (rawText: string): ParsedTransactionResult => {
  const text = rawText.replace(/\r/g, '');

  const amount =
    findLabeledAmount(text, ['amount\\s*paid', 'grand\\s*total', 'total\\s*amount', 'amount\\s*due', 'total\\s*due', 'total', 'amount']) ??
    largestCurrencyLikeNumber(text);

  if (!amount) {
    return { transactions: [], vendorName: null, documentDate: null };
  }

  const labeledType = findLabeledText(text, ['type'])?.toLowerCase();
  let type: 'income' | 'expense' = 'expense';
  if (labeledType === 'income' || labeledType === 'expense') {
    type = labeledType;
  } else if (/payment received|received from|deposit|credit(?:ed)?\b/i.test(text)) {
    type = 'income';
  }

  const description =
    findLabeledText(text, ['description']) ??
    firstMeaningfulLine(text) ??
    'Scanned Transaction';

  const vendorName = findLabeledText(text, ['vendor', 'from', 'merchant']) ?? firstMeaningfulLine(text);
  const documentDate = findDate(text, ['date']);
  const category = detectCategory(text);

  return {
    transactions: [{ amount, type, description: description.substring(0, 100), category }],
    vendorName,
    documentDate,
  };
};

export interface ParsedInvoiceLineItem {
  description: string;
  quantity: number;
  price: number;
  total: number;
}

export interface ParsedInvoice {
  invoiceNumber: string | null;
  vendorName: string | null;
  clientName: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  subtotal: number | null;
  tax: number;
  total: number;
  currency: string;
  lineItems: ParsedInvoiceLineItem[];
}

// Matches a row that looks like "<description>  <qty>  <unit price>  <line total>"
// — the common shape once OCR/PDF text collapses a table's columns onto one line.
const LINE_ITEM_ROW = /^(.{3,60}?)\s+(\d+(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/;

const parseLineItems = (text: string): ParsedInvoiceLineItem[] => {
  const items: ParsedInvoiceLineItem[] = [];
  for (const line of text.split('\n')) {
    const match = line.trim().match(LINE_ITEM_ROW);
    if (!match) continue;
    const [, description, qty, price, total] = match as unknown as [string, string, string, string, string];
    items.push({
      description: description.trim(),
      quantity: numberFrom(qty),
      price: numberFrom(price),
      total: numberFrom(total),
    });
  }
  return items;
};

export const parseInvoiceText = (rawText: string): ParsedInvoice | null => {
  const text = rawText.replace(/\r/g, '');

  const total = findLabeledAmount(text, ['grand\\s*total', 'total\\s*due', 'amount\\s*due', 'balance\\s*due', 'total']) ?? largestCurrencyLikeNumber(text);
  if (!total) return null;

  const subtotal = findLabeledAmount(text, ['sub\\s*total', 'subtotal']);
  const taxAmount = findLabeledAmount(text, ['vat', 'tax']);
  const tax = taxAmount && subtotal ? Math.round((taxAmount / subtotal) * 1000) / 10 : 0;

  const invoiceNumberMatch = text.match(/invoice\s*(?:number|#|no\.?)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,30})/i);
  const invoiceNumber = invoiceNumberMatch?.[1]?.trim() ?? null;

  const vendorName = findLabeledText(text, ['vendor', 'from', 'bill\\s*from']) ?? firstMeaningfulLine(text);
  const clientName = findLabeledText(text, ['bill\\s*to', 'client', 'customer', 'billed\\s*to']);

  const invoiceDate = findDate(text, ['invoice\\s*date', 'date']);
  const dueDate = findDate(text, ['due\\s*date']);

  const currency = detectCurrency(text);

  const lineItems = parseLineItems(text);

  return {
    invoiceNumber,
    vendorName,
    clientName,
    invoiceDate,
    dueDate,
    subtotal: subtotal ?? total,
    tax,
    total,
    currency,
    lineItems: lineItems.length > 0
      ? lineItems
      : [{ description: vendorName ?? 'Scanned item', quantity: 1, price: total, total }],
  };
};
