export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreateCostPerToken: number;
  cacheReadCostPerToken: number;
  reasoningCostPerToken: number;
  webSearchCostPerRequest: number;
}

export function normalizeModelKey(key: string): string {
  return key.trim().toLowerCase().replaceAll("_", "-");
}
