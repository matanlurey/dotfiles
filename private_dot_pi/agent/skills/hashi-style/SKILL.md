---
name: hashi-style
description: Write and review code in the style of Mitchell Hashimoto's open source work (Ghostty, libxev, Waypoint, Vagrant, Terraform) — declaration comments that carry design rationale and caller contracts, sparse narrative comments in function bodies, machine-checked invariants, and behavior-named colocated tests. Use this whenever writing a new module, type, or public API; whenever adding a non-obvious constant or workaround; whenever reviewing code for whether a future reader could recover the author's reasoning; and whenever the user mentions doc comments, code craft, readable code, self-documenting code, or asks why some code is pleasant or unpleasant to read. Also use when the user asks for code that will be maintained by other people rather than thrown away.
---

# Writing code in the Hashimoto style

## The core idea

The distinguishing property of this code is that **the author's reasoning is recoverable from the source alone**. Not what the code does, which you can read off the syntax. Why it is shaped this way, what was rejected, what breaks if you change it, and how confident the author was.

Everything below follows from that. When a rule here seems ambiguous, ask: can a competent stranger reconstruct my thinking six months from now without me in the room? If no, the code isn't done.

The failure mode to avoid is the opposite of under-commenting. It is spraying restatement comments over every line. That produces noise, buries the real rationale, and is worse than silence. The rules below allocate comment weight deliberately.

## The comment budget

Treat declaration comments and body comments as two different tools with opposite defaults.

**Declaration comments (on types, fields, functions, constants, packages): dense.** Nearly every declaration gets one, including unexported and private ones. This is where rationale, contracts, lifetimes, and failure modes live. In Ghostty's terminal subsystem roughly one line in six is a comment, and the bulk of that weight sits on declarations.

**Body comments (inside function bodies): sparse.** These are narrative beats that let a reader skim the algorithm's shape. One every ten or fifteen lines at the phase boundaries, not one per statement. Write them as short plain sentences marking what the next chunk accomplishes. If a body needs a comment on most lines, the body is wrong; extract named helpers instead.

A body comment earns its place if it does one of these: names a phase of a multi-step algorithm, explains why a surprising line is correct, or flags a workaround. Otherwise delete it.

## What a declaration comment must contain

Start with one sentence saying what the thing is, in terms of the caller's problem rather than the implementation. Then add whichever of these apply. Most declarations need one or two, not all six.

**The contract the caller must uphold.** State it bluntly and state the consequence of violating it. "This is only valid if it was returned by X; constructing it any other way is undefined and will likely crash" is the right register. Vagueness here is the single most common defect.

**Lifetime and validity.** If a returned pointer, slice, or borrowed reference stops being valid at some point, say exactly when, at the definition site. Tell the caller what to do about it, e.g. copy out anything they want to keep.

**What the function does not do.** Adjacent responsibilities the caller might reasonably assume are handled. If a function trims rows but leaves the total count to the caller, that belongs in the doc comment in plain language, not in a comment on the one line that would have updated it.

**Failure modes.** What conditions produce an error, listed concretely.

**The reason for the shape.** Why this design and not the obvious alternative. Name the alternative.

**Threading and reentrancy** if the type can be touched from more than one thread.

Write these as prose paragraphs separated by blank lines. Do not compress them into a dense block; they get read.

## Rationale: name the alternative you rejected

The highest-value sentence in a comment is usually the one starting with "because." Ghostty's terminal code contains hundreds of them. This is the difference between a comment and documentation.

For any non-obvious decision, record the tradeoff in both directions rather than only defending the choice:

```zig
/// Number of nodes to preheat the pool with. Nodes are small, so we can
/// afford a generous number, but the right value is a guess: too large
/// wastes memory on windows that never scroll, too small forces an
/// allocation on the first scroll. This is set to roughly what we expect
/// a window to scroll through immediately.
const node_preheat = 4;
```

Every magic number gets this treatment. If a constant is 4 because emoji sequences are usually at most four codepoints and four is a convenient power of two for alignment, write that down. A bare `= 4` is a defect.

Workarounds get the specific cause and version:

```go
// Recreate the client here rather than reusing the pooled one. The pooled
// client caches the auth token, and a token refreshed on another goroutine
// won't be visible to it until the next eviction. Remove this once the
// upstream client exposes token invalidation (tracked in #4412).
```

## Document the negative space

Say what a reader must not conclude, and what would go wrong if they did. This is what separates code that survives edits from code that gets subtly broken by the next person.

Patterns worth writing down explicitly:

- **Why a field has no default.** "No default on purpose so that every construction site is forced to decide" prevents someone from helpfully adding one.
- **Why a value must not be derived.** If ownership can't be inferred from allocation size because compacted allocations are smaller, say so and say that inferring it would corrupt the pool.
- **Why an apparently redundant step is load-bearing.** Someone will try to delete it.
- **Which cheap-looking accessor is expensive.** Flag it. A one-word marker like WARNING is appropriate when calling a getter silently decompresses a page.

Use emphatic markers sparingly and only for real hazards. In roughly 88,000 lines of Ghostty terminal code there are eight WARNINGs. That scarcity is what makes them work.

## Say what you don't know

Record your confidence level alongside the decision. This is unusual and it is one of the most useful things in the codebase.

Acceptable and encouraged: noting that a chunk size was picked by feel and should really be measured; noting that a better allocation strategy probably exists; noting that 32-bit targets can overflow the addressable space and this remains unaddressed. Writing "this is currently set based on vibes" next to a constant tells the next reader they may change it freely, which a confident-sounding comment would not.

Known limitations belong at the definition site, in the doc comment, not in an issue tracker the reader won't find.

## Cite the source of truth

When code implements an external specification, protocol, or algorithm, put the URL or citation in the file-level doc comment. When behavior exists to match another implementation's quirk, name that implementation. This converts hours of archaeology into one click.

```zig
//! VT-series parser for escape and control sequences.
//!
//! Implemented directly as the state machine described at
//! https://vt100.net/emu/dec_ansi_parser
```

## Draw the picture

For anything spatial, structural, or with a memory layout, an ASCII diagram in the doc comment is worth several paragraphs. Ghostty has hundreds of lines of these. Use them for buffer layouts, linked structures, coordinate systems, viewport-versus-backing-store relationships, and state machines.

```
      +--------+  region A (immutable)
      |        |
      +--------+  <-- boundary, moves on resize
      |        |  region B (active)
      +--------+
```

## Make invariants machine-checked

Documented invariants drift. Checked invariants don't. When you write a comment asserting that something is always true, consider whether the compiler or an assert can enforce it instead, and then keep the comment as the explanation of why.

Concretely: assert preconditions liberally in internal code (Ghostty's terminal code carries hundreds of asserts). Where the language allows compile-time reflection, verify structural invariants at compile time. libxev re-exports its backend API through an explicit list, then uses a `comptime` block to fail the build if any declaration is missing or has the wrong type, so the list cannot silently rot.

The Go equivalent is a compile-time interface assertion; in Rust, a trait bound or a `const` assertion; in TypeScript, an exhaustiveness check via `never`.

## Tests

Colocate tests with the code they test where the language permits.

Name tests as English sentences describing a behavior, not as function names. Prefer `"PageList bounded pruning after partial erase preserves live serials"` over `TestPruning2`. The name should read as a claim that the test proves, so a failure in CI is self-explaining without opening the file.

Test the failure paths deliberately: allocation failure, partial application, and whether an operation left state unchanged when it errored. A meaningful share of Ghostty's terminal tests exist to prove that a failed operation is a no-op. Transactional behavior is worth an explicit test with "leaves list unchanged" in the name.

## Designing public API surfaces

**Separate the low-level and high-level API and say which is which.** Document the high-level one as opinionated and less flexible, and mean it. Give the reader the escape hatch and tell them when to reach for it.

**Make the entry point obvious.** Package documentation should name the one constructor everything hangs off and show a representative call chain in prose. A reader landing on the package cold should know where to start within two sentences.

**Prefer functional options** for constructors with many optional parameters in Go. Have the option type return an error so validation lives with the option rather than in the constructor.

```go
// BuildOption configures a Build.
type BuildOption func(*buildOptions) error

// BuildWithPush sets whether the build pushes to a registry.
// The default is to push.
func BuildWithPush(v bool) BuildOption {
	return func(opts *buildOptions) error {
		opts.Push = v
		return nil
	}
}
```

**Isolate platform differences into small parallel implementations** with identical surfaces, selected once by a compile-time switch or build tag. Each implementation gets a doc comment naming the underlying primitive and the guarantee it provides.

**State resource behavior as a promise.** If a library performs no runtime allocation, say that in the README and treat it as a constraint, not an aspiration.

## READMEs

Structure a project README as: what it is in two or three sentences, an honest status paragraph, a "Why does this exist?" section, then features.

The status paragraph should be specific and unflattering where warranted: name the projects using it, and name the corners that are less exercised.

"Why does this exist?" is a numbered personal argument, not marketing. Say what was missing, whose design you're borrowing and link them, and what constraint drove you. Ending with something like "primarily this was scratching my own itch" is on-register.

State each feature as a bolded claim followed by the tradeoff it implies. A feature description that admits nothing is not doing its job.

## What this style is not

- Not a comment on every line. Restating the code in English is the failure mode this style exists to avoid.
- Not ceremonial doc blocks with empty `@param` lists. Prose, not templates.
- Not apologetic hedging. Contracts are stated bluntly. "Undefined and likely to crash" is better than "may not work as expected."
- Not exhaustive commenting of trivial declarations. A struct field named `logger` holding a logger needs nothing.
- Not clever. Naming is plain and slightly verbose in preference to short and sharp. The reader six months out is the audience, not the author today.

## Review checklist

Run this over a diff before considering it finished:

1. Can a stranger tell why each non-obvious decision was made, without asking?
2. Does every magic number carry its justification and the tradeoff on both sides?
3. Does every public declaration state its caller contract, and every borrowed return state its validity window?
4. Is there anything a future maintainer might reasonably delete or "simplify" that would break? Is that written down where they'll see it?
5. Are the uncertain parts labeled as uncertain?
6. Could any comment asserting an invariant be replaced by an assert or a compile-time check, keeping the comment as the explanation?
7. Do the test names read as claims?
8. Are there body comments that only restate the line below them? Delete those.
9. If this implements a spec or matches another implementation's quirk, is the source linked?

## Provenance

Synthesized from direct reading of Ghostty (`src/terminal`, Zig), libxev (Zig), and Waypoint (`internal/core`, Go), spanning roughly 2019 to 2026. The patterns hold across language and era, which is what makes them a style rather than a language convention.

Worth knowing: Ghostty's own `AGENTS.md` is 39 lines and purely operational — build commands, directory layout, and a rule against opening PRs. It encodes no style guidance at all. The conventions above live in the code, not in a document, which is itself a fair statement of the philosophy.
