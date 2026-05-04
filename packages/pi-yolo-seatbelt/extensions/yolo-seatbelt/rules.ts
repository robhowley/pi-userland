/**
 * Rule definitions for the yolo-seatbelt safety guard.
 *
 * Phase E: Simplified rule IDs - no prefix categories.
 * Pattern: type.name (e.g., "rm-rf-root", "sudo", "push-force")
 */

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
    defaultSeverity: 'block',
    description: 'rm -rf / would delete the entire filesystem',
  },
  {
    id: 'rm-rf-git',
    pattern: /\brm\s+-rf\s+\.git\b/,
    defaultSeverity: 'block',
    description: 'rm -rf .git would delete the git repository',
  },
  {
    id: 'rm-rf-home',
    pattern: /\brm\s+-rf\s+~(?=\s|$)/,
    defaultSeverity: 'block',
    description: 'rm -rf ~ would delete the home directory',
  },
  {
    id: 'rm-rf',
    pattern: /\brm\s+-rf\b/,
    defaultSeverity: 'ask',
    description: 'rm -rf operations',
  },
  {
    id: 'find-delete',
    pattern: /\bfind\s+.*-delete\b/,
    defaultSeverity: 'ask',
    description: 'find with -delete flag',
  },
  {
    id: 'chmod-recursive',
    pattern: /\bchmod\s+-R\b/,
    defaultSeverity: 'ask',
    description: 'recursive chmod operations',
  },
  {
    id: 'chown-recursive',
    pattern: /\bchown\s+-R\b/,
    defaultSeverity: 'ask',
    description: 'recursive chown operations',
  },
  // Protected path rules
  {
    id: 'path-git',
    pattern: /\b\.git\b/,
    defaultSeverity: 'block',
    description: 'Targets .git directory',
  },
  {
    id: 'path-env',
    pattern: /\b\.env(?=\s|$|\/)/,
    defaultSeverity: 'block',
    description: 'Targets .env files',
  },
  {
    id: 'path-ssh',
    pattern: /\b\.ssh\b/,
    defaultSeverity: 'block',
    description: 'Targets .ssh directory',
  },
  {
    id: 'path-npmrc',
    pattern: /\b\.npmrc\b/,
    defaultSeverity: 'block',
    description: 'Targets .npmrc file',
  },
  {
    id: 'path-pypirc',
    pattern: /\b\.pypirc\b/,
    defaultSeverity: 'block',
    description: 'Targets .pypirc file',
  },
  {
    id: 'path-netrc',
    pattern: /\b\.netrc\b/,
    defaultSeverity: 'block',
    description: 'Targets .netrc file',
  },
  {
    id: 'path-ssh-key',
    pattern: /\bid_rsa\b|\bid_ed25519\b/,
    defaultSeverity: 'block',
    description: 'Targets SSH private keys',
  },
  {
    id: 'path-pem',
    pattern: /\b\w+\.pem\b/,
    defaultSeverity: 'block',
    description: 'Targets .pem certificate files',
  },
  {
    id: 'outside-workspace',
    pattern: /\b\.\.\//,
    defaultSeverity: 'ask',
    description: 'Commands targeting paths outside workspace',
  },
  // Trust boundary rules
  {
    id: 'sudo',
    pattern: /\bsudo\b/,
    defaultSeverity: 'ask',
    description: 'sudo elevates privileges',
  },
  // Git history rules
  {
    id: 'git.reset-hard',
    pattern: /\bgit\s+reset\s+--hard\b/,
    defaultSeverity: 'ask',
    description: 'git reset --hard',
  },
  {
    id: 'git.clean-force',
    pattern: /\bgit\s+clean\s+-[^\s]*[fdx]/,
    defaultSeverity: 'ask',
    description: 'git clean -f, -d, or -x',
  },
  {
    id: 'git.push-force',
    pattern: /\bgit\s+push\b.*--force/,
    defaultSeverity: 'ask',
    description: 'git push --force',
  },
  {
    id: 'git.rebase-interactive',
    pattern: /\bgit\s+rebase\s+-i\b/,
    defaultSeverity: 'ask',
    description: 'git rebase -i',
  },
  {
    id: 'git.filter-branch',
    pattern: /\bgit\s+filter-branch\b/,
    defaultSeverity: 'ask',
    description: 'git filter-branch',
  },
  {
    id: 'git.update-ref',
    pattern: /\bgit\s+update-ref\b/,
    defaultSeverity: 'ask',
    description: 'git update-ref',
  },
  {
    id: 'git.reflog-expire',
    pattern: /\bgit\s+reflog\s+expire\b/,
    defaultSeverity: 'ask',
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
