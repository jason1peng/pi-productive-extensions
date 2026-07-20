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
	execGlab?: GitExecutor;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

async function git(
	cwd: string,
	args: string[],
	runtime: CleanupRuntimeOptions,
	options: { allowFailure?: boolean; rawOutput?: boolean; timeout?: number } = {},
): Promise<string> {
	const result = await runtime.exec(args, {
		cwd,
		signal: runtime.signal,
		timeout: options.timeout ?? LOCAL_COMMAND_TIMEOUT_MS,
	});
	if (result.code === 0) return options.rawOutput ? result.stdout : result.stdout.trim();
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
	untracked: string[];
	ignored: string[];
}

async function dirtyState(worktreePath: string, runtime: CleanupRuntimeOptions): Promise<WorktreeDirtyState> {
	const status = await git(worktreePath, ["status", "--porcelain"], runtime);
	const lines = status.split(/\r?\n/).filter(Boolean);
	const [untracked, ignored] = await untrackedAndIgnoredPaths(worktreePath, runtime);
	return {
		hasTrackedChanges: lines.some((line) => !line.startsWith("??")),
		untracked,
		ignored,
	};
}

function nulPaths(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

async function untrackedAndIgnoredPaths(cwd: string, runtime: CleanupRuntimeOptions): Promise<[string[], string[]]> {
	const [untracked, ignored] = await Promise.all([
		git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], runtime, { rawOutput: true }),
		git(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], runtime, { rawOutput: true }),
	]);
	return [nulPaths(untracked), nulPaths(ignored)];
}

function isPiRuntimePath(entry: string): boolean {
	return entry === ".pi-subagents" || entry.startsWith(".pi-subagents/");
}

function pathsConflict(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

async function assertNoUntrackedOverwrite(cwd: string, from: string, to: string, runtime: CleanupRuntimeOptions): Promise<void> {
	const changed = nulPaths(await git(cwd, ["diff", "--name-only", "-z", from, to], runtime, { rawOutput: true }));
	const [untracked, ignored] = await untrackedAndIgnoredPaths(cwd, runtime);
	const conflicts = [...new Set([...untracked, ...ignored])].filter((localPath) => changed.some((changedPath) => pathsConflict(localPath, changedPath)));
	if (conflicts.length > 0) {
		throw new Error(
			`Cannot update the primary worktree: local untracked or ignored content would be overwritten (${conflicts.slice(0, 3).join(", ")}` +
			`${conflicts.length > 3 ? ", …" : ""}). Ignored content is disposable only when removing a proven-merged linked worktree; ` +
			"the primary content was preserved. Relocate it and rerun /cleanup.",
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

interface GitLabMergeRequest {
	state?: string;
	target_branch?: string;
	sha?: string;
	merge_commit_sha?: string;
	squash_commit_sha?: string;
	diff_refs?: { head_sha?: string };
}

async function isMergedGitLabMr(
	cwd: string,
	branch: string | undefined,
	branchHead: string | undefined,
	targetBranch: string,
	targetHead: string,
	runtime: CleanupRuntimeOptions,
): Promise<boolean> {
	if (!runtime.execGlab || !branch || !branchHead) return false;
	const response = await runtime.execGlab(
		["api", `projects/:fullpath/merge_requests?scope=all&source_branch=${encodeURIComponent(branch)}&per_page=100`],
		{ cwd, signal: runtime.signal, timeout: NETWORK_COMMAND_TIMEOUT_MS },
	);
	if (response.code !== 0) {
		runtime.onProgress?.(`GitLab merge lookup failed for ${branch}; preserving it unless local Git proves it merged.`);
		return false;
	}
	try {
		const mergeRequests = JSON.parse(response.stdout) as GitLabMergeRequest[];
		// Refuse an incomplete first page rather than risk missing an open or
		// closed-unmerged MR for a heavily reused source branch.
		if (!Array.isArray(mergeRequests) || mergeRequests.length >= 100) return false;
		const exactHead = mergeRequests.filter((mr) => mr.sha === branchHead || mr.diff_refs?.head_sha === branchHead);
		if (exactHead.some((mr) => mr.state !== "merged")) return false;
		for (const mr of exactHead) {
			if (mr.state !== "merged" || mr.target_branch !== targetBranch) continue;
			for (const mergeHead of [mr.squash_commit_sha, mr.merge_commit_sha]) {
				if (mergeHead && await isAncestor(cwd, mergeHead, targetHead, runtime)) return true;
			}
		}
		return false;
	} catch {
		return false;
	}
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
		const gitLabMerged = !merged && !equivalent && await isMergedGitLabMr(
			primaryPath, displacedBranch, primaryWorktree.head, options.mainBranch, target, runtime,
		);
		if (!merged && !equivalent && !gitLabMerged) {
			throw new Error(`Primary planning branch ${displacedBranch} is not merged or patch-equivalent to current origin/${options.mainBranch}; it was preserved.`);
		}
		await assertNoUntrackedOverwrite(primaryPath, primaryWorktree.head, localMainHead, runtime);
		await assertNoUntrackedOverwrite(primaryPath, localMainHead, target, runtime);
		runtime.onProgress?.(`Switching primary worktree to ${options.mainBranch} without overwriting ignored files…`);
		await runGit(primaryPath, ["switch", "--no-overwrite-ignore", options.mainBranch]);
		mainWorktree = { ...primaryWorktree, branch: mainRef };
		runtime.onProgress?.(`Fast-forwarding ${options.mainBranch}…`);
		await runGit(primaryPath, ["merge", "--ff-only", target], NETWORK_COMMAND_TIMEOUT_MS);
		await runGit(primaryPath, ["branch", equivalent || gitLabMerged ? "-D" : "-d", displacedBranch!]);
	} else {
		runtime.onProgress?.(`Fast-forwarding ${options.mainBranch}…`);
		await assertNoUntrackedOverwrite(mainWorktree.path, localMainHead, target, runtime);
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
			result.skipped.push({ path: worktree.path, branch, reason: "tracked changes; removal would lose uncommitted work" });
			continue;
		}
		const unrecognizedUntracked = dirty.untracked.filter((entry) => !isPiRuntimePath(entry));
		const untrackedSummary = unrecognizedUntracked.length > 0
			? `${unrecognizedUntracked.slice(0, 3).join(", ")}${unrecognizedUntracked.length > 3 ? ", …" : ""}`
			: undefined;
		const ancestorMerged = await isAncestor(mainWorktree!.path, worktree.head, target, runtime);
		const patchEquivalent = !ancestorMerged && await hasNoUniquePatch(mainWorktree!.path, worktree.head, target, runtime);
		const gitLabMerged = !ancestorMerged && !patchEquivalent && await isMergedGitLabMr(
			mainWorktree!.path, branch, worktree.head, options.mainBranch, target, runtime,
		);
		if (!ancestorMerged && !patchEquivalent && !gitLabMerged) {
			const contentState = untrackedSummary
				? `; it also has untracked files (${untrackedSummary}) that would be lost`
				: "; the worktree has no tracked or non-ignored untracked changes, but removal may lose commits";
			result.skipped.push({
				path: worktree.path,
				branch,
				reason: `branch is not merged or patch-equivalent to ${options.mainBranch} (${target})${contentState}`,
			});
			continue;
		}
		if (untrackedSummary) {
			result.skipped.push({ path: worktree.path, branch, reason: `untracked files (${untrackedSummary}); removal would lose uncommitted local content` });
			continue;
		}
		runtime.onProgress?.(`Removing ${worktree.path}…`);
		if (dirty.ignored.length > 0) await runGit(worktree.path, ["clean", "-d", "-f", "-X", "--"]);
		if (dirty.untracked.some(isPiRuntimePath)) await runGit(worktree.path, ["clean", "-d", "-f", "-x", "--", ".pi-subagents"]);
		await runGit(mainWorktree!.path, ["worktree", "remove", worktree.path]);
		if (branch) await runGit(mainWorktree!.path, ["branch", patchEquivalent || gitLabMerged ? "-D" : "-d", branch]);
		result.removed.push({ path: worktree.path, branch });
	}
	await runGit(mainWorktree!.path, ["worktree", "prune"]);
	return result;
}

function resultLabel(index: number): string {
	let value = index + 1;
	let label = "";
	while (value > 0) {
		value -= 1;
		label = String.fromCharCode(65 + (value % 26)) + label;
		value = Math.floor(value / 26);
	}
	return label;
}

export function formatCleanupResult(result: CleanupResult, dryRun: boolean): string {
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
		for (const [index, item] of result.skipped.entries()) {
			lines.push(`- [${resultLabel(index)}] ${item.path}${item.branch ? ` (${item.branch})` : ""}: ${item.reason}`);
		}
	} else lines.push("none");
	lines.push("", "## Commands", ...result.commands.map((command) => `- \`${command}\``));
	return lines.join("\n");
}

export function cleanupAgentPrompt(options: CleanupOptions): string {
	return [
		"Run the git_cleanup tool exactly once with these arguments:",
		JSON.stringify(options),
		"Then investigate every labeled skipped worktree using read-only commands and present a concise recommendation.",
		"Preserve the tool's [A], [B], ... labels exactly. Infer the forge from the remote URL. For each skip, check as applicable:",
		"- tracked and non-ignored untracked cleanliness;",
		"- branch/upstream names, local HEAD, remote branch existence, and whether the exact HEAD and any local-only history are recoverable from a remote ref;",
		"- GitHub PR or GitLab MR state, target branch, and clickable web URL using gh, glab, or a read-only forge API;",
		"- each non-ignored untracked artifact's path, file type, size, and modification time;",
		"- whether each artifact's same path and content blob exists in a commit, remote-tracking ref, or another explicit backup (use read-only metadata, git log/hash-object/rev-list checks as appropriate).",
		"Do not read or print ignored secret contents. Do not print non-ignored artifact contents; metadata and hashes are sufficient. Do not fetch or mutate, clean, remove, switch, commit, push, or otherwise change any worktree or ref during this investigation.",
		"For each label use this compact shape:",
		"- [A] `<path>` (`<branch>`): **safe to remove** | **don't remove yet** | **uncertain** — <plain-English evidence-based reason>",
		"  Evidence: HEAD/remote recoverability; PR/MR state, target, and clickable URL when one exists; local-only artifact backup summary.",
		"  Technical: <the raw cleanup reason>",
		"Always include a discovered PR/MR URL, including for don't-remove or uncertain recommendations.",
		"Only say safe to remove when every local commit and meaningful untracked artifact is demonstrably recoverable from a remote ref or other explicit backup. A closed PR/MR alone is not sufficient evidence.",
		"Do not remove any skipped worktree in this run. Wait for an explicit user follow-up naming a label.",
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
					execGlab: (glabArgs, execOptions) => pi.exec("env", ["GIT_TERMINAL_PROMPT=0", "glab", ...glabArgs], execOptions),
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
