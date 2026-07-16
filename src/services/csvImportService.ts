import mongoose from 'mongoose';
import Transaction, { type ITransaction } from '../models/Transaction.js';
import { parseCsv } from './csvImport.js';
import { predictCategory, learnTransactionCategory } from './learningService.js';
import { loadRules, evaluateItemWithRules } from './autoCommitEngine.js';
import { emitToBusiness } from './socketService.js';
import { createNotification } from './notificationService.js';
import { AppError } from '../utils/AppError.js';
import type { IUser } from '../models/User.js';

const MAX_ROWS = 5000;

interface PreviewRow {
  rowIndex: number;
  date: string | null;
  amount: number;
  type: 'income' | 'expense';
  description: string;
  category: string | null;
  predictedCategory: string | null;
  willAutoCommit: boolean;
  ruleName: string | null;
  warnings: string[];
}

export const previewCsvForBusiness = async (
  user: IUser,
  params: { csv?: string; signConvention?: 'debits-negative' | 'debits-positive' },
) => {
  const { csv, signConvention } = params;

  if (typeof csv !== 'string' || !csv.trim()) throw new AppError('CSV content is required', 400);
  if (csv.length > 5_000_000) throw new AppError('CSV too large (max ~5MB). Split into smaller files.', 413);

  const parsed = parseCsv(csv, signConvention ? { signConvention } : {});

  if (parsed.rows.length === 0) {
    return {
      ...parsed,
      rows: [],
      message: 'No valid rows detected. Check the column headers — we look for Date, Description, and Amount (or Debit/Credit).',
    };
  }

  const limitedRows = parsed.rows.slice(0, MAX_ROWS);
  const rules = await loadRules(String(user.businessId));

  const enriched: PreviewRow[] = await Promise.all(
    limitedRows.map(async (row) => {
      const predictedCategory = await predictCategory(String(user.businessId), row.description);
      const ruleDecision = evaluateItemWithRules(
        {
          amount: row.amount,
          type: row.type,
          description: row.description,
          category: predictedCategory || undefined,
          confidence: predictedCategory ? 0.9 : 0.5,
        },
        rules,
      );
      return {
        rowIndex: row.rowIndex,
        date: row.date,
        amount: row.amount,
        type: row.type,
        description: row.description,
        category: predictedCategory || ruleDecision.finalCategory || null,
        predictedCategory,
        willAutoCommit: ruleDecision.autoCommit,
        ruleName: ruleDecision.rule?.name || null,
        warnings: row.warnings,
      };
    }),
  );

  const truncated = parsed.rows.length > MAX_ROWS;

  return {
    detectedColumns: parsed.detectedColumns,
    signConvention: parsed.signConvention,
    totalRows: parsed.totalRows,
    skippedRows: parsed.skippedRows,
    truncated,
    rows: enriched,
  };
};

interface CommitRow {
  amount: number;
  type: string;
  category?: string;
  description?: string;
  date?: string;
}

export const commitCsvForBusiness = async (
  user: IUser,
  params: { rows?: CommitRow[]; clientId?: string; projectId?: string },
) => {
  const { rows, clientId, projectId } = params;

  if (!Array.isArray(rows) || rows.length === 0) throw new AppError('No rows provided', 400);
  if (rows.length > MAX_ROWS) throw new AppError(`Too many rows (max ${MAX_ROWS} per commit).`, 413);

  const created: ITransaction[] = [];
  for (const row of rows) {
    if (!row || typeof row.amount !== 'number' || row.amount <= 0) continue;
    if (row.type !== 'income' && row.type !== 'expense') continue;

    const tx = await Transaction.create({
      businessId: user.businessId,
      clientId: clientId || undefined,
      projectId: projectId || undefined,
      amount: row.amount,
      type: row.type,
      category: row.category || 'Uncategorized',
      description: row.description || '',
      recordedBy: user._id,
      source: 'csv_import',
      ...(row.date ? { createdAt: new Date(row.date) } : {}),
    });
    created.push(tx);

    if (row.category && row.category !== 'Uncategorized') {
      await learnTransactionCategory(String(user.businessId), row.description || '', row.category);
    }
  }

  if (created.length > 0) {
    emitToBusiness(String(user.businessId), 'data_updated', { type: 'transaction', action: 'csv_import' });
    await createNotification({
      businessId: user.businessId,
      userId: user._id as mongoose.Types.ObjectId,
      message: `Imported ${created.length} transaction${created.length === 1 ? '' : 's'} from CSV.`,
      link: '/transactions',
    });
  }

  return {
    message: `Imported ${created.length} of ${rows.length} rows.`,
    imported: created.length,
    attempted: rows.length,
  };
};
