export interface LiveStreamsEnv {
  STRIPCASH_API_BASE?: string;
  STRIPCASH_API_KEY?: string;
  STRIPCASH_MODELS_PATH?: string;
  STRIPCASH_BANNED_COUNTRIES?: string;
}

export interface LiveModelSummary {
  username: string;
  live: boolean;
  profileUrl: string;
}

export interface LiveFeedResponse {
  models: LiveModelSummary[];
  fetchedAt: string;
  stale: boolean;
}
