/**
 * Syntax-checks every ```js block in docs/ADDING-A-CHANGE.md.
 *
 * The guide's whole job is to hand out copy-pasteable rule templates; a template with a typo would send
 * whoever follows it into a debugging session against the codemod itself. This used to live in a
 * gitignored scratch directory, which meant it ran exactly as often as someone remembered it.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const DOC = new URL('../../docs/ADDING-A-CHANGE.md', import.meta.url);
const doc = readFileSync(DOC, 'utf8');
const blocks = [...doc.matchAll(/```js\n([\s\S]*?)```/g)].map(match => match[1]);

/** Every parseable form the surrounding prose implies: a module, an object literal, or a method body. */
const forms = block =>
	/^\s*(import|export)\s/m.test(block)
		? [{ kind: 'module', source: block }]
		: [
				{ kind: 'object literal', source: `const __unused = [\n${block.replace(/^/gm, '\t')}\n];\nvoid __unused;\n` },
				{ kind: 'method body', source: `const __unused = {\n${block}\n};\nvoid __unused;\n` },
			];

test('the guide keeps its js code blocks parseable', () => {
	assert.ok(blocks.length > 0, 'the guide should still contain js templates');

	const dir = mkdtempSync(join(tmpdir(), 'rebuild-gitlens-docs-'));
	const failures = [];

	try {
		blocks.forEach((block, index) => {
			const errors = [];

			for (const form of forms(block)) {
				const file = join(dir, `block-${index}.mjs`);
				writeFileSync(file, form.source);

				try {
					execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
					return;
				} catch (error) {
					errors.push(`${form.kind}: ${String(error.stderr ?? error).split('\n')[0]}`);
				}
			}

			failures.push(`block #${index + 1} (${errors.join(' | ')})\n${block}`);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	assert.deepEqual(failures, [], `js blocks in ${DOC.pathname} do not parse`);
});
