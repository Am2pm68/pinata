const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export { sha256Hex };

/**
 * Strip everything that varies between otherwise-identical posts -- links,
 * times, counts, emoji, case, punctuation -- so that two captions which read
 * the same to a human collapse to the same hash. This is what the near-duplicate
 * guard compares.
 */
export function normaliseCaption(caption: string): string {
  return caption
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{Letter}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function captionHash(caption: string): Promise<string> {
  return sha256Hex(normaliseCaption(caption));
}

/** Stable short digest used to pick a copy variant without any randomness. */
export async function stableIndex(seed: string, modulo: number): Promise<number> {
  if (modulo <= 0) return 0;
  const hex = await sha256Hex(seed);
  return parseInt(hex.slice(0, 8), 16) % modulo;
}
