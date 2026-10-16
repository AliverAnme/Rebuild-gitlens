/**
 * The local modifications this repository makes to upstream GitLens.
 *
 * Each rule is a structural rewrite of one function: it finds the function by name, replaces (or
 * extends) what that function does, and can tell whether it has already been applied. Nothing here
 * depends on line numbers or on the surrounding lines, so upstream adding, removing or reformatting
 * code next to a target no longer invalidates the change.
 *
 * Every rewrite stamps its own marker comment into the function it changed, and `isApplied()` accepts
 * nothing but that marker. Matching on the shape of the rewritten code instead (a substring such as
 * `enterprisePlan`, or an exact `return false;` body) can be satisfied by *upstream* code that happens
 * to look similar — and a rule that is wrongly reported as "already applied" is skipped in silence,
 * so the build would ship an extension without that change. The marker makes "this rule really ran"
 * a fact rather than an inference.
 *
 * Keep the semantics identical to the historical `patches/*.patch` set:
 *   1. the Commit Graph's "account access required" gate always reports "no account needed",
 *   2. the computed subscription state is always `Paid`,
 *   3. the offline / signed-out Community subscription becomes a verified Enterprise account,
 *   4. what a GitLens (check-in) response yields is always an Enterprise plan.
 */

import {
	applyEdits,
	buildCodeMask,
	findCalls,
	findFunction,
	findObjectProperty,
	findTopLevelReturns,
	matchBalanced,
} from './codemod.mjs';

const SUBSCRIPTION_UTILS = 'src/plus/gk/utils/subscription.utils.ts';
const CHECKIN_UTILS = 'src/plus/gk/utils/checkin.utils.ts';

/** The injected account, mirroring the identifiers used by the historical patch. */
const INJECTED_ACCOUNT = {
	id: 'voyager-enterprise',
	name: 'Voyager',
	email: 'voyager@gitlens.dev',
	createdOn: '2020-01-01T00:00:00.000Z',
};

/** The plan id every subscription is forced to. */
const FORCED_PLAN_ID = 'enterprise';

/** The plan id upstream uses for its own fallback plan, whose `getSubscriptionPlan(...)` call we clone. */
const UPSTREAM_FALLBACK_PLAN_ID = 'community-with-account';

/** The plan id of the Community plan `getCommunitySubscription()` builds, whose call shape we clone. */
const UPSTREAM_COMMUNITY_PLAN_ID = 'community';

/**
 * The marker every rule stamps into the function it rewrites. `isApplied()` looks for this and
 * nothing else, so a rewrite can never be mistaken for one that already ran.
 */
const MARKER_PREFIX = '// local-change:';

export const markerFor = ruleId => `${MARKER_PREFIX}${ruleId}`;

/** Renames a parameter to the `_`-prefixed form, which is how the codebase marks intentionally-unused ones. */
function unusedParamEdit(fn) {
	const param = fn.params[0];
	if (param == null) throw new Error(`function ${fn.name}() no longer takes a parameter`);
	if (param.name.startsWith('_')) return [];

	return [{ start: param.start, end: param.end, text: `_${param.name}`, source: `${fn.name}() parameter` }];
}

function firstParamName(fn) {
	const param = fn.params[0];
	if (param == null) throw new Error(`function ${fn.name}() no longer takes a parameter`);
	return param.name;
}

/** The leading whitespace of the line `index` sits on. */
function indentOf(src, index) {
	const lineStart = src.lastIndexOf('\n', index) + 1;
	return /^[ \t]*/.exec(src.slice(lineStart, index))[0];
}

/**
 * Shifts the continuation lines of a cloned expression from the indentation it had upstream to the
 * indentation it has in its new home, so the codemod's output is already formatter-clean.
 */
function reindentTo(text, fromIndent, toIndent) {
	if (fromIndent === toIndent) return text;

	return text
		.split('\n')
		.map((line, index) => (index === 0 || !line.startsWith(fromIndent) ? line : toIndent + line.slice(fromIndent.length)))
		.join('\n');
}

/**
 * The first `getSubscriptionPlan(<planId>, ...)` call inside `[from, to)`, cloned verbatim.
 *
 * Cloning upstream's own call instead of hand-writing the argument list means the plan arguments, the
 * opt-in-date expression and the identifiers they read all follow upstream automatically — only the
 * plan id we want is spelled out here. Upstream may legitimately have several such calls (the original
 * and its `effective` twin); the first one is the shape to clone, and a missing anchor stays loud.
 */
function clonePlanCall(src, mask, from, to, planId, consumer) {
	const matches = findCalls(src, mask, from, to, 'getSubscriptionPlan').filter(({ start, end }) =>
		new RegExp(`^\\s*getSubscriptionPlan\\s*\\(\\s*'${planId}'\\s*,`).test(src.slice(start, end + 1)),
	);

	if (matches.length === 0) {
		throw new Error(
			`found no getSubscriptionPlan('${planId}', ...) call to clone inside ${consumer}. ` +
				`Upstream most likely restructured that fallback — pick another expression to clone, or rewrite the rule by hand.`,
		);
	}

	const { start, end } = matches[0];
	return {
		call: src.slice(start, end + 1).replace(`'${planId}'`, `'${FORCED_PLAN_ID}'`),
		indent: indentOf(src, start),
	};
}

/** The object literal a `return` statement hands back, i.e. the index of its opening `{`. */
function returnedObjectStart(src, mask, returnIndex, limit) {
	for (let i = returnIndex + 'return'.length; i < limit; i++) {
		if (mask[i] !== 1) continue;
		if (src[i] === '{') return i;
		if (src[i] === ';') break;
	}
	return -1;
}

export const rules = [
	{
		id: 'account-access-not-required',
		file: SUBSCRIPTION_UTILS,
		title: 'isAccountAccessRequired() always returns false (Commit Graph sign-in gate removed)',
		isApplied(src) {
			const mask = buildCodeMask(src);
			return findFunction(src, mask, 'isAccountAccessRequired').body.includes(markerFor('account-access-not-required'));
		},
		apply(src) {
			const mask = buildCodeMask(src);
			const fn = findFunction(src, mask, 'isAccountAccessRequired');

			return {
				src: applyEdits(src, [
					{
						start: fn.bodyStart + 1,
						end: fn.bodyEnd,
						text: `\n\treturn false; ${markerFor('account-access-not-required')}\n`,
						source: `${fn.name}() body`,
					},
					...unusedParamEdit(fn),
				]),
				notes: [`line ${fn.line}: isAccountAccessRequired() -> return false`],
			};
		},
	},
	{
		id: 'subscription-state-paid',
		file: SUBSCRIPTION_UTILS,
		title: 'computeSubscriptionState() always reports SubscriptionState.Paid',
		isApplied(src) {
			const mask = buildCodeMask(src);
			return findFunction(src, mask, 'computeSubscriptionState').body.includes(markerFor('subscription-state-paid'));
		},
		apply(src) {
			const mask = buildCodeMask(src);
			const fn = findFunction(src, mask, 'computeSubscriptionState');

			return {
				src: applyEdits(src, [
					{
						start: fn.bodyStart + 1,
						end: fn.bodyEnd,
						text: `\n\treturn SubscriptionState.Paid; ${markerFor('subscription-state-paid')}\n`,
						source: `${fn.name}() body`,
					},
					...unusedParamEdit(fn),
				]),
				notes: [`line ${fn.line}: computeSubscriptionState() -> SubscriptionState.Paid`],
			};
		},
	},
	{
		id: 'community-subscription-is-enterprise',
		file: SUBSCRIPTION_UTILS,
		title: 'getCommunitySubscription() returns a verified Enterprise account instead of a Community plan',
		isApplied(src) {
			const mask = buildCodeMask(src);
			return findFunction(src, mask, 'getCommunitySubscription').body.includes(
				markerFor('community-subscription-is-enterprise'),
			);
		},
		apply(src) {
			const mask = buildCodeMask(src);
			const fn = findFunction(src, mask, 'getCommunitySubscription');
			const param = firstParamName(fn);

			// Clone upstream's own `getSubscriptionPlan('community', ...)` call: its plan arguments, the
			// opt-in-date expression and the parameter name all follow whatever upstream currently writes,
			// so only the semantics we want to change (paid instead of free) is spelled out here.
			const community = clonePlanCall(src, mask, fn.bodyStart, fn.bodyEnd, UPSTREAM_COMMUNITY_PLAN_ID, fn.name);
			const plan = reindentTo(community.call, community.indent, '\t\t\t');

			const body = `
	${markerFor('community-subscription-is-enterprise')}
	return {
		...${param},
		plan: {
			actual: ${plan},
			effective: ${plan},
		},
		account: ${param}?.account ?? {
			id: '${INJECTED_ACCOUNT.id}',
			name: '${INJECTED_ACCOUNT.name}',
			email: '${INJECTED_ACCOUNT.email}',
			verified: true,
			createdOn: '${INJECTED_ACCOUNT.createdOn}',
		},
		activeOrganization: undefined,
		state: SubscriptionState.Paid,
	};
`;

			return {
				src: applyEdits(src, [
					{ start: fn.bodyStart + 1, end: fn.bodyEnd, text: body, source: `${fn.name}() body` },
				]),
				notes: [`line ${fn.line}: getCommunitySubscription() -> enterprise plan + verified account`],
			};
		},
	},
	{
		id: 'checkin-subscription-is-enterprise',
		file: CHECKIN_UTILS,
		title: 'getSubscriptionFromCheckIn() always resolves to an Enterprise plan',
		isApplied(src) {
			const mask = buildCodeMask(src);
			return findFunction(src, mask, 'getSubscriptionFromCheckIn').body.includes(
				markerFor('checkin-subscription-is-enterprise'),
			);
		},
		apply(src) {
			const mask = buildCodeMask(src);
			const fn = findFunction(src, mask, 'getSubscriptionFromCheckIn');

			const returns = findTopLevelReturns(src, mask, fn.bodyStart, fn.bodyEnd);
			if (returns.length === 0) {
				throw new Error(`${fn.name}() has no top-level return statement to override`);
			}
			const lastReturn = returns[returns.length - 1];

			// Rewrite the `plan` property of the object the final return hands back. Only a top-level key of
			// that object counts — a nested `plan: { ... }` somewhere inside a value is a different thing, and
			// rewriting it would leave the real plan untouched while every check still passed.
			const objectStart = returnedObjectStart(src, mask, lastReturn, fn.bodyEnd);
			if (objectStart === -1) {
				throw new Error(`the final return of ${fn.name}() no longer hands back an object literal to rewrite`);
			}
			const objectEnd = matchBalanced(src, mask, objectStart, '{', '}');
			if (objectEnd === -1 || objectEnd > fn.bodyEnd) {
				throw new Error(`could not find the end of the object ${fn.name}()'s final return hands back`);
			}

			const plan = findObjectProperty(src, mask, objectStart, objectEnd, 'plan');
			if (plan == null) {
				throw new Error(`could not find a top-level \`plan\` property in the object ${fn.name}()'s final return hands back`);
			}

			const planBlock = src.slice(plan.valueStart, plan.valueEnd);
			if (!/\bactual\b/.test(planBlock) || !/\beffective\b/.test(planBlock)) {
				throw new Error(`${fn.name}()'s final return no longer hands back an \`actual\`/\`effective\` plan`);
			}

			// Clone upstream's own fallback plan so the plan id, args and opt-in date stay in sync with
			// whatever upstream's `GKCheckInResponse` shape currently is.
			const fallback = clonePlanCall(
				src,
				mask,
				fn.bodyStart,
				fn.bodyEnd,
				UPSTREAM_FALLBACK_PLAN_ID,
				`${fn.name}()`,
			);

			const indent = indentOf(src, plan.keyStart);
			const call = reindentTo(fallback.call, fallback.indent, `${indent}\t`);
			const replacement =
				`{\n${indent}\t${markerFor('checkin-subscription-is-enterprise')}\n` +
				`${indent}\tactual: ${call},\n${indent}\teffective: ${call},\n${indent}}`;

			return {
				src: applyEdits(src, [
					{ start: plan.valueStart, end: plan.valueEnd, text: replacement, source: `${fn.name}() plan property` },
				]),
				notes: [`line ${fn.line}: ${fn.name}() plan -> ${FORCED_PLAN_ID} (cloned from upstream's own ${UPSTREAM_FALLBACK_PLAN_ID} fallback)`],
			};
		},
	},
];

export const touchedFiles = [...new Set(rules.map(rule => rule.file))];
