import * as path from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LOCAL_COMMAND_TIMEOUT_MS = 15_000;
const NETWORK_COMMAND_TIMEOUT_MS = 60_000;
const STATUS_KEY = "git-cleanup";

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

export interface GitExecutorOptions {
	cwd: string;
	signal?: AbortSignal;
	timeout: number;
}

export type GitExecutor = (args: string[], options: GitExecutorOptions) => Promise<ExecResult>;

export interface CleanupRuntimeOptions {
	exec: GitExecutor;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

async function git(
	cwd: string,
	args: string[],
	runtime: CleanupRuntimeOptions,
	options: { allowFailure?: boolean; timeout?: number } = {},
): Promise<string> {
	const result = await runtime.exec(args, {
		cwd,
		signal: runtime.signal,
		timeout: options.timeout ?? LOCAL_COMMAND_TIMEOUT_MS,
	});
	if (result.code === 0) return result.stdout.trim();
	if (options.allowFailure) return "";
	const detail = result.stderr.trim() || result.stdout.trim() || (result.killed ? "command cancelled or timed out" : `exit code ${result.code}`);
	throw new Error(`git ${args.join(" ")} failed: ${detail}`);
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

function isPlanningBranch(branch: string | undefined): boolean {
	return branch?.startsWith("plan/") === true && branch.length > "plan/".length;
}

interface WorktreeDirtyState {
	hasTrackedChanges: boolean;
	untrackedOrIgnored: string[];
}

async function dirtyState(worktreePath: string, runtime: CleanupRuntimeOptions): Promise<WorktreeDirtyState> {
	const status = await git(worktreePath, ["status", "--porcelain"], runtime);
	const lines = status.split(/\r?\n/).filter(Boolean);
	return {
		hasTrackedChanges: lines.some((line) => !line.startsWith("??")),
		untrackedOrIgnored: await untrackedAndIgnoredPaths(worktreePath, runtime),
	};
}

function hasUnexpectedUntracked(paths: string[]): boolean {
	return paths.some((entry) => entry !== ".pi-subagents" && !entry.startsWith(".pi-subagents/"));
}

function nulPaths(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

async function untrackedAndIgnoredPaths(cwd: string, runtime: CleanupRuntimeOptions): Promise<string[]> {
	const [untracked, ignored] = await Promise.all([
		git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], runtime),
		git(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], runtime),
	]);
	return [...new Set([...nulPaths(untracked), ...nulPaths(ignored)])];
}

function pathsConflict(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

async function assertNoUntrackedFastForwardOverwrite(cwd: string, from: string, to: string, runtime: CleanupRuntimeOptions): Promise<void> {
	const changed = nulPaths(await git(cwd, ["diff", "--name-only", "-z", from, to], runtime));
	const local = await untrackedAndIgnoredPaths(cwd, runtime);
	const conflicts = local.filter((localPath) => changed.some((changedPath) => pathsConflict(localPath, changedPath)));
	if (conflicts.length > 0) {
		throw new Error(
			`Cannot fast-forward this worktree: local untracked or ignored content would be overwritten (${conflicts.slice(0, 3).join(", ")}` +
			`${conflicts.length > 3 ? ", …" : ""}). The content was preserved; relocate it and rerun /cleanup.`,
		);
	}
}

async function isAncestor(cwd: string, maybeAncestor: string | undefined, descendant: string, runtime: CleanupRuntimeOptions): Promise<boolean> {
	if (!maybeAncestor) return false;
	const result = await runtime.exec(["merge-base", "--is-ancestor", maybeAncestor, descendant], {
		cwd,
		signal: runtime.signal,
		timeout: LOCAL_COMMAND_TIMEOUT_MS,
	});
	return result.code === 0;
}

async function hasNoUniquePatch(cwd: string, branchHead: string | undefined, target: string, runtime: CleanupRuntimeOptions): Promise<boolean> {
	if (!branchHead) return false;
	// `git cherry` does not represent merge commits, so an all-negative result
	// cannot prove that a merge's conflict resolution is present in the target.
	// Only use patch equivalence for a merge-free candidate range.
	const merges = await git(cwd, ["rev-list", "--min-parents=2", `${target}..${branchHead}`], runtime);
	if (merges) return false;
	const cherry = await git(cwd, ["cherry", target, branchHead], runtime);
	if (!cherry) return false;
	return cherry.split(/\r?\n/).filter(Boolean).every((line) => line.startsWith("-"));
}

export async function cleanupGitWorktrees(
	cwd: string,
	options: CleanupOptions,
	runtime: CleanupRuntimeOptions,
): Promise<CleanupResult> {
	const currentRoot = await git(cwd, ["rev-parse", "--show-toplevel"], runtime);
	const worktrees = parseWorktreeList(await git(currentRoot, ["worktree", "list", "--porcelain"], runtime));
	const primaryWorktree = worktrees[0];
	if (!primaryWorktree) throw new Error("No worktrees found for this repository.");
	const mainRef = `refs/heads/${options.mainBranch}`;
	let mainWorktree = worktrees.find((worktree) => worktree.branch === mainRef);
	const invokedFromPrimary = path.resolve(currentRoot) === path.resolve(primaryWorktree.path);
	if (!invokedFromPrimary) {
		throw new Error(
			`/cleanup must be run from the primary checkout at ${primaryWorktree.path}; ` +
			`the current checkout at ${currentRoot} is a linked worktree. Open the primary checkout and rerun /cleanup there.`,
		);
	}
	if (mainWorktree && path.resolve(mainWorktree.path) !== path.resolve(primaryWorktree.path)) {
		throw new Error(
			`Cannot restore the primary checkout to ${options.mainBranch} because that branch is checked out in the linked worktree at ${mainWorktree.path}. ` +
			`Switch or remove that linked worktree, then rerun /cleanup from the primary checkout at ${primaryWorktree.path}.`,
		);
	}

	const result: CleanupResult = {
		mainWorktree: mainWorktree?.path ?? primaryWorktree.path,
		mainBranch: options.mainBranch,
		pulled: false,
		removed: [],
		skipped: [],
		commands: [],
	};

	const runGit = async (runCwd: string, args: string[], timeout = LOCAL_COMMAND_TIMEOUT_MS) => {
		result.commands.push(commandText(runCwd, args));
		if (!options.dryRun) await git(runCwd, args, runtime, { timeout });
	};
	const primaryPath = primaryWorktree.path;
	const displacedBranch = !mainWorktree ? localBranchName(primaryWorktree.branch) : undefined;
	if (!mainWorktree && !isPlanningBranch(displacedBranch)) {
		throw new Error(
			`Primary checkout is on ${displacedBranch ?? "a detached HEAD"}, not an eligible planning branch. ` +
			`Automatic restoration and deletion is limited to branches named plan/<slug>. ` +
			`Switch the primary checkout back to ${options.mainBranch} manually (preserving this branch), then rerun /cleanup.`,
		);
	}
	// Read every status before fetching, switching, merging, or removing anything.
	// A failed status is not evidence of a clean worktree and must leave the
	// repository's worktrees and branches untouched.
	const dirtyByPath = new Map<string, WorktreeDirtyState>();
	for (const worktree of worktrees) {
		dirtyByPath.set(worktree.path, await dirtyState(worktree.path, runtime));
	}
	const primaryDirty = dirtyByPath.get(primaryPath)!;
	if (primaryDirty.hasTrackedChanges) {
		throw new Error(`Primary worktree has tracked local changes; cannot safely update or switch it to ${options.mainBranch}. Commit or stash them, then rerun /cleanup.`);
	}
	const localMainHead = await git(primaryPath, ["rev-parse", "--verify", mainRef], runtime, { allowFailure: true });
	if (!localMainHead) {
		throw new Error(`Local branch ${options.mainBranch} does not exist. Create it to track origin/${options.mainBranch}, then rerun /cleanup.`);
	}

	let target: string;
	if (options.dryRun) {
		runtime.onProgress?.(`Reading current origin/${options.mainBranch} without updating local refs…`);
		const args = ["ls-remote", "--exit-code", "origin", `refs/heads/${options.mainBranch}`];
		result.commands.push(commandText(primaryPath, args));
		const output = await git(primaryPath, args, runtime, { timeout: NETWORK_COMMAND_TIMEOUT_MS });
		target = output.split(/\s+/)[0] ?? "";
		if (!/^[0-9a-f]{40,64}$/i.test(target)) {
			throw new Error(`origin/${options.mainBranch} did not resolve to a commit. Check the remote and branch name, then rerun /cleanup.`);
		}
		const fetchArgs = ["fetch", "--no-write-fetch-head", "origin", target];
		result.commands.push(commandText(primaryPath, fetchArgs));
		await git(primaryPath, fetchArgs, runtime, { timeout: NETWORK_COMMAND_TIMEOUT_MS });
	} else {
		runtime.onProgress?.(`Fetching origin/${options.mainBranch}…`);
		await runGit(primaryPath, ["fetch", "origin", options.mainBranch], NETWORK_COMMAND_TIMEOUT_MS);
		target = await git(primaryPath, ["rev-parse", "--verify", `origin/${options.mainBranch}^{commit}`], runtime);
		if (!/^[0-9a-f]{40,64}$/i.test(target)) {
			throw new Error(`Fetched origin/${options.mainBranch} did not resolve to a commit. Cleanup stopped before changing worktrees or branches.`);
		}
	}

	if (!await isAncestor(primaryPath, localMainHead, target, runtime)) {
		throw new Error(
			`Local ${options.mainBranch} cannot be fast-forwarded to current origin/${options.mainBranch}. ` +
				`Reconcile or preserve the local commits manually, then rerun /cleanup; no worktrees or branches were removed.`,
		);
	}
	if (!mainWorktree) {
		const merged = await isAncestor(primaryPath, primaryWorktree.head, target, runtime);
		const equivalent = !merged && await hasNoUniquePatch(primaryPath, primaryWorktree.head, target, runtime);
		if (!merged && !equivalent) {
			throw new Error(`Primary planning branch ${displacedBranch} is not merged or patch-equivalent to current origin/${options.mainBranch}; it was preserved.`);
		}
		runtime.onProgress?.(`Switching primary worktree to ${options.mainBranch} without overwriting ignored files…`);
		await runGit(primaryPath, ["switch", "--no-overwrite-ignore", options.mainBranch]);
		mainWorktree = { ...primaryWorktree, branch: mainRef };
		runtime.onProgress?.(`Fast-forwarding ${options.mainBranch}…`);
		if (!options.dryRun) await assertNoUntrackedFastForwardOverwrite(primaryPath, localMainHead, target, runtime);
		await runGit(primaryPath, ["merge", "--ff-only", target], NETWORK_COMMAND_TIMEOUT_MS);
		await runGit(primaryPath, ["branch", equivalent ? "-D" : "-d", displacedBranch!]);
	} else {
		runtime.onProgress?.(`Fast-forwarding ${options.mainBranch}…`);
		if (!options.dryRun) await assertNoUntrackedFastForwardOverwrite(mainWorktree.path, localMainHead, target, runtime);
		await runGit(mainWorktree.path, ["merge", "--ff-only", target], NETWORK_COMMAND_TIMEOUT_MS);
	}
	result.pulled = !options.dryRun;

	for (const worktree of worktrees) {
		if (path.resolve(worktree.path) === path.resolve(mainWorktree!.path)) continue;
		const branch = localBranchName(worktree.branch);
		if (path.resolve(worktree.path) === path.resolve(currentRoot) && !options.forceCurrent) {
			result.skipped.push({ path: worktree.path, branch, reason: "current worktree" });
			continue;
		}
		const dirty = dirtyByPath.get(worktree.path)!;
		if (dirty.hasTrackedChanges) {
			result.skipped.push({ path: worktree.path, branch, reason: "tracked changes" });
			continue;
		}
		if (hasUnexpectedUntracked(dirty.untrackedOrIgnored)) {
			result.skipped.push({ path: worktree.path, branch, reason: "untracked or ignored content" });
			continue;
		}
		const ancestorMerged = await isAncestor(mainWorktree!.path, worktree.head, target, runtime);
		const patchEquivalent = !ancestorMerged && await hasNoUniquePatch(mainWorktree!.path, worktree.head, target, runtime);
		if (!ancestorMerged && !patchEquivalent) {
			result.skipped.push({ path: worktree.path, branch, reason: `not merged or patch-equivalent to ${target}` });
			continue;
		}
		runtime.onProgress?.(`Removing ${worktree.path}…`);
		await runGit(worktree.path, ["clean", "-d", "-f", "-x", "--", ".pi-subagents/"]);
		await runGit(mainWorktree!.path, ["worktree", "remove", worktree.path]);
		if (branch) await runGit(mainWorktree!.path, ["branch", patchEquivalent ? "-D" : "-d", branch]);
		result.removed.push({ path: worktree.path, branch });
	}
	await runGit(mainWorktree!.path, ["worktree", "prune"]);
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

export function cleanupAgentPrompt(options: CleanupOptions): string {
	return [
		"Run the git_cleanup tool exactly once with these arguments, then briefly report its result.",
		JSON.stringify(options),
	].join("\n");
}

export default function gitCleanupExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "git_cleanup",
		label: "Git Cleanup",
		description: "Fast-forward the main branch and remove clean worktrees already merged or patch-equivalent to it.",
		parameters: Type.Object({
			mainBranch: Type.String(),
			dryRun: Type.Boolean(),
			forceCurrent: Type.Boolean(),
		}),
		async execute(_toolCallId, options, signal, onUpdate, ctx) {
			try {
				const result = await cleanupGitWorktrees(ctx.cwd, options, {
					signal,
					onProgress: (message) => {
						ctx.ui.setStatus(STATUS_KEY, message);
						onUpdate?.({ content: [{ type: "text", text: message }] });
					},
					exec: (gitArgs, execOptions) => pi.exec("env", ["GIT_TERMINAL_PROMPT=0", "git", ...gitArgs], execOptions),
				});
				return {
					content: [{ type: "text", text: formatCleanupResult(result, options.dryRun) }],
					details: result,
				};
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});

	pi.registerCommand("cleanup", {
		description: "Run abortable git cleanup through the agent/tool lifecycle",
		handler: async (args) => {
			pi.sendUserMessage(cleanupAgentPrompt(parseCleanupArgs(args)), { deliverAs: "followUp" });
		},
	});
}
