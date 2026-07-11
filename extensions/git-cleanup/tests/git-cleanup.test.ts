import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { cleanupGitWorktrees, parseCleanupArgs, parseWorktreeList, type GitExecutor } from "../index.ts";

const execFileAsync = promisify(execFile);

function sh(cwd: string, args: string[]): string {
	return execFileSync(args[0]!, args.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const execGit: GitExecutor = async (args, options) => {
	try {
		const result = await execFileAsync("git", args, {
			cwd: options.cwd,
			encoding: "utf8",
			timeout: options.timeout,
			signal: options.signal,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
	} catch (error) {
		const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
			code: typeof failure.code === "number" ? failure.code : 1,
			killed: failure.killed ?? failure.name === "AbortError",
		};
	}
};

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

await runTest("cleanup removes merged worktrees with untracked-only artifacts and skips tracked changes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-"));
	const remote = path.join(root, "remote.git");
	const main = path.join(root, "repo");
	const merged = path.join(root, "repo-merged");
	const untrackedOnly = path.join(root, "repo-untracked");
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

		sh(main, ["git", "worktree", "add", "-b", "untracked-branch", untrackedOnly, "main"]);
		fs.mkdirSync(path.join(untrackedOnly, ".pi-subagents", "artifacts"), { recursive: true });
		fs.writeFileSync(path.join(untrackedOnly, ".pi-subagents", "artifacts", "runtime.txt"), "runtime\n", "utf8");

		sh(main, ["git", "worktree", "add", "-b", "dirty-branch", dirty, "main"]);
		fs.writeFileSync(path.join(dirty, "README.md"), "tracked dirty\n", "utf8");

		const result = await cleanupGitWorktrees(main, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit });

		assert.equal(fs.existsSync(merged), false);
		assert.equal(fs.existsSync(untrackedOnly), false);
		assert.equal(fs.existsSync(dirty), true);
		assert.deepEqual(result.removed.map((item) => item.branch).sort(), ["merged-branch", "untracked-branch"]);
		assert.equal(result.skipped.some((item) => item.branch === "dirty-branch" && item.reason === "tracked changes"), true);
		const branches = sh(main, ["git", "branch"]);
		assert.doesNotMatch(branches, /merged-branch/);
		assert.doesNotMatch(branches, /untracked-branch/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("cleanup removes patch-equivalent worktrees from rewritten MR merges", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-cherry-"));
	const remote = path.join(root, "remote.git");
	const main = path.join(root, "repo");
	const feature = path.join(root, "repo-feature");
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

		sh(main, ["git", "worktree", "add", "-b", "feature-branch", feature, "main"]);
		sh(feature, ["git", "config", "user.email", "test@example.com"]);
		sh(feature, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(feature, "feature.txt"), "feature\n", "utf8");
		sh(feature, ["git", "add", "feature.txt"]);
		sh(feature, ["git", "commit", "-m", "feature change"]);

		fs.writeFileSync(path.join(main, "feature.txt"), "feature\n", "utf8");
		sh(main, ["git", "add", "feature.txt"]);
		sh(main, ["git", "commit", "-m", "rewritten feature change"]);
		sh(main, ["git", "push", "origin", "main"]);

		const result = await cleanupGitWorktrees(main, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit });

		assert.equal(fs.existsSync(feature), false);
		assert.deepEqual(result.removed.map((item) => item.branch), ["feature-branch"]);
		assert.doesNotMatch(sh(main, ["git", "branch"]), /feature-branch/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("cleanup forwards cancellation, uses a network timeout, and reports fetch progress", async () => {
	const controller = new AbortController();
	const calls: Array<{ args: string[]; timeout: number; signal?: AbortSignal }> = [];
	const progress: string[] = [];
	const executor: GitExecutor = async (args, options) => {
		calls.push({ args, timeout: options.timeout, signal: options.signal });
		if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
		if (args[0] === "worktree") {
			return { stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/main\n", stderr: "", code: 0, killed: false };
		}
		controller.abort();
		return { stdout: "", stderr: "", code: 1, killed: true };
	};

	await assert.rejects(
		cleanupGitWorktrees(
			"/repo",
			{ mainBranch: "main", dryRun: false, forceCurrent: false },
			{ exec: executor, signal: controller.signal, onProgress: (message) => progress.push(message) },
		),
		/command cancelled or timed out/,
	);
	const fetchCall = calls.find((call) => call.args[0] === "fetch");
	assert.equal(fetchCall?.timeout, 60_000);
	assert.equal(fetchCall?.signal, controller.signal);
	assert.deepEqual(progress, ["Fetching origin/main…"]);
});
