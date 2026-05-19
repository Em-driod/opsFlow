import { parseCsv, parseAmount } from '../src/services/csvImport.js';

describe('parseAmount', () => {
  it('parses US format', () => {
    expect(parseAmount('1,234.56')).toBeCloseTo(1234.56);
  });
  it('parses EU format', () => {
    expect(parseAmount('1.234,56')).toBeCloseTo(1234.56);
  });
  it('parses parens as negative', () => {
    expect(parseAmount('(123.45)')).toBeCloseTo(-123.45);
  });
  it('strips currency symbols', () => {
    expect(parseAmount('$ 50.00')).toBeCloseTo(50);
    expect(parseAmount('₦ 1,200')).toBeCloseTo(1200);
  });
  it('returns NaN for empty input', () => {
    expect(parseAmount('')).toBeNaN();
  });
  it('handles bare comma decimal', () => {
    expect(parseAmount('45,99')).toBeCloseTo(45.99);
  });
});

describe('parseCsv', () => {
  it('detects Date / Description / Amount columns', () => {
    const csv = [
      'Date,Description,Amount',
      '2024-01-15,Coffee shop,-4.50',
      '2024-01-16,Client payment,1500.00',
    ].join('\n');
    const result = parseCsv(csv);
    expect(result.detectedColumns.date).toBe(0);
    expect(result.detectedColumns.description).toBe(1);
    expect(result.detectedColumns.amount).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.type).toBe('expense');
    expect(result.rows[0]?.amount).toBeCloseTo(4.5);
    expect(result.rows[1]?.type).toBe('income');
    expect(result.rows[1]?.amount).toBeCloseTo(1500);
  });

  it('handles separate Debit and Credit columns', () => {
    const csv = [
      'Posting Date,Narration,Debit,Credit',
      '01/15/2024,ATM withdrawal,200.00,',
      '01/16/2024,Salary deposit,,3500.00',
    ].join('\n');
    const result = parseCsv(csv);
    expect(result.detectedColumns.debit).not.toBeNull();
    expect(result.detectedColumns.credit).not.toBeNull();
    expect(result.rows[0]?.type).toBe('expense');
    expect(result.rows[1]?.type).toBe('income');
    expect(result.rows[1]?.amount).toBeCloseTo(3500);
  });

  it('honors debits-positive sign convention', () => {
    const csv = [
      'Date,Description,Amount',
      '2024-01-15,Test debit,100.00',
    ].join('\n');
    const result = parseCsv(csv, { signConvention: 'debits-positive' });
    expect(result.rows[0]?.type).toBe('expense');
  });

  it('parses quoted descriptions containing commas', () => {
    const csv = [
      'Date,Description,Amount',
      '2024-01-15,"Lagos, Nigeria taxi",-12.00',
    ].join('\n');
    const result = parseCsv(csv);
    expect(result.rows[0]?.description).toBe('Lagos, Nigeria taxi');
  });

  it('skips rows with no amount', () => {
    const csv = [
      'Date,Description,Amount',
      '2024-01-15,Header section,',
      '2024-01-16,Real txn,-50.00',
    ].join('\n');
    const result = parseCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.skippedRows).toBe(1);
  });

  it('returns empty preview for blank input', () => {
    const result = parseCsv('');
    expect(result.rows).toHaveLength(0);
    expect(result.totalRows).toBe(0);
  });
});
