// Escapes user input before it is used inside a RegExp / Mongo $regex, so a
// search for "a+b" matches the literal text instead of being interpreted as a
// pattern — and so crafted patterns can't trigger catastrophic backtracking (ReDoS).
export const escapeRegex = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const containsRegex = (input: string): RegExp => new RegExp(escapeRegex(input), 'i');
