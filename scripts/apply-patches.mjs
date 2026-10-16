#!/usr/bin/env node
/**
 * Applies this repository's local modifications to a checkout of upstream GitLens.
 *
 * Usage:
 *   node scripts/apply-patches.mjs [--root <dir>] [--check] [--diff <file>]
 *
 *   --root <dir>   Upstream GitLens checkout to patch (default: the current directory).
 *   --check        Verify every modification can be applied, without writing anything.
 *   --diff <file>  Write the resulting unified diff to <file> (for review/auditing).
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

  --root <dir>   Upstream GitLens checkout to patch (default: the current directory).
  --check        Verify every modification can be applied, without writing anything.
  --diff <file>  Write the resulting unified diff to <file> (for review/auditing).
`;

const UPSTREAM_PACKAGE_NAME = 'gitlens';

function parseArgs(argv) {
	const options = { root: process.cwd(), check: false, diff: undefined };

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--root':
				options.root = resolve(argv[++i] ?? '');
				break;
			case '--check':
				options.check = true;
				break;
			case '--diff':
				options.diff = resolve(argv[++i] ?? '');
				break;
			case '--help':
				options.help = true;
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
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

function gitDiff(root) {
	try {
		return execFileSync(
			'git',
			['-C', root, '--no-pager', 'diff', '--no-color', '--no-ext-diff', '--', ...touchedFiles],
			{ encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
		);
	} catch {
		return undefined;
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}

	const upstream = readUpstreamPackage(options.root);
	const mode = options.check ? 'check' : 'apply';
	console.log(`GitLens ${upstream.version} at ${options.root} — ${mode} ${rules.length} local modifications\n`);

	const pending = new Map();
	let changed = 0;
	let alreadyApplied = 0;
	const problems = [];
	const notes = [];

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

	if (problems.length > 0) {
		console.error(`\n${problems.length} local modification(s) could not be applied to GitLens ${upstream.version}:`);
		for (const problem of problems) {
			console.error(`  - [${problem.rule}] ${problem.file}: ${problem.message}`);
			annotate('error', `[${problem.rule}] ${problem.message}`, problem.file);
		}
		console.error(
			'\nUpstream most likely restructured the function this rule targets. Update the matching rule in scripts/lib/rules.mjs.',
		);
		process.exitCode = 1;
		return;
	}

	if (!options.check) {
		for (const [file, { src }] of pending) {
			writeFileSync(join(options.root, file), src);
		}
	}

	const verb = options.check ? 'verified' : 'applied';
	console.log(
		`\n${verb}: ${changed} modified, ${alreadyApplied} already applied, ${pending.size} file(s) ${
			options.check ? 'would be rewritten' : 'rewritten'
		}`,
	);

	if (options.diff != null && !options.check) {
		const diff = gitDiff(options.root);
		if (diff == null) {
			console.warn(`warning: could not generate a diff for ${options.diff} (not a git checkout?)`);
		} else {
			writeFileSync(options.diff, diff);
			console.log(`diff written to ${options.diff} (${diff.split('\n').length} lines)`);
		}
	}

	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary != null && summary.length > 0 && !options.check) {
		const diff = options.diff != null && existsSync(options.diff) ? readFileSync(options.diff, 'utf8') : undefined;
		const body = [
			`## 🔧 本地改动已应用 (GitLens ${upstream.version})`,
			'',
			`- 改动项: **${changed}** 项应用 / **${alreadyApplied}** 项已存在`,
			`- 涉及文件: ${touchedFiles.map(file => `\`${file}\``).join(', ')}`,
			'',
			'| 规则 | 作用 |',
			'| --- | --- |',
			...rules.map(rule => `| \`${rule.id}\` | ${rule.title} |`),
			'',
			'<details><summary>应用详情</summary>',
			'',
			...notes.map(note => `- ${note}`),
			'',
			'</details>',
			'',
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
}

try {
	main();
} catch (error) {
	const message = describe(error);
	console.error(`::error::${message.replaceAll('\n', ' ')}`);
	process.exitCode = 1;
}
