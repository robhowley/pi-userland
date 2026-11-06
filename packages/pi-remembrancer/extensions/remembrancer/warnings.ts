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
