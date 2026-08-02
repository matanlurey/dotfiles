#!/usr/bin/env node
// Deterministic bookkeeping for the Hunk manual-audit workflow.
// Subcommands: init, next, status, pending-comments, mark-triaged
//
// Design constraint this works around: pi-prompt-template-model's deterministic
// `script:` step never receives the slash command's runtime arguments (checked
// against the installed extension source) - only the markdown body gets $1/$@
// substitution. So `init` (which needs a path/glob argument) is invoked by the
// LLM via bash from the prompt body, while next/status/pending-comments/
// mark-triaged take no required argument and read all state from the ledger,
// so they can run as true pre-LLM deterministic steps.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DEFAULT_BATCH_SIZE = 8;
const GREP_CHUNK_SIZE = 300;

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

// execFileSync throws on non-zero exit; callers that need to distinguish
// "no matches" (exit 1) from a real failure use this instead of `run`.
function tryRun(cmd, args, opts = {}) {
	try {
		return { ok: true, status: 0, stdout: run(cmd, args, opts), stderr: "" };
	} catch (err) {
		return {
			ok: false,
			status: typeof err.status === "number" ? err.status : 1,
			stdout: err.stdout?.toString() ?? "",
			stderr: err.stderr?.toString() ?? String(err.message),
		};
	}
}

function repoRoot() {
	return run("git", ["rev-parse", "--show-toplevel"]).trim();
}

function vcsInfo(root) {
	const isJj = existsSync(path.join(root, ".jj"));
	// A single jj revset diffs that revision against its own parent (root()
	// alone is empty, confirmed empirically). A range from root() to the
	// working copy is what actually shows "everything as added". Git's `diff
	// <ref>` natively compares a single ref against the working tree, so the
	// empty-tree sha alone is enough there (per hunk's own --help text).
	return isJj ? { kind: "jj", diffTarget: "root()..@" } : { kind: "git", diffTarget: GIT_EMPTY_TREE };
}

function slugify(s) {
	return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "root";
}

function sha256(s) {
	return createHash("sha256").update(s).digest("hex");
}

// Leading intent prefix on a comment's own text, colon optional: "fix: leaks the handle",
// "fix leaks the handle", or bare "fix". The lookahead requires a real word boundary
// (end of string, colon, or space) so "filed"/"fixture"/"explains" don't false-match.
// No recognized prefix means "auto" - investigate, then judge.
const INTENT_PREFIX = /^(explain|file|fix)(?=$|[:\s])/i;

function parseIntent(summary) {
	const m = summary.match(INTENT_PREFIX);
	if (!m) return { intent: "auto", text: summary };
	const rest = summary.slice(m[0].length).replace(/^:?\s*/, "");
	return { intent: m[1].toLowerCase(), text: rest };
}

function chunked(arr, size) {
	const out = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

function parseNulList(stdout) {
	return stdout.split("\0").filter(Boolean);
}

// git ls-files + linguist-generated filter + binary filter, in that order.
// git grep -I treats a zero-byte file as "no lines to match" and silently
// drops it, so empty files are special-cased back in rather than lost.
function enumerateFiles(root, pathspec) {
	const candidates = parseNulList(run("git", ["-C", root, "ls-files", "-z", "--", pathspec]));
	if (candidates.length === 0) return [];

	const generated = new Set();
	for (const chunk of chunked(candidates, GREP_CHUNK_SIZE)) {
		const attrOut = run("git", ["-C", root, "check-attr", "linguist-generated", "--", ...chunk]);
		for (const line of attrOut.split("\n")) {
			const m = line.match(/^(.*): linguist-generated: (.+)$/);
			if (m && m[2].trim() === "set") generated.add(m[1]);
		}
	}
	const nonGenerated = candidates.filter((f) => !generated.has(f));
	if (nonGenerated.length === 0) return [];

	const emptyFiles = [];
	const nonEmpty = [];
	for (const f of nonGenerated) {
		let size;
		try {
			size = statSync(path.join(root, f)).size;
		} catch {
			continue; // tracked but missing from the working copy - nothing to review
		}
		(size === 0 ? emptyFiles : nonEmpty).push(f);
	}

	const textFiles = [...emptyFiles];
	for (const chunk of chunked(nonEmpty, GREP_CHUNK_SIZE)) {
		// pattern ('') comes before `--`; -I matches every line in text files only
		const r = tryRun("git", ["-C", root, "grep", "-I", "-l", "-z", "", "--", ...chunk]);
		if (r.ok) textFiles.push(...parseNulList(r.stdout));
		else if (r.status !== 1) throw new Error(`git grep failed unexpectedly: ${r.stderr}`);
		// status 1 = no text files in this chunk (all binary) - not an error
	}
	return [...new Set(textFiles)].sort();
}

function partitionBatches(files, batchSize) {
	return chunked(files, batchSize).map((batch, index) => ({ index, files: batch, status: "pending" }));
}

// --- paths & persistence ---

const auditDir = (root) => path.join(root, ".matan", "audit");
const currentPath = (root) => path.join(auditDir(root), "current.json");
const targetDir = (root, slug) => path.join(auditDir(root), slug);
const ledgerPath = (root, slug) => path.join(targetDir(root, slug), "ledger.json");
const triagePath = (root, slug) => path.join(targetDir(root, slug), "triage.json");

function readJson(p, fallback) {
	if (!existsSync(p)) return fallback;
	return JSON.parse(readFileSync(p, "utf8"));
}

function writeJson(p, data) {
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

function loadActiveLedger(root) {
	const current = readJson(currentPath(root), null);
	if (!current) return { error: "No active audit in this repo. Run /audit <path-or-glob> first." };
	const ledger = readJson(ledgerPath(root, current.targetSlug), null);
	if (!ledger) return { error: `Ledger missing for target "${current.targetSlug}". Run /audit <path-or-glob> again.` };
	return { current, ledger };
}

// --- hunk CLI integration ---

// Sessions are matched by --repo <path>, which fails ambiguously once more
// than one Hunk window is open on the same repo. Once we've successfully
// targeted a specific session (recorded as ledger.hunkSessionId), keep
// addressing that exact session id instead of re-resolving by repo path.
function sessionSelector(ledger) {
	return ledger.hunkSessionId ? [ledger.hunkSessionId] : ["--repo", ledger.repoRoot];
}

function hunkReload(ledger, files) {
	return tryRun("hunk", ["session", "reload", ...sessionSelector(ledger), "--", "diff", ledger.diffTarget, "--", ...files]);
}

function hunkCommentList(ledger) {
	return tryRun("hunk", ["session", "comment", "list", ...sessionSelector(ledger), "--type", "user", "--json"]);
}

function hunkCommentAdd(ledger, { file, sideFlag, line, summary, author }) {
	return tryRun("hunk", ["session", "comment", "add", ...sessionSelector(ledger), "--file", file, sideFlag, line, "--summary", summary, "--author", author]);
}

// Resolves a bare --repo match into one concrete session id so every later
// call in this audit targets that exact session, even if more windows on
// the same repo open later. Only meaningful right after a successful reload.
function resolveSessionId(root) {
	const r = tryRun("hunk", ["session", "list", "--json"]);
	if (!r.ok) return null;
	const matches = JSON.parse(r.stdout).sessions.filter((s) => s.repoRoot === root);
	return matches.length === 1 ? matches[0].sessionId : null;
}

// --- reporting ---

function batchSummary(ledger) {
	const done = ledger.batches.filter((b) => b.status === "done").length;
	const total = ledger.batches.length;
	const pct = total === 0 ? 0 : Math.round((done / total) * 100);
	return { done, total, pct };
}

function printLedgerReport(ledger, { hunkResult } = {}) {
	const { done, total, pct } = batchSummary(ledger);
	const active = ledger.batches[ledger.activeBatch];
	const lines = [
		`Audit target: ${ledger.target} (${ledger.batches.reduce((n, b) => n + b.files.length, 0)} files, ${total} batches of ${ledger.batchSize})`,
		`Progress: ${done}/${total} batches reviewed (${pct}%)`,
	];
	if (active && active.status === "pending") {
		lines.push(`Active batch ${active.index + 1}/${total} (${active.files.length} files):`);
		for (const f of active.files) lines.push(`  ${f}`);
	} else {
		lines.push("All batches reviewed. Run /audit-triage to process any comments you left.");
	}
	if (hunkResult) {
		lines.push(hunkResult.ok ? "Hunk session retargeted to this batch." : `Hunk reload failed: ${hunkResult.stderr.trim() || "(no session found for this repo - open one with `hunk diff` in a terminal first)"}`);
	}
	console.log(lines.join("\n"));
}

// --- subcommands ---

function cmdInit(args) {
	const flags = parseFlags(args);
	const target = flags._[0];
	if (!target) throw new Error("usage: audit.mjs init <path-or-glob> [--batch-size N] [--fresh] [--session <id>]");
	const batchSize = flags["batch-size"] ? parseInt(flags["batch-size"], 10) : DEFAULT_BATCH_SIZE;
	const fresh = Boolean(flags.fresh);
	const sessionOverride = typeof flags.session === "string" ? flags.session : null;

	const root = repoRoot();
	const { kind, diffTarget } = vcsInfo(root);
	const files = enumerateFiles(root, target);
	if (files.length === 0) throw new Error(`No matching non-generated text files under "${target}".`);
	const fileListHash = sha256(files.join("\n"));
	const slug = slugify(target);
	const existing = readJson(ledgerPath(root, slug), null);

	let ledger;
	if (existing && !fresh) {
		if (existing.fileListHash !== fileListHash) {
			throw new Error(
				[
					`File set for "${target}" changed since the last audit (${existing.batches.reduce((n, b) => n + b.files.length, 0)} files then, ${files.length} now).`,
					`Re-run with --fresh to start a new ledger, or review the existing state as-is via /audit-status.`,
				].join("\n"),
			);
		}
		ledger = existing;
		ledger.updatedAt = new Date().toISOString();
	} else {
		ledger = {
			version: 1,
			target,
			targetSlug: slug,
			repoRoot: root,
			vcsKind: kind,
			diffTarget,
			fileListHash,
			batchSize,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			activeBatch: 0,
			batches: partitionBatches(files, batchSize),
			hunkSessionId: null,
		};
	}
	if (sessionOverride) ledger.hunkSessionId = sessionOverride;

	// Resuming: land on the first pending batch rather than wherever it was left.
	const firstPending = ledger.batches.findIndex((b) => b.status === "pending");
	ledger.activeBatch = firstPending === -1 ? ledger.batches.length - 1 : firstPending;

	writeJson(ledgerPath(root, slug), ledger);
	writeJson(currentPath(root), { targetSlug: slug, updatedAt: new Date().toISOString() });

	let hunkResult;
	if (firstPending !== -1) {
		hunkResult = hunkReload(ledger, ledger.batches[firstPending].files);
		if (hunkResult.ok && !ledger.hunkSessionId) {
			ledger.hunkSessionId = resolveSessionId(root);
			writeJson(ledgerPath(root, slug), ledger);
		}
	}
	printLedgerReport(ledger, { hunkResult });
}

function cmdNext() {
	const root = repoRoot();
	const { current, ledger, error } = loadActiveLedger(root);
	if (error) throw new Error(error);

	const activeIdx = ledger.activeBatch;
	if (ledger.batches[activeIdx]) ledger.batches[activeIdx].status = "done";

	const nextIdx = ledger.batches.findIndex((b) => b.status === "pending");
	let hunkResult;
	if (nextIdx !== -1) {
		ledger.activeBatch = nextIdx;
		hunkResult = hunkReload(ledger, ledger.batches[nextIdx].files);
	}
	ledger.updatedAt = new Date().toISOString();
	writeJson(ledgerPath(root, ledger.targetSlug), ledger);
	printLedgerReport(ledger, { hunkResult });
}

function cmdStatus() {
	const root = repoRoot();
	const { ledger, error } = loadActiveLedger(root);
	if (error) {
		console.log(error);
		return;
	}
	printLedgerReport(ledger);
}

function cmdPendingComments() {
	const root = repoRoot();
	const { ledger, error } = loadActiveLedger(root);
	if (error) {
		console.log(error);
		process.exitCode = 1;
		return;
	}

	const listResult = hunkCommentList(ledger);
	if (!listResult.ok) {
		console.log(`Could not read Hunk comments: ${listResult.stderr.trim()}`);
		process.exitCode = 1;
		return;
	}

	const { comments } = JSON.parse(listResult.stdout);
	const triage = readJson(triagePath(root, ledger.targetSlug), { version: 1, comments: {} });
	const pending = comments.filter((c) => !(c.commentId in triage.comments));

	if (pending.length === 0) {
		console.log(`No new comments to triage (${comments.length} total, all already triaged).`);
		process.exitCode = 1; // signals "nothing to do" so the prompt template skips the LLM turn
		return;
	}

	const lines = [`${pending.length} comment(s) pending triage (${comments.length - pending.length} already triaged):`, ""];
	for (const c of pending) {
		const { intent, text } = parseIntent(c.summary);
		lines.push(`- commentId: ${c.commentId}`);
		lines.push(`  file: ${c.filePath}`);
		lines.push(`  line: ${c.line} (${c.side})`);
		lines.push(`  hunk: ${c.hunkIndex}`);
		lines.push(`  intent: ${intent}`);
		lines.push(`  text: ${text || "(none)"}`);
		lines.push("");
	}
	console.log(lines.join("\n"));
}

function cmdMarkTriaged(args) {
	const flags = parseFlags(args);
	const commentId = flags._[0];
	const status = flags._[1];
	if (!commentId || !["filed", "fixed", "explained"].includes(status)) {
		throw new Error("usage: audit.mjs mark-triaged <commentId> <filed|fixed|explained> --file <path> --line <n> --side <old|new> [--issue <url>] [--note <text>]");
	}
	if (!flags.file || !flags.line || !flags.side) throw new Error("mark-triaged requires --file, --line, and --side");

	const root = repoRoot();
	const { ledger, error } = loadActiveLedger(root);
	if (error) throw new Error(error);

	const triage = readJson(triagePath(root, ledger.targetSlug), { version: 1, comments: {} });
	triage.comments[commentId] = {
		status,
		issueUrl: flags.issue ?? null,
		note: flags.note ?? "",
		triagedAt: new Date().toISOString(),
	};
	writeJson(triagePath(root, ledger.targetSlug), triage);

	const summary =
		status === "filed"
			? `Filed${flags.issue ? `: ${flags.issue}` : " (no link provided)"}${flags.note ? ` — ${flags.note}` : ""}`
			: status === "fixed"
				? `Fixed locally, uncommitted${flags.note ? ` — ${flags.note}` : ""}`
				: `Explained${flags.note ? `: ${flags.note}` : ""}`;
	// A new comment can only land on a file that's in the *currently loaded*
	// diff, but triage often happens well after the human has moved past the
	// batch that file belonged to. Widen to the full target first so any file
	// in scope is addressable; the next /audit-next or /audit-status naturally
	// re-narrows to the correct active batch, so there's no need to restore it here.
	const allFiles = ledger.batches.flatMap((b) => b.files);
	hunkReload(ledger, allFiles);

	const sideFlag = flags.side === "old" ? "--old-line" : "--new-line";
	const addResult = hunkCommentAdd(ledger, { file: flags.file, sideFlag, line: flags.line, summary, author: `triage:${status}` });
	console.log(addResult.ok ? `Recorded ${status} for ${commentId}.` : `Recorded ${status} for ${commentId}, but the Hunk annotation failed: ${addResult.stderr.trim()}`);
}

// --- CLI plumbing ---

function parseFlags(args) {
	const flags = { _: [] };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			flags._.push(a);
		}
	}
	return flags;
}

const [, , sub, ...rest] = process.argv;
try {
	switch (sub) {
		case "init":
			cmdInit(rest);
			break;
		case "next":
			cmdNext();
			break;
		case "status":
			cmdStatus();
			break;
		case "pending-comments":
			cmdPendingComments();
			break;
		case "mark-triaged":
			cmdMarkTriaged(rest);
			break;
		default:
			console.error("usage: audit.mjs <init|next|status|pending-comments|mark-triaged> ...");
			process.exit(2);
	}
} catch (err) {
	console.error(err.message);
	process.exit(1);
}
