import type { Request, Response } from 'express';
import Transaction from '../models/Transaction.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini
const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

// @desc    Get complete Intelligence payload (Metrics + Gemini Advice)
// @route   GET /api/intelligence/advisor
// @access  Private
export const getBusinessAdvisorState = async (req: Request, res: Response) => {
  try {
    const businessId = (req.user as any).businessId;
    
    // 1. Gather Raw Data
    const today = new Date();
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(today.getMonth() - 3);

    const [income, expenses, activeClients, overdueInvoices] = await Promise.all([
      Transaction.aggregate([
        { $match: { businessId, type: 'income', createdAt: { $gte: threeMonthsAgo } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Transaction.aggregate([
        { $match: { businessId, type: 'expense', createdAt: { $gte: threeMonthsAgo } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Client.countDocuments({ businessId, status: 'active' }),
      Invoice.find({ businessId, status: 'overdue' })
    ]);

    const totalIncome90d = income[0]?.total || 0;
    const totalExpense90d = expenses[0]?.total || 0;
    
    // Core logic
    const monthlyBurnRate = totalExpense90d / 3;
    const monthlyIncome = totalIncome90d / 3;
    const netMargin = totalIncome90d > 0 ? ((totalIncome90d - totalExpense90d) / totalIncome90d) * 100 : 0;
    
    // Assuming 'balance' or total banked is total historical income - expenses (simplified for runway)
    const allTimeStats = await Transaction.aggregate([
      { $match: { businessId } },
      { $group: { 
        _id: '$type', 
        total: { $sum: '$amount' } 
      }}
    ]);
    
    let historicalCash = 0;
    allTimeStats.forEach(stat => {
      if (stat._id === 'income') historicalCash += stat.total;
      if (stat._id === 'expense') historicalCash -= stat.total;
    });

    const cashRunwayMonths = monthlyBurnRate > 0 ? (historicalCash / monthlyBurnRate) : 99;
    
    // 2. Health Score Algorithm (Out of 100)
    let healthScore = 50; // baseline
    if (netMargin > 20) healthScore += 20;
    else if (netMargin > 0) healthScore += 10;
    else healthScore -= 20;

    if (cashRunwayMonths > 6) healthScore += 20;
    else if (cashRunwayMonths > 3) healthScore += 10;
    else healthScore -= 20;

    if (activeClients > 10) healthScore += 10;
    
    const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + (inv.total || 0), 0);
    if (overdueAmount > historicalCash * 0.2) healthScore -= 15; // Too much uncollected debt

    healthScore = Math.max(0, Math.min(100, healthScore)); // Clamp 0-100

    // 3. Generate Gemini 2.5 Pro Scenarios
    let aiScenarios: Array<{ title: string; impact: string; action: string }> = [
      { title: "Optimize Pipeline", impact: "+ Baseline", action: "Focus on generating intelligent insights." }
    ];
    let aiStatus: 'healthy' | 'warning' | 'critical' = 'healthy';

    if (apiKey) {
      try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-pro",
            systemInstruction: "You are an elite, highly intelligent financial CFO Assistant. Output MUST be valid JSON, containing an array of 'scenarios'."
        });
        const prompt = `
          Current status:
          - Cash lasts: ${cashRunwayMonths.toFixed(1)} months
          - Monthly spending: $${monthlyBurnRate.toFixed(2)}
          - Profit: ${netMargin.toFixed(1)}%
          - Active Clients: ${activeClients}
          - Unpaid bills: $${overdueAmount.toFixed(2)}
          - Business Score: ${Math.round(healthScore)}/100

          Generate exactly 2 actionable 'Scenarios' tailored for the business owner.
          For example, if they have unpaid bills, suggest a scenario about collecting it. 
          If runway is low, suggest cutting a % of spending.
          Calculate the actual mathematical impact.

          Return exactly this JSON format (no markdown wrappers):
          {
            "scenarios": [
              {
                "title": "Short title describing the action",
                "impact": "+$X or +Y months",
                "action": "One actionable sentence."
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
            }
        } catch(e) {
            console.error('Failed to parse AI Scenarios:', e);
        }
        
        if (healthScore < 40 || cashRunwayMonths < 2) aiStatus = 'critical';
        else if (healthScore < 70 || cashRunwayMonths < 6 || overdueAmount > monthlyIncome) aiStatus = 'warning';
        
      } catch (aiError) {
        console.error('[Gemini 2.5 Pro] Failed to generate advice:', aiError);
      }
    }

    res.status(200).json({
      metrics: {
        healthScore: Math.round(healthScore),
        cashRunwayMonths: Number(cashRunwayMonths.toFixed(1)),
        monthlyBurnRate: Number(monthlyBurnRate.toFixed(2)),
        netMargin: Number(netMargin.toFixed(1)),
        overdueDebt: Number(overdueAmount.toFixed(2))
      },
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
