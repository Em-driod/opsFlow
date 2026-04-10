import SmartMapping from '../models/SmartMapping.js';

/**
 * Normalizes text to extract the core brand/vendor identity
 * E.g., "UBER *TRIP 1234 SAN FRANCISCO" -> "uber trip san francisco"
 */
export const normalizeDescription = (desc: string): string => {
  return desc
    .toLowerCase()
    .replace(/[*\d#\-:/]/g, ' ') // Strip special chars and numbers
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();
};

/**
 * Records a mapping when a user saves/updates a transaction manually.
 * The system "learns" from this action.
 */
export const learnTransactionCategory = async (businessId: string, description: string, category: string) => {
  if (!description || !category || category === 'Uncategorized') return;

  const normalized = normalizeDescription(description);
  
  // Don't learn extremely short generic terms
  if (normalized.length < 3) return;

  try {
    await SmartMapping.findOneAndUpdate(
      { businessId, normalizedDescription: normalized },
      { 
        $set: { category, lastSeenAt: new Date() },
        $inc: { confidenceScore: 1 } 
      },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error('[LearningService] Failed to record mapping:', error);
  }
};

/**
 * Predicts the category for a new scanned transaction based on past learnings.
 * Checks for precise matches first, then partial "includes" matches.
 */
export const predictCategory = async (businessId: string, description: string): Promise<string | null> => {
  if (!description) return null;

  const normalized = normalizeDescription(description);

  try {
    // 1. Exact Match Check (Highest Confidence)
    const exactMatch = await SmartMapping.findOne({ 
      businessId, 
      normalizedDescription: normalized 
    }).sort({ confidenceScore: -1 });

    if (exactMatch) return exactMatch.category;

    // 2. Partial Match Check (Look for saved mappings that appear as substrings)
    // We sort by longest string first so "starbucks coffee" matching beats "starbucks" if both exist
    const partialMatches = await SmartMapping.find({ 
      businessId,
      confidenceScore: { $gt: 1 } // Only use robust correlations for fuzzy matching
    });

    // Find the longest mapping that is included in our new description
    let bestMatch = null;
    let maxLen = 0;

    for (const mapping of partialMatches) {
      if (normalized.includes(mapping.normalizedDescription) && mapping.normalizedDescription.length > maxLen) {
        bestMatch = mapping.category;
        maxLen = mapping.normalizedDescription.length;
      }
    }

    return bestMatch;

  } catch (error) {
    console.error('[LearningService] Failed to predict category:', error);
    return null;
  }
};
