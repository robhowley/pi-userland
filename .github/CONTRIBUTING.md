# Pi Userland - Conventional Commits

## PR Title Format

All PR titles must follow conventional commits with a **package scope**:

```
<type>(<scope>): <description>
```

### Scopes

| Scope | Meaning |
|-------|---------|
| `pi-structured-return` | Changes to `packages/pi-structured-return` |
| `spinner-verbs` | Changes to `packages/spinner-verbs` |
| `root` | Root-level changes (CI, workflows, configs, shared tooling) |
| _omit scope_ | Changes affecting all packages equally |

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `chore`: Maintenance, dependencies
- `refactor`: Code refactoring
- `test`: Adding/modifying tests
- `perf`: Performance improvements
- `ci`: CI/CD changes
- `build`: Build system changes
- `revert`: Revert previous commit

### Examples

```
feat(pi-structured-return): add JSON parser for tool outputs
fix(spinner-verbs): handle null response gracefully
chore(root): update pnpm to v9.15.0
docs: update package installation guide
refactor: standardize package.json structure
```

### Branch Protection

PRs must follow this format to merge. The CI `pr-title-check` workflow enforces this.
