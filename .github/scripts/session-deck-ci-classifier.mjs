#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ZERO_SHA = "0".repeat(40);
const OWNER_MANIFESTS = [
  "apps/session-deck-desktop/package.json",
  "packages/pi-session-deck/package.json",
];
const LOCAL_PROTOCOLS = ["workspace:", "link:", "file:"];
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const UNRELATED_PACKAGES = new Set([
  "pi-merge-ready",
  "pi-openrouter",
  "pi-session-hygiene",
  "pi-spinner-verbs",
  "pi-structured-return",
  "pi-yolo-seatbelt",
]);
const COSMETIC_POINTERS = new Map([
  [
    "packages/pi-session-deck/package.json",
    [
      "/description",
      "/keywords",
      "/repository",
      "/homepage",
      "/bugs",
      "/funding",
      "/author",
      "/contributors",
      "/license",
      "/pi/image",
    ],
  ],
  [
    "apps/session-deck-desktop/package.json",
    [
      "/description",
      "/keywords",
      "/repository",
      "/homepage",
      "/bugs",
      "/funding",
      "/author",
      "/contributors",
      "/license",
      "/private",
      "/version",
    ],
  ],
]);

function decodeUtf8(value, label) {
  if (typeof value === "string") return value;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function gitStdout(result) {
  if (result && typeof result === "object" && "stdout" in result) {
    return result.stdout;
  }
  return result;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value) || value === ZERO_SHA) {
    throw new Error(`${label} must be a nonzero 40-character hexadecimal SHA`);
  }
  return value.toLowerCase();
}

function requirePullNumber(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("pull request number must be a positive integer");
  }
  return value;
}

function requireBranchRef(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\0-\x20~^:?*\\[]/.test(value) ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error("pull request base ref is not a safe Git branch ref");
  }
  return value;
}

async function verifyCommit(sha, git) {
  await git(["rev-parse", "--verify", `${sha}^{commit}`]);
}

/** Resolve and verify the event SHAs, fetching explicit PR refs when needed. */
export async function resolvePullRequestRange(event, git) {
  if (!event || typeof event !== "object" || !event.pull_request) {
    throw new Error("pull_request event data is required");
  }
  if (typeof git !== "function") throw new TypeError("git must be a function");

  const pull = event.pull_request;
  const base = requireSha(pull.base?.sha, "pull request base SHA");
  const head = requireSha(pull.head?.sha, "pull request head SHA");
  const number = requirePullNumber(event.number);
  const baseRef = requireBranchRef(pull.base?.ref);

  try {
    await Promise.all([verifyCommit(base, git), verifyCommit(head, git)]);
  } catch {
    await git([
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
      `+refs/pull/${number}/head:refs/remotes/pull/${number}/head`,
    ]);
    await verifyCommit(base, git);
    await verifyCommit(head, git);
  }

  const rawMergeBase = gitStdout(await git(["merge-base", base, head]));
  const mergeBaseText = decodeUtf8(rawMergeBase, "git merge-base output").trim();
  if (!SHA_PATTERN.test(mergeBaseText) || mergeBaseText === ZERO_SHA) {
    throw new Error("git merge-base did not return one valid commit SHA");
  }

  return { base, head, mergeBase: mergeBaseText.toLowerCase() };
}

function validateRepositoryPath(repositoryPath) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    repositoryPath.startsWith("/") ||
    repositoryPath.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(repositoryPath) ||
    repositoryPath.includes("\\") ||
    repositoryPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe repository path: ${JSON.stringify(repositoryPath)}`);
  }
  return repositoryPath;
}

/** Read and strictly parse Git's NUL-delimited name-status stream. */
export async function readChanges(mergeBase, head, git) {
  const validMergeBase = requireSha(mergeBase, "merge base");
  const validHead = requireSha(head, "head SHA");
  if (typeof git !== "function") throw new TypeError("git must be a function");

  const result = await git([
    "diff",
    "--name-status",
    "-z",
    "--find-renames=50%",
    "--find-copies=50%",
    validMergeBase,
    validHead,
    "--",
  ]);
  const raw = gitStdout(result);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? "");
  if (bytes.length === 0) return [];

  const text = decodeUtf8(bytes, "git diff output");
  if (!text.endsWith("\0")) throw new Error("truncated NUL-delimited git diff output");
  const fields = text.slice(0, -1).split("\0");
  const changes = [];

  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (/^[AMDTU]$/.test(status)) {
      if (index >= fields.length) throw new Error(`truncated ${status} diff record`);
      changes.push({ status, paths: [validateRepositoryPath(fields[index++])] });
      continue;
    }

    const scored = /^([RC])(\d{1,3})$/.exec(status);
    if (!scored || Number(scored[2]) > 100) {
      throw new Error(`unsupported git diff status: ${JSON.stringify(status)}`);
    }
    if (index + 1 >= fields.length) throw new Error(`truncated ${status} diff record`);
    changes.push({
      status,
      paths: [
        validateRepositoryPath(fields[index++]),
        validateRepositoryPath(fields[index++]),
      ],
    });
  }

  return changes;
}

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed =
      typeof value === "string" || Buffer.isBuffer(value)
        ? JSON.parse(decodeUtf8(value, label))
        : value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function normalizeManifestMap(input) {
  const entries = input instanceof Map ? input.entries() : Object.entries(input ?? {});
  const manifests = new Map();
  for (const [manifestPath, value] of entries) {
    const safePath = validateRepositoryPath(manifestPath);
    if (!safePath.endsWith("/package.json") && safePath !== "package.json") {
      throw new Error(`workspace manifest path must end in package.json: ${safePath}`);
    }
    manifests.set(safePath, parseJsonObject(value, safePath));
  }
  return manifests;
}

function dependencyEntries(manifest, manifestPath) {
  const entries = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new Error(`${manifestPath}#/${field} must be an object`);
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec === "string" && LOCAL_PROTOCOLS.some((prefix) => spec.startsWith(prefix))) {
        entries.push({ name, spec });
      }
    }
  }
  return entries;
}

function localPathManifest(ownerPath, target) {
  if (!target || target.includes("\\") || path.posix.isAbsolute(target)) {
    throw new Error(`unsafe local dependency target ${JSON.stringify(target)} in ${ownerPath}`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), target));
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(`local dependency escapes the repository in ${ownerPath}`);
  }
  return resolved.endsWith("/package.json") ? resolved : `${resolved}/package.json`;
}

function workspaceDependencyName(dependencyName, body, manifestsByName) {
  if (body.startsWith(".") || body.startsWith("/")) return undefined;
  if (manifestsByName.has(dependencyName)) return dependencyName;

  const separator = body.startsWith("@") ? body.indexOf("@", 1) : body.indexOf("@");
  const alias = separator > 0 ? body.slice(0, separator) : body;
  return manifestsByName.has(alias) ? alias : dependencyName;
}

/** Resolve every local dependency declared by the desktop and Session Deck owners. */
export function assertLocalDependencyOwnership(workspaceManifests) {
  const manifests = normalizeManifestMap(workspaceManifests);
  for (const owner of OWNER_MANIFESTS) {
    if (!manifests.has(owner)) throw new Error(`missing owner manifest: ${owner}`);
  }

  const manifestsByName = new Map();
  for (const [manifestPath, manifest] of manifests) {
    if (typeof manifest.name !== "string" || manifest.name.length === 0) continue;
    if (manifestsByName.has(manifest.name)) {
      throw new Error(`duplicate workspace package name: ${manifest.name}`);
    }
    manifestsByName.set(manifest.name, manifestPath);
  }

  const ownedRoots = new Set();
  for (const ownerPath of OWNER_MANIFESTS) {
    const owner = manifests.get(ownerPath);
    for (const { name, spec } of dependencyEntries(owner, ownerPath)) {
      let targetManifest;
      if (spec.startsWith("link:") || spec.startsWith("file:")) {
        targetManifest = localPathManifest(ownerPath, spec.slice(spec.indexOf(":") + 1));
      } else {
        const body = spec.slice("workspace:".length);
        if (body.startsWith(".") || body.startsWith("/")) {
          targetManifest = localPathManifest(ownerPath, body);
        } else {
          const targetName = workspaceDependencyName(name, body, manifestsByName);
          targetManifest = manifestsByName.get(targetName);
        }
      }
      if (!targetManifest || !manifests.has(targetManifest)) {
        throw new Error(`${ownerPath} dependency ${name}@${spec} has no resolved workspace manifest`);
      }
      ownedRoots.add(path.posix.dirname(targetManifest));
    }
  }
  return ownedRoots;
}

function escapePointerPart(part) {
  return String(part).replaceAll("~", "~0").replaceAll("/", "~1");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function changedPointers(before, after, pointer = "") {
  if (Object.is(before, after)) return [];

  const beforeObject = isObject(before);
  const afterObject = isObject(after);
  if ((beforeObject || before === undefined) && (afterObject || after === undefined)) {
    const left = beforeObject ? before : {};
    const right = afterObject ? after : {};
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    if (keys.size === 0) return [pointer || "/"];
    return [...keys].flatMap((key) =>
      changedPointers(left[key], right[key], `${pointer}/${escapePointerPart(key)}`),
    );
  }

  const beforeArray = Array.isArray(before);
  const afterArray = Array.isArray(after);
  if ((beforeArray || before === undefined) && (afterArray || after === undefined)) {
    const left = beforeArray ? before : [];
    const right = afterArray ? after : [];
    const length = Math.max(left.length, right.length);
    if (length === 0) return [pointer || "/"];
    return Array.from({ length }, (_, index) =>
      changedPointers(left[index], right[index], `${pointer}/${index}`),
    ).flat();
  }

  return [pointer || "/"];
}

function isCosmeticPointer(pointer, allowlist) {
  return allowlist.some((allowed) => pointer === allowed || pointer.startsWith(`${allowed}/`));
}

async function manifestChangeIsCosmetic(manifestPath, readBlob) {
  if (typeof readBlob !== "function") throw new TypeError("readBlob must be a function");
  let before;
  let after;
  try {
    [before, after] = await Promise.all([
      readBlob(manifestPath, "old"),
      readBlob(manifestPath, "new"),
    ]);
  } catch (error) {
    throw new Error(`unable to read both revisions of ${manifestPath}`, { cause: error });
  }
  const oldManifest = parseJsonObject(before, `old ${manifestPath}`);
  const newManifest = parseJsonObject(after, `new ${manifestPath}`);
  return changedPointers(oldManifest, newManifest).every((pointer) =>
    isCosmeticPointer(pointer, COSMETIC_POINTERS.get(manifestPath)),
  );
}

function belongsToRoot(repositoryPath, root) {
  return repositoryPath === root || repositoryPath.startsWith(`${root}/`);
}

function pathNeedsDesktop(repositoryPath, ownedRoots) {
  if ([...ownedRoots].some((root) => belongsToRoot(repositoryPath, root))) return true;

  if (repositoryPath === "README.md" || repositoryPath === "LICENSE" || repositoryPath === ".gitignore") {
    return false;
  }
  if (repositoryPath.startsWith("site/") || repositoryPath.startsWith(".agents/")) return false;
  if (repositoryPath.startsWith(".github/")) return true;

  if (repositoryPath.startsWith("apps/session-deck-desktop/")) {
    return repositoryPath !== "apps/session-deck-desktop/README.md";
  }
  if (repositoryPath.startsWith("packages/pi-session-deck/")) {
    return !(
      repositoryPath === "packages/pi-session-deck/README.md" ||
      repositoryPath === "packages/pi-session-deck/CHANGELOG.md" ||
      repositoryPath.startsWith("packages/pi-session-deck/img/")
    );
  }

  const packageMatch = /^packages\/([^/]+)(?:\/|$)/.exec(repositoryPath);
  if (packageMatch && UNRELATED_PACKAGES.has(packageMatch[1])) return false;
  return true;
}

function validateChange(change) {
  if (!change || typeof change !== "object" || typeof change.status !== "string" || !Array.isArray(change.paths)) {
    throw new Error("invalid change record");
  }
  const renameOrCopy = /^[RC](?:\d{1,3})$/.test(change.status);
  const onePath = /^[AMDTU]$/.test(change.status);
  if ((!renameOrCopy && !onePath) || change.paths.length !== (renameOrCopy ? 2 : 1)) {
    throw new Error(`invalid change status or path count: ${change.status}`);
  }
  if (renameOrCopy && Number(change.status.slice(1)) > 100) {
    throw new Error(`invalid rename/copy score: ${change.status}`);
  }
  return change.paths.map(validateRepositoryPath);
}

/** Classify already-parsed changes. All I/O is supplied by the caller. */
export async function classify(changes, readBlob, mode = {}) {
  if (!Array.isArray(changes)) throw new TypeError("changes must be an array");
  if (mode.name !== undefined && mode.name !== "option2") {
    throw new Error(`unsupported classifier mode: ${mode.name}`);
  }
  const ownedRoots = assertLocalDependencyOwnership(mode.workspaceManifests);
  let runDesktop = false;

  for (const change of changes) {
    const paths = validateChange(change);
    const manifestPath = paths.length === 1 ? paths[0] : undefined;
    if (
      change.status === "M" &&
      manifestPath &&
      COSMETIC_POINTERS.has(manifestPath)
    ) {
      if (!(await manifestChangeIsCosmetic(manifestPath, readBlob))) runDesktop = true;
      continue;
    }
    if (paths.some((repositoryPath) => pathNeedsDesktop(repositoryPath, ownedRoots))) {
      runDesktop = true;
    }
  }

  return { run_desktop: runDesktop, classification_error: false };
}

function discoverWorkspaceManifests(rootDirectory) {
  const manifests = new Map();
  const visit = (relativeDirectory) => {
    const absoluteDirectory = path.join(rootDirectory, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const relativePath = path.posix.join(relativeDirectory, entry.name, "package.json");
      const absolutePath = path.join(rootDirectory, relativePath);
      try {
        if (statSync(absolutePath).isFile()) manifests.set(relativePath, readFileSync(absolutePath));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      visit(path.posix.join(relativeDirectory, entry.name));
    }
  };
  visit("packages");
  visit("apps");
  return manifests;
}

function runGit(args) {
  return execFileSync("git", args, {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is not set");
  const lines = Object.entries(outputs).map(([name, value]) => {
    if (value !== true && value !== false) throw new Error(`invalid output value for ${name}`);
    return `${name}=${value}\n`;
  });
  appendFileSync(outputPath, lines.join(""), "utf8");
}

async function main() {
  const rootDirectory = process.cwd();
  const workspaceManifests = discoverWorkspaceManifests(rootDirectory);
  assertLocalDependencyOwnership(workspaceManifests);

  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    writeOutputs({ run_desktop: true, classification_error: false });
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set for pull_request");
  const event = parseJsonObject(readFileSync(eventPath), "GitHub event file");
  const { head, mergeBase } = await resolvePullRequestRange(event, runGit);
  const changes = await readChanges(mergeBase, head, runGit);
  const outputs = await classify(
    changes,
    (manifestPath, side) =>
      runGit(["show", `${side === "old" ? mergeBase : head}:${manifestPath}`]),
    { name: "option2", workspaceManifests },
  );
  writeOutputs(outputs);
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error) => {
    try {
      writeOutputs({ run_desktop: true, classification_error: true });
    } catch (outputError) {
      console.error(`Session Deck CI classifier output error: ${outputError.message}`);
    }
    console.error(`Session Deck CI classifier error: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
