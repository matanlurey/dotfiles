---
name: api-doc-comments
description: Write and review high-quality documentation comments for public APIs. Treats a doc comment as a contract for external consumers (summary, params, returns, errors, invariants, examples) and strips AI slop and redundant human comments. Use when adding docstrings/JSDoc/rustdoc/godoc to public functions, classes, or modules, or when auditing existing doc comments for quality. Load references/<language>.md for language-specific conventions (TypeScript, Python, Rust, Go).
---

# API Doc Comments

Author and audit documentation comments for public APIs. A public API doc comment
is a **contract**: it is written for someone who will call the code but never read
its implementation. That framing drives every rule below.

## Doc comments vs inline comments

Keep these two jobs separate. They follow opposite rules.

- **Inline comments** explain *why*. The code already shows *what*. A comment that
  restates the next line is a defect. See the global CLAUDE.md rules.
- **Doc comments** describe the *contract*: what the symbol does, its parameters,
  return value, errors, and invariants. Here it is correct to state *what*, because
  the consumer cannot see the body. This is the one place "describe the code" is right.

Do not blur them. A doc comment is not the place for implementation trivia, and an
inline comment is not the place for parameter tables.

## When to write a doc comment

Document every **public/exported** symbol that a consumer can reach: modules,
packages, types, public functions/methods, constants, and public fields.

Skip the comment (or keep it to one line) when the signature already says everything:
trivial getters/setters, obvious enum variants, `New()`/`Default()` with no
surprises. **Prefer no doc comment over a useless one.** An empty or padded comment
signals an under-supported API; silence signals "the name is enough."

Do not document private/internal symbols unless the behavior is genuinely non-obvious,
and then a short inline note is usually better.

## Anatomy of a good doc comment

Include the following **when applicable**. Omit sections that do not apply rather
than writing filler.

1. **Summary line** first. One sentence, present tense, third person, describing
   the effect: "Returns...", "Creates...", "Parses...". Not "This function will...".
2. **Parameters**: purpose and constraints, not a retype of the type. Document
   valid ranges, units, ownership, nullability, defaults, and what booleans mean.
3. **Return value**: what it represents, including special values (empty, null,
   sentinel) and their meaning.
4. **Errors / exceptions / panics**: which ones, and the condition that triggers each.
5. **Contract notes**: preconditions, invariants, side effects, thread-safety,
   ordering guarantees, complexity if surprising.
6. **Example**: a runnable usage example for any non-trivial API. Show the common case.
7. **Cross-references** to closely related symbols when it helps navigation.

Rule of thumb for a parameter/return line: if deleting the type from the sentence
leaves nothing, delete the sentence. `@param userId The user ID` adds zero
information over `userId: string`. `@param userId ID of an existing, non-deleted
account; unknown IDs return null` earns its place.

## De-slop rules (enforce hard)

Reject and rewrite comments that show these tells, whether written by an AI or a human:

- **Signature restatement**: `@param name The name`, `@returns The result`,
  "Getter for `x`". If the type and name already carry it, cut it.
- **Narrator voice**: "This function handles...", "This method is responsible for...",
  "This class serves to...". Start with the verb instead: "Handles...".
- **Marketing adjectives**: robust, seamless, powerful, elegant, comprehensive,
  cutting-edge, flexible, efficient (unless you state the actual complexity).
- **Filler and hedging**: "it's worth noting", "simply", "basically", "essentially",
  "please note", "as you can see", "in order to" (use "to").
- **Decorative junk**: emdashes, emoji, ASCII banners, section dividers inside comments.
- **Stale / inaccurate**: a comment that contradicts the code. Flag it, verify against
  the implementation, and fix or delete. A wrong comment is worse than none.
- **Padding**: restating the class name as a sentence, empty `@param` tags with no text,
  boilerplate "Constructs a new instance of X".

Tone: terse, factual, declarative. Same voice as the rest of the codebase's docs.

## Workflow

**Authoring** new doc comments:
1. Read the actual implementation. Never document inferred behavior; document real
   behavior including error paths and edge cases.
2. Identify the public surface. Skip internals unless non-obvious.
3. Load `references/<language>.md` for the target language's tag syntax and idioms.
4. Write summary → params → returns → errors → contract → example, dropping empty sections.
5. Re-read each line against the de-slop rules and delete anything that fails.

**Reviewing / de-slopping** existing comments:
1. For each doc comment, check it against the implementation for accuracy first.
2. Run the de-slop checklist; mark each violation.
3. Rewrite or delete. Report findings grouped by symbol, using the repo's review
   format if one applies.

## Language references

Load only the file you need:

- `references/typescript.md` — TSDoc / JSDoc tags and conventions
- `references/python.md` — docstrings (PEP 257, Google/NumPy styles)
- `references/rust.md` — rustdoc, sections, doctests
- `references/go.md` — go doc comment conventions

For any other language, apply the agnostic principles above and match the
language's standard doc tool syntax.
