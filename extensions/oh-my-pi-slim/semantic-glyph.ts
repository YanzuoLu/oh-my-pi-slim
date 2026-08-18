export const SEMANTIC_GLYPH_GAP = "  ";

/** Format a standalone package-owned semantic glyph before visible content. */
export function formatSemanticGlyphPrefix(glyph: string): string {
  return `${glyph}${SEMANTIC_GLYPH_GAP}`;
}
