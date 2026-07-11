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

interface WorktreeDirtyState {
	hasTrackedChanges: boolean;
	hasUntrackedOnly: boolean;
}

async function dirtyState(worktreePath: string, runtime: CleanupRuntimeOptions): Promise<WorktreeDirtyState> {
	const status = await git(worktreePath, ["status", "--porcelain"], runtime, { allowFailure: true });
	const lines = status.split(/\r?\n/).filter(Boolean);
	return {
		hasTrackedChanges: lines.some((line) => !line.startsWith("??")),
		hasUntrackedOnly: lines.length > 0 && lines.every((line) => line.startsWith("??")),
	};
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
	const cherry = await git(cwd, ["cherry", target, branchHead], runtime, { allowFailure: true });
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

	const runGit = async (runCwd: string, args: string[], timeout = LOCAL_COMMAND_TIMEOUT_MS) => {
		result.commands.push(commandText(runCwd, args));
		if (!options.dryRun) await git(runCwd, args, runtime, { timeout });
	};

	runtime.onProgress?.(`Fetching origin/${options.mainBranch}…`);
	await runGit(mainWorktree.path, ["fetch", "origin", options.mainBranch, "--prune"], NETWORK_COMMAND_TIMEOUT_MS);
	runtime.onProgress?.(`Fast-forwarding ${options.mainBranch}…`);
	await runGit(mainWorktree.path, ["pull", "--ff-only", "origin", options.mainBranch], NETWORK_COMMAND_TIMEOUT_MS);
	result.pulled = !options.dryRun;

	const target = `origin/${options.mainBranch}`;
	for (const worktree of worktrees) {
		if (path.resolve(worktree.path) === path.resolve(mainWorktree.path)) continue;
		const branch = localBranchName(worktree.branch);
		if (path.resolve(worktree.path) === path.resolve(currentRoot) && !options.forceCurrent) {
			result.skipped.push({ path: worktree.path, branch, reason: "current worktree" });
			continue;
		}
		const dirty = await dirtyState(worktree.path, runtime);
		if (dirty.hasTrackedChanges) {
			result.skipped.push({ path: worktree.path, branch, reason: "tracked changes" });
			continue;
		}
		const ancestorMerged = await isAncestor(mainWorktree.path, worktree.head, target, runtime);
		const patchEquivalent = !ancestorMerged && await hasNoUniquePatch(mainWorktree.path, worktree.head, target, runtime);
		if (!ancestorMerged && !patchEquivalent) {
			result.skipped.push({ path: worktree.path, branch, reason: `not merged or patch-equivalent to ${target}` });
			continue;
		}
		runtime.onProgress?.(`Removing ${worktree.path}…`);
		await runGit(mainWorktree.path, ["worktree", "remove", ...(dirty.hasUntrackedOnly ? ["--force"] : []), worktree.path]);
		if (branch) await runGit(mainWorktree.path, ["branch", patchEquivalent ? "-D" : "-d", branch]);
		result.removed.push({ path: worktree.path, branch });
	}
	await runGit(mainWorktree.path, ["worktree", "prune"]);
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
