import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertLocalDependencyOwnership,
  classify,
  readChanges,
  resolvePullRequestRange,
} from "../session-deck-ci-classifier.mjs";

const SCRIPT = fileURLToPath(new URL("../session-deck-ci-classifier.mjs", import.meta.url));
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function ownerManifests(overrides = {}) {
  return {
    "apps/session-deck-desktop/package.json": {
      name: "@test/desktop",
      private: true,
      ...(overrides.desktop ?? {}),
    },
    "packages/pi-session-deck/package.json": {
      name: "@test/session-deck",
      ...(overrides.sessionDeck ?? {}),
    },
    ...(overrides.extra ?? {}),
  };
}

function change(repositoryPath, status = "M") {
  return { status, paths: [repositoryPath] };
}

function blobReader(oldValue = {}, newValue = {}) {
  return async (_manifestPath, side) => JSON.stringify(side === "old" ? oldValue : newValue);
}

async function classifyPaths(changes, options = {}) {
  return classify(changes, options.readBlob ?? blobReader(), {
    name: "option2",
    workspaceManifests: options.manifests ?? ownerManifests(),
  });
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepository() {
  const cwd = mkdtempSync(path.join(tmpdir(), "session-deck-classifier-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.email", "ci@example.test"]);
  git(cwd, ["config", "user.name", "CI Test"]);
  return cwd;
}

function commitFile(cwd, repositoryPath, contents, message) {
  const absolutePath = path.join(cwd, repositoryPath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  git(cwd, ["add", "--", repositoryPath]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function event(base, head, extra = {}) {
  return {
    number: 42,
    pull_request: {
      base: { sha: base, ref: "main" },
      head: { sha: head },
    },
    ...extra,
  };
}

function diffBuffer(...fields) {
  return Buffer.from(`${fields.join("\0")}\0`);
}

test("resolvePullRequestRange uses the merge base when the base branch advanced", async () => {
  const cwd = initRepository();
  const branchPoint = commitFile(cwd, "common.txt", "base\n", "base");
  git(cwd, ["checkout", "-q", "-b", "feature"]);
  commitFile(cwd, "feature-one.txt", "one\n", "feature one");
  const head = commitFile(cwd, "feature-two.txt", "two\n", "feature two");
  git(cwd, ["checkout", "-q", "main"]);
  const base = commitFile(cwd, "main-only.txt", "main\n", "advance main");

  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return git(cwd, args, { encoding: null });
  };
  const range = await resolvePullRequestRange(event(base, head), run);
  assert.deepEqual(range, { base, head, mergeBase: branchPoint });
  assert.equal(calls.some(([command]) => command === "fetch"), false);

  const changes = await readChanges(range.mergeBase, range.head, run);
  assert.deepEqual(
    changes.map(({ status, paths }) => [status, ...paths]),
    [
      ["A", "feature-one.txt"],
      ["A", "feature-two.txt"],
    ],
  );
});

test("readChanges handles a valid empty multi-commit PR diff", async () => {
  const calls = [];
  const changes = await readChanges(SHA_A, SHA_B, async (args) => {
    calls.push(args);
    return Buffer.alloc(0);
  });
  assert.deepEqual(changes, []);
  assert.deepEqual(calls[0], [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=50%",
    "--find-copies=50%",
    SHA_A,
    SHA_B,
    "--",
  ]);
});

test("resolvePullRequestRange fetches explicit refs with argument arrays and re-verifies", async () => {
  let verifyAttempts = 0;
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && verifyAttempts++ < 2) throw new Error("missing");
    if (args[0] === "merge-base") return `${SHA_C}\n`;
    return "";
  };

  assert.deepEqual(await resolvePullRequestRange(event(SHA_A, SHA_B), run), {
    base: SHA_A,
    head: SHA_B,
    mergeBase: SHA_C,
  });
  assert.deepEqual(calls.find(([command]) => command === "fetch"), [
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    "+refs/pull/42/head:refs/remotes/pull/42/head",
  ]);
  assert.equal(calls.filter(([command]) => command === "rev-parse").length, 4);
});

for (const [name, mutate, message] of [
  ["missing SHA", (value) => delete value.pull_request.base.sha, /base SHA/],
  ["short SHA", (value) => (value.pull_request.head.sha = "abc123"), /head SHA/],
  ["zero SHA", (value) => (value.pull_request.base.sha = "0".repeat(40)), /base SHA/],
  ["invalid PR number", (value) => (value.number = "42"), /positive integer/],
  ["unsafe base ref", (value) => (value.pull_request.base.ref = "--upload-pack=bad"), /safe Git branch/],
]) {
  test(`resolvePullRequestRange rejects ${name}`, async () => {
    const value = event(SHA_A, SHA_B);
    mutate(value);
    await assert.rejects(resolvePullRequestRange(value, async () => ""), message);
  });
}

test("resolvePullRequestRange accepts uppercase event SHAs", async () => {
  const calls = [];
  const result = await resolvePullRequestRange(event(SHA_A.toUpperCase(), SHA_B.toUpperCase()), async (args) => {
    calls.push(args);
    return args[0] === "merge-base" ? SHA_C.toUpperCase() : "";
  });
  assert.deepEqual(result, { base: SHA_A, head: SHA_B, mergeBase: SHA_C });
  assert.equal(calls[0][2], `${SHA_A}^{commit}`);
});

test("resolvePullRequestRange fails for fetch errors and missing merge bases", async (t) => {
  await t.test("fetch failure", async () => {
    await assert.rejects(
      resolvePullRequestRange(event(SHA_A, SHA_B), async (args) => {
        if (args[0] === "rev-parse" || args[0] === "fetch") throw new Error("network unavailable");
        return "";
      }),
      /network unavailable/,
    );
  });
  await t.test("empty merge base", async () => {
    await assert.rejects(
      resolvePullRequestRange(event(SHA_A, SHA_B), async () => ""),
      /merge-base did not return/,
    );
  });
  await t.test("invalid merge base output", async () => {
    await assert.rejects(
      resolvePullRequestRange(event(SHA_A, SHA_B), async (args) =>
        args[0] === "merge-base" ? `${SHA_C}\n${SHA_A}\n` : "",
      ),
      /merge-base did not return/,
    );
  });
});

test("readChanges parses modify, delete, rename, copy, spaces, and tabs", async () => {
  const output = diffBuffer(
    "M",
    "ordinary.txt",
    "D",
    "deleted file.txt",
    "R75",
    "old\tname.txt",
    "new name.txt",
    "C100",
    "source.txt",
    "copy.txt",
  );
  const changes = await readChanges(SHA_A, SHA_B, async () => output);
  assert.deepEqual(changes, [
    { status: "M", paths: ["ordinary.txt"] },
    { status: "D", paths: ["deleted file.txt"] },
    { status: "R75", paths: ["old\tname.txt", "new name.txt"] },
    { status: "C100", paths: ["source.txt", "copy.txt"] },
  ]);
});

for (const [name, output, message] of [
  ["truncated one-path record", Buffer.from("M\0"), /truncated M/],
  ["truncated rename", diffBuffer("R90", "old.txt"), /truncated R90/],
  ["unknown status", diffBuffer("Q", "file.txt"), /unsupported git diff status/],
  ["unscored rename", diffBuffer("R", "old", "new"), /unsupported git diff status/],
  ["invalid score", diffBuffer("C101", "old", "new"), /unsupported git diff status/],
  ["missing final NUL", Buffer.from("M\0file.txt"), /truncated NUL/],
  ["empty path", diffBuffer("M", ""), /unsafe repository path/],
  ["absolute path", diffBuffer("M", "/tmp/file"), /unsafe repository path/],
  ["drive path", diffBuffer("M", "C:\\tmp\\file"), /unsafe repository path/],
  ["traversal path", diffBuffer("M", "safe/../outside"), /unsafe repository path/],
  ["dot path", diffBuffer("M", "safe/./file"), /unsafe repository path/],
]) {
  test(`readChanges rejects ${name}`, async () => {
    await assert.rejects(readChanges(SHA_A, SHA_B, async () => output), message);
  });
}

test("readChanges rejects invalid UTF-8", async () => {
  const output = Buffer.concat([Buffer.from("M\0bad-"), Buffer.from([0xff]), Buffer.from("\0")]);
  await assert.rejects(readChanges(SHA_A, SHA_B, async () => output), /not valid UTF-8/);
});

test("Option 2 path rules preserve known-safe scopes", async () => {
  const safePaths = [
    "README.md",
    "LICENSE",
    ".gitignore",
    "site/index.html",
    ".agents/skills/example/SKILL.md",
    "packages/pi-session-deck/README.md",
    "packages/pi-session-deck/CHANGELOG.md",
    "packages/pi-session-deck/img/screenshot.png",
    "apps/session-deck-desktop/README.md",
    "packages/pi-merge-ready/src/index.ts",
    "packages/pi-openrouter/package.json",
    "packages/pi-session-hygiene/README.md",
    "packages/pi-spinner-verbs/img/example.png",
    "packages/pi-structured-return/src/index.ts",
    "packages/pi-yolo-seatbelt/package.json",
  ];
  for (const repositoryPath of safePaths) {
    assert.deepEqual(await classifyPaths([change(repositoryPath)]), {
      run_desktop: false,
      classification_error: false,
    }, repositoryPath);
    assert.equal((await classifyPaths([change(repositoryPath, "D")])).run_desktop, false, repositoryPath);
  }
});

test("Option 2 conservatively selects implementation, CI, toolchain, and unknown paths", async () => {
  const relevantPaths = [
    "apps/session-deck-desktop/web/app.js",
    "apps/session-deck-desktop/RELEASE.md",
    "packages/pi-session-deck/extensions/session-deck/index.ts",
    "packages/pi-session-deck/tsconfig.json",
    ".github/workflows/ci.yml",
    ".github/scripts/session-deck-ci-classifier.mjs",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "eslint.config.js",
    ".prettierrc",
    ".prettierignore",
    "rust-toolchain.toml",
    ".cargo/config.toml",
    "Cargo.toml",
    "scripts/new-root-tool.js",
    "packages/new-package/README.md",
    "apps/new-app/README.md",
  ];
  for (const repositoryPath of relevantPaths) {
    assert.equal((await classifyPaths([change(repositoryPath)])).run_desktop, true, repositoryPath);
    assert.equal((await classifyPaths([change(repositoryPath, "D")])).run_desktop, true, repositoryPath);
  }
});

test("empty and mixed diffs OR all path results", async () => {
  assert.deepEqual(await classifyPaths([]), { run_desktop: false, classification_error: false });
  assert.equal(
    (await classifyPaths([change("README.md"), change("apps/session-deck-desktop/web/app.js")])).run_desktop,
    true,
  );
});

test("renames and copies evaluate both old and new paths", async () => {
  for (const status of ["R50", "C100"]) {
    assert.equal(
      (
        await classifyPaths([
          { status, paths: ["README.md", "apps/session-deck-desktop/web/app.js"] },
        ])
      ).run_desktop,
      true,
    );
    assert.equal(
      (
        await classifyPaths([
          { status, paths: ["packages/pi-session-deck/extensions/session-deck/index.ts", "README.md"] },
        ])
      ).run_desktop,
      true,
    );
  }
});

test("the exact PR #150 six-path fixture skips desktop work", async () => {
  const oldManifest = {
    name: "@robhowley/pi-session-deck",
    description: "Old description",
    keywords: ["terminal"],
    pi: { extensions: ["./extensions/session-deck"], image: "same.png" },
  };
  const newManifest = {
    ...oldManifest,
    description: "New description",
    keywords: ["terminal", "tauri"],
  };
  const changes = [
    change("README.md"),
    change("packages/pi-merge-ready/package.json"),
    change("packages/pi-session-deck/README.md"),
    change("packages/pi-session-deck/img/session-deck-activity-states.svg", "A"),
    change("packages/pi-session-deck/img/session-deck-iterm2-integrated.png", "A"),
    change("packages/pi-session-deck/package.json"),
  ];
  assert.deepEqual(await classifyPaths(changes, { readBlob: blobReader(oldManifest, newManifest) }), {
    run_desktop: false,
    classification_error: false,
  });
});

const cosmeticCases = [
  [
    "packages/pi-session-deck/package.json",
    { description: "old", pi: { image: "old.png", extensions: ["keep"] } },
    { description: "new", pi: { image: "new.png", extensions: ["keep"] } },
  ],
  [
    "apps/session-deck-desktop/package.json",
    { version: "0.0.0", private: true, repository: { url: "old" } },
    { version: "0.0.1", private: false, repository: { url: "new" } },
  ],
];
for (const [manifestPath, before, after] of cosmeticCases) {
  test(`${manifestPath} allows only same-path cosmetic modifications`, async () => {
    assert.equal(
      (await classifyPaths([change(manifestPath)], { readBlob: blobReader(before, after) })).run_desktop,
      false,
    );
  });
}

for (const [name, manifestPath, before, after] of [
  [
    "Session Deck scripts",
    "packages/pi-session-deck/package.json",
    { description: "old", scripts: { test: "old" } },
    { description: "new", scripts: { test: "new" } },
  ],
  [
    "Session Deck pi extension",
    "packages/pi-session-deck/package.json",
    { pi: { image: "old", extensions: ["one"] } },
    { pi: { image: "new", extensions: ["two"] } },
  ],
  [
    "desktop unknown field",
    "apps/session-deck-desktop/package.json",
    { description: "old" },
    { description: "new", engines: { node: ">=20" } },
  ],
]) {
  test(`manifest semantics select functional or unknown ${name} changes`, async () => {
    assert.equal(
      (await classifyPaths([change(manifestPath)], { readBlob: blobReader(before, after) })).run_desktop,
      true,
    );
  });
}

test("mixed cosmetic and functional manifest changes remain selected", async () => {
  assert.equal(
    (
      await classifyPaths([change("packages/pi-session-deck/package.json")], {
        readBlob: blobReader(
          { description: "old", scripts: { test: "old" } },
          { description: "new", scripts: { test: "new" } },
        ),
      })
    ).run_desktop,
    true,
  );
});

test("malformed, non-object, unreadable, and invalid UTF-8 manifests are semantic errors", async (t) => {
  const manifestPath = "packages/pi-session-deck/package.json";
  for (const [name, reader, message] of [
    ["malformed", blobReader("{", "{}"), /old .* not valid JSON/],
    ["non-object", blobReader("[]", "{}"), /must contain a JSON object/],
    ["unreadable", async () => { throw new Error("missing blob"); }, /unable to read both revisions/],
    [
      "invalid UTF-8",
      async (_path, side) => (side === "old" ? Buffer.from([0xff]) : Buffer.from("{}")),
      /not valid UTF-8/,
    ],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(classifyPaths([change(manifestPath)], { readBlob: reader }), message);
    });
  }
});

test("manifest additions, deletions, renames, and copies select desktop without blob reads", async () => {
  let reads = 0;
  const readBlob = async () => { reads += 1; return "{}"; };
  const manifest = "packages/pi-session-deck/package.json";
  for (const record of [
    change(manifest, "A"),
    change(manifest, "D"),
    { status: "R100", paths: [manifest, "packages/pi-session-deck/package-renamed.json"] },
    { status: "C100", paths: ["README.md", manifest] },
  ]) {
    assert.equal((await classifyPaths([record], { readBlob })).run_desktop, true);
  }
  assert.equal(reads, 0);
});

test("classify rejects malformed records and unsafe caller-supplied paths", async () => {
  for (const record of [
    { status: "Q", paths: ["README.md"] },
    { status: "R90", paths: ["one"] },
    { status: "M", paths: ["../README.md"] },
  ]) {
    await assert.rejects(classifyPaths([record]), /invalid|unsafe/);
  }
});

test("local workspace, link, and file dependencies own their target package paths", async () => {
  const manifests = ownerManifests({
    desktop: {
      dependencies: {
        "@test/workspace": "workspace:*",
        "@test/linked": "link:../../packages/linked",
      },
    },
    sessionDeck: {
      optionalDependencies: { "@test/filed": "file:../filed" },
    },
    extra: {
      "packages/workspace/package.json": { name: "@test/workspace" },
      "packages/linked/package.json": { name: "@test/linked" },
      "packages/filed/package.json": { name: "@test/filed" },
    },
  });

  assert.deepEqual(
    [...assertLocalDependencyOwnership(manifests)].sort(),
    ["packages/filed", "packages/linked", "packages/workspace"],
  );
  for (const repositoryPath of [
    "packages/workspace/src/index.ts",
    "packages/linked/README.md",
    "packages/filed/package.json",
  ]) {
    assert.equal((await classifyPaths([change(repositoryPath)], { manifests })).run_desktop, true);
  }
});

test("relative workspace dependencies resolve and ownership overrides unrelated package rules", async () => {
  const manifests = ownerManifests({
    desktop: { devDependencies: { "@test/openrouter": "workspace:../../packages/pi-openrouter" } },
    extra: { "packages/pi-openrouter/package.json": { name: "@test/openrouter" } },
  });
  assert.deepEqual([...assertLocalDependencyOwnership(manifests)], ["packages/pi-openrouter"]);
  assert.equal(
    (await classifyPaths([change("packages/pi-openrouter/README.md")], { manifests })).run_desktop,
    true,
  );
});

test("missing, escaping, and duplicate local dependency resolutions fail closed", async () => {
  const fixtures = [
    ownerManifests({ desktop: { dependencies: { "@test/missing": "workspace:*" } } }),
    ownerManifests({ desktop: { dependencies: { "@test/outside": "file:../../../outside" } } }),
    ownerManifests({
      desktop: { dependencies: { "@test/duplicate": "workspace:*" } },
      extra: {
        "packages/one/package.json": { name: "@test/duplicate" },
        "packages/two/package.json": { name: "@test/duplicate" },
      },
    }),
  ];
  for (const manifests of fixtures) {
    assert.throws(() => assertLocalDependencyOwnership(manifests), /no resolved|escapes|duplicate/);
    await assert.rejects(classifyPaths([], { manifests }), /no resolved|escapes|duplicate/);
  }
});

test("adding a local dependency selects desktop and makes later target changes owned", async () => {
  const manifests = ownerManifests({
    desktop: { dependencies: { "@test/helper": "workspace:*" } },
    extra: { "packages/helper/package.json": { name: "@test/helper" } },
  });
  const before = { name: "@test/desktop", private: true };
  const after = { ...before, dependencies: { "@test/helper": "workspace:*" } };
  assert.equal(
    (
      await classifyPaths([change("apps/session-deck-desktop/package.json")], {
        manifests,
        readBlob: blobReader(before, after),
      })
    ).run_desktop,
    true,
  );
  assert.equal(
    (await classifyPaths([change("packages/helper/src/index.ts")], { manifests })).run_desktop,
    true,
  );
});

function writeRuntimeManifests(cwd) {
  const manifests = ownerManifests();
  for (const [manifestPath, manifest] of Object.entries(manifests)) {
    const absolutePath = path.join(cwd, manifestPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, JSON.stringify(manifest));
  }
}

test("non-PR execution writes full desktop selection without invoking Git or reading an event", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "session-deck-non-pr-"));
  writeRuntimeManifests(cwd);
  const ignoredManifest = path.join(cwd, "packages/fixture/node_modules/.ignored/package.json");
  mkdirSync(path.dirname(ignoredManifest), { recursive: true });
  writeFileSync(ignoredManifest, JSON.stringify({ name: "@test/desktop" }));
  const bin = path.join(cwd, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho invoked > git-was-invoked\nexit 99\n", { mode: 0o755 });
  const output = path.join(cwd, "github-output");
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: path.join(cwd, "does-not-exist.json"),
      GITHUB_OUTPUT: output,
      PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "run_desktop=true\nclassification_error=false\n");
  assert.throws(() => readFileSync(path.join(cwd, "git-was-invoked")), /ENOENT/);
});

test("runtime event errors emit the fail-closed output envelope and exit nonzero", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "session-deck-error-"));
  writeRuntimeManifests(cwd);
  const eventPath = path.join(cwd, "event.json");
  writeFileSync(eventPath, JSON.stringify(event("bad", SHA_B)));
  const output = path.join(cwd, "github-output");
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: output,
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(output, "utf8"), "run_desktop=true\nclassification_error=true\n");
  assert.match(result.stderr, /Session Deck CI classifier error:.*base SHA/s);
});

test("runtime output-write errors are reported and exit nonzero", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "session-deck-output-error-"));
  writeRuntimeManifests(cwd);
  const outputDirectory = path.join(cwd, "not-a-file");
  mkdirSync(outputDirectory);
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "push",
      GITHUB_OUTPUT: outputDirectory,
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /classifier output error/);
  assert.match(result.stderr, /classifier error/);
});
