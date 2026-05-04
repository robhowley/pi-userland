/**
 * Rule definitions for the yolo-seatbelt safety guard.
 *
 * Phase E: Simplified rule IDs - no prefix categories.
 * Pattern: type.name (e.g., "rm-rf-root", "sudo", "push-force")
 */

/** Severity levels for rule enforcement */
export enum RuleSeverity {
  BLOCK = 'block',
  ASK = 'ask',
  ALLOW = 'allow',
}

/**
 * Definition of a single safety rule
 */
export interface RuleDefinition {
  /** Unique identifier for the rule (e.g., "rm-rf-root") */
  id: string;
  /** Regex pattern to match against commands */
  pattern: RegExp;
  /** Default severity when no config override is provided */
  defaultSeverity: RuleSeverity;
  /** Human-readable description of what the rule detects */
  description: string;
}

/**
 * Built-in rule definitions registry
 * All 18 filters in a single flat list
 */

export const BUILTIN_RULES: RuleDefinition[] = [
  // Data loss rules
  {
    id: 'rm-rf-root',
    pattern: /\brm\s+-rf\s+\//,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'rm -rf / would delete the entire filesystem',
  },
  {
    id: 'rm-rf-git',
    pattern: /\brm\s+-rf\s+\.git\b/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'rm -rf .git would delete the git repository',
  },
  {
    id: 'rm-rf-home',
    pattern: /\brm\s+-rf\s+~(?=\s|$)/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'rm -rf ~ would delete the home directory',
  },
  {
    id: 'rm-rf',
    pattern: /\brm\s+-rf\b/,
    defaultSeverity: RuleSeverity.ALLOW,
    description: 'rm -rf operations',
  },
  {
    id: 'find-delete',
    pattern: /\bfind\s+.*-delete\b/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'find with -delete flag',
  },
  {
    id: 'chmod-recursive',
    pattern: /\bchmod\s+-R\b/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'recursive chmod operations',
  },
  {
    id: 'chown-recursive',
    pattern: /\bchown\s+-R\b/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'recursive chown operations',
  },
  // Protected path rules
  {
    id: 'path-git',
    pattern: /\b\.git\b/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'Targets .git directory',
  },
  {
    id: 'path-env',
    pattern: /\b\.env(?=\s|$|\/)/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'Targets .env files',
  },
  {
    id: 'path-ssh',
    pattern: /\b\.ssh\b/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'Targets .ssh directory',
  },
  {
    id: 'path-npmrc',
    pattern: /\b\.npmrc\b/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'Targets .npmrc file',
  },
  {
    id: 'path-pypirc',
    pattern: /\b\.pypirc\b/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'Targets .pypirc file',
  },
  {
    id: 'path-netrc',
    pattern: /\b\.netrc\b/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'Targets .netrc file',
  },
  {
    id: 'path-ssh-key',
    pattern: /\bid_rsa\b|\bid_ed25519\b/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'Targets SSH private keys',
  },
  {
    id: 'path-pem',
    pattern: /\b\w+\.pem\b/,
    defaultSeverity: RuleSeverity.BLOCK,
    description: 'Targets .pem certificate files',
  },
  {
    id: 'outside-workspace',
    pattern: /\b\.\.\//,
    defaultSeverity: RuleSeverity.ALLOW,
    description: 'Commands targeting paths outside workspace',
  },
  // Trust boundary rules
  {
    id: 'sudo',
    pattern: /\bsudo\b/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'sudo elevates privileges',
  },
  // Git history rules
  {
    id: 'git.reset-hard',
    pattern: /\bgit\s+reset\s+--hard\b/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'git reset --hard',
  },
  {
    id: 'git.clean-force',
    pattern: /\bgit\s+clean\s+-[^\s]*[fdx]/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'git clean -f, -d, or -x',
  },
  {
    id: 'git.push-force',
    pattern: /\bgit\s+push\b.*--force/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'git push --force',
  },
  {
    id: 'git.rebase-interactive',
    pattern: /\bgit\s+rebase\s+-i\b/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'git rebase -i',
  },
  {
    id: 'git.filter-branch',
    pattern: /\bgit\s+filter-branch\b/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'git filter-branch',
  },
  {
    id: 'git.update-ref',
    pattern: /\bgit\s+update-ref\b/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'git update-ref',
  },
  {
    id: 'git.reflog-expire',
    pattern: /\bgit\s+reflog\s+expire\b/,
    defaultSeverity: RuleSeverity.ASK,
    description: 'git reflog expire',
  },
];

/**
 * Get a rule definition by its unique ID
 *
 * @param ruleId - The rule ID to look up (e.g., "rm-rf-root")
 * @returns RuleDefinition if found, undefined otherwise
 */
export function getRuleById(ruleId: string): RuleDefinition | undefined {
  return BUILTIN_RULES.find((rule) => rule.id === ruleId);
}

/**
 * Get all rule IDs as an array
 *
 * @returns Array of all rule IDs
 */
export function getAllRuleIds(): string[] {
  return BUILTIN_RULES.map((rule) => rule.id);
}
