/** A message: text with {placeholders}, or one text per plural form (chosen by the `n` parameter). */
export type Msg = string | { one?: string; few?: string; many?: string; other: string }

/**
 * One namespace of messages. English is the reference; the other languages must have exactly the same keys, which the compiler
 * checks. Add a language by adding a column here (and in `index.ts`).
 */
export function defineMessages<const T extends Record<string, Msg>>(en: T, sk: { [K in keyof T]: Msg }): { en: T; sk: { [K in keyof T]: Msg } } {
  return { en, sk }
}
