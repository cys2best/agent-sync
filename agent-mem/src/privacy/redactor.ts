import { getConfig } from "../config";

export interface RedactionResult {
  sanitized: string;
  privateBlocksRemoved: number;
  secretsMasked: number;
}

const PRIVATE_TAG_REGEX = /<private>[\s\S]*?<\/private>/gi;

export function redactPrivateTags(input: string): { sanitized: string; count: number } {
  let count = 0;
  const sanitized = input.replace(PRIVATE_TAG_REGEX, () => {
    count++;
    return "[REDACTED_PRIVATE]";
  });
  return { sanitized, count };
}

export function maskSecrets(input: string, patterns?: RegExp[]): { sanitized: string; count: number } {
  const secretPatterns = patterns || getConfig().secretPatterns;
  let count = 0;
  let result = input;

  for (const pattern of secretPatterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    const globalPattern = new RegExp(pattern.source, flags);
    result = result.replace(globalPattern, () => {
      count++;
      return "[REDACTED_SECRET]";
    });
  }

  return { sanitized: result, count };
}

export function sanitizePayload(input: string): RedactionResult {
  const tagResult = redactPrivateTags(input);
  const secretResult = maskSecrets(tagResult.sanitized);

  return {
    sanitized: secretResult.sanitized,
    privateBlocksRemoved: tagResult.count,
    secretsMasked: secretResult.count,
  };
}
