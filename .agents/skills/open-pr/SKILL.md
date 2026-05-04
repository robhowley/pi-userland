---
name: open-pr
description: |
  Creates a pull request with a conventional commit package-aware title and a succinct bulleted description.
  Use this skill when the user says they want to open a PR, create a pull request, or when they're done with changes and want to submit them.
  Also trigger when the user mentions "pr title", "conventional commit", or wants help with PR formatting.
---

# Open PR

This skill helps create pull requests that follow the pi-userland repository conventions.

## PR Title Format

The title must follow conventional commits with a **package scope**:

```
<type>(<scope>): <description>
```

### Detecting the Scope

1. Look at what files were changed to determine which package(s) are affected
2. Use the package name from `packages/<package-name>` directory
3. Available types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`, `build`, `revert`

### Scope Rules

| Scope | When to Use |
|-------|-------------|
| `<package-name>` | Changes specific to a single package in `packages/<package-name>` |
| `root` | Root-level changes (CI, workflows, configs at repo root) |
| _omit scope_ | Changes affecting multiple/all packages equally |

### Title Examples

```
feat(pi-structured-return): add JSON parser for tool outputs
fix(pi-spinner-verbs): handle null response gracefully
chore(root): update pnpm to v9.15.0
docs: update package installation guide
```

## PR Description Format

The description must be **super terse** bullet points:

- Focus on **WHAT** was done, not HOW
- One-liners only
- No flourishes, no adjectives, no explanation
- Brevity over completeness
- Use present tense, imperative mood

### Good Examples

```
- add JSON parser for structured-return
- handle null response in spinner-verbs
- update pnpm to v9.15.0
- fix off-by-one error in paginated results
```

### Bad Examples (too verbose, focus on how)

```
- Implemented a custom JSON parser that handles nested objects by recursively iterating through keys
- I updated the package manager because the old version had security vulnerabilities
```

## Workflow

1. **Examine changes**: Look at what files were modified to determine affected packages
2. **Determine type**: Is this a feature, fix, docs update, chore, refactor?
3. **Draft title**: Use conventional commit format with appropriate scope
4. **Draft description**: List 1-5 bullet points describing what changed
5. **Submit PR**: Open the PR with the generated title and description
6. **Return link**: Return the PR URL to the user

The PR title and description should be generated directly without asking for confirmation - the format is standardized and the output is predictable.

## Edge Cases

- **Multiple packages affected**: Either omit scope (if equal impact) or list the primary package
- **No clear type**: Default to `chore` for maintenance, `feat` for new functionality
- **Single change**: One bullet point is fine
- **Breaking change**: Add `!` after type/scope, e.g., `feat(pi-foo)!: remove deprecated API`
