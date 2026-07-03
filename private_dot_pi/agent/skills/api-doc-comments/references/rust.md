# Rust doc comments (rustdoc)

Use `///` for item docs and `//!` for module/crate docs (inner). Content is
Markdown. Every public item should have a doc comment with an example; rustdoc
compiles examples as tests, so keep them correct.

## Core rules

- First line is a short summary sentence, present tense: "Returns the resolved user."
- Blank line, then details in Markdown paragraphs.
- Use `` `backticks` `` for identifiers and `[Type]` intra-doc links for cross-refs.
- Standard section headers (`#`) that rustdoc and readers expect:
  - `# Errors` — for functions returning `Result`, describe each error condition.
  - `# Panics` — conditions under which the function panics.
  - `# Safety` — for `unsafe fn`, the invariants the caller must uphold.
  - `# Examples` — runnable code; use `?` not `.unwrap()` where reasonable.
- Don't restate types the signature encodes; describe meaning, ownership, lifetimes.

## Example

```rust
/// Resolves a user by ID from the primary store, falling back to the cache.
///
/// Returns [`None`] if no active account matches. Soft-deleted accounts are
/// treated as absent.
///
/// # Errors
///
/// Returns [`StoreError::Unavailable`] if neither store responds within the timeout.
///
/// # Examples
///
/// ```
/// # use mycrate::{resolve_user, Store};
/// # fn run(store: &Store) -> Result<(), mycrate::StoreError> {
/// if let Some(user) = resolve_user(store, "u_123")? {
///     println!("{}", user.email);
/// }
/// # Ok(())
/// # }
/// ```
pub fn resolve_user(store: &Store, user_id: &str) -> Result<Option<User>, StoreError> {
    // ...
}
```

## Avoid

- Omitting `# Errors` / `# Panics` / `# Safety` when they apply. These are the contract.
- `/// The user id` on a param-less doc; describe behavior, not the name.
- `unwrap()` in examples where `?` reads better and models real usage.
- Marketing prose in crate-level `//!` docs; state what the crate does, plainly.
