/**
 * End-to-end tests for the CLI, driven exactly the way the workflows drive it.
 *
 * The counting invariants are the point: `--assert-fresh` is what turns "a rule quietly decided it had
 * nothing to do" into a failed build, and `--assert-applied` is what replaces grepping the human-readable
 * output for the idempotency check.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECKIN_UTILS, SUBSCRIPTION_UTILS, writeCheckout } from './fixtures/upstreamSources.mjs';

const CLI = fileURLToPath(new URL('../apply-patches.mjs', import.meta.url));

const sandbox = () => {
	const dir = mkdtempSync(join(tmpdir(), 'rebuild-gitlens-cli-'));
	writeCheckout(dir);
	return dir;
};

/** Runs the CLI and returns its exit code together with everything it printed. */
const run = (dir, args) => {
	try {
		return { code: 0, output: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir }) };
	} catch (error) {
		return { code: error.status ?? 'signal', output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
};

test('--list-files prints the files the rules touch', () => {
	const { code, output } = run('.', ['--list-files']);

	assert.equal(code, 0);
	assert.deepEqual(output.trim().split('\n'), [SUBSCRIPTION_UTILS, CHECKIN_UTILS]);
});

test('a missing or flag-shaped option value is an error instead of a silent fallback', () => {
	// `--root --check` used to swallow `--check` as the root path, so the run wrote files while the caller
	// believed it had asked for a read-only check.
	for (const args of [['--root'], ['--root', '--check'], ['--diff'], ['--expect-version']]) {
		const { code, output } = run('.', args);
		assert.equal(code, 1, `${args.join(' ')} must fail`);
		assert.match(output, /requires a value/);
	}
});

test('--check and --diff are refused together, and unknown options print the usage', () => {
	const conflict = run('.', ['--check', '--diff', 'out.diff']);
	assert.equal(conflict.code, 1);
	assert.match(conflict.output, /--check never writes/);

	const unknown = run('.', ['--frobnicate']);
	assert.equal(unknown.code, 1);
	assert.match(unknown.output, /unknown argument: --frobnicate/);
	assert.match(unknown.output, /Usage: node scripts\/apply-patches\.mjs/);

	const both = run('.', ['--assert-fresh', '--assert-applied']);
	assert.equal(both.code, 1);
	assert.match(both.output, /mutually exclusive/);
});

test('--expect-version refuses a checkout that is not the requested version', () => {
	const dir = sandbox();
	try {
		assert.equal(run(dir, ['--root', dir, '--check', '--expect-version', 'v19.4.0']).code, 0);
		assert.equal(run(dir, ['--root', dir, '--check', '--expect-version=19.3.0']).code, 1);
		assert.match(run(dir, ['--root', dir, '--check', '--expect-version', '19.3.0']).output, /holds 19\.4\.0/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a fresh checkout applies every rule, and reports it', () => {
	const dir = sandbox();
	try {
		const first = run(dir, ['--root', dir, '--expect-version', 'v19.4.0', '--assert-fresh']);
		assert.equal(first.code, 0, first.output);
		assert.match(first.output, /applied: 4 modified, 0 already applied/);

		// The rewrite is on disk, not just in the report.
		assert.ok(readFileSync(join(dir, CHECKIN_UTILS), 'utf8').includes('local-change:checkin-subscription-is-enterprise'));

		// …and a second pass is a no-op, which is the invariant CI asserts.
		const second = run(dir, ['--root', dir, '--check', '--assert-applied']);
		assert.equal(second.code, 0, second.output);
		assert.match(second.output, /verified: 0 modified, 4 already applied/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('--assert-fresh fails when a rule decides it has nothing to do', () => {
	const dir = sandbox();
	try {
		assert.equal(run(dir, ['--root', dir]).code, 0, 'patch the checkout first');

		// This is the scenario the invariant exists for: a skippable rule on a checkout that was supposed to
		// be untouched. Without --assert-fresh the run reports success.
		const relaxed = run(dir, ['--root', dir, '--check']);
		assert.equal(relaxed.code, 0);
		assert.match(relaxed.output, /4 already applied/);

		const strict = run(dir, ['--root', dir, '--check', '--assert-fresh']);
		assert.equal(strict.code, 1);
		assert.match(strict.output, /a fresh checkout must have every rule applied by this run/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('--assert-applied fails when a checkout is not patched yet', () => {
	const dir = sandbox();
	try {
		const { code, output } = run(dir, ['--root', dir, '--check', '--assert-applied']);

		assert.equal(code, 1);
		assert.match(output, /should already carry every local modification/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('--check never writes, but still reports what it would do', () => {
	const dir = sandbox();
	try {
		const before = readFileSync(join(dir, SUBSCRIPTION_UTILS), 'utf8');
		const { code, output } = run(dir, ['--root', dir, '--check']);

		assert.equal(code, 0);
		assert.match(output, /verified: 4 modified/);
		assert.equal(readFileSync(join(dir, SUBSCRIPTION_UTILS), 'utf8'), before, '--check must not touch the checkout');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('--diff exports what the rules changed, including a staged checkout', () => {
	const dir = sandbox();
	try {
		const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
		git('init', '-q');
		git('config', 'user.email', 'ci@example.com');
		git('config', 'user.name', 'CI');
		git('config', 'commit.gpgsign', 'false');
		git('add', '.');
		git('commit', '-q', '-m', 'fixture');

		const diffFile = join(dir, 'applied.diff');
		const { code, output } = run(dir, ['--root', dir, '--diff', diffFile, '--assert-fresh']);
		assert.equal(code, 0, output);

		const diff = readFileSync(diffFile, 'utf8');
		assert.match(diff, /^diff --git a\/src\/plus\/gk\/utils\/checkin\.utils\.ts/m);
		assert.match(diff, /\n\+\t+\/\/ local-change:checkin-subscription-is-enterprise/, 'the audit trail shows the real edit');

		// Staging the result must not hide it from the audit trail.
		git('add', SUBSCRIPTION_UTILS);
		const { code: again } = run(dir, ['--root', dir, '--check', '--assert-applied']);
		assert.equal(again, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an unknown option value does not get written to disk', () => {
	const dir = sandbox();
	try {
		const { code } = run(dir, ['--root', dir, '--check', '--diff', '--check']);
		assert.equal(code, 1);
		assert.equal(
			readFileSync(join(dir, SUBSCRIPTION_UTILS), 'utf8').includes('local-change:'),
			false,
			'nothing may be rewritten when the arguments are rejected',
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a failed write rolls back the files it already rewrote', () => {
	const dir = sandbox();
	try {
		// The plan succeeds for both files, then the second write fails (read-only on both POSIX and
		// Windows). Without a rollback the first file would keep its rewrite, leaving a checkout that is
		// half patched and impossible to reason about.
		const pristine = readFileSync(join(dir, SUBSCRIPTION_UTILS), 'utf8');
		const blocked = join(dir, CHECKIN_UTILS);
		chmodSync(blocked, 0o444);

		const { code, output } = run(dir, ['--root', dir]);
		assert.equal(code, 1);
		assert.match(output, /could not write/);

		if (process.platform === 'win32') {
			// Windows keeps a stale handle on the read-only file for a moment; restore the attribute
			// before the cleanup below deletes the directory.
			chmodSync(blocked, 0o666);
		}
		assert.equal(readFileSync(join(dir, SUBSCRIPTION_UTILS), 'utf8'), pristine, 'the first file must be rolled back');
	} finally {
		chmodSync(join(dir, CHECKIN_UTILS), 0o666);
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the checkout is left untouched when a rule cannot find its anchor', () => {
	const dir = sandbox();
	try {
		// Remove the anchor the check-in rule clones from, leaving every other rule intact.
		const path = join(dir, CHECKIN_UTILS);
		writeFileSync(path, readFileSync(path, 'utf8').replace('getSubscriptionPlan(', 'getSubscriptionPlanRenamed('));
		const before = readFileSync(path, 'utf8');

		const { code, output } = run(dir, ['--root', dir]);
		assert.equal(code, 1);
		assert.match(output, /found no getSubscriptionPlan\('community-with-account'/);
		assert.equal(readFileSync(path, 'utf8'), before, 'a failed plan must not leave a half-patched checkout');
		assert.equal(
			readFileSync(join(dir, SUBSCRIPTION_UTILS), 'utf8').includes('local-change:'),
			false,
			'no file may be written when another rule failed',
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
