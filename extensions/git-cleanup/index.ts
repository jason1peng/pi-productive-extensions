import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CleanupOptions {
	mainBranch: string;
	dryRun: boolean;
	forceCurrent: boolean;
}

interface WorktreeInfo {
	path: string;
	head?: string;
	branch?: string;
	detached?: boolean;
}

export interface CleanupResult {
	mainWorktree?: string;
	mainBranch: string;
	pulled: boolean;
	removed: Array<{ path: string; branch?: string }>;
	skipped: Array<{ path: string; branch?: string; reason: string }>;
	commands: string[];
}

function git(cwd: string, args: string[], options: { allowFailure?: boolean } = {}): string {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		if (options.allowFailure) return "";
		throw error;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandText(cwd: string, args: string[]): string {
	return `git -C ${shellQuote(cwd)} ${args.map(shellQuote).join(" ")}`;
}

export function parseCleanupArgs(args: string): CleanupOptions {
	const parts = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
	let mainBranch = "main";
	let dryRun = false;
	let forceCurrent = false;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (part === "--dry-run" || part === "-n") dryRun = true;
		else if (part === "--force-current") forceCurrent = true;
		else if (part === "--main" && parts[index + 1]) {
			mainBranch = parts[index + 1]!;
			index += 1;
		}
	}
	return { mainBranch, dryRun, forceCurrent };
}

export function parseWorktreeList(output: string): WorktreeInfo[] {
	const worktrees: WorktreeInfo[] = [];
	let current: WorktreeInfo | undefined;
	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) {
			if (current) worktrees.push(current);
			current = undefined;
			continue;
		}
		if (line.startsWith("worktree ")) {
			if (current) worktrees.push(current);
			current = { path: line.slice("worktree ".length) };
		} else if (current && line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
		else if (current && line.startsWith("branch ")) current.branch = line.slice("branch ".length);
		else if (current && line === "detached") current.detached = true;
	}
	if (current) worktrees.push(current);
	return worktrees;
}

function localBranchName(ref: string | undefined): string | undefined {
	return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

function isClean(worktreePath: string): boolean {
	return git(worktreePath, ["status", "--porcelain"], { allowFailure: true }) === "";
}

function isAncestor(cwd: string, maybeAncestor: string | undefined, descendant: string): boolean {
	if (!maybeAncestor) return false;
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", maybeAncestor, descendant], { cwd, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function hasNoUniquePatch(cwd: string, branchHead: string | undefined, target: string): boolean {
	if (!branchHead) return false;
	const cherry = git(cwd, ["cherry", target, branchHead], { allowFailure: true });
	if (!cherry) return false;
	return cherry.split(/\r?\n/).filter(Boolean).every((line) => line.startsWith("-"));
}

export function cleanupGitWorktrees(cwd: string, options: CleanupOptions): CleanupResult {
	const currentRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
	const worktrees = parseWorktreeList(git(currentRoot, ["worktree", "list", "--porcelain"]));
	const mainRef = `refs/heads/${options.mainBranch}`;
	const mainWorktree = worktrees.find((worktree) => worktree.branch === mainRef);
	if (!mainWorktree) throw new Error(`No ${options.mainBranch} worktree found for this repository.`);

	const result: CleanupResult = {
		mainWorktree: mainWorktree.path,
		mainBranch: options.mainBranch,
		pulled: false,
		removed: [],
		skipped: [],
		commands: [],
	};

	const runGit = (runCwd: string, args: string[]) => {
		result.commands.push(commandText(runCwd, args));
		if (!options.dryRun) git(runCwd, args);
	};

	runGit(mainWorktree.path, ["fetch", "origin", options.mainBranch, "--prune"]);
	runGit(mainWorktree.path, ["pull", "--ff-only", "origin", options.mainBranch]);
	result.pulled = !options.dryRun;

	const target = `origin/${options.mainBranch}`;
	for (const worktree of worktrees) {
		if (path.resolve(worktree.path) === path.resolve(mainWorktree.path)) continue;
		const branch = localBranchName(worktree.branch);
		if (path.resolve(worktree.path) === path.resolve(currentRoot) && !options.forceCurrent) {
			result.skipped.push({ path: worktree.path, branch, reason: "current worktree" });
			continue;
		}
		if (!isClean(worktree.path)) {
			result.skipped.push({ path: worktree.path, branch, reason: "dirty or untracked files" });
			continue;
		}
		const ancestorMerged = isAncestor(mainWorktree.path, worktree.head, target);
		const patchEquivalent = !ancestorMerged && hasNoUniquePatch(mainWorktree.path, worktree.head, target);
		if (!ancestorMerged && !patchEquivalent) {
			result.skipped.push({ path: worktree.path, branch, reason: `not merged or patch-equivalent to ${target}` });
			continue;
		}
		runGit(mainWorktree.path, ["worktree", "remove", worktree.path]);
		if (branch) runGit(mainWorktree.path, ["branch", patchEquivalent ? "-D" : "-d", branch]);
		result.removed.push({ path: worktree.path, branch });
	}
	runGit(mainWorktree.path, ["worktree", "prune"]);
	return result;
}

function formatCleanupResult(result: CleanupResult, dryRun: boolean): string {
	const lines = [
		`# Git cleanup ${dryRun ? "plan" : "complete"}`,
		"",
		`Main branch: ${result.mainBranch}`,
		`Main worktree: ${result.mainWorktree ?? "unavailable"}`,
		`Pull latest main: ${dryRun ? "planned" : result.pulled ? "done" : "not run"}`,
		"",
		"## Removed worktrees",
	];
	if (result.removed.length) {
		for (const item of result.removed) lines.push(`- ${item.path}${item.branch ? ` (${item.branch})` : ""}`);
	} else lines.push("none");
	lines.push("", "## Skipped worktrees");
	if (result.skipped.length) {
		for (const item of result.skipped) lines.push(`- ${item.path}${item.branch ? ` (${item.branch})` : ""}: ${item.reason}`);
	} else lines.push("none");
	lines.push("", "## Commands", ...result.commands.map((command) => `- \`${command}\``));
	return lines.join("\n");
}

export default function gitCleanupExtension(pi: ExtensionAPI) {
	pi.registerCommand("cleanup", {
		description: "Fast-forward main and remove clean worktrees already merged into origin/main",
		handler: async (args, ctx) => {
			try {
				const options = parseCleanupArgs(args);
				const result = cleanupGitWorktrees(ctx.cwd, options);
				ctx.ui.notify(formatCleanupResult(result, options.dryRun), "info");
			} catch (error) {
				ctx.ui.notify(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
