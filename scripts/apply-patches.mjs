#!/usr/bin/env node
/**
 * Applies this repository's local modifications to a checkout of upstream GitLens.
 *
 * Usage:
 *   node scripts/apply-patches.mjs [--root <dir>] [--check] [--diff <file>]
 *                                  [--expect-version <version>] [--assert-fresh | --assert-applied]
 *                                  [--list-files]
 *
 *   --root <dir>            Upstream GitLens checkout to patch (default: the current directory).
 *   --check                 Verify every modification can be applied, without writing anything.
 *   --diff <file>           Write the resulting unified diff to <file> (for review/auditing).
 *   --expect-version <v>    Fail unless the checkout is exactly this GitLens version.
 *   --assert-fresh          Fail unless every rule was applied now — nothing was already in place.
 *                           This is the invariant of a fresh checkout, and it is what turns a silently
 *                           skipped rule ("already applied") into a build failure.
 *   --assert-applied        Fail unless every rule was already applied and nothing was rewritten.
 *                           This is the invariant of a second pass over a patched checkout.
 *   --list-files            Print the files the rules touch, one per line, and exit.
 *
 * Exits non-zero, with a GitHub annotation per problem, when an anchor cannot be located — so a
 * genuinely incompatible upstream change stops the build with an actionable message instead of
 * producing a silently unpatched extension.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { rules, touchedFiles } from './lib/rules.mjs';

const USAGE = `Usage: node scripts/apply-patches.mjs [--root <dir>] [--check] [--diff <file>]
                                  [--expect-version <version>] [--assert-fresh | --assert-applied]
                                  [--list-files]

  --root <dir>            Upstream GitLens checkout to patch (default: the current directory).
  --check                 Verify every modification can be applied, without writing anything.
  --diff <file>           Write the resulting unified diff to <file> (for review/auditing).
  --expect-version <v>    Fail unless the checkout is exactly this GitLens version.
  --assert-fresh          Fail unless every rule was applied now (fresh-checkout invariant).
  --assert-applied        Fail unless every rule was already applied (idempotency invariant).
  --list-files            Print the files the rules touch, one per line, and exit.
`;

const UPSTREAM_PACKAGE_NAME = 'gitlens';

/** Options that take a value. */
const VALUE_OPTIONS = new Set(['--root', '--diff', '--expect-version']);

function parseArgs(argv) {
	const options = {
		root: process.cwd(),
		check: false,
		diff: undefined,
		expectVersion: undefined,
		assertFresh: false,
		assertApplied: false,
		listFiles: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i++) {
		// `--opt=value` is accepted alongside `--opt value`, so a mistyped separator can't silently
		// turn the next flag into a value.
		const equals = argv[i].indexOf('=');
		const arg = equals > 0 ? argv[i].slice(0, equals) : argv[i];
		const inlineValue = equals > 0 ? argv[i].slice(equals + 1) : undefined;

		if (VALUE_OPTIONS.has(arg)) {
			const value = inlineValue ?? argv[++i];
			if (value == null || value === '' || (inlineValue == null && value.startsWith('-'))) {
				throw new Error(`${arg} requires a value`);
			}

			switch (arg) {
				case '--root':
					options.root = resolve(value);
					break;
				case '--diff':
					options.diff = resolve(value);
					break;
				case '--expect-version':
					// Upstream tags carry a `v` prefix ("v19.4.0") while package.json does not ("19.4.0").
					options.expectVersion = value.replace(/^v/, '');
					break;
			}
			continue;
		}

		switch (arg) {
			case '--check':
				options.check = true;
				break;
			case '--assert-fresh':
				options.assertFresh = true;
				break;
			case '--assert-applied':
				options.assertApplied = true;
				break;
			case '--list-files':
				options.listFiles = true;
				break;
			case '--help':
				options.help = true;
				break;
			default:
				throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
		}
	}

	if (options.assertFresh && options.assertApplied) {
		throw new Error('--assert-fresh and --assert-applied are mutually exclusive');
	}
	if (options.check && options.diff != null) {
		throw new Error('--check never writes, so --diff has nothing to export; run them separately');
	}

	return options;
}

function annotate(kind, message, file) {
	if (process.env.GITHUB_ACTIONS !== 'true') return;

	const location = file != null ? ` file=${file}` : '';
	console.log(`::${kind}${location}::${message.replaceAll('\n', ' ')}`);
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Runs a git command in `root`, or returns undefined when git cannot answer. */
function git(root, args) {
	try {
		return execFileSync('git', ['-C', root, '--no-pager', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
	} catch {
		return undefined;
	}
}

function readUpstreamPackage(root) {
	const manifest = join(root, 'package.json');
	if (!existsSync(manifest)) {
		throw new Error(`${root} does not look like a GitLens checkout: package.json is missing`);
	}

	const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
	if (pkg.name !== UPSTREAM_PACKAGE_NAME) {
		throw new Error(`${root} is not the GitLens extension (package.json name is "${pkg.name}")`);
	}

	return { name: pkg.name, version: pkg.version };
}

/** Local modifications already present in the files the rules touch — our own or a human's. */
function dirtyFiles(root) {
	const status = git(root, ['status', '--porcelain', '--', ...touchedFiles]);
	if (status == null) return undefined;

	return status
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

function gitDiff(root) {
	// `git diff HEAD` so a file that was staged (`git add`) still shows up in the audit trail.
	return git(root, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', ...touchedFiles]);
}

/** Rules must exist and be individually identifiable, otherwise "all rules applied" means nothing. */
function checkRegistry() {
	const problems = [];

	if (rules.length === 0) {
		problems.push({ rule: '(registry)', message: 'no rules are registered — every run would report success' });
	}

	const seen = new Map();
	for (const rule of rules) {
		if (seen.has(rule.id)) {
			problems.push({ rule: rule.id, message: `duplicate rule id (also used by the rule for ${seen.get(rule.id)})` });
		}
		seen.set(rule.id, rule.file);
	}

	return problems;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}
	if (options.listFiles) {
		for (const file of touchedFiles) {
			console.log(file);
		}
		return;
	}

	const problems = checkRegistry();
	const notes = [];

	if (problems.length > 0) {
		report(problems, notes, '(registry)');
		return;
	}

	const upstream = readUpstreamPackage(options.root);
	if (options.expectVersion != null && options.expectVersion !== upstream.version) {
		problems.push({
			rule: '(version)',
			message: `expected GitLens ${options.expectVersion} but ${options.root} holds ${upstream.version}`,
		});
	}

	const mode = options.check ? 'check' : 'apply';
	console.log(`GitLens ${upstream.version} at ${options.root} — ${mode} ${rules.length} local modifications\n`);

	// A checkout that already carries modifications to a rule's file is either a half-applied state or
	// someone's manual edit: the rewrite below replaces whole function bodies, so it would drop that
	// work without a trace. Say so instead of silently rewriting it (the build always starts clean).
	const dirty = dirtyFiles(options.root);
	if (dirty != null && dirty.length > 0) {
		const warning = `checkout is not clean for the files the rules touch:\n${dirty.join('\n')}`;
		notes.push(warning);
		console.log(`  ~ warning: ${warning.replaceAll('\n', '\n    ')}`);
	}

	const pending = new Map();
	let changed = 0;
	let alreadyApplied = 0;

	// Every rule is planned before anything is written, so a single incompatible anchor leaves the
	// whole checkout untouched instead of half-patched.
	for (const rule of rules) {
		const path = join(options.root, rule.file);
		if (!existsSync(path)) {
			problems.push({ rule: rule.id, file: rule.file, message: `file not found: ${rule.file}` });
			continue;
		}

		const src = pending.get(rule.file)?.src ?? readFileSync(path, 'utf8');

		try {
			if (rule.isApplied(src)) {
				alreadyApplied++;
				console.log(`  = ${rule.id} (already applied)`);
				continue;
			}

			const result = rule.apply(src);
			pending.set(rule.file, { src: result.src });
			notes.push(...result.notes.map(note => `${rule.file}: ${note}`));
			changed++;
			console.log(`  + ${rule.id}`);
		} catch (error) {
			problems.push({ rule: rule.id, file: rule.file, message: describe(error) });
			console.log(`  ! ${rule.id} — ${describe(error)}`);
		}
	}

	// A rewrite that reports success but doesn't leave its marker behind would let a broken build ship.
	// Only checked when planning already succeeded: a stale anchor makes `isApplied` throw too, and
	// reporting that twice would bury the real cause.
	if (problems.length === 0) {
		for (const rule of rules) {
			const path = join(options.root, rule.file);
			const src = pending.get(rule.file)?.src ?? (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
			if (src == null) continue;

			try {
				if (!rule.isApplied(src)) {
					problems.push({ rule: rule.id, file: rule.file, message: 'post-apply verification failed' });
				}
			} catch (error) {
				problems.push({
					rule: rule.id,
					file: rule.file,
					message: `post-apply verification failed: ${describe(error)}`,
				});
			}
		}
	}

	// Counting invariants. `isApplied()` can only report on the code it is shown, so these are the checks
	// that catch a rule quietly deciding it has nothing to do.
	if (problems.length === 0 && options.assertFresh && (changed !== rules.length || alreadyApplied !== 0)) {
		problems.push({
			rule: '(assert-fresh)',
			message:
				`a fresh checkout must have every rule applied by this run, but ${changed} of ${rules.length} were applied ` +
				`and ${alreadyApplied} were reported as already in place. A rule whose "already applied" test matches ` +
				`upstream code by accident is skipped in silence — see scripts/lib/rules.mjs.`,
		});
	}
	if (problems.length === 0 && options.assertApplied && (changed !== 0 || alreadyApplied !== rules.length)) {
		problems.push({
			rule: '(assert-applied)',
			message:
				`this checkout should already carry every local modification, but ${changed} were rewritten again ` +
				`and ${alreadyApplied} of ${rules.length} were recognised.`,
		});
	}

	if (problems.length > 0) {
		report(problems, notes, options.root);
		return;
	}

	if (!options.check) {
		writeAll(options.root, pending, problems);
		if (problems.length > 0) {
			report(problems, notes, options.root);
			return;
		}
	}

	const verb = options.check ? 'verified' : 'applied';
	console.log(
		`\n${verb}: ${changed} modified, ${alreadyApplied} already applied, ${pending.size} file(s) ${
			options.check ? 'would be rewritten' : 'rewritten'
		}`,
	);

	let diff;
	if (options.diff != null && !options.check) {
		diff = gitDiff(options.root);
		if (diff == null) {
			console.warn(`warning: could not generate a diff for ${options.diff} (not a git checkout?)`);
		} else {
			if (changed > 0 && diff.trim().length === 0) {
				// The rules changed files but git sees no difference: `--root` is probably not the git
				// worktree those files belong to, and the "audit trail" would be an empty file.
				console.warn(
					`warning: the rules changed ${changed} file(s) but git reports no diff in ${options.root} — is --root the right worktree?`,
				);
				notes.push(`git shows no diff for the modified files in ${options.root}`);
			}
			writeFileSync(options.diff, diff);
			console.log(`diff written to ${options.diff} (${diff.split('\n').length} lines)`);
		}
	}

	writeSummary({ upstream, changed, alreadyApplied, notes, diff, problems });
}

/**
 * Writes the planned rewrites, rolling back on failure so a failed run cannot leave a checkout half
 * patched (the local workflow patches the sandbox it is about to test against).
 */
function writeAll(root, pending, problems) {
	const originals = new Map();
	const written = [];

	try {
		for (const [file, { src }] of pending) {
			const path = join(root, file);
			originals.set(file, readFileSync(path, 'utf8'));
			writeFileSync(path, src);
			written.push(file);
		}
	} catch (error) {
		for (const file of written) {
			try {
				writeFileSync(join(root, file), originals.get(file));
			} catch {
				// Nothing better to do than report the original failure; the list below names the files.
			}
		}

		problems.push({
			rule: '(write)',
			message:
				`could not write ${written.length + 1} file(s): ${describe(error)}` +
				(written.length > 0 ? ` — rolled back ${written.join(', ')}` : ''),
		});
	}
}

function report(problems, notes, root) {
	console.error(`\n${problems.length} local modification(s) could not be applied (${root}):`);
	for (const problem of problems) {
		console.error(`  - [${problem.rule}] ${problem.file != null ? `${problem.file}: ` : ''}${problem.message}`);
		annotate('error', `[${problem.rule}] ${problem.file != null ? problem.file + ': ' : ''}${problem.message}`, problem.file);
	}
	console.error(
		'\nUpstream most likely restructured the function this rule targets. Update the matching rule in scripts/lib/rules.mjs.',
	);
	if (notes.length > 0) {
		console.error('\nNotes:');
		for (const note of notes) {
			console.error(`  - ${note}`);
		}
	}
	process.exitCode = 1;
}

function writeSummary({ upstream, changed, alreadyApplied, notes, diff, problems }) {
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary == null || summary.length === 0) return;

	const body = [
		`## 🔧 本地改动已应用 (GitLens ${upstream.version})`,
		'',
		`- 改动项: **${changed}** 项应用 / **${alreadyApplied}** 项已存在 (共 ${rules.length} 条规则)`,
		`- 涉及文件: ${touchedFiles.map(file => `\`${file}\``).join(', ')}`,
		'',
		'| 规则 | 作用 |',
		'| --- | --- |',
		...rules.map(rule => `| \`${rule.id}\` | ${rule.title} |`),
		'',
		...(notes.length === 0 ? [] : ['<details><summary>注意事项</summary>', '', ...notes.map(note => `- ${note}`), '', '</details>', '']),
		...(problems.length === 0
			? []
			: ['<details><summary>❌ 失败原因</summary>', '', ...problems.map(p => `- \`${p.rule}\`: ${p.message}`), '', '</details>', '']),
		...(diff == null || diff.length === 0
			? []
			: [
					'<details><summary>实际生成的 diff</summary>',
					'',
					'```diff',
					diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n… (truncated)` : diff,
					'```',
					'',
					'</details>',
					'',
				]),
	].join('\n');

	try {
		writeFileSync(summary, `${body}\n`, { flag: 'a' });
	} catch (error) {
		console.warn(`warning: could not write the step summary (${error})`);
	}
}

try {
	main();
} catch (error) {
	const message = describe(error);
	console.error(`::error::${message.replaceAll('\n', ' ')}`);
	process.exitCode = 1;
}
