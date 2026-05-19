import type { Request, Response } from 'express';
import Invoice from '../models/Invoice.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { analyzeCashFlow } from '../services/cashFlowService.js';
import { checkAiRateLimit } from '../services/aiRateLimiter.js';

// Cache scenarios per business to avoid re-calling Gemini on every dashboard
// reload. Five-minute TTL keeps it fresh enough without burning tokens when a
// user is poking at the dashboard.
const SCENARIO_CACHE_TTL_MS = 5 * 60 * 1000;
const scenarioCache = new Map<string, { at: number; scenarios: any[] }>();

// Initialize Gemini
const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

// @desc    Get complete Intelligence payload (Metrics + Gemini Advice)
// @route   GET /api/intelligence/advisor
// @access  Private
export const getBusinessAdvisorState = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    
    // 1. Get Predictive Metrics from Service
    const cashFlowAnalysis = await analyzeCashFlow(businessId);
    const { metrics, dataQuality } = cashFlowAnalysis;

    // 2. Fetch overdue invoices for raw context
    const overdueInvoices = await Invoice.find({ businessId, status: 'overdue' });
    const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + (inv.total || 0), 0);

    // 3. Generate scenarios. We skip Gemini entirely when data confidence is low —
    //    a generated narrative on top of 5 transactions is fiction, and fiction
    //    erodes the same trust the advisor is supposed to build. Instead we emit
    //    deterministic, source-cited insights from real data.
    let aiScenarios: Array<{ title: string; impact: string; action: string }> = [];
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
          impact: `+$${Math.round(overdueAmount)}`,
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
          aiScenarios = [{
            title: 'Collect overdue invoices',
            impact: `+$${Math.round(overdueAmount)}`,
            action: `${overdueInvoices.length} invoice${overdueInvoices.length === 1 ? '' : 's'} past due — chase them today.`,
          }];
        }
      } else try {
        const model = genAI.getGenerativeModel({
            model: process.env.ADVISOR_MODEL || "gemini-2.0-flash",
            systemInstruction: "You are an elite, highly intelligent financial CFO Assistant. Output MUST be valid JSON, containing an array of 'scenarios'."
        });
        const prompt = `
          Current status:
          - Cash Runway: ${metrics.cashRunwayMonths} months
          - Monthly Burn: $${metrics.monthlyBurnRate}
          - Profit Margin: ${metrics.netMargin}%
          - Unpaid Receivables: $${overdueAmount}
          - Projected Revenue (Next 30d): $${metrics.projectedRevenueNext30d}
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
                "impact": "+$X or +Y months",
                "action": "One actionable sentence focusing on the revenue model."
              }
            ]
          }
        `;
        
        const result = await model.generateContent(prompt);
        const textOutput = result.response.text().trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        
        try {
            const parsed = JSON.parse(textOutput);
            if (parsed.scenarios && Array.isArray(parsed.scenarios)) {
                aiScenarios = parsed.scenarios;
                scenarioCache.set(cacheKey, { at: Date.now(), scenarios: aiScenarios });
            }
        } catch(e) {
            console.error('Failed to parse AI Scenarios:', e);
        }

      } catch (aiError) {
        console.error('[Gemini] Failed to generate advice:', aiError);
      }
    }

    // Compute status from real metrics regardless of which scenario branch ran.
    if (metrics.healthScore < 40 || metrics.cashRunwayMonths < 2) aiStatus = 'critical';
    else if (metrics.healthScore < 70 || metrics.cashRunwayMonths < 6) aiStatus = 'warning';

    if (aiScenarios.length === 0) {
      aiScenarios = [{ title: 'Keep logging', impact: '—', action: 'Log a few more transactions to unlock advisor insights.' }];
    }

    res.status(200).json({
      metrics: {
        ...metrics,
        overdueDebt: overdueAmount
      },
      dataQuality,
      advisor: {
        scenarios: aiScenarios,
        status: aiStatus
      }
    });

  } catch (error) {
    console.error('Error in intelligence controller:', error);
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};
