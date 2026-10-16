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
 *   4. where is a specific call expression inside it,
 *   5. where is a named property of an object literal.
 *
 * Every scan runs against a pre-computed code mask, so braces, parens and keywords that live inside
 * comments, strings, template literals or regex literals can never skew the balance counting.
 */

/** A character that can end an expression, meaning a following `/` starts a division, not a regex. */
const EXPRESSION_END = /[A-Za-z0-9_$)\]'"`]/;

export function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the index just past a `'`/`"` literal that starts at `i`. */
function skipString(src, i) {
	const quote = src[i];
	i++;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1;
		if (ch === '\n') return i;
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
 * Whether a `/` starts a regex literal (true) or is a division operator (false).
 *
 * `previousChar` is the last non-whitespace code character seen before the slash — it covers the
 * cases that end an expression without forming a token (`)`, `]`, `}`, a string or a template
 * literal). `previousToken` is the last identifier/keyword token before the slash.
 *
 * TODO(human): 目前只看 `previousChar`，所以 `return /}/.test(x)` 这类「关键字后紧跟正则字面量」的写法
 * 会被当成除法，掩码把正则里的 `}` / `(` 当作代码，后续 findFunction / matchBalanced 的括号配对就会
 * 静默错位（改错函数体跨度）。请把 `previousToken` 用起来：决定「哪些关键字之后必然是正则」的集合，
 * 例如 return / typeof / case / in / of / await / delete / void / yield / else / do / instanceof，
 * 并想清楚 `new`（`new /re/` 虽然罕见但语法合法）与 `a in /re/` 这类边界要怎么处理。
 * 判定改动只影响掩码，改完请跑 `node --test scripts/__tests__/` —— 里面有一条被 skip 的用例
 * 「关键字后的正则字面量」等你把它打开。
 */
function startsRegexLiteral(previousChar, previousToken) {
	void previousToken;
	return !EXPRESSION_END.test(previousChar);
}

/**
 * Marks every character that is real code with a 1. Comments, string literals, the literal text of
 * template literals and regex literals stay 0. Balanced-bracket walks then only have to look at the
 * masked characters.
 *
 * Template *interpolations* (`${ ... }`) are real code and are masked recursively — a nested template
 * inside an interpolation therefore cannot terminate the outer one early.
 */
export function buildCodeMask(src) {
	const mask = new Uint8Array(src.length);
	let i = 0;
	let previous = '';
	let previousToken = '';

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
		if (ch === '"' || ch === "'") {
			i = skipString(src, i);
			previous = ')';
			previousToken = '';
			continue;
		}
		if (ch === '`') {
			i = skipTemplate(src, mask, i);
			previous = ')';
			previousToken = '';
			continue;
		}
		if (ch === '/' && startsRegexLiteral(previous, previousToken)) {
			i = skipRegex(src, i);
			previous = ')';
			previousToken = '';
			continue;
		}

		mask[i] = 1;
		if (!/\s/.test(ch)) previous = ch;
		previousToken = /[\w$]/.test(ch) ? previousToken + ch : '';
		i++;
	}

	return mask;
}

/**
 * Skips a template literal starting at the backtick `i`, marking the literal text as non-code and
 * every interpolation as code (`mask` gets 1s for the `${ ... }` region, recursively).
 */
function skipTemplate(src, mask, i) {
	i++;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '`') return i + 1;
		if (ch === '$' && src[i + 1] === '{') {
			i = skipInterpolation(src, mask, i + 2);
			continue;
		}
		i++;
	}
	return src.length;
}

/**
 * Scans the body of a `${ ... }` interpolation that starts just after the opening brace, marking the
 * code it contains and returning the index just past the matching `}`.
 */
function skipInterpolation(src, mask, i) {
	let depth = 1;
	let previous = '';
	let previousToken = '';

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
		if (ch === '"' || ch === "'") {
			i = skipString(src, i);
			previous = ')';
			previousToken = '';
			continue;
		}
		if (ch === '`') {
			i = skipTemplate(src, mask, i);
			previous = ')';
			previousToken = '';
			continue;
		}
		if (ch === '/' && startsRegexLiteral(previous, previousToken)) {
			i = skipRegex(src, i);
			previous = ')';
			previousToken = '';
			continue;
		}

		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return i + 1;
		}

		mask[i] = 1;
		if (!/\s/.test(ch)) previous = ch;
		previousToken = /[\w$]/.test(ch) ? previousToken + ch : '';
		i++;
	}

	return src.length;
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

/** Returns the index of the previous code (masked) character before `index`, or -1. */
function previousCodeIndex(src, mask, index) {
	for (let i = index - 1; i >= 0; i--) {
		if (mask[i] === 1 && !/\s/.test(src[i])) return i;
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

/** The identifier/keyword token that ends just before `index`, or the single character there. */
function tokenBefore(src, mask, index) {
	const end = previousCodeIndex(src, mask, index);
	if (end === -1) return '';
	if (!/[\w$]/.test(src[end])) return src[end];

	let start = end;
	while (start > 0 && /[\w$]/.test(src[start - 1])) {
		start--;
	}
	return src.slice(start, end + 1);
}

/**
 * Whether the `function` keyword at `index` starts a *statement*. `const f = function f() {}` declares
 * the same name as an expression — counting it as a second declaration would stop the build over code
 * the rule could still safely rewrite.
 */
function isStatementPosition(src, mask, index) {
	const before = previousCodeIndex(src, mask, index);
	if (before === -1) return true;
	if (/[=(,:?+\-*/&|![]/.test(src[before])) return false;

	return !new Set(['return', 'typeof', 'new', 'void', 'await', 'case', 'in', 'of', 'delete', 'instanceof']).has(
		tokenBefore(src, mask, index),
	);
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
		if (!isStatementPosition(src, mask, match.index)) continue;
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

	const bodyStart = findBodyStart(src, mask, name, paramsEnd);
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

/**
 * Finds the `{` that opens a function body, skipping any return-type annotation in between.
 *
 * A return type can itself contain braces — `): { actual: number } {`, `): Promise<{ ok: boolean }> {`,
 * or a union of object types — and treating the first `{` after the parameter list as the body would
 * then rewrite the *type annotation* instead of the body.
 */
function findBodyStart(src, mask, name, paramsEnd) {
	let depth = 0;
	let previous = '';
	let sawAnnotation = false;
	let i = paramsEnd + 1;

	while (i < src.length) {
		if (mask[i] !== 1) {
			i++;
			continue;
		}

		const ch = src[i];
		if (depth === 0 && !sawAnnotation && ch === ':') {
			sawAnnotation = true;
		} else if (ch === '(' || ch === '[' || ch === '<') {
			depth++;
		} else if (ch === ')' || ch === ']' || ch === '>') {
			if (depth > 0) depth--;
		} else if (ch === '{') {
			// Inside brackets, or right after a `:`/`|`/`&`, a brace belongs to the type annotation.
			if (depth > 0 || (sawAnnotation && (previous === ':' || previous === '|' || previous === '&'))) {
				depth++;
			} else {
				return i;
			}
		} else if (ch === '}') {
			if (depth > 0) depth--;
		} else if (ch === ';' && depth === 0) {
			throw new Error(`function ${name}() has no body (declaration only)`);
		}

		if (!/\s/.test(ch)) previous = ch;
		i++;
	}

	throw new Error(`could not find the body of function ${name}()`);
}

/** Keywords that can legitimately sit directly before a `return` statement. */
const RETURN_PRECEDING_KEYWORDS = new Set(['else', 'do', 'case', 'default']);

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
		if (/[\w$]/.test(src[i + 6] ?? '')) continue;

		const before = previousCodeIndex(src, mask, i);
		if (before !== -1) {
			const previous = src[before];
			// `object.return` / `object?.return` are member accesses, not statements.
			if (previous === '.' || previous === '?') continue;
			// A word character here means `return` is the tail of a longer identifier — unless the word is
			// one of the keywords a statement can follow (`} else return { … }`).
			if (/[\w$]/.test(previous) && !RETURN_PRECEDING_KEYWORDS.has(tokenBefore(src, mask, i))) continue;
		}

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

		// A member call (`foo.bar()`) is not a call to the bare name; the dot may sit on an earlier
		// line or behind a comment, so look at the previous *code* character rather than `src[absolute-1]`.
		const before = previousCodeIndex(src, mask, absolute);
		if (before !== -1 && (src[before] === '.' || src[before] === '?')) continue;

		const after = absolute + match[0].length;
		if (src[after] !== '(') continue;

		const close = matchBalanced(src, mask, after, '(', ')');
		if (close === -1) continue;

		calls.push({ start: absolute, end: close });
	}

	return calls;
}

/**
 * Locates a property by name in the object literal that starts at `objectStart`.
 *
 * Only depth-0 keys count: a `plan: { ... }` nested inside another value (or passed to a callback)
 * is a different property, and rewriting it would silently change the wrong thing. Returns
 * `{ keyStart, keyEnd, valueStart, valueEnd }` with `valueEnd` exclusive, or `undefined` when the
 * object has no such property.
 */
export function findObjectProperty(src, mask, objectStart, objectEnd, name) {
	let depth = 0;
	let ternary = 0;
	let key; // the top-level key whose value we are currently inside
	let valueStart = -1;

	const found = valueEnd => ({ keyStart: key.keyStart, keyEnd: key.keyEnd, valueStart: valueStart, valueEnd: valueEnd });

	for (let i = objectStart + 1; i < objectEnd; i++) {
		if (mask[i] !== 1) continue;

		const ch = src[i];
		if (ch === '{' || ch === '[' || ch === '(') {
			depth++;
			continue;
		}
		if (ch === '}' || ch === ']' || ch === ')') {
			if (depth > 0) depth--;
			continue;
		}
		if (depth > 0) continue;

		if (ch === ',') {
			if (valueStart >= 0 && key?.name === name) return found(previousCodeIndex(src, mask, i) + 1);

			key = undefined;
			valueStart = -1;
			ternary = 0;
			continue;
		}

		if (valueStart >= 0) {
			// Inside a property's value at the object's top level. A `?` here is a ternary (unless it is
			// part of `?.`/`??`, which never opens a branch), and only after it is closed can a `:` or a
			// comma mean what it usually means.
			if (ch === '?') {
				if (src[i + 1] !== '.' && src[i + 1] !== '?' && src[i + 1] !== '[') ternary++;
			} else if (ch === ':' && ternary > 0) {
				ternary--;
			}
			continue;
		}

		if (!/[A-Za-z_$]/.test(ch)) continue;

		let keyEnd = i;
		while (keyEnd < objectEnd && /[\w$]/.test(src[keyEnd])) {
			keyEnd++;
		}

		let colon = keyEnd;
		while (colon < objectEnd && (mask[colon] !== 1 || /\s/.test(src[colon]))) {
			colon++;
		}
		if (src[colon] !== ':') {
			i = keyEnd - 1;
			continue;
		}

		let start = colon + 1;
		while (start < objectEnd && (mask[start] !== 1 || /\s/.test(src[start]))) {
			start++;
		}

		key = { name: src.slice(i, keyEnd), keyStart: i, keyEnd: keyEnd };
		valueStart = start;
		i = start - 1;
	}

	if (valueStart >= 0 && key?.name === name) return found(objectEnd);

	return undefined;
}

/**
 * Applies `{ start, end, text }` edits to `src`. Overlapping edits are a rule-authoring bug, so they
 * fail loudly rather than silently producing a half-patched file. Edits that start at the same offset
 * are applied in the order they were given.
 */
export function applyEdits(src, edits) {
	if (edits.length === 0) return src;

	const ordered = [...edits].sort((a, b) => a.start - b.start);
	for (const edit of ordered) {
		if (edit.end < edit.start) {
			throw new Error(`edit ${edit.source} ends before it starts`);
		}
	}
	for (let i = 1; i < ordered.length; i++) {
		if (ordered[i].start < ordered[i - 1].end) {
			throw new Error(`overlapping edits: ${ordered[i - 1].source} and ${ordered[i].source}`);
		}
	}

	return ordered
		.slice()
		.reverse()
		.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), src);
}
