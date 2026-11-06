# Pi Userland - Conventional Commits

## PR Title Format

All PR titles must follow conventional commits with a **package scope**:

```
<type>(<scope>): <description>
```

### Scopes

| Scope                  | Meaning                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `[pi-package-name]`    | Changes to `packages/[pi-package-name]`                          |
| `root`                 | Root-level changes (CI, workflows, configs, shared tooling)      |
| _omit scope_           | Changes affecting all packages equally                           |

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
fix(pi-spinner-verbs): handle null response gracefully
chore(root): update pnpm to v9.15.0
docs: update package installation guide
refactor: standardize package.json structure
```

### Runtime and dependency policy

- Run validation on Node.js `>=22.19.0`.
- This repository targets Pi 1.x only. Use `@earendil-works/pi-*` imports, not legacy namespaces or compatibility aliases.
- Declare each Pi host package the extension actually imports in `peerDependencies` with a `^1.4.0` range, and pin the same package to `1.4.0` in `devDependencies` for validation. Do not declare unused host packages or put host packages in `dependencies`.
- If code imports `typebox` for schemas or types, declare `typebox` as a `^1.3.27` peer and pin `1.3.27` for development validation.

### Branch Protection

PRs must follow this format to merge. The CI `pr-title-check` workflow enforces this.
