import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import gitCleanupExtension, { cleanupAgentPrompt, cleanupGitWorktrees, parseCleanupArgs, parseWorktreeList, type GitExecutor } from "../index.ts";

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

await runTest("cleanupAgentPrompt preserves parsed command options", () => {
	assert.equal(
		cleanupAgentPrompt({ mainBranch: "trunk", dryRun: true, forceCurrent: false }),
		'Run the git_cleanup tool exactly once with these arguments, then briefly report its result.\n{"mainBranch":"trunk","dryRun":true,"forceCurrent":false}',
	);
});

await runTest("/cleanup dispatches an agent turn configured to invoke the cleanup tool", async () => {
	let registeredTool: { name: string } | undefined;
	let registeredCommand: { handler: (args: string) => Promise<void> } | undefined;
	let sent: { content: string; options: unknown } | undefined;
	const pi = {
		registerTool(tool: { name: string }) { registeredTool = tool; },
		registerCommand(_name: string, command: { handler: (args: string) => Promise<void> }) { registeredCommand = command; },
		sendUserMessage(content: string, options: unknown) { sent = { content, options }; },
	};

	gitCleanupExtension(pi as never);
	assert.equal(registeredTool?.name, "git_cleanup");
	await registeredCommand?.handler("--main trunk --dry-run");
	assert.deepEqual(sent, {
		content: cleanupAgentPrompt({ mainBranch: "trunk", dryRun: true, forceCurrent: false }),
		options: { deliverAs: "followUp" },
	});
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
		assert.equal(result.commands.some((command) => command.includes("'clean' '-d' '-f' '-x' '--' '.pi-subagents/'")), true);
		assert.equal(result.commands.some((command) => command.includes("'worktree' 'remove' '--force'")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("cleanup preserves worktrees containing unrecognized untracked or ignored files", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-unrecognized-"));
	const remote = path.join(root, "remote.git");
	const main = path.join(root, "main");
	const candidate = path.join(root, "candidate");
	const calls: string[][] = [];
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, main]);
		sh(main, ["git", "checkout", "-b", "main"]);
		sh(main, ["git", "config", "user.email", "test@example.com"]);
		sh(main, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(main, "README.md"), "initial\n", "utf8");
		fs.writeFileSync(path.join(main, ".gitignore"), "keep-me.log\n", "utf8");
		sh(main, ["git", "add", "README.md", ".gitignore"]);
		sh(main, ["git", "commit", "-m", "initial"]);
		sh(main, ["git", "push", "-u", "origin", "main"]);
		sh(main, ["git", "worktree", "add", "-b", "candidate", candidate, "main"]);
		fs.mkdirSync(path.join(candidate, ".pi-subagents", "runtime"), { recursive: true });
		fs.writeFileSync(path.join(candidate, ".pi-subagents", "runtime", "state.log"), "runtime\n", "utf8");
		fs.writeFileSync(path.join(candidate, "keep-me.txt"), "untracked\n", "utf8");
		fs.writeFileSync(path.join(candidate, "keep-me.log"), "ignored\n", "utf8");

		const recordingExec: GitExecutor = async (args, options) => {
			calls.push(args);
			return execGit(args, options);
		};
		const result = await cleanupGitWorktrees(main, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: recordingExec });
		assert.equal(result.skipped.some((item) => item.branch === "candidate" && item.reason === "untracked or ignored content"), true);
		assert.equal(fs.existsSync(path.join(candidate, ".pi-subagents")), true);
		assert.equal(fs.readFileSync(path.join(candidate, "keep-me.txt"), "utf8"), "untracked\n");
		assert.equal(fs.readFileSync(path.join(candidate, "keep-me.log"), "utf8"), "ignored\n");
		assert.equal(fs.existsSync(candidate), true);
		assert.match(sh(main, ["git", "branch"]), /candidate/);
		assert.equal(calls.some((args) => args[0] === "clean" && args.at(-1) === ".pi-subagents/"), false);
		assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "remove"), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("primary restoration preserves ignored content that main would overwrite", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-primary-ignore-"));
	const remote = path.join(root, "remote.git");
	const primary = path.join(root, "primary");
	const integrator = path.join(root, "integrator");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, primary]);
		sh(primary, ["git", "checkout", "-b", "main"]);
		sh(primary, ["git", "config", "user.email", "test@example.com"]);
		sh(primary, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(primary, ".gitignore"), "generated.txt\n", "utf8");
		fs.writeFileSync(path.join(primary, "generated.txt"), "tracked on main\n", "utf8");
		sh(primary, ["git", "add", ".gitignore", "-f", "generated.txt"]);
		sh(primary, ["git", "commit", "-m", "initial"]);
		sh(primary, ["git", "push", "-u", "origin", "main"]);
		sh(primary, ["git", "switch", "-c", "plan/ignored-sentinel"]);
		sh(primary, ["git", "rm", "generated.txt"]);
		sh(primary, ["git", "commit", "-m", "merged planning deletion"]);
		sh(primary, ["git", "push", "origin", "plan/ignored-sentinel:main"]);
		fs.writeFileSync(path.join(primary, "generated.txt"), "local sentinel\n", "utf8");

		await assert.rejects(
			cleanupGitWorktrees(primary, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit }),
			/overwritten by checkout|would be overwritten/i,
		);
		assert.equal(fs.readFileSync(path.join(primary, "generated.txt"), "utf8"), "local sentinel\n");
		assert.equal(sh(primary, ["git", "branch", "--show-current"]), "plan/ignored-sentinel");
		assert.match(sh(primary, ["git", "branch"]), /plan\/ignored-sentinel/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("dry-run and live preflight preserve a planning checkout when remote main would overwrite ignored content", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-ff-ignore-"));
	const remote = path.join(root, "remote.git");
	const primary = path.join(root, "primary");
	const integrator = path.join(root, "integrator");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, primary]);
		sh(primary, ["git", "checkout", "-b", "main"]);
		sh(primary, ["git", "config", "user.email", "test@example.com"]);
		sh(primary, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(primary, ".gitignore"), "generated.txt\n", "utf8");
		sh(primary, ["git", "add", ".gitignore"]);
		sh(primary, ["git", "commit", "-m", "initial"]);
		sh(primary, ["git", "push", "-u", "origin", "main"]);
		sh(primary, ["git", "switch", "-c", "plan/preserve-overwrite"]);
		fs.writeFileSync(path.join(primary, "generated.txt"), "local sentinel\n", "utf8");

		sh(root, ["git", "clone", remote, integrator]);
		sh(integrator, ["git", "config", "user.email", "test@example.com"]);
		sh(integrator, ["git", "config", "user.name", "Test User"]);
		sh(integrator, ["git", "switch", "main"]);
		fs.writeFileSync(path.join(integrator, "generated.txt"), "remote tracked\n", "utf8");
		sh(integrator, ["git", "add", "-f", "generated.txt"]);
		sh(integrator, ["git", "commit", "-m", "track generated"]);
		sh(integrator, ["git", "push", "origin", "main"]);

		for (const dryRun of [true, false]) {
			const localRefsBefore = sh(primary, ["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
			const headBefore = sh(primary, ["git", "rev-parse", "HEAD"]);
			await assert.rejects(
				cleanupGitWorktrees(primary, { mainBranch: "main", dryRun, forceCurrent: false }, { exec: execGit }),
				/local untracked or ignored content would be overwritten/,
			);
			assert.equal(sh(primary, ["git", "branch", "--show-current"]), "plan/preserve-overwrite");
			assert.equal(sh(primary, ["git", "rev-parse", "HEAD"]), headBefore);
			assert.equal(sh(primary, ["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]), localRefsBefore);
			assert.equal(fs.readFileSync(path.join(primary, "generated.txt"), "utf8"), "local sentinel\n");
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("dry-run and live preflight preserve a planning checkout when switching to local main would overwrite ignored content", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-switch-ignore-"));
	const remote = path.join(root, "remote.git");
	const primary = path.join(root, "primary");
	const integrator = path.join(root, "integrator");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, primary]);
		sh(primary, ["git", "checkout", "-b", "main"]);
		sh(primary, ["git", "config", "user.email", "test@example.com"]);
		sh(primary, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(primary, ".gitignore"), "generated.txt\n", "utf8");
		sh(primary, ["git", "add", ".gitignore"]);
		sh(primary, ["git", "commit", "-m", "initial"]);
		const initial = sh(primary, ["git", "rev-parse", "HEAD"]);
		sh(primary, ["git", "push", "-u", "origin", "main"]);

		fs.writeFileSync(path.join(primary, "generated.txt"), "tracked on local main\n", "utf8");
		sh(primary, ["git", "add", "-f", "generated.txt"]);
		sh(primary, ["git", "commit", "-m", "track generated on main"]);
		sh(primary, ["git", "push", "origin", "main"]);
		sh(primary, ["git", "switch", "-c", "plan/switch-overwrite", initial]);
		fs.writeFileSync(path.join(primary, "plan.md"), "the plan\n", "utf8");
		sh(primary, ["git", "add", "plan.md"]);
		sh(primary, ["git", "commit", "-m", "planning change"]);
		fs.writeFileSync(path.join(primary, "generated.txt"), "local sentinel\n", "utf8");

		sh(root, ["git", "clone", remote, integrator]);
		sh(integrator, ["git", "config", "user.email", "test@example.com"]);
		sh(integrator, ["git", "config", "user.name", "Test User"]);
		sh(integrator, ["git", "switch", "main"]);
		fs.writeFileSync(path.join(integrator, "plan.md"), "the plan\n", "utf8");
		sh(integrator, ["git", "add", "plan.md"]);
		sh(integrator, ["git", "commit", "-m", "integrate planning change"]);
		sh(integrator, ["git", "push", "origin", "main"]);

		for (const dryRun of [true, false]) {
			const localRefsBefore = sh(primary, ["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
			const headBefore = sh(primary, ["git", "rev-parse", "HEAD"]);
			await assert.rejects(
				cleanupGitWorktrees(primary, { mainBranch: "main", dryRun, forceCurrent: false }, { exec: execGit }),
				/local untracked or ignored content would be overwritten/,
			);
			assert.equal(sh(primary, ["git", "branch", "--show-current"]), "plan/switch-overwrite");
			assert.equal(sh(primary, ["git", "rev-parse", "HEAD"]), headBefore);
			assert.equal(sh(primary, ["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]), localRefsBefore);
			assert.equal(fs.readFileSync(path.join(primary, "generated.txt"), "utf8"), "local sentinel\n");
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("cleanup restores a clean primary checkout from a merged planning branch and ends on latest main", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-primary-"));
	const remote = path.join(root, "remote.git");
	const primary = path.join(root, "session-repo");
	const mergedWorktree = path.join(root, "merged-worktree");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, primary]);
		sh(primary, ["git", "checkout", "-b", "main"]);
		sh(primary, ["git", "config", "user.email", "test@example.com"]);
		sh(primary, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(primary, "README.md"), "initial\n", "utf8");
		sh(primary, ["git", "add", "README.md"]);
		sh(primary, ["git", "commit", "-m", "initial"]);
		sh(primary, ["git", "push", "-u", "origin", "main"]);

		sh(primary, ["git", "switch", "-c", "plan/planning-mr"]);
		fs.writeFileSync(path.join(primary, "plan.md"), "the plan\n", "utf8");
		sh(primary, ["git", "add", "plan.md"]);
		sh(primary, ["git", "commit", "-m", "planning MR"]);
		sh(primary, ["git", "push", "origin", "plan/planning-mr"]);

		const integrator = path.join(root, "integrator");
		sh(root, ["git", "clone", remote, integrator]);
		sh(integrator, ["git", "config", "user.email", "test@example.com"]);
		sh(integrator, ["git", "config", "user.name", "Test User"]);
		sh(integrator, ["git", "switch", "main"]);
		fs.writeFileSync(path.join(integrator, "plan.md"), "the plan\n", "utf8");
		sh(integrator, ["git", "add", "plan.md"]);
		sh(integrator, ["git", "commit", "-m", "squashed planning MR"]);
		sh(integrator, ["git", "push", "origin", "main"]);

		sh(primary, ["git", "worktree", "add", "-b", "already-merged", mergedWorktree, "main"]);
		const runtimeArtifact = path.join(primary, ".pi-subagents", "runtime", "active.json");
		fs.mkdirSync(path.dirname(runtimeArtifact), { recursive: true });
		fs.writeFileSync(runtimeArtifact, "primary runtime artifact\n", "utf8");
		const result = await cleanupGitWorktrees(primary, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit });

		assert.equal(sh(primary, ["git", "branch", "--show-current"]), "main");
		assert.equal(sh(primary, ["git", "rev-parse", "HEAD"]), sh(primary, ["git", "rev-parse", "origin/main"]));
		assert.doesNotMatch(sh(primary, ["git", "branch"]), /plan\/planning-mr|already-merged/);
		assert.equal(fs.existsSync(mergedWorktree), false);
		assert.equal(fs.realpathSync(result.mainWorktree!), fs.realpathSync(primary));
		assert.equal(fs.readFileSync(runtimeArtifact, "utf8"), "primary runtime artifact\n");
		assert.equal(fs.existsSync(primary), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("cleanup requires the primary checkout and reports main checked out in a linked worktree", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-linked-main-"));
	const remote = path.join(root, "remote.git");
	const primary = path.join(root, "primary");
	const mainWorktree = path.join(root, "linked-main");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, primary]);
		sh(primary, ["git", "checkout", "-b", "main"]);
		sh(primary, ["git", "config", "user.email", "test@example.com"]);
		sh(primary, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(primary, "README.md"), "initial\n", "utf8");
		sh(primary, ["git", "add", "README.md"]);
		sh(primary, ["git", "commit", "-m", "initial"]);
		sh(primary, ["git", "push", "-u", "origin", "main"]);
		sh(primary, ["git", "switch", "-c", "plan/planning-mr"]);
		sh(primary, ["git", "worktree", "add", mainWorktree, "main"]);

		await assert.rejects(
			cleanupGitWorktrees(mainWorktree, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit }),
			(error: Error) => error.message.includes("must be run from the primary checkout") && error.message.includes(primary),
		);
		await assert.rejects(
			cleanupGitWorktrees(primary, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit }),
			(error: Error) => error.message.includes("main") && error.message.includes("checked out in the linked worktree") && error.message.includes(mainWorktree),
		);
		assert.equal(sh(primary, ["git", "branch", "--show-current"]), "plan/planning-mr");
		assert.equal(sh(mainWorktree, ["git", "branch", "--show-current"]), "main");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("cleanup refuses to displace a dirty primary planning checkout", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-primary-dirty-"));
	const remote = path.join(root, "remote.git");
	const primary = path.join(root, "session-repo");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, primary]);
		sh(primary, ["git", "checkout", "-b", "main"]);
		sh(primary, ["git", "config", "user.email", "test@example.com"]);
		sh(primary, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(primary, "README.md"), "initial\n", "utf8");
		sh(primary, ["git", "add", "README.md"]);
		sh(primary, ["git", "commit", "-m", "initial"]);
		sh(primary, ["git", "push", "-u", "origin", "main"]);
		sh(primary, ["git", "switch", "-c", "plan/planning-mr"]);
		fs.writeFileSync(path.join(primary, "README.md"), "tracked local change\n", "utf8");

		await assert.rejects(
			cleanupGitWorktrees(primary, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit }),
			/has tracked local changes/,
		);
		assert.equal(sh(primary, ["git", "branch", "--show-current"]), "plan/planning-mr");
		assert.equal(fs.readFileSync(path.join(primary, "README.md"), "utf8"), "tracked local change\n");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("cleanup preserves a merged non-planning branch in the primary checkout", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-primary-policy-"));
	const remote = path.join(root, "remote.git");
	const primary = path.join(root, "primary");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, primary]);
		sh(primary, ["git", "checkout", "-b", "main"]);
		sh(primary, ["git", "config", "user.email", "test@example.com"]);
		sh(primary, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(primary, "README.md"), "initial\n", "utf8");
		sh(primary, ["git", "add", "README.md"]);
		sh(primary, ["git", "commit", "-m", "initial"]);
		sh(primary, ["git", "push", "-u", "origin", "main"]);
		sh(primary, ["git", "switch", "-c", "release/maintenance"]);

		await assert.rejects(
			cleanupGitWorktrees(primary, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit }),
			(error: Error) => error.message.includes("plan/<slug>") && error.message.includes("preserving this branch"),
		);
		assert.equal(sh(primary, ["git", "branch", "--show-current"]), "release/maintenance");
		assert.match(sh(primary, ["git", "branch"]), /release\/maintenance/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("cleanup preflights a diverged local main before switching the primary planning branch", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-diverged-main-"));
	const remote = path.join(root, "remote.git");
	const primary = path.join(root, "primary");
	const integrator = path.join(root, "integrator");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, primary]);
		sh(primary, ["git", "checkout", "-b", "main"]);
		sh(primary, ["git", "config", "user.email", "test@example.com"]);
		sh(primary, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(primary, "README.md"), "initial\n", "utf8");
		sh(primary, ["git", "add", "README.md"]);
		sh(primary, ["git", "commit", "-m", "initial"]);
		sh(primary, ["git", "push", "-u", "origin", "main"]);

		sh(root, ["git", "clone", remote, integrator]);
		sh(integrator, ["git", "config", "user.email", "test@example.com"]);
		sh(integrator, ["git", "config", "user.name", "Test User"]);
		sh(integrator, ["git", "switch", "main"]);
		fs.writeFileSync(path.join(integrator, "remote.txt"), "remote\n", "utf8");
		sh(integrator, ["git", "add", "remote.txt"]);
		sh(integrator, ["git", "commit", "-m", "remote main"]);
		sh(integrator, ["git", "push", "origin", "main"]);

		fs.writeFileSync(path.join(primary, "local-main.txt"), "local\n", "utf8");
		sh(primary, ["git", "add", "local-main.txt"]);
		sh(primary, ["git", "commit", "-m", "local main"]);
		sh(primary, ["git", "switch", "-c", "plan/diverged-main"]);

		await assert.rejects(
			cleanupGitWorktrees(primary, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit }),
			(error: Error) => error.message.includes("cannot be fast-forwarded") && error.message.includes("no worktrees or branches were removed"),
		);
		assert.equal(sh(primary, ["git", "branch", "--show-current"]), "plan/diverged-main");
		assert.match(sh(primary, ["git", "branch"]), /plan\/diverged-main/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("dry-run reads current remote main without changing refs and matches live cleanup", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-dry-remote-"));
	const remote = path.join(root, "remote.git");
	const primary = path.join(root, "primary");
	const feature = path.join(root, "feature");
	const integrator = path.join(root, "integrator");
	try {
		sh(root, ["git", "init", "--bare", remote]);
		sh(root, ["git", "clone", remote, primary]);
		sh(primary, ["git", "checkout", "-b", "main"]);
		sh(primary, ["git", "config", "user.email", "test@example.com"]);
		sh(primary, ["git", "config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(primary, "README.md"), "initial\n", "utf8");
		sh(primary, ["git", "add", "README.md"]);
		sh(primary, ["git", "commit", "-m", "initial"]);
		sh(primary, ["git", "push", "-u", "origin", "main"]);
		sh(primary, ["git", "fetch", "origin", "main"]);
		const fetchHeadBefore = fs.readFileSync(path.join(primary, ".git", "FETCH_HEAD"), "utf8");
		sh(primary, ["git", "worktree", "add", "-b", "feature", feature, "main"]);
		fs.writeFileSync(path.join(feature, "feature.txt"), "feature\n", "utf8");
		sh(feature, ["git", "add", "feature.txt"]);
		sh(feature, ["git", "commit", "-m", "feature"]);
		sh(primary, ["git", "switch", "-c", "plan/dry-run"]);

		sh(root, ["git", "clone", remote, integrator]);
		sh(integrator, ["git", "config", "user.email", "test@example.com"]);
		sh(integrator, ["git", "config", "user.name", "Test User"]);
		sh(integrator, ["git", "switch", "main"]);
		fs.writeFileSync(path.join(integrator, "feature.txt"), "feature\n", "utf8");
		sh(integrator, ["git", "add", "feature.txt"]);
		sh(integrator, ["git", "commit", "-m", "squashed feature"]);
		sh(integrator, ["git", "push", "origin", "main"]);

		const staleOriginMain = sh(primary, ["git", "rev-parse", "origin/main"]);
		assert.notEqual(staleOriginMain, sh(integrator, ["git", "rev-parse", "HEAD"]));
		const refsBefore = sh(primary, ["git", "for-each-ref", "--format=%(refname) %(objectname)"]);
		const worktreesBefore = sh(primary, ["git", "worktree", "list", "--porcelain"]);
		const symbolicHeadBefore = sh(primary, ["git", "symbolic-ref", "HEAD"]);
		const headBefore = sh(primary, ["git", "rev-parse", "HEAD"]);
		assert.equal(symbolicHeadBefore, "refs/heads/plan/dry-run");
		const dryResult = await cleanupGitWorktrees(primary, { mainBranch: "main", dryRun: true, forceCurrent: false }, { exec: execGit });

		assert.deepEqual(dryResult.removed.map((item) => item.branch), ["feature"]);
		assert.equal(dryResult.skipped.length, 0);
		assert.equal(dryResult.commands.some((command) => command.includes("'switch' '--no-overwrite-ignore' 'main'")), true);
		assert.equal(dryResult.commands.some((command) => command.includes("'branch'") && command.includes("'plan/dry-run'")), true);
		assert.equal(sh(primary, ["git", "for-each-ref", "--format=%(refname) %(objectname)"]), refsBefore);
		assert.equal(sh(primary, ["git", "worktree", "list", "--porcelain"]), worktreesBefore);
		assert.equal(sh(primary, ["git", "symbolic-ref", "HEAD"]), symbolicHeadBefore);
		assert.equal(sh(primary, ["git", "rev-parse", "HEAD"]), headBefore);
		assert.equal(fs.readFileSync(path.join(primary, ".git", "FETCH_HEAD"), "utf8"), fetchHeadBefore);
		assert.equal(sh(primary, ["git", "rev-parse", "origin/main"]), staleOriginMain);
		assert.equal(fs.existsSync(feature), true);

		const liveResult = await cleanupGitWorktrees(primary, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit });
		assert.deepEqual(liveResult.removed, dryResult.removed);
		assert.deepEqual(liveResult.skipped, dryResult.skipped);
		assert.equal(fs.existsSync(feature), false);
		assert.equal(sh(primary, ["git", "branch", "--show-current"]), "main");
		assert.doesNotMatch(sh(primary, ["git", "branch"]), /plan\/dry-run|feature/);
		assert.equal(sh(primary, ["git", "rev-parse", "HEAD"]), sh(integrator, ["git", "rev-parse", "HEAD"]));
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

await runTest("cleanup rejects patch-equivalent candidate ranges containing a merge commit", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-cleanup-merge-range-"));
	const remote = path.join(root, "remote.git");
	const main = path.join(root, "main");
	const candidate = path.join(root, "candidate");
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

		sh(main, ["git", "worktree", "add", "-b", "merge-candidate", candidate, "main"]);
		fs.writeFileSync(path.join(candidate, "feature.txt"), "feature\n", "utf8");
		sh(candidate, ["git", "add", "feature.txt"]);
		sh(candidate, ["git", "commit", "-m", "feature"]);
		const featureCommit = sh(candidate, ["git", "rev-parse", "HEAD"]);
		sh(candidate, ["git", "branch", "merge-side", "main"]);
		sh(candidate, ["git", "switch", "merge-side"]);
		fs.writeFileSync(path.join(candidate, "side.txt"), "side\n", "utf8");
		sh(candidate, ["git", "add", "side.txt"]);
		sh(candidate, ["git", "commit", "-m", "side"]);
		const sideCommit = sh(candidate, ["git", "rev-parse", "HEAD"]);
		sh(candidate, ["git", "switch", "merge-candidate"]);
		sh(candidate, ["git", "merge", "--no-ff", "--no-commit", "merge-side"]);
		fs.writeFileSync(path.join(candidate, "resolution.txt"), "unique merge resolution\n", "utf8");
		sh(candidate, ["git", "add", "resolution.txt"]);
		sh(candidate, ["git", "commit", "-m", "merge with unique resolution"]);

		sh(main, ["git", "cherry-pick", featureCommit]);
		sh(main, ["git", "cherry-pick", sideCommit]);
		sh(main, ["git", "push", "origin", "main"]);
		const result = await cleanupGitWorktrees(main, { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: execGit });

		assert.equal(fs.existsSync(candidate), true);
		assert.equal(fs.readFileSync(path.join(candidate, "resolution.txt"), "utf8"), "unique merge resolution\n");
		assert.equal(result.removed.some((item) => item.branch === "merge-candidate"), false);
		assert.equal(result.skipped.some((item) => item.branch === "merge-candidate" && item.reason.includes("not merged or patch-equivalent")), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

await runTest("cleanup propagates a linked-worktree status failure before mutating anything", async () => {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const executor: GitExecutor = async (args, options) => {
		calls.push({ args, cwd: options.cwd });
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
			return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
		}
		if (args[0] === "worktree" && args[1] === "list") {
			return {
				stdout: "worktree /repo\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nbranch refs/heads/feature\n",
				stderr: "",
				code: 0,
				killed: false,
			};
		}
		if (args[0] === "status" && options.cwd === "/repo") {
			return { stdout: "", stderr: "", code: 0, killed: false };
		}
		if (args[0] === "status" && options.cwd === "/repo-feature") {
			return { stdout: "", stderr: "status unavailable", code: 128, killed: false };
		}
		if (args[0] === "ls-files") return { stdout: "", stderr: "", code: 0, killed: false };
		throw new Error(`unexpected git call: ${args.join(" ")}`);
	};

	await assert.rejects(
		cleanupGitWorktrees("/repo", { mainBranch: "main", dryRun: false, forceCurrent: false }, { exec: executor }),
		(error: Error) => error.message.includes("git status --porcelain failed") && error.message.includes("status unavailable"),
	);
	assert.deepEqual(calls.filter((call) => call.args[0] === "status").map((call) => call.cwd), ["/repo", "/repo-feature"]);
	assert.equal(calls.some((call) => ["fetch", "switch", "merge", "update-ref"].includes(call.args[0]!)), false);
	assert.equal(calls.some((call) => call.args[0] === "worktree" && ["remove", "prune"].includes(call.args[1]!)), false);
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
		if (args[0] === "status" || args[0] === "ls-files") return { stdout: "", stderr: "", code: 0, killed: false };
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
