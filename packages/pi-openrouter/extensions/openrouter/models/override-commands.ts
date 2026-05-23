/**
 * Model override DSL parsing, validation, and command handlers.
 * Extracted from index.ts to keep command routing logic separate from DSL implementation.
 */

import type { ThinkingLevelMap, UserModelOverride } from './types.js';
import type { ModelOverridesFile } from './types.js';
import {
  getModelOverride,
  getOverrideModelIds,
  hasOverrides,
  loadModelOverrides,
  removeModelOverride,
  saveModelOverrides,
  setModelOverride,
} from './overrides.js';
// Utility to extract error messages
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// =============================================================================
// Types
// =============================================================================

export interface HandlerResult {
  success: boolean;
  message: string;
  modelId?: string;
}

interface ScopedField {
  targetField: string;
  targetType: 'string' | 'number' | 'boolean';
}

// =============================================================================
// Scoped Field Mapping
// =============================================================================

/**
 * Scoped field name mapping: converts user-facing 'thinking.X' to internal 'thinkingLevelMap.X'
 * Also supports exact PiModelConfig field names for future extensibility.
 */
export const SCOPED_FIELD_MAP: Record<string, ScopedField> = {
  // thinking.* shorthand - maps to thinkingLevelMap
  'thinking.off': { targetField: 'thinkingLevelMap.off', targetType: 'string' },
  'thinking.minimal': { targetField: 'thinkingLevelMap.minimal', targetType: 'string' },
  'thinking.low': { targetField: 'thinkingLevelMap.low', targetType: 'string' },
  'thinking.medium': { targetField: 'thinkingLevelMap.medium', targetType: 'string' },
  'thinking.high': { targetField: 'thinkingLevelMap.high', targetType: 'string' },
  'thinking.xhigh': { targetField: 'thinkingLevelMap.xhigh', targetType: 'string' },

  // exact field names (passthrough)
  'thinkingLevelMap.off': { targetField: 'thinkingLevelMap.off', targetType: 'string' },
  'thinkingLevelMap.minimal': { targetField: 'thinkingLevelMap.minimal', targetType: 'string' },
  'thinkingLevelMap.low': { targetField: 'thinkingLevelMap.low', targetType: 'string' },
  'thinkingLevelMap.medium': { targetField: 'thinkingLevelMap.medium', targetType: 'string' },
  'thinkingLevelMap.high': { targetField: 'thinkingLevelMap.high', targetType: 'string' },
  'thinkingLevelMap.xhigh': { targetField: 'thinkingLevelMap.xhigh', targetType: 'string' },

  // top-level fields (future extensibility)
  contextWindow: { targetField: 'contextWindow', targetType: 'number' },
  maxTokens: { targetField: 'maxTokens', targetType: 'number' },
  reasoning: { targetField: 'reasoning', targetType: 'boolean' },
};

// =============================================================================
// Validation
// =============================================================================

/**
 * Conservative allowlist of thinking level values accepted via CLI DSL.
 * These match documented OpenRouter and Pi thinking values.
 *
 * The JSON file escape hatch (`~/.pi/openrouter/model-overrides.json`) can be
 * edited manually for advanced or experimental values outside this set.
 */
const ALLOWED_THINKING_VALUES = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
  'xhigh', // Alias for some models
]);

/**
 * Validate a thinking level value from the CLI DSL.
 * Rejects empty, whitespace-only, or control-character values.
 * Allows null (explicit "hide this level in UI" signal) and documented thinking values.
 */
export function validateThinkingValue(value: string | null): {
  valid: boolean;
  error?: string;
} {
  if (value === null) {
    return { valid: true }; // null is allowed (means "hide this level")
  }

  // Reject empty or whitespace-only
  if (value.trim() === '') {
    return {
      valid: false,
      error: 'Thinking value cannot be empty or whitespace-only',
    };
  }

  // Reject control characters (0x00-0x1F except tab/newline, and 0x7F)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/.test(value)) {
    return {
      valid: false,
      error: 'Thinking value cannot contain control characters',
    };
  }

  // Check against conservative allowlist
  if (!ALLOWED_THINKING_VALUES.has(value)) {
    return {
      valid: false,
      error: `Thinking value "${value}" is not in the allowed set: ${Array.from(ALLOWED_THINKING_VALUES).join(', ')}\nFor advanced values, edit ~/.pi/openrouter/model-overrides.json directly`,
    };
  }

  return { valid: true };
}

// =============================================================================
// DSL Parsing
// =============================================================================

/**
 * Parse a scoped assignment like "thinking.high=high" or "contextWindow=128000".
 */
export function parseScopedAssignment(
  assignment: string,
): { fullPath: string; value: unknown } | null {
  const eqIdx = assignment.indexOf('=');
  if (eqIdx === -1) return null;

  const scopedName = assignment.slice(0, eqIdx).trim();
  const rawValue = assignment.slice(eqIdx + 1).trim();

  const mapped = SCOPED_FIELD_MAP[scopedName];
  if (!mapped) return null;

  // Parse value by type
  let parsedValue: unknown;
  switch (mapped.targetType) {
    case 'string': {
      // "null" -> null, otherwise string
      const stringValue = rawValue === 'null' ? null : rawValue;

      // Validate thinking values if this is a thinkingLevelMap field
      if (mapped.targetField.startsWith('thinkingLevelMap.')) {
        const validation = validateThinkingValue(stringValue);
        if (!validation.valid) {
          // Return null to signal parse failure; caller will show generic "Invalid assignment" error
          // This keeps CLI error messages consistent with existing behavior
          return null;
        }
      }

      parsedValue = stringValue;
      break;
    }
    case 'number': {
      const num = parseInt(rawValue, 10);
      if (isNaN(num)) return null;
      parsedValue = num;
      break;
    }
    case 'boolean':
      if (rawValue !== 'true' && rawValue !== 'false') return null;
      parsedValue = rawValue === 'true';
      break;
    default:
      return null;
  }

  return { fullPath: mapped.targetField, value: parsedValue };
}

/**
 * Apply a nested value to an object using dot notation path.
 */
export function applyNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: unknown = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const currentRecord = current as Record<string, unknown>;
    if (
      !(key in currentRecord) ||
      typeof currentRecord[key] !== 'object' ||
      currentRecord[key] === null
    ) {
      currentRecord[key] = {};
    }
    current = currentRecord[key];
  }

  const finalKey = parts[parts.length - 1]!;
  (current as Record<string, unknown>)[finalKey] = value;
}

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Handle /openrouter model-override-set command.
 * Format: model-override-set <model-id> <field=value>...
 * Examples:
 *   /openrouter model-override-set deepseek/deepseek-v4-pro thinking.high=high thinking.xhigh=max
 *   /openrouter model-override-set deepseek/deepseek-v4-pro contextWindow=128000
 */
export async function handleModelOverrideSet(
  args: string,
  userOverrides: ModelOverridesFile,
): Promise<HandlerResult> {
  const parts = args.trim().split(/\s+/).filter(Boolean);

  if (parts.length < 1) {
    return {
      success: false,
      message:
        'Usage: /openrouter model-override-set <model-id> <field=value>...\nExample: /openrouter model-override-set deepseek/deepseek-v4-pro thinking.high=high thinking.xhigh=max',
    };
  }

  const modelId = parts[0];

  if (!modelId) {
    return {
      success: false,
      message:
        'Usage: /openrouter model-override-set <model-id> <field=value>...\nExample: /openrouter model-override-set deepseek/deepseek-v4-pro thinking.high=high thinking.xhigh=max',
    };
  }

  // Validate model ID format (should be provider/model)
  if (!modelId.includes('/')) {
    return {
      success: false,
      message: `Invalid model ID format: "${modelId}"\nExpected format: provider/model (e.g., "deepseek/deepseek-v4-pro")`,
    };
  }

  // Build override incrementally from assignments
  const override: UserModelOverride = {};
  const assignments = parts.slice(1).filter((p) => !p.startsWith('--'));

  for (const assignment of assignments) {
    const parsed = parseScopedAssignment(assignment);
    if (!parsed) {
      return {
        success: false,
        message: `Invalid assignment: "${assignment}"\nExpected format: field=value (e.g., thinking.high=high or contextWindow=128000)\nSee available fields with /openrouter model-override-list --fields`,
      };
    }
    applyNestedValue(override as Record<string, unknown>, parsed.fullPath, parsed.value);
  }

  // If no assignments provided, error out
  if (Object.keys(override).length === 0) {
    return {
      success: false,
      message:
        'No field assignments provided.\nUsage: /openrouter model-override-set <model-id> field=value [field=value]...\nExample: /openrouter model-override-set deepseek/deepseek-v4-pro thinking.high=high thinking.xhigh=max',
    };
  }

  // Update overrides file
  const updatedOverrides = setModelOverride(userOverrides, modelId, override);
  try {
    await saveModelOverrides(updatedOverrides);
  } catch (error) {
    return {
      success: false,
      message: `Failed to save overrides for ${modelId}: ${getErrorMessage(error)}`,
    };
  }

  const savedOverride = updatedOverrides.overrides[modelId] as UserModelOverride;

  // Format success message
  const lines: string[] = [`Saved overrides for ${modelId}:`];
  for (const [key, val] of Object.entries(savedOverride)) {
    if (key === 'thinkingLevelMap' && val) {
      lines.push('  thinkingLevelMap:');
      for (const [level, mapped] of Object.entries(val as ThinkingLevelMap)) {
        lines.push(`    ${level}: ${mapped === null ? 'null' : mapped}`);
      }
    } else {
      lines.push(`  ${key}: ${val}`);
    }
  }

  return {
    success: true,
    message: lines.join('\n'),
    modelId,
  };
}

/**
 * Handle /openrouter model-override-clear command.
 */
export async function handleModelOverrideClear(
  args: string,
  userOverrides: ModelOverridesFile,
): Promise<HandlerResult> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const modelId = parts[0];

  if (!modelId) {
    return {
      success: false,
      message: 'Usage: /openrouter model-override-clear <model-id>',
    };
  }

  if (!modelId.includes('/')) {
    return {
      success: false,
      message: `Invalid model ID format: "${modelId}"\nExpected format: provider/model`,
    };
  }

  const existing = getModelOverride(userOverrides, modelId);
  if (!existing) {
    return {
      success: false,
      message: `No overrides found for ${modelId}`,
    };
  }

  const updatedOverrides = removeModelOverride(userOverrides, modelId);
  try {
    await saveModelOverrides(updatedOverrides);
  } catch (error) {
    return {
      success: false,
      message: `Failed to clear overrides for ${modelId}: ${getErrorMessage(error)}`,
    };
  }

  return {
    success: true,
    message: `Cleared all overrides for ${modelId}`,
    modelId,
  };
}

/**
 * Handle /openrouter model-override-list command.
 */
export async function handleModelOverrideList(args: string): Promise<string> {
  const userOverrides = await loadModelOverrides();
  const modelId = args.trim();

  // List available fields if --fields flag
  if (modelId === '--fields') {
    const fields = Object.keys(SCOPED_FIELD_MAP)
      .map(
        (k) => `  ${k}: ${SCOPED_FIELD_MAP[k]!.targetField} (${SCOPED_FIELD_MAP[k]!.targetType})`,
      )
      .join('\n');
    return `Available override fields:\n${fields}`;
  }

  if (modelId) {
    // Show specific model
    const override = getModelOverride(userOverrides, modelId);
    if (!override) {
      return `No overrides configured for ${modelId}`;
    }

    const lines: string[] = [`Overrides for ${modelId}:`];
    for (const [key, val] of Object.entries(override)) {
      if (key === 'thinkingLevelMap' && val) {
        lines.push('  thinkingLevelMap:');
        for (const [level, mapped] of Object.entries(val as ThinkingLevelMap)) {
          lines.push(`    ${level}: ${mapped === null ? 'null' : mapped}`);
        }
      } else {
        lines.push(`  ${key}: ${val}`);
      }
    }
    return lines.join('\n');
  }

  if (!hasOverrides(userOverrides)) {
    return 'No model overrides configured.\nUse /openrouter model-override-set to add overrides.';
  }

  // List all overrides
  const modelIds = getOverrideModelIds(userOverrides);
  const lines: string[] = [`${modelIds.length} model(s) with overrides:`];
  for (const id of modelIds) {
    const override = getModelOverride(userOverrides, id);
    if (override?.thinkingLevelMap && Object.keys(override.thinkingLevelMap).length > 0) {
      const tlm = Object.entries(override.thinkingLevelMap)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      lines.push(`  ${id}${tlm ? ` [${tlm}]` : ''}`);
    } else {
      lines.push(`  ${id}`);
    }
  }
  lines.push('\nUse /openrouter model-override-list <model-id> for details');
  return lines.join('\n');
}
