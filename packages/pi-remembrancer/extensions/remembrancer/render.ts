import type { WarningRecord } from './warnings.js';

export type ReviewAction = 'begin' | 'next' | 'context' | 'finish' | 'cancel';

export type ReviewResultDetails = {
  action: ReviewAction;
  batch: string;
  seed?: string;
  requestedSince?: string;
  incomplete: boolean;
  warnings: WarningRecord[];
};
