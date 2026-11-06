export type WarningKind =
  | 'source-failure'
  | 'archive-scan'
  | 'identity-ambiguity'
  | 'unknown-timestamp';

export type WarningRecord = {
  message: string;
  sources: string[];
  reason: string;
  kind: WarningKind;
};

export function createWarning(
  message: string,
  sources: readonly string[],
  reason: string,
  kind: WarningKind,
): WarningRecord {
  return { message, sources: [...sources], reason, kind };
}

export function warningMessages(warnings: readonly WarningRecord[]): string[] {
  return warnings.map((warning) => warning.message);
}

export function copyWarnings(warnings: readonly WarningRecord[]): WarningRecord[] {
  return warnings.map((warning) => ({ ...warning, sources: [...warning.sources] }));
}
