# Python docstrings (PEP 257 + Google / NumPy style)

Use triple-quoted `"""..."""` docstrings as the first statement of a module,
class, or public function. Follow PEP 257 for form; pick Google or NumPy style
for structured sections and stay consistent within a project.

## Core rules

- Summary line first: one imperative-or-descriptive sentence ending in a period,
  on the first line of the docstring. "Return the resolved user." / "Resolve a user."
- For multi-line docstrings, blank line after the summary, then the body.
- Type hints in the signature are the source of truth for types. In annotated code,
  do **not** repeat types in the docstring; describe meaning and constraints.
- Document raised exceptions. This is the main part of the contract the signature omits.

## Google style (recommended default)

```python
def resolve_user(user_id: str) -> User | None:
    """Resolve a user by ID, falling back to the cache.

    Args:
        user_id: ID of an existing account. Unknown or soft-deleted IDs
            resolve to ``None``.

    Returns:
        The matching active user, or ``None`` if none matches.

    Raises:
        StoreUnavailableError: If neither store responds within the timeout.

    Example:
        >>> user = resolve_user("u_123")
        >>> user.email if user else None
    """
```

## NumPy style

Use for scientific/array-heavy APIs. Sections use underline dashes:

```python
def resolve_user(user_id):
    """Resolve a user by ID.

    Parameters
    ----------
    user_id : str
        ID of an existing account; unknown IDs return ``None``.

    Returns
    -------
    User or None
        The matching active user, or ``None``.

    Raises
    ------
    StoreUnavailableError
        If neither store responds within the timeout.
    """
```

## Avoid

- `:param user_id: the user id` — restates the name.
- Repeating types when the signature is already annotated (Google style).
- "This function resolves..." — start with the verb: "Resolve...".
- Module docstrings that just repeat the filename.
