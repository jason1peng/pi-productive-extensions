import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(extensionRoot, "bin", "launch-agy");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-cmux-test-"));
const fakeBin = path.join(root, "bin");
const worktree = path.join(root, "worktree");
const runDir = path.join(worktree, ".pi-subagents", "antigravity-cmux", "run-1");
const cmuxCapture = path.join(root, "cmux-command.txt");
const agyCapture = path.join(root, "agy-prompt.txt");
fs.mkdirSync(fakeBin, { recursive: true });
fs.mkdirSync(worktree, { recursive: true });

const fakeCmux = path.join(fakeBin, "cmux");
fs.writeFileSync(fakeCmux, `#!/usr/bin/env bash
set -eu
if [[ "$1" == "new-split" ]]; then
  printf 'surface:42\\n'
  exit 0
fi
if [[ "$1" == "send" ]]; then
  command=\"\${@: -1}\"
  printf '%s' \"$command\" > \"$CMUX_CAPTURE\"
  # cmux treats a trailing newline as Enter. Reject missing Enter and model
  # textual \\n escapes as transport input rather than shell source.
  [[ \"$command\" == *$'\n' ]] || { printf 'cmux send missing Enter\n' >&2; exit 1; }
  command=\"\${command%$'\n'}\"
  [[ \"$command\" != *'\\n'* ]] || { printf 'cmux send received an embedded newline escape\n' >&2; exit 1; }
  ( /bin/sh -c \"$command\" ) >/dev/null 2>&1 &
  exit 0
fi
printf 'unexpected cmux command: %s\\n' \"$*\" >&2
exit 1
`, "utf8");
fs.chmodSync(fakeCmux, 0o755);

const fakeAgy = path.join(fakeBin, "agy");
fs.writeFileSync(fakeAgy, `#!/usr/bin/env bash
set -eu
[[ "$1" == "-p" ]]
printf '%s' "$2" > \"$AGY_CAPTURE\"
if [[ \"\${AGY_SLEEP:-0}\" != 0 ]]; then sleep \"$AGY_SLEEP\"; fi
exit \"\${AGY_EXIT:-0}\"
`, "utf8");
fs.chmodSync(fakeAgy, 0o755);

const env = {
  ...process.env,
  PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  CMUX_BIN: fakeCmux,
  AGY_BIN: "agy",
  CMUX_WORKSPACE_ID: "workspace:9",
  CMUX_SURFACE_ID: "surface:3",
  CMUX_CAPTURE: cmuxCapture,
  AGY_CAPTURE: agyCapture,
};

try {
  const prompt = "Inspect this; do not run $(touch SHOULD_NOT_EXIST) or `echo unsafe`.\n\n";
  const output = execFileSync("bash", [launcher, "--worktree", worktree, "--run-dir", runDir, "--timeout", "5"], { env, input: prompt, encoding: "utf8" });
  assert.match(output, /^state=completed/m);
  assert.match(output, /^exit_code=0/m);
  assert.match(output, /^surface=surface:42/m);
  assert.equal(fs.readFileSync(agyCapture, "utf8"), prompt, "prompt bytes must survive the cmux command boundary");
  const sent = fs.readFileSync(cmuxCapture, "utf8");
  assert.equal(sent.endsWith("\n"), true, "cmux send must receive one terminating Enter");
  assert.doesNotMatch(sent.slice(0, -1), /\\\\n/, "cmux command must not contain embedded newline escapes");
  assert.match(sent, /cd -- '.*worktree'/);
  assert.match(sent, /cat -- '.*prompt\.md'/);
  assert.match(sent, /agy' -p/);
  assert.doesNotMatch(sent, /SHOULD_NOT_EXIST|echo unsafe/, "raw task text must not be cmux control input");
  assert.equal(fs.statSync(path.join(runDir, "prompt.md")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(worktree, "SHOULD_NOT_EXIST")), false);

  const timeoutRunDir = path.join(worktree, ".pi-subagents", "antigravity-cmux", "run-timeout");
  const timeout = spawnSync("bash", [launcher, "--worktree", worktree, "--run-dir", timeoutRunDir, "--timeout", "1"], {
    env: { ...env, AGY_SLEEP: "3" },
    input: "bounded task\n",
    encoding: "utf8",
  });
  assert.equal(timeout.status, 124, `expected timeout exit, got ${timeout.status}: ${timeout.stderr}`);
  const timeoutStatus = fs.readFileSync(path.join(timeoutRunDir, "status.env"), "utf8");
  assert.match(timeoutStatus, /^state=timeout/m);
  assert.match(timeoutStatus, /^exit_code=124/m);
  assert.doesNotMatch(fs.readFileSync(cmuxCapture, "utf8"), /bounded task/);

  const frontmatter = fs.readFileSync(path.join(extensionRoot, "agents", "antigravity-cmux.md"), "utf8");
  assert.match(frontmatter, /\nname: antigravity-cmux\n/);
  assert.match(frontmatter, /\ntools: read, bash\n/);
  assert.match(frontmatter, /\nskills: cmux, cmux-workspace\n/);
  const header = frontmatter.split("---", 3)[1] ?? "";
  assert.doesNotMatch(header, /external-cli|runner\.type/);
  assert.match(frontmatter, /fixed, quoted command/);
  assert.match(frontmatter, /headless and one-shot/);
  assert.match(frontmatter, /paste raw task text into `cmux send`/);

  console.log("antigravity-cmux tests: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
