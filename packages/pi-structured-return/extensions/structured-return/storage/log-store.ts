import fs from "node:fs";
import path from "node:path";

export function ensureRunDir(cwd: string): string {
  const dir = path.join(cwd, ".pi", "structured-returns");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeRunArtifacts(
  dir: string,
  runId: string,
  stdout: string,
  stderr: string
): { stdoutPath: string; stderrPath: string; logPath: string } {
  const stdoutPath = path.join(dir, `${runId}.stdout.log`);
  const stderrPath = path.join(dir, `${runId}.stderr.log`);
  const logPath = path.join(dir, `${runId}.combined.log`);
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, stderr);
  fs.writeFileSync(logPath, [stdout, stderr].filter(Boolean).join("\n"));
  return { stdoutPath, stderrPath, logPath };
}
