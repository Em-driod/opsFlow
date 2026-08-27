import mongoose from 'mongoose';
import Invoice from '../models/Invoice.js';
import Business from '../models/Business.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { analyzeCashFlow } from './cashFlowService.js';
import { checkAiRateLimit } from './aiRateLimiter.js';
import { formatCurrency, getCurrencySymbol } from '../utils/currency.js';

interface Scenario {
  title: string;
  impact: string;
  action: string;
}

// Cache scenarios per business to avoid re-calling Gemini on every dashboard
// reload. Five-minute TTL keeps it fresh enough without burning tokens when a
// user is poking at the dashboard.
const SCENARIO_CACHE_TTL_MS = 5 * 60 * 1000;
const scenarioCache = new Map<string, { at: number; scenarios: Scenario[] }>();

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

export const getBusinessAdvisorStateForBusiness = async (businessId: mongoose.Types.ObjectId) => {
  // 1. Get Predictive Metrics from Service
  const cashFlowAnalysis = await analyzeCashFlow(String(businessId));
  const { metrics, dataQuality } = cashFlowAnalysis;

  // 2. Fetch overdue invoices for raw context
  const overdueInvoices = await Invoice.find({ businessId, status: 'overdue' });
  const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + (inv.total || 0), 0);

  // Resolve the business's own currency so every figure we surface (and every
  // figure we hand to Gemini) is in the currency the owner actually operates in.
  const business = await Business.findById(businessId).select('currency').lean();
  const currency = business?.currency || 'NGN';
  const currencySymbol = getCurrencySymbol(currency);
  const money = (amount: number) => formatCurrency(amount, currency);

  // 3. Generate scenarios. We skip Gemini entirely when data confidence is low —
  //    a generated narrative on top of 5 transactions is fiction, and fiction
  //    erodes the same trust the advisor is supposed to build. Instead we emit
  //    deterministic, source-cited insights from real data.
  let aiScenarios: Scenario[] = [];
  let aiStatus: 'healthy' | 'warning' | 'critical' = 'healthy';

  if (dataQuality.confidence === 'low') {
    aiScenarios = [
      {
        title: 'Build a baseline',
        impact: `${dataQuality.transactionsLast90d} tx so far`,
        action: 'Log 30+ transactions or import a bank statement before relying on projections.',
      },
    ];
    if (overdueInvoices.length > 0) {
      aiScenarios.push({
        title: 'Collect overdue invoices',
        impact: `+${money(overdueAmount)}`,
        action: `${overdueInvoices.length} invoice${overdueInvoices.length === 1 ? '' : 's'} past due — chase them today.`,
      });
    }
  } else if (apiKey) {
    const cacheKey = String(businessId);
    const cached = scenarioCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SCENARIO_CACHE_TTL_MS) {
      aiScenarios = cached.scenarios;
    } else if (!checkAiRateLimit(String(businessId)).allowed) {
      // Quietly fall back to deterministic insights when rate-limited; the
      // dashboard should never block on AI budget exhaustion.
      if (overdueInvoices.length > 0) {
        aiScenarios = [
          {
            title: 'Collect overdue invoices',
            impact: `+${money(overdueAmount)}`,
            action: `${overdueInvoices.length} invoice${overdueInvoices.length === 1 ? '' : 's'} past due — chase them today.`,
          },
        ];
      }
    } else {
      try {
        const model = genAI.getGenerativeModel({
          model: process.env.ADVISOR_MODEL || 'gemini-2.0-flash',
          systemInstruction:
            "You are an elite, highly intelligent financial CFO Assistant. Output MUST be valid JSON, containing an array of 'scenarios'.",
        });
        const prompt = `
          All monetary amounts are in ${currency}. Use the "${currencySymbol.trim()}" symbol (or the ${currency} code) for every figure you output — never assume US dollars.

          Current status:
          - Cash Runway: ${metrics.cashRunwayMonths} months
          - Monthly Burn: ${money(metrics.monthlyBurnRate)}
          - Profit Margin: ${metrics.netMargin}%
          - Unpaid Receivables: ${money(overdueAmount)}
          - Projected Revenue (Next 30d): ${money(metrics.projectedRevenueNext30d)}
          - Business Score: ${metrics.healthScore}/100

          Generate exactly 2 high-impact actionable 'Scenarios' for the business owner.
          Focus on BOTH Revenue Growth and Risk Mitigation.
          Example scenarios:
          - "Pricing Strategy": What if I raise rates by 10%? (Calculate impact on projected revenue)
          - "Client Retention": Impact if a major recurring client leaves.
          - "Cash Acceleration": Collecting overdue debt.

          Return exactly this JSON format (no markdown wrappers):
          {
            "scenarios": [
              {
                "title": "Short descriptive title",
                "impact": "+${currencySymbol.trim()}X or +Y months",
                "action": "One actionable sentence focusing on the revenue model."
              }
            ]
          }
        `;

        const result = await model.generateContent(prompt);
        const textOutput = result.response
          .text()
          .trim()
          .replace(/^```json\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();

        try {
          const parsed = JSON.parse(textOutput);
          if (parsed.scenarios && Array.isArray(parsed.scenarios)) {
            aiScenarios = parsed.scenarios;
            scenarioCache.set(cacheKey, { at: Date.now(), scenarios: aiScenarios });
          }
        } catch (e) {
          console.error('Failed to parse AI Scenarios:', e);
        }
      } catch (aiError) {
        console.error('[Gemini] Failed to generate advice:', aiError);
      }
    }
  }

  // Compute status from real metrics regardless of which scenario branch ran.
  if (metrics.healthScore < 40 || metrics.cashRunwayMonths < 2) aiStatus = 'critical';
  else if (metrics.healthScore < 70 || metrics.cashRunwayMonths < 6) aiStatus = 'warning';

  if (aiScenarios.length === 0) {
    aiScenarios = [{ title: 'Keep logging', impact: '—', action: 'Log a few more transactions to unlock advisor insights.' }];
  }

  return {
    metrics: { ...metrics, overdueDebt: overdueAmount },
    dataQuality,
    advisor: { scenarios: aiScenarios, status: aiStatus },
  };
};
