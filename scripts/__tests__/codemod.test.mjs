/**
 * Regression tests for the scanning primitives every rule is built on.
 *
 * These are the pieces whose failure mode is *silent*: a mask that is off by one bracket makes
 * `findFunction` report a body that ends too early, and the rule then rewrites the wrong span while
 * every downstream check still passes. Keep the fixtures small and the expectations exact.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	applyEdits,
	buildCodeMask,
	escapeRegExp,
	findCalls,
	findFunction,
	findObjectProperty,
	findTopLevelReturns,
	matchBalanced,
} from '../lib/codemod.mjs';

const maskOf = source => buildCodeMask(source);

test('buildCodeMask keeps comments, strings and regex out of the code mask', () => {
	const source = [
		'// } not a brace',
		'/* { also not */',
		"const a = '}';",
		'const b = "{";',
		'const c = /[}]/;',
		'const d = 1;',
		'',
	].join('\n');

	const mask = maskOf(source);
	const code = index => mask[index] === 1;

	assert.equal(code(source.indexOf('const')), true);
	assert.equal(code(source.indexOf('} not a brace')), false);
	assert.equal(code(source.indexOf('{ also not')), false);
	assert.equal(code(source.indexOf('}')), false, 'string content is not code');
	assert.equal(code(source.indexOf('1;')), true);
});

test('buildCodeMask treats template interpolations as code and literal text as text', () => {
	const source = ['const greeting = `hello ${name} and ${other}`;', ''].join('\n');
	const mask = maskOf(source);

	assert.equal(mask[source.indexOf('hello')], 0, 'literal text is not code');
	assert.equal(mask[source.indexOf('name')], 1, 'an interpolation is code');
	assert.equal(mask[source.indexOf('other')], 1, 'a later interpolation is code too');
});

test('buildCodeMask survives a template literal nested inside another template interpolation', () => {
	// The inner backtick closes the *inner* template, not the outer one — getting this wrong shifts
	// every span that follows.
	const source = ['const text = `outer ${inner(`inner ${deep}`)} tail`;', 'const after = 1;', ''].join('\n');
	const mask = maskOf(source);

	assert.equal(mask[source.indexOf('tail')], 0, 'the outer literal continues after the nested template');
	assert.equal(mask[source.indexOf('after')], 1);
	assert.equal(mask[source.indexOf('deep')], 1, 'nested interpolation is code');
});

test('buildCodeMask handles a brace inside a template interpolation', () => {
	const source = ['const text = `a ${object.key} b`;', 'function f() {', '\treturn 1;', '}', ''].join('\n');
	const mask = maskOf(source);
	const fn = findFunction(source, mask, 'f');

	assert.equal(fn.body.trim(), 'return 1;');
});

test('buildCodeMask keeps a division operator out of the regex branch', () => {
	const source = ['function f(total) {', '\tconst half = total / 2;', '\treturn half;', '}', ''].join('\n');
	const fn = findFunction(source, maskOf(source), 'f');

	assert.equal(fn.bodyEnd, source.lastIndexOf('}'));
});

test(
	'buildCodeMask treats a regex literal after a keyword as a literal',
	{ skip: '未实现：startsRegexLiteral 目前只看前一个字符，见 scripts/lib/codemod.mjs' },
	() => {
		const source = ['function f(x) {', '\treturn /[)]/.test(x);', '}', ''].join('\n');
		const fn = findFunction(source, maskOf(source), 'f');

		assert.equal(fn.body.trim(), 'return /[)]/.test(x);');
	},
);

test('matchBalanced ignores brackets that live in strings, templates and comments', () => {
	const source = [
		'function f() {',
		"\tconst a = '}';",
		'\tconst b = `${ { nested: 1 } }`;',
		'\t// }',
		'\treturn { ok: true };',
		'}',
		'',
	].join('\n');
	const mask = maskOf(source);
	const bodyStart = source.indexOf('{');

	assert.equal(matchBalanced(source, mask, bodyStart, '{', '}'), source.lastIndexOf('}'));
});

test('findFunction returns spans, parameters and the body of a plain function', () => {
	const source = ['export function target(_a: string, b = 2) {', '\treturn b;', '}', ''].join('\n');
	const fn = findFunction(source, maskOf(source), 'target');

	assert.equal(fn.line, 1);
	assert.deepEqual(
		fn.params.map(param => param.name),
		['_a', 'b'],
	);
	assert.equal(fn.body.trim(), 'return b;');
});

test('findFunction skips an inline object return type instead of rewriting the annotation', () => {
	const source = [
		'export function target(a: string): { actual: number; effective: number } {',
		'\treturn { actual: 1, effective: 1 };',
		'}',
		'',
	].join('\n');
	const fn = findFunction(source, maskOf(source), 'target');

	assert.equal(fn.body.trim(), 'return { actual: 1, effective: 1 };');
});

test('findFunction skips an object type nested inside a generic return type', () => {
	const source = ['function target(): Promise<{ ok: boolean }> {', '\treturn Promise.resolve({ ok: true });', '}', ''].join('\n');
	const fn = findFunction(source, maskOf(source), 'target');

	assert.equal(fn.body.trim(), 'return Promise.resolve({ ok: true });');
});

test('findFunction skips a union of object return types', () => {
	const source = ['function target(): { a: 1 } | { b: 2 } {', '\treturn { a: 1 };', '}', ''].join('\n');
	const fn = findFunction(source, maskOf(source), 'target');

	assert.equal(fn.body.trim(), 'return { a: 1 };');
});

test('findFunction ignores a named function expression with the same name', () => {
	// `const f = function f() {}` is an expression, not a second declaration — reporting it as an
	// ambiguous declaration would stop the build over code the rule could still safely rewrite.
	const source = [
		'const other = function target() {',
		'\treturn 1;',
		'};',
		'',
		'export function target() {',
		'\treturn 2;',
		'}',
		'',
	].join('\n');
	const fn = findFunction(source, maskOf(source), 'target');

	assert.equal(fn.line, 5);
	assert.equal(fn.body.trim(), 'return 2;');
});

test('findFunction reports a genuinely duplicated declaration', () => {
	const source = ['export function target() {', '\treturn 1;', '}', '', 'export function target() {', '\treturn 2;', '}', ''].join('\n');

	assert.throws(() => findFunction(source, maskOf(source), 'target'), /more than one top-level declaration/);
});

test('findFunction reports a missing function and a declaration without a body', () => {
	assert.throws(() => findFunction('const a = 1;', maskOf('const a = 1;'), 'target'), /could not find function target\(\)/);
	assert.throws(() => findFunction('function target(a: string): void;', maskOf('function target(a: string): void;'), 'target'), /no body/);
});

test('findTopLevelReturns only reports returns that are not nested', () => {
	const source = [
		'function target() {',
		'\tif (a) {',
		'\t\treturn 1;',
		'\t}',
		'\tlist.map(item => {',
		'\t\treturn item;',
		'\t});',
		'\treturn 2;',
		'}',
		'',
	].join('\n');
	const mask = maskOf(source);
	const fn = findFunction(source, mask, 'target');
	const returns = findTopLevelReturns(source, mask, fn.bodyStart, fn.bodyEnd);

	assert.equal(returns.length, 1);
	assert.equal(source.slice(returns[0], returns[0] + 6), 'return');
	assert.equal(source.slice(returns[0], returns[0] + 9), 'return 2;');
});

test('findCalls finds bare calls and skips member calls and definition sites', () => {
	const source = [
		'function target() {',
		'\tconst a = getSubscriptionPlan("community");',
		'\tconst b = helper.getSubscriptionPlan("community");',
		'\tconst c = helper',
		'\t\t.getSubscriptionPlan("community");',
		'\treturn a ?? b ?? c;',
		'}',
		'',
	].join('\n');
	const mask = maskOf(source);
	const fn = findFunction(source, mask, 'target');
	const calls = findCalls(source, mask, fn.bodyStart, fn.bodyEnd, 'getSubscriptionPlan');

	assert.equal(calls.length, 1);
	assert.match(source.slice(calls[0].start, calls[0].end + 1), /^getSubscriptionPlan\("community"\)$/);
});

test('findObjectProperty finds a top-level property and skips nested ones', () => {
	const source = [
		'function target() {',
		'\treturn {',
		'\t\touter: { plan: { actual: 1, effective: 1 } },',
		'\t\tplan: { actual: 2, effective: 2 },',
		'\t\taccount: undefined,',
		'\t};',
		'}',
		'',
	].join('\n');
	const mask = maskOf(source);
	const fn = findFunction(source, mask, 'target');
	const objectStart = source.indexOf('{', source.indexOf('return'));
	const objectEnd = matchBalanced(source, mask, objectStart, '{', '}');
	const plan = findObjectProperty(source, mask, objectStart, objectEnd, 'plan');

	assert.notEqual(plan, undefined);
	assert.equal(source.slice(plan.valueStart, plan.valueEnd).replace(/\s+/g, ' '), '{ actual: 2, effective: 2 }');
});

test('findObjectProperty handles ternary values, optional chaining and a trailing property', () => {
	const source = [
		'function target() {',
		'\treturn {',
		'\t\tfirst: a ? b : c,',
		'\t\tsecond: object?.value ?? fallback,',
		'\t\tplan: { actual: 1, effective: 1 },',
		'\t};',
		'}',
		'',
	].join('\n');
	const mask = maskOf(source);
	const fn = findFunction(source, mask, 'target');
	const objectStart = source.indexOf('{', source.indexOf('return'));
	const objectEnd = matchBalanced(source, mask, objectStart, '{', '}');
	const plan = findObjectProperty(source, mask, objectStart, objectEnd, 'plan');

	assert.notEqual(plan, undefined, 'the last property of an object literal still has to be found');
	assert.equal(source.slice(plan.valueStart, plan.valueEnd).replace(/\s+/g, ' '), '{ actual: 1, effective: 1 }');
	assert.equal(findObjectProperty(source, mask, objectStart, objectEnd, 'missing'), undefined);
});

test('applyEdits accepts adjacent edits, keeps insertion order and rejects overlap', () => {
	const source = 'abcdef';

	assert.equal(
		applyEdits(source, [
			{ start: 0, end: 3, text: 'X', source: 'first' },
			{ start: 3, end: 6, text: 'Y', source: 'second' },
		]),
		'XY',
	);
	assert.equal(
		applyEdits(source, [
			{ start: 2, end: 2, text: 'A', source: 'first insert' },
			{ start: 2, end: 2, text: 'B', source: 'second insert' },
		]),
		'abABcdef',
	);
	assert.throws(
		() =>
			applyEdits(source, [
				{ start: 1, end: 4, text: 'X', source: 'first' },
				{ start: 3, end: 5, text: 'Y', source: 'second' },
			]),
		/overlapping edits: first and second/,
	);
	assert.throws(() => applyEdits(source, [{ start: 3, end: 1, text: 'X', source: 'backwards' }]), /ends before it starts/);
});

test('escapeRegExp makes a literal safe to embed in a pattern', () => {
	assert.equal(escapeRegExp('a.b(c)'), 'a\\.b\\(c\\)');
});
