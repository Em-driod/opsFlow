// Reads a bank alert email (forwarded by the business) and pulls out what the
// order matcher needs: was money received, how much, and the narration.
//
// Nigerian banks each word their alerts differently, so this works on
// labelled fields first ("Amount: NGN 5,000.00", "Narration: ...") and falls
// back to looser patterns ("You received ₦5,000 from ..."). Anything it can't
// confidently read as a credit is reported as such and left alone — a missed
// alert just means the owner confirms by hand; a misread one would mark an
// order paid wrongly.

export interface ParsedAlert {
  direction: 'credit' | 'debit' | 'unknown';
  amount: number | null;
  narration: string | null;
  // Plain-text version of the whole alert; the matcher searches it for order codes.
  text: string;
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#8358;': '₦', '&naira;': '₦',
};

export const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ');

const normaliseSpace = (s: string) =>
  s.replace(/\r/g, '').replace(/[ \t\xa0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

const MONEY = String.raw`(?:NGN|N|₦|=N=)?\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)`;

const toNumber = (s: string) => {
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

const findDirection = (text: string, subject: string): ParsedAlert['direction'] => {
  const labelled = /(?:transaction\s*type|txn\s*type|trans(?:action)?\s*type|type|txn)\s*[:-]?\s*(credit|debit|cr|dr)\b/i.exec(text);
  if (labelled) return /^c/i.test(labelled[1]!) ? 'credit' : 'debit';

  const s = `${subject}\n${text.slice(0, 400)}`;
  const credit = /\b(credit(?:ed)?\s*(?:alert|transaction)?|you(?:'ve| have)?\s*received|money\s*in|inflow|deposit(?:ed)?)\b/i.test(s);
  const debit = /\b(debit(?:ed)?\s*(?:alert|transaction)?|you(?:'ve| have)?\s*(?:sent|paid|spent)|money\s*out|withdrawal)\b/i.test(s);
  if (credit && !debit) return 'credit';
  if (debit && !credit) return 'debit';
  return 'unknown';
};

const findAmount = (text: string): number | null => {
  // Labelled amount — the most reliable.
  const labelled = new RegExp(
    String.raw`\b(?:credit\s*amount|transaction\s*amount|amount\s*credited|amount|amt)\b\s*[:\-]?\s*` + MONEY,
    'i',
  ).exec(text);
  if (labelled) return toNumber(labelled[1]!);

  // "You received ₦5,000.00 from ..." — first currency amount not describing a balance.
  const re = /(?:NGN|₦|=N=)\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
    if (/bal(ance)?|avail|ledger|limit/.test(before)) continue;
    return toNumber(m[1]!);
  }
  return null;
};

const findNarration = (text: string): string | null => {
  const m = /\b(?:narration|narrative|description|remarks?|details|memo|des|desc)\s*[:-]\s*([^\n]{1,200})/i.exec(text);
  if (!m) return null;
  // Stop at the next labelled field on the same line, e.g. "... Date: 12/10".
  return m[1]!.split(/\s+(?:date|time|balance|bal|amount|amt|ref(?:erence)?)\s*[:-]/i)[0]!.trim() || null;
};

export const parseBankAlert = (input: { subject?: string; text?: string; html?: string }): ParsedAlert => {
  const subject = normaliseSpace(input.subject || '');
  const body = input.text?.trim() ? input.text : input.html ? htmlToText(input.html) : '';
  const text = normaliseSpace(`${subject}\n${body}`);
  const direction = findDirection(text, subject);
  return {
    direction,
    amount: direction === 'credit' ? findAmount(text) : null,
    narration: direction === 'credit' ? findNarration(text) : null,
    text,
  };
};

// Gmail won't forward anything until the forwarding address confirms. Morniy
// is that address, so pull the code/link out and show it to the owner.
export const parseGmailForwardingConfirmation = (subject: string, text: string) => {
  if (!/forwarding confirmation/i.test(subject) && !/receive mail from/i.test(text)) return null;
  const code = /confirmation code[:\s]*([0-9]{6,12})/i.exec(text)?.[1] ?? /\(#?([0-9]{6,12})\)/.exec(subject)?.[1];
  const link = /(https:\/\/mail(?:-settings)?\.google\.com\/mail\/[^\s"<>)]+)/i.exec(text)?.[1];
  if (!code && !link) return null;
  return { code, link };
};
