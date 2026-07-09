import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { cleanupGitWorktrees, parseCleanupArgs, parseWorktreeList } from "../index.ts";

function sh(cwd: string, args: string[]): string {
	return execFileSync(args[0]!, args.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function runTest(name: string, fn: () => Promise<void> | void) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

await runTest("parseCleanupArgs supports dry-run and custom main", () => {
	assert.deepEqual(parseCleanupArgs("--dry-run --main trunk"), { mainBranch: "trunk", dryRun: true, forceCurrent: false });
	assert.deepEqual(parseCleanupArgs("-n --force-current"), { mainBranch: "main", dryRun: true, forceCurrent: true });
});

await runTest("parseWorktreeList reads porcelain output", () => {
	const parsed = parseWorktreeList("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def\nbranch refs/heads/feature\n");
	assert.deepEqual(parsed, [
		{ path: "/repo", head: "abc", branch: "refs/heads/main" },
		{ path: "/repo-feature", head: "def", branch: "refs/heads/feature" },
	]);
});

await runTest("cleanup removes clean merged worktrees and skips dirty ones", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-"));
	const remote = path.join(root, "remote.git");
	const main = path.join(root, "repo");
	const merged = path.join(root, "repo-merged");
	const dirty = path.join(root, "repo-dirty");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, main]);
		sh(main, ["git", "checkout", "-b", "main"]);
		sh(main, ["git", "config", "user.email", "test@example.com"]);
		sh(main, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(main, "README.md"), "initial\n", "utf8");
		sh(main, ["git", "add", "README.md"]);
		sh(main, ["git", "commit", "-m", "initial"]);
		sh(main, ["git", "push", "-u", "origin", "main"]);

		sh(main, ["git", "worktree", "add", "-b", "merged-branch", merged]);
		fs.writeFileSync(path.join(merged, "merged.txt"), "merged\n", "utf8");
		sh(merged, ["git", "add", "merged.txt"]);
		sh(merged, ["git", "commit", "-m", "merged change"]);
		sh(main, ["git", "merge", "--ff-only", "merged-branch"]);
		sh(main, ["git", "push", "origin", "main"]);

		sh(main, ["git", "worktree", "add", "-b", "dirty-branch", dirty, "main"]);
		fs.writeFileSync(path.join(dirty, "untracked.txt"), "dirty\n", "utf8");

		const result = cleanupGitWorktrees(main, { mainBranch: "main", dryRun: false, forceCurrent: false });

		assert.equal(fs.existsSync(merged), false);
		assert.equal(fs.existsSync(dirty), true);
		assert.deepEqual(result.removed.map((item) => item.branch), ["merged-branch"]);
		assert.equal(result.skipped.some((item) => item.branch === "dirty-branch" && item.reason === "dirty or untracked files"), true);
		assert.doesNotMatch(sh(main, ["git", "branch"]), /merged-branch/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
