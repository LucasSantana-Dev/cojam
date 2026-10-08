// Serialize structured data for an inline <script type="application/ld+json">.
// Plain JSON.stringify leaves "<" intact, so a value containing "</script>"
// would end the script element early. Escaping "<" (and the two JS line
// separators) keeps the payload valid JSON with identical meaning.
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
