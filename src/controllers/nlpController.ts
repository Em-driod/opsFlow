import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import * as nlpService from '../services/nlpService.js';

// @desc    Parse natural language into structured data OR answer a contextual query
// @route   POST /api/intelligence/parse
// @access  Private
export const parseCommand = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new AppError('Not authorized', 401);
  const parsedData = await nlpService.parseNlpCommand(req.user.businessId, req.body.command);
  res.status(200).json(parsedData);
});
