# TypeScript / JavaScript doc comments (TSDoc / JSDoc)

Use `/** ... */` block comments immediately above the exported symbol. TSDoc is the
baseline for TypeScript; JSDoc is the superset used in plain JS. Prefer TSDoc tags.

## Core rules

- The **type system already documents types.** Do not repeat `string`, `number`,
  nullability, or optionality that the signature encodes. Describe meaning and constraints.
- Summary is the first paragraph, no tag. Present tense: "Fetches...", "Returns...".
- Blank line separates summary from `@remarks` and tag block.

## Tags that earn their place

| Tag | Use for |
|-----|---------|
| `@param name` | Meaning/constraints of a param (not its type). Omit if the name says all. |
| `@returns` | What the value represents, including special cases. Omit for `void`. |
| `@throws` | Each error type and the condition that triggers it. |
| `@remarks` | Extended contract: side effects, invariants, thread/async notes. |
| `@example` | Runnable usage. Wrap in a fenced ```ts block. |
| `@defaultValue` | Default for an optional property/param. |
| `@see` | Cross-reference with `{@link Symbol}`. |
| `@deprecated` | Reason + replacement. |

Use `{@link Foo}` for inline references. Do not use `@type`/`@returns {Type}`
JSDoc type annotations in `.ts` files — the compiler owns types there.

## Example

```ts
/**
 * Resolves a user by ID from the primary store, falling back to the cache.
 *
 * @param userId - ID of an existing account. Unknown or soft-deleted IDs resolve to `null`.
 * @returns The user, or `null` if no active account matches.
 * @throws StoreUnavailableError if neither store responds within the timeout.
 *
 * @example
 * ```ts
 * const user = await resolveUser("u_123");
 * if (user) console.log(user.email);
 * ```
 */
export async function resolveUser(userId: string): Promise<User | null> { /* ... */ }
```

## Avoid

- `@param userId The user ID` — pure restatement.
- `@returns {Promise<User>}` in TS — redundant with the signature.
- Narrator summaries: "This function is used to resolve a user."
- Documenting every trivial React prop when the name is self-evident.
