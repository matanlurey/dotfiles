# Go doc comments

Doc comments are plain `//` line comments directly above the declaration, with no
blank line between. Every exported (capitalized) name should have one. There are
no parameter/return tags in Go; write full sentences.

## Core rules

- **Begin the comment with the name of the thing** being documented. This is a hard
  Go convention: `// ResolveUser returns...`, `// Store manages...`, `// ErrNotFound is...`.
- Write complete sentences, present tense. The first sentence is the summary shown
  in package listings, so make it stand alone.
- Every package needs a package comment (`// Package foo ...`) above `package foo`,
  in one file only (conventionally `doc.go`).
- Document error behavior and any concurrency/thread-safety guarantees in prose.
- Runnable examples go in `_test.go` files as `func ExampleResolveUser()`, not in
  the doc comment. Reference them; godoc renders them.

## Example

```go
// ResolveUser returns the active user with the given id, falling back to the
// cache when the primary store misses. It returns (nil, nil) when no active
// account matches; soft-deleted accounts are treated as absent.
//
// ResolveUser returns an error only when neither store is reachable within the
// timeout; callers should treat that as retryable.
func ResolveUser(ctx context.Context, id string) (*User, error) {
    // ...
}
```

## Avoid

- Starting with anything but the identifier: `// This function returns...` breaks
  the convention and godoc rendering.
- Restating the signature: `// id is the id` adds nothing.
- Comments on unexported symbols unless the behavior is genuinely non-obvious.
- Marketing adjectives; state the guarantee (e.g. "safe for concurrent use").
