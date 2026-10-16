/**
 * Dependency-free TypeScript scanning primitives used by the GitLens codemod.
 *
 * A `.patch` file pins the *surrounding* lines of every change, so any upstream commit that inserts
 * a function next to one of ours invalidates the whole hunk — which is exactly how the previous
 * `patches/*.patch` set kept going stale. These helpers instead locate a change target structurally:
 *
 *   1. where does `function <name>(...)` start, and where does its body end,
 *   2. what is its parameter list,
 *   3. where are the top-level `return` statements inside it,
 *   4. where is a specific call expression inside it.
 *
 * Every scan runs against a pre-computed code mask, so braces, parens and keywords that live inside
 * comments, strings, template literals or regex literals can never skew the balance counting.
 */

/** A character that can end an expression, meaning a following `/` starts a division, not a regex. */
const EXPRESSION_END = /[A-Za-z0-9_$)\]'"`]/;

export function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the index just past a string/template/regex literal that starts at `i`. */
function skipLiteral(src, i) {
	const quote = src[i];
	i++;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1;
		if (ch === '\n' && quote !== '`') return i;
		i++;
	}
	return src.length;
}

/** Returns the index just past a regex literal (including flags) that starts at `i`. */
function skipRegex(src, i) {
	i++;
	let inClass = false;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '\n') return i;
		if (ch === '[') {
			inClass = true;
		} else if (ch === ']') {
			inClass = false;
		} else if (ch === '/' && !inClass) {
			i++;
			break;
		}
		i++;
	}
	while (i < src.length && /[a-z]/i.test(src[i])) {
		i++;
	}
	return i;
}

/**
 * Marks every character that is real code with a 1. Comments, string/template literals and regex
 * literals stay 0. Balanced-bracket walks then only have to look at the masked characters.
 */
export function buildCodeMask(src) {
	const mask = new Uint8Array(src.length);
	let i = 0;
	let previous = '';

	while (i < src.length) {
		const ch = src[i];
		if (ch === '/' && src[i + 1] === '/') {
			const newline = src.indexOf('\n', i);
			i = newline === -1 ? src.length : newline;
			continue;
		}
		if (ch === '/' && src[i + 1] === '*') {
			const close = src.indexOf('*/', i + 2);
			i = close === -1 ? src.length : close + 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			i = skipLiteral(src, i);
			previous = ')';
			continue;
		}
		if (ch === '/' && !EXPRESSION_END.test(previous)) {
			i = skipRegex(src, i);
			previous = ')';
			continue;
		}

		mask[i] = 1;
		if (!/\s/.test(ch)) previous = ch;
		i++;
	}

	return mask;
}

/** Returns the index of the bracket matching the one at `openIndex`, or -1. */
export function matchBalanced(src, mask, openIndex, open, close) {
	let depth = 0;
	for (let i = openIndex; i < src.length; i++) {
		if (mask[i] !== 1) continue;

		const ch = src[i];
		if (ch === open) {
			depth++;
		} else if (ch === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function lineOf(src, index) {
	let line = 1;
	for (let i = 0; i < index && i < src.length; i++) {
		if (src[i] === '\n') line++;
	}
	return line;
}

/** Splits a parameter list into `{ name, start, end }`, ignoring nesting inside `<...>`, `(...)`, etc. */
function parseParams(src, mask, paramsStart, paramsEnd) {
	const params = [];
	let depth = 0;
	let segmentStart = paramsStart + 1;

	for (let i = paramsStart + 1; i <= paramsEnd; i++) {
		const isSeparator = i === paramsEnd;
		const ch = isSeparator ? ',' : src[i];
		const isCode = isSeparator || mask[i] === 1;

		if (isCode && !isSeparator && (ch === '(' || ch === '[' || ch === '{' || ch === '<')) {
			depth++;
			continue;
		}
		if (isCode && !isSeparator && (ch === ')' || ch === ']' || ch === '}' || ch === '>')) {
			// Clamped so a stray `>` (from an arrow-function default value) can't drive the depth negative.
			if (depth > 0) depth--;
			continue;
		}
		if (!isCode || ch !== ',' || depth !== 0) continue;

		const segment = src.slice(segmentStart, i);
		const identifier = /^\s*([A-Za-z_$][\w$]*)/.exec(segment);
		if (identifier != null) {
			const start = segmentStart + identifier[0].indexOf(identifier[1]);
			params.push({ name: identifier[1], start: start, end: start + identifier[1].length });
		}
		segmentStart = i + 1;
	}

	return params;
}

/**
 * Locates `function <name>(...)  { ... }` and returns its spans.
 * Throws when the declaration is ambiguous or shaped differently than the codemod expects, so a
 * surprise upstream refactor surfaces as an actionable error instead of a silently missed patch.
 */
export function findFunction(src, mask, name) {
	const pattern = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\b`, 'g');
	let declaration;

	for (const match of src.matchAll(pattern)) {
		if (mask[match.index] !== 1) continue;
		if (declaration != null) {
			throw new Error(`found more than one top-level declaration of function ${name}()`);
		}
		declaration = match;
	}
	if (declaration == null) {
		throw new Error(`could not find function ${name}()`);
	}

	let i = declaration.index + declaration[0].length;
	while (i < src.length && /\s/.test(src[i])) {
		i++;
	}
	if (src[i] !== '(') {
		throw new Error(`function ${name}() no longer has a plain parameter list`);
	}

	const paramsStart = i;
	const paramsEnd = matchBalanced(src, mask, paramsStart, '(', ')');
	if (paramsEnd === -1) throw new Error(`unbalanced parameter list in function ${name}()`);

	let bodyStart = -1;
	for (let j = paramsEnd + 1; j < src.length; j++) {
		if (mask[j] !== 1) continue;
		if (src[j] === '{') {
			bodyStart = j;
			break;
		}
		if (src[j] === ';') {
			throw new Error(`function ${name}() has no body (declaration only)`);
		}
	}
	if (bodyStart === -1) throw new Error(`could not find the body of function ${name}()`);

	const bodyEnd = matchBalanced(src, mask, bodyStart, '{', '}');
	if (bodyEnd === -1) throw new Error(`unbalanced body in function ${name}()`);

	return {
		name: name,
		line: lineOf(src, declaration.index),
		declStart: declaration.index,
		paramsStart: paramsStart,
		paramsEnd: paramsEnd,
		params: parseParams(src, mask, paramsStart, paramsEnd),
		bodyStart: bodyStart,
		bodyEnd: bodyEnd,
		body: src.slice(bodyStart + 1, bodyEnd),
	};
}

/** Top-level (depth 0) `return` statement start offsets inside `[start, end)`; `start` is a `{`. */
export function findTopLevelReturns(src, mask, start, end) {
	const returns = [];
	let depth = 0;

	for (let i = start + 1; i < end; i++) {
		if (mask[i] !== 1) continue;

		const ch = src[i];
		if (ch === '{' || ch === '(' || ch === '[') {
			depth++;
			continue;
		}
		if (ch === '}' || ch === ')' || ch === ']') {
			if (depth > 0) depth--;
			continue;
		}
		if (depth !== 0 || ch !== 'r') continue;
		if (!src.startsWith('return', i)) continue;
		if (/[\w$.]/.test(src[i - 1] ?? '')) continue;
		if (/[\w$]/.test(src[i + 6] ?? '')) continue;

		returns.push(i);
		i += 5;
	}

	return returns;
}

/** Every `<callee>(...)` call expression inside `[start, end)`, as `{ start, end }` (end is inclusive). */
export function findCalls(src, mask, start, end, callee) {
	const calls = [];
	const pattern = new RegExp(`\\b${escapeRegExp(callee)}\\b`, 'g');
	const scoped = src.slice(start, end);

	for (const match of scoped.matchAll(pattern)) {
		const absolute = start + match.index;
		if (mask[absolute] !== 1) continue;
		if (src[absolute - 1] === '.') continue;

		const after = absolute + match[0].length;
		if (src[after] !== '(') continue;

		const close = matchBalanced(src, mask, after, '(', ')');
		if (close === -1) continue;

		calls.push({ start: absolute, end: close });
	}

	return calls;
}

/**
 * Applies `{ start, end, text }` edits to `src`. Overlapping edits are a rule-authoring bug, so they
 * fail loudly rather than silently producing a half-patched file.
 */
export function applyEdits(src, edits) {
	if (edits.length === 0) return src;

	const ordered = [...edits].sort((a, b) => b.start - a.start);
	for (let i = 1; i < ordered.length; i++) {
		if (ordered[i].end > ordered[i - 1].start) {
			throw new Error(`overlapping edits: ${ordered[i - 1].source} and ${ordered[i].source}`);
		}
	}

	return ordered.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), src);
}
