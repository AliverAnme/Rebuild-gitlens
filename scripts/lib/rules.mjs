/**
 * The local modifications this repository makes to upstream GitLens.
 *
 * Each rule is a structural rewrite of one function: it finds the function by name, replaces (or
 * extends) what that function does, and can tell whether it has already been applied. Nothing here
 * depends on line numbers or on the surrounding lines, so upstream adding, removing or reformatting
 * code next to a target no longer invalidates the change.
 *
 * Keep the semantics identical to the historical `patches/*.patch` set:
 *   1. the Commit Graph's "account access required" gate always reports "no account needed",
 *   2. the computed subscription state is always `Paid`,
 *   3. the offline / signed-out Community subscription becomes a verified Enterprise account,
 *   4. what a GitLens (check-in) response yields is always an Enterprise plan.
 */

import { applyEdits, buildCodeMask, findCalls, findFunction, findTopLevelReturns, matchBalanced } from './codemod.mjs';

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

export const rules = [
	{
		id: 'account-access-not-required',
		file: SUBSCRIPTION_UTILS,
		title: 'isAccountAccessRequired() always returns false (Commit Graph sign-in gate removed)',
		isApplied(src) {
			const mask = buildCodeMask(src);
			return findFunction(src, mask, 'isAccountAccessRequired').body.trim() === 'return false;';
		},
		apply(src) {
			const mask = buildCodeMask(src);
			const fn = findFunction(src, mask, 'isAccountAccessRequired');

			return {
				src: applyEdits(src, [
					{
						start: fn.bodyStart + 1,
						end: fn.bodyEnd,
						text: '\n\treturn false;\n',
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
			return findFunction(src, mask, 'computeSubscriptionState').body.trim() === 'return SubscriptionState.Paid;';
		},
		apply(src) {
			const mask = buildCodeMask(src);
			const fn = findFunction(src, mask, 'computeSubscriptionState');

			return {
				src: applyEdits(src, [
					{
						start: fn.bodyStart + 1,
						end: fn.bodyEnd,
						text: '\n\treturn SubscriptionState.Paid;\n',
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
			return findFunction(src, mask, 'getCommunitySubscription').body.includes(INJECTED_ACCOUNT.id);
		},
		apply(src) {
			const mask = buildCodeMask(src);
			const fn = findFunction(src, mask, 'getCommunitySubscription');

			// The injected call is positional, so the shared factory's shape is a hard prerequisite.
			const factory = findFunction(src, mask, 'getSubscriptionPlan');
			const expected = ['id', 'bundle', 'trialReactivationCount', 'organizationId', 'startedOn'];
			const actual = factory.params.slice(0, expected.length).map(param => param.name);
			if (actual.join(',') !== expected.join(',')) {
				throw new Error(
					`getSubscriptionPlan() signature changed: expected (${expected.join(', ')}, ...) but found (${factory.params
						.map(param => param.name)
						.join(', ')}). Update the community-subscription-is-enterprise rule.`,
				);
			}

			const startedOnExpr = 'subscription?.plan?.actual?.startedOn';
			const body = `
	const startedOn = ${startedOnExpr};
	const parsedStartedOn = startedOn != null ? new Date(startedOn) : undefined;

	return {
		...subscription,
		plan: {
			actual: getSubscriptionPlan('${FORCED_PLAN_ID}', false, 0, undefined, parsedStartedOn),
			effective: getSubscriptionPlan('${FORCED_PLAN_ID}', false, 0, undefined, parsedStartedOn),
		},
		account: subscription?.account ?? {
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
			return findFunction(src, mask, 'getSubscriptionFromCheckIn').body.includes('enterprisePlan');
		},
		apply(src) {
			const mask = buildCodeMask(src);
			const fn = findFunction(src, mask, 'getSubscriptionFromCheckIn');

			const returns = findTopLevelReturns(src, mask, fn.bodyStart, fn.bodyEnd);
			if (returns.length === 0) {
				throw new Error(`${fn.name}() has no top-level return statement to override`);
			}
			const lastReturn = returns[returns.length - 1];
			const tail = src.slice(lastReturn, fn.bodyEnd);

			// Rewrite the `plan` property of the final return rather than reassigning the plan locals: assigning
			// a `let` after a closure that reads it would defeat TypeScript's narrowing inside that closure.
			const planProperty = /\bplan\s*:\s*\{/.exec(tail);
			if (planProperty == null) {
				throw new Error(`could not find the \`plan\` property of ${fn.name}()'s final return statement`);
			}
			const planStart = lastReturn + planProperty.index + planProperty[0].length - 1;
			const planEnd = matchBalanced(src, mask, planStart, '{', '}');
			if (planEnd === -1 || planEnd > fn.bodyEnd) {
				throw new Error(`could not find the end of the \`plan\` property of ${fn.name}()'s final return statement`);
			}

			const planBlock = src.slice(planStart + 1, planEnd);
			if (!/\bactual\b/.test(planBlock) || !/\beffective\b/.test(planBlock)) {
				throw new Error(`${fn.name}()'s final return no longer hands back an \`actual\`/\`effective\` plan`);
			}

			const data = firstParamName(fn);

			// Clone upstream's own fallback plan so the plan ids, args and opt-in date stay in sync with
			// whatever upstream's `GKCheckInResponse` shape currently is.
			const fallback = findCalls(src, mask, fn.bodyStart, fn.bodyEnd, 'getSubscriptionPlan').filter(({ start, end }) =>
				new RegExp(`^\\s*getSubscriptionPlan\\s*\\(\\s*'${UPSTREAM_FALLBACK_PLAN_ID}'`).test(
					src.slice(start, end + 1),
				),
			);
			if (fallback.length !== 1) {
				throw new Error(
					`expected exactly one getSubscriptionPlan('${UPSTREAM_FALLBACK_PLAN_ID}', ...) call in ${fn.name}() but found ${fallback.length}`,
				);
			}

			const enterpriseCall = src
				.slice(fallback[0].start, fallback[0].end + 1)
				.replace(`'${UPSTREAM_FALLBACK_PLAN_ID}'`, `'${FORCED_PLAN_ID}'`);

			// Anchor on the start of the statement's line so the inserted block inherits the function's indentation.
			const insertAt = src.lastIndexOf('\n', lastReturn) + 1;
			const declaration = `\tconst enterprisePlan = ${enterpriseCall};\n\n`;

			return {
				src: applyEdits(src, [
					{ start: insertAt, end: insertAt, text: declaration, source: `${fn.name}() enterprise plan` },
					{
						start: planStart + 1,
						end: planEnd,
						text: ` actual: enterprisePlan, effective: enterprisePlan `,
						source: `${fn.name}() plan property`,
					},
				]),
				notes: [
					`line ${fn.line}: ${fn.name}() plan -> ${FORCED_PLAN_ID} (cloned from upstream's own ${UPSTREAM_FALLBACK_PLAN_ID} fallback, reads \`${data}\`)`,
				],
			};
		},
	},
];

export const touchedFiles = [...new Set(rules.map(rule => rule.file))];
