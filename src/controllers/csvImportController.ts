import type { Request, Response } from 'express';
import Transaction from '../models/Transaction.js';
import { parseCsv } from '../services/csvImport.js';
import { predictCategory, learnTransactionCategory } from '../services/learningService.js';
import { loadRules, evaluateItemWithRules } from '../services/autoCommitEngine.js';
import { emitToBusiness } from '../services/socketService.js';
import { createNotification } from './notificationController.js';

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

// @desc    Parse a CSV and return a preview with predicted categories
// @route   POST /api/transactions/csv/preview
// @access  Private
export const previewCsv = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { csv, signConvention } = req.body || {};

    if (typeof csv !== 'string' || !csv.trim()) {
      return res.status(400).json({ message: 'CSV content is required' });
    }
    if (csv.length > 5_000_000) {
      return res.status(413).json({ message: 'CSV too large (max ~5MB). Split into smaller files.' });
    }

    const parsed = parseCsv(csv, { signConvention });

    if (parsed.rows.length === 0) {
      return res.status(200).json({
        ...parsed,
        rows: [],
        message: 'No valid rows detected. Check the column headers — we look for Date, Description, and Amount (or Debit/Credit).',
      });
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

    res.json({
      detectedColumns: parsed.detectedColumns,
      signConvention: parsed.signConvention,
      totalRows: parsed.totalRows,
      skippedRows: parsed.skippedRows,
      truncated,
      rows: enriched,
    });
  } catch (error) {
    res.status(500).json({ message: 'CSV preview failed', error: (error as Error).message });
  }
};

// @desc    Commit selected rows from a CSV import as Transactions
// @route   POST /api/transactions/csv/commit
// @access  Private
export const commitCsv = async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { rows, clientId, projectId } = req.body || {};

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'No rows provided' });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(413).json({ message: `Too many rows (max ${MAX_ROWS} per commit).` });
    }

    const created = [] as any[];
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
        userId: user._id,
        message: `Imported ${created.length} transaction${created.length === 1 ? '' : 's'} from CSV.`,
        link: '/transactions',
      });
    }

    res.status(201).json({
      message: `Imported ${created.length} of ${rows.length} rows.`,
      imported: created.length,
      attempted: rows.length,
    });
  } catch (error) {
    res.status(500).json({ message: 'CSV commit failed', error: (error as Error).message });
  }
};
