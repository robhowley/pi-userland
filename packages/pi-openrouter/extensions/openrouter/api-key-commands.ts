import { createApiKey, setApiKeyDisabled } from './account-client.js';

export interface HandlerResult {
  success: boolean;
  message: string;
  /** Create-only one-time secret. The command router must render this outside notify/log paths. */
  secret?: string;
}

export interface ParsedApiKeyCreateArgs {
  name: string;
  limit?: number | null;
  limitReset?: 'daily' | 'weekly' | 'monthly' | null;
  includeByokInLimit?: boolean;
  workspaceId?: string;
  expiresAt?: Date;
}

const API_KEY_CREATE_USAGE =
  'Usage: /openrouter api-key-create <name> [limit=<usd|none>] [reset=<daily|weekly|monthly|none>] [byok=<incl|excl>] [workspace=<id>] [expires=<UTC ISO>]';
const API_KEY_DISABLE_USAGE = 'Usage: /openrouter api-key-disable <hash>';
const API_KEY_ENABLE_USAGE = 'Usage: /openrouter api-key-enable <hash>';

const ALLOWED_RESET_VALUES = new Set(['daily', 'weekly', 'monthly', 'none']);
const ALLOWED_BYOK_VALUES = new Set(['incl', 'excl']);

export function isUtcIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  const canonical = parsed.toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
}

function tokenizeArgs(
  args: string,
): { ok: true; value: string[] } | { ok: false; message: string } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of args.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    return {
      ok: false,
      message: `Unterminated quoted string in arguments.\n${API_KEY_CREATE_USAGE}`,
    };
  }

  if (current) {
    tokens.push(current);
  }

  return { ok: true, value: tokens };
}

export function parseApiKeyCreateArgs(
  args: string,
): { ok: true; value: ParsedApiKeyCreateArgs } | { ok: false; message: string } {
  const tokenized = tokenizeArgs(args);
  if (!tokenized.ok) {
    return { ok: false, message: tokenized.message };
  }

  const parts = tokenized.value;
  const name = parts[0];

  if (!name || name.includes('=')) {
    return { ok: false, message: API_KEY_CREATE_USAGE };
  }

  const parsed: ParsedApiKeyCreateArgs = { name };

  for (const token of parts.slice(1)) {
    const separatorIndex = token.indexOf('=');
    if (separatorIndex === -1) {
      return {
        ok: false,
        message: `Invalid option: "${token}"\nExpected key=value options after the key name.\n${API_KEY_CREATE_USAGE}`,
      };
    }

    const key = token.slice(0, separatorIndex).trim();
    const rawValue = token.slice(separatorIndex + 1).trim();

    switch (key) {
      case 'limit': {
        if (rawValue === 'none') {
          parsed.limit = null;
          break;
        }

        if (rawValue === '') {
          return {
            ok: false,
            message: `Invalid limit value: "${rawValue}"\nExpected a non-negative USD amount or 'none'.`,
          };
        }

        const limit = Number(rawValue);
        if (!Number.isFinite(limit) || limit < 0) {
          return {
            ok: false,
            message: `Invalid limit value: "${rawValue}"\nExpected a non-negative USD amount or 'none'.`,
          };
        }

        parsed.limit = limit;
        break;
      }
      case 'reset': {
        if (!ALLOWED_RESET_VALUES.has(rawValue)) {
          return {
            ok: false,
            message: `Invalid reset value: "${rawValue}"\nAllowed values: daily, weekly, monthly, none.`,
          };
        }

        parsed.limitReset =
          rawValue === 'none' ? null : (rawValue as 'daily' | 'weekly' | 'monthly');
        break;
      }
      case 'byok': {
        if (!ALLOWED_BYOK_VALUES.has(rawValue)) {
          return {
            ok: false,
            message: `Invalid byok value: "${rawValue}"\nAllowed values: incl, excl.`,
          };
        }

        parsed.includeByokInLimit = rawValue === 'incl';
        break;
      }
      case 'workspace': {
        if (!rawValue) {
          return {
            ok: false,
            message: 'Invalid workspace value: workspace id cannot be empty.',
          };
        }

        parsed.workspaceId = rawValue;
        break;
      }
      case 'expires': {
        if (!isUtcIsoTimestamp(rawValue)) {
          return {
            ok: false,
            message: `Invalid expires value: "${rawValue}"\nExpected an ISO 8601 UTC timestamp ending in Z, for example 2026-06-01T00:00:00Z.`,
          };
        }

        parsed.expiresAt = new Date(rawValue);
        break;
      }
      default:
        return {
          ok: false,
          message: `Unknown option: "${key}"\nAllowed options: limit, reset, byok, workspace, expires.\n${API_KEY_CREATE_USAGE}`,
        };
    }
  }

  return { ok: true, value: parsed };
}

export async function handleApiKeyCreate(args: string): Promise<HandlerResult> {
  const parsed = parseApiKeyCreateArgs(args);
  if (!parsed.ok) {
    return {
      success: false,
      message: parsed.message,
    };
  }

  try {
    const created = await createApiKey(parsed.value);
    const status = created.keyState.disabled ? 'disabled' : 'enabled';

    return {
      success: true,
      message: [
        'OpenRouter API key created',
        `Name: ${created.keyState.name}`,
        `Status: ${status}`,
        'Use /openrouter account to inspect or toggle the key.',
        'Secret shown in secure overlay; store it now.',
        'Warning: This secret cannot be recovered and was not written or cached locally.',
      ].join('\n'),
      secret: created.key,
    };
  } catch (error) {
    return {
      success: false,
      message: getErrorMessage(error),
    };
  }
}

export async function handleApiKeyDisable(args: string): Promise<HandlerResult> {
  return handleApiKeyToggle(args, true);
}

export async function handleApiKeyEnable(args: string): Promise<HandlerResult> {
  return handleApiKeyToggle(args, false);
}

async function handleApiKeyToggle(args: string, disabled: boolean): Promise<HandlerResult> {
  const tokenized = tokenizeArgs(args);
  if (!tokenized.ok) {
    return {
      success: false,
      message: disabled ? API_KEY_DISABLE_USAGE : API_KEY_ENABLE_USAGE,
    };
  }

  const parts = tokenized.value;
  const hash = parts[0];

  if (!hash || parts.length !== 1) {
    return {
      success: false,
      message: disabled ? API_KEY_DISABLE_USAGE : API_KEY_ENABLE_USAGE,
    };
  }

  try {
    const keyInfo = await setApiKeyDisabled(hash, disabled);
    return {
      success: true,
      message: [
        `OpenRouter API key ${disabled ? 'disabled' : 'enabled'}`,
        `Name: ${keyInfo.name}`,
        `Status: ${keyInfo.disabled ? 'disabled' : 'enabled'}`,
        'Run /openrouter account to verify.',
      ].join('\n'),
    };
  } catch (error) {
    return {
      success: false,
      message: getToggleErrorMessage(error, disabled),
    };
  }
}

function getToggleErrorMessage(error: unknown, disabled: boolean): string {
  const message = getErrorMessage(error);
  if (/OPENROUTER_MANAGEMENT_KEY/i.test(message)) {
    return message;
  }
  return `Failed to ${disabled ? 'disable' : 'enable'} OpenRouter API key. Check the key identifier and management-key permissions.`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
