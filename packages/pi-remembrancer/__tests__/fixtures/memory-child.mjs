/* global console, process */

import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , evidencePath, discoveryPath, archiveRoot, nearLimitFile, overLimitFile, mode] =
  process.argv;

if (!evidencePath || !discoveryPath || !archiveRoot || !nearLimitFile || !overLimitFile || !mode)
  throw new Error('memory child arguments are incomplete');

const evidence = await import(pathToFileURL(evidencePath).href);
const discoveryModule = await import(pathToFileURL(discoveryPath).href);
const { branchEvidence, prepareReview, readSession } = evidence;
const { discoverSources } = discoveryModule;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equalJson(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${label}: expected ${expectedJson}, got ${actualJson}`);
}

function memoryDiagnostic() {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    rss: usage.rss,
    maxRSS: process.resourceUsage().maxRSS,
  };
}

const sourceFiles = readdirSync(archiveRoot)
  .filter((file) => file.endsWith('.jsonl'))
  .sort()
  .map((file) => join(archiveRoot, file));
const sourceIds = sourceFiles.map((file) => basename(file, '.jsonl'));
const expectedIds = sourceIds.map((file) =>
  file === 'source-near-limit' ? 'memory-near-limit' : `memory-${file.slice(-2)}`,
);

if (mode === 'limit') {
  const limits = { recordBytes: 32 * 1024 * 1024 };
  const accepted = readSession(nearLimitFile, limits);
  assert(accepted.sessionId === 'memory-near-limit', 'near-limit record was not accepted');
  assert(accepted.tips.length === 1, 'near-limit record lost its tip');

  let rejected = false;
  try {
    readSession(overLimitFile, limits);
  } catch (error) {
    rejected = /record limit/u.test(String(error));
  }
  assert(rejected, 'over-limit record was not rejected by the raw record limit');
  console.log(JSON.stringify({ ok: true, mode, ...memoryDiagnostic() }));
} else if (mode === 'memory') {
  assert(sourceFiles.length === 7, `expected 7 source files, got ${sourceFiles.length}`);
  assert(expectedIds.length === 7, 'expected source IDs are incomplete');

  const direct = readSession(sourceFiles[0]);
  assert(direct.sessionId === expectedIds[0], 'direct read returned the wrong session');
  assert(direct.entries.size === 3, 'direct read did not retain the complete compact tree');
  assert(direct.tips.length === 1, 'direct read did not retain the session tip');
  assert(direct.tips[0].entryId === `assistant-${direct.sessionId}`, 'direct read lost the tip ID');

  const discovered = discoverSources(archiveRoot, [], '2026-01-01T00:00:00.000Z');
  assert(discovered.incomplete === false, 'discovery reported an incomplete archive');
  equalJson(
    discovered.sources.map((source) => source.sessionId),
    expectedIds,
    'discovered source IDs',
  );
  assert(discovered.newSources.length === 7, 'discovery did not stage every source');
  assert(discovered.snapshots.length === 7, 'discovery did not retain every snapshot');
  assert(discovered.warnings.length === 0, 'discovery emitted unexpected warnings');

  const review = prepareReview(
    discovered.sources,
    [],
    { requestedSince: '2026-01-01T00:00:00.000Z' },
    discovered.snapshots,
  );
  assert(review.incomplete === false, 'review reported an incomplete archive');
  assert(review.warnings.length === 0, 'review emitted unexpected warnings');
  assert(review.successfulSources.length === 7, 'review did not complete every source');
  assert(review.snapshots.length === 7, 'review lost a source snapshot');
  assert(review.tips.length === 7, 'review lost a source tip');
  assert(review.checkpoints.length === 7, 'review lost a source checkpoint');
  assert(review.evidence.length === 14, 'review lost visible evidence');
  assert(review.coverageChanged === true, 'review did not report changed coverage');

  const expectedEvidence = expectedIds.flatMap((sessionId) => [
    [`${sessionId}:user`, `user-${sessionId}`],
    [`${sessionId}:assistant`, `assistant-${sessionId}`],
  ]);
  equalJson(
    review.evidence.map((item) => [`${item.sessionId}:${item.role}`, item.text]),
    expectedEvidence,
    'review evidence',
  );

  for (const snapshot of review.snapshots) {
    const tip = snapshot.tree.tips[0];
    assert(tip !== undefined, `snapshot ${snapshot.source.sessionId} has no tip`);
    const context = branchEvidence(snapshot.tree, tip);
    equalJson(
      context.map((item) => item.text),
      [`user-${snapshot.source.sessionId}`, `assistant-${snapshot.source.sessionId}`],
      `context for ${snapshot.source.sessionId}`,
    );
  }

  console.log(
    JSON.stringify({
      ok: true,
      mode,
      sources: discovered.sources.length,
      evidence: review.evidence.length,
      contextBranches: review.snapshots.length,
      ...memoryDiagnostic(),
    }),
  );
} else {
  throw new Error(`unknown memory child mode: ${mode}`);
}
