/**
 * Rule definitions for the yolo-seatbelt safety guard.
 *
 * Phase A: Refactor to use RuleDefinition objects with unique IDs
 * for user-configurable severity overrides.
 *
 * Rule IDs are namespaced with category.name format to prevent collisions
 * and support organization (e.g., "catastrophic.rm-rf-root").
 */

/** Category types for organizing rules */
export type RuleCategory =
  | 'catastrophic'
  | 'protected-path'
  | 'destructive'
  | 'privilege'
  | 'git'
  | 'boundary';

/** Severity levels for rule enforcement */
export type RuleSeverity = 'block' | 'ask' | 'allow';

/** Decision enum for command classification */
export enum Decision {
  BLOCK = 'BLOCK',
  ASK = 'ASK',
  ALLOW = 'ALLOW',
}

/**
 * Definition of a single safety rule
 */
export interface RuleDefinition {
  /** Unique identifier for the rule (e.g., "catastrophic.rm-rf-root") */
  id: string;
  /** Category for organization and grouping */
  category: RuleCategory;
  /** Regex pattern to match against commands */
  pattern: RegExp;
  /** Default severity when no config override is provided */
  defaultSeverity: RuleSeverity;
  /** Human-readable description of what the rule detects */
  description: string;
  /** If true, rule cannot be downgraded below ASK (for safety) */
  immutable?: boolean;
}

/**
 * Built-in rule definitions registry
 * All 18 filters defined as RuleDefinition objects with IDs
 */

// Catastrophic rules (always block by default, immutable)
export const CATASTROPHIC_RULES: RuleDefinition[] = [
  {
    id: 'catastrophic.rm-rf-root',
    category: 'catastrophic',
    pattern: /\brm\s+-rf\s+\//,
    defaultSeverity: 'block',
    description: 'Blocks rm -rf / which would delete the entire filesystem',
    immutable: true,
  },
  {
    id: 'catastrophic.rm-rf-git',
    category: 'catastrophic',
    pattern: /\brm\s+-rf\s+\.git\b/,
    defaultSeverity: 'block',
    description: 'Blocks rm -rf .git which would delete the git repository',
    immutable: true,
  },
  {
    id: 'catastrophic.rm-rf-home',
    category: 'catastrophic',
    pattern: /\brm\s+-rf\s+~(?=\s|$)/,
    defaultSeverity: 'block',
    description: 'Blocks rm -rf ~ which would delete the home directory',
    immutable: true,
  },
];

// Protected path rules (always block by default, immutable)
export const PROTECTED_PATH_RULES: RuleDefinition[] = [
  {
    id: 'protected-path.git',
    category: 'protected-path',
    pattern: /\b\.git\b/,
    defaultSeverity: 'block',
    description: 'Blocks operations targeting .git directory',
    immutable: true,
  },
  {
    id: 'protected-path.env',
    category: 'protected-path',
    pattern: /\b\.env(?=\s|$|\/)/,
    defaultSeverity: 'block',
    description: 'Blocks operations targeting .env files',
    immutable: true,
  },
  {
    id: 'protected-path.ssh',
    category: 'protected-path',
    pattern: /\b\.ssh\b/,
    defaultSeverity: 'block',
    description: 'Blocks operations targeting .ssh directory',
    immutable: true,
  },
  {
    id: 'protected-path.npmrc',
    category: 'protected-path',
    pattern: /\b\.npmrc\b/,
    defaultSeverity: 'block',
    description: 'Blocks operations targeting .npmrc file',
    immutable: true,
  },
  {
    id: 'protected-path.pypirc',
    category: 'protected-path',
    pattern: /\b\.pypirc\b/,
    defaultSeverity: 'block',
    description: 'Blocks operations targeting .pypirc file',
    immutable: true,
  },
  {
    id: 'protected-path.netrc',
    category: 'protected-path',
    pattern: /\b\.netrc\b/,
    defaultSeverity: 'block',
    description: 'Blocks operations targeting .netrc file',
    immutable: true,
  },
  {
    id: 'protected-path.ssh-key',
    category: 'protected-path',
    pattern: /\bid_rsa\b|\bid_ed25519\b/,
    defaultSeverity: 'block',
    description: 'Blocks operations targeting SSH private keys',
    immutable: true,
  },
  {
    id: 'protected-path.pem',
    category: 'protected-path',
    pattern: /\b\w+\.pem\b/,
    defaultSeverity: 'block',
    description: 'Blocks operations targeting .pem certificate files',
    immutable: true,
  },
];

// Destructive rules (ask by default)
export const DESTRUCTIVE_RULES: RuleDefinition[] = [
  {
    id: 'destructive.rm-rf',
    category: 'destructive',
    pattern: /\brm\s+-rf\b/, // Changed from rm-rf-wildcard to rm-rf to match old behavior
    defaultSeverity: 'ask',
    description: 'Requires confirmation for rm -rf operations',
  },
  {
    id: 'destructive.find-delete',
    category: 'destructive',
    pattern: /\bfind\s+.*-delete\b/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for find with -delete flag',
  },
  {
    id: 'destructive.chmod-recursive',
    category: 'destructive',
    pattern: /\bchmod\s+-R\b/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for recursive chmod operations',
  },
  {
    id: 'destructive.chown-recursive',
    category: 'destructive',
    pattern: /\bchown\s+-R\b/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for recursive chown operations',
  },
];

// Privilege rules (ask by default)
export const PRIVILEGE_RULES: RuleDefinition[] = [
  {
    id: 'privilege.sudo',
    category: 'privilege',
    pattern: /\bsudo\b/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for sudo commands',
  },
];

// Git rules (ask by default)
export const GIT_RULES: RuleDefinition[] = [
  {
    id: 'git.reset-hard',
    category: 'git',
    pattern: /\bgit\s+reset\s+--hard\b/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for git reset --hard',
  },
  {
    id: 'git.clean-force',
    category: 'git',
    pattern: /\bgit\s+clean\s+-[^\s]*[fdx]/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for git clean -f, -d, or -x',
  },
  {
    id: 'git.push-force',
    category: 'git',
    pattern: /\bgit\s+push\b.*--force/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for git push --force',
  },
  {
    id: 'git.rebase-interactive',
    category: 'git',
    pattern: /\bgit\s+rebase\s+-i\b/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for git rebase -i',
  },
  {
    id: 'git.filter-branch',
    category: 'git',
    pattern: /\bgit\s+filter-branch\b/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for git filter-branch',
  },
  {
    id: 'git.update-ref',
    category: 'git',
    pattern: /\bgit\s+update-ref\b/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for git update-ref',
  },
  {
    id: 'git.reflog-expire',
    category: 'git',
    pattern: /\bgit\s+reflog\s+expire\b/,
    defaultSeverity: 'ask',
    description: 'Requires confirmation for git reflog expire',
  },
];

// Boundary rules (configurable)
export const BOUNDARY_RULES: RuleDefinition[] = [
  {
    id: 'boundary.outside-workspace',
    category: 'boundary',
    pattern: /\b\.\.\//,
    defaultSeverity: 'ask',
    description: 'Commands targeting paths outside workspace',
  },
];

/**
 * Combined registry of all built-in rules
 * This is the master list for Phase A
 */
export const BUILTIN_RULES: RuleDefinition[] = [
  ...CATASTROPHIC_RULES,
  ...PROTECTED_PATH_RULES,
  ...DESTRUCTIVE_RULES,
  ...PRIVILEGE_RULES,
  ...GIT_RULES,
  ...BOUNDARY_RULES,
];

/**
 * Get a rule definition by its unique ID
 *
 * @param ruleId - The rule ID to look up (e.g., "catastrophic.rm-rf-root")
 * @returns RuleDefinition if found, undefined otherwise
 */
export function getRuleById(ruleId: string): RuleDefinition | undefined {
  return BUILTIN_RULES.find((rule) => rule.id === ruleId);
}

/**
 * Get all rules in a specific category
 *
 * @param category - The category to filter by
 * @returns Array of rules in that category
 */
export function getRulesByCategory(category: RuleCategory): RuleDefinition[] {
  return BUILTIN_RULES.filter((rule) => rule.category === category);
}

/**
 * Get all rule IDs as an array
 *
 * @returns Array of all rule IDs
 */
export function getAllRuleIds(): string[] {
  return BUILTIN_RULES.map((rule) => rule.id);
}
