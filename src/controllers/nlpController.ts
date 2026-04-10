import type { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

// @desc    Parse natural language into structured transaction data
// @route   POST /api/intelligence/parse
// @access  Private
export const parseCommand = async (req: Request, res: Response) => {
  try {
    const { command } = req.body;
    
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ message: 'Invalid command provided' });
    }

    if (!apiKey) {
      return res.status(500).json({ message: 'Gemini API not configured' });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    
    const prompt = `
      You are an elite financial assistant for the OpsFlow application.
      The user wants to log a transaction using natural language.
      Parse the following user command: "${command}"

      Extract the following information:
      - amount (number)
      - type ('income' or 'expense')
      - description (string)

      Rules:
      - Always respond ONLY with a valid JSON object.
      - Do not wrap the JSON in Markdown code blocks (no \`\`\`json).
      - If you cannot determine the amount, default to 0.
      - If you cannot determine the type, make your best guess based on the context (e.g. "spent", "bought", "paid for" = expense. "received", "earned", "paid by" = income).
      - Ensure the JSON fields exactly match the names 'amount', 'type', and 'description'.
    `;

    const result = await model.generateContent(prompt);
    const textOutput = result.response.text().trim();
    
    // Clean up potential markdown wrapper from Gemini (even though we asked it not to)
    const cleanedJson = textOutput.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    
    let parsedData;
    try {
      parsedData = JSON.parse(cleanedJson);
    } catch (parseError) {
      console.error('[NLP Controller] Failed to parse model output:', textOutput);
      return res.status(422).json({ message: 'Failed to extract structured data from command' });
    }

    // Validate structure
    if (typeof parsedData.amount !== 'number' || (parsedData.type !== 'income' && parsedData.type !== 'expense')) {
      return res.status(422).json({ message: 'AI returned invalid structure', rawData: parsedData });
    }

    res.status(200).json(parsedData);

  } catch (error) {
    console.error('Error in NLP controller:', error);
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
  }
};
