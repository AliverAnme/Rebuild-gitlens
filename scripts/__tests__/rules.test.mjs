/**
 * Regression tests for the rules themselves.
 *
 * Two failure modes matter here, and both are silent in a real build:
 *   1. a rule that reports "already applied" because *upstream* code happens to look like its output,
 *      which skips the rewrite while every check still passes;
 *   2. a rule that rewrites the wrong span — a nested `plan` property instead of the returned one, or
 *      a type annotation instead of a body.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCodeMask, findFunction, findObjectProperty, findTopLevelReturns, matchBalanced } from '../lib/codemod.mjs';
import { markerFor, rules, touchedFiles } from '../lib/rules.mjs';
import { CHECKIN_UTILS, SUBSCRIPTION_UTILS, checkinUtils, subscriptionUtils } from './fixtures/upstreamSources.mjs';

const ruleFor = id => {
	const rule = rules.find(candidate => candidate.id === id);
	assert.notEqual(rule, undefined, `no rule named ${id}`);
	return rule;
};

const fixtureFor = file => (file === CHECKIN_UTILS ? checkinUtils : subscriptionUtils);

/** Applies every rule to a fresh copy of the fixture sources, the way the CLI does. */
const applyAll = (sources = { [SUBSCRIPTION_UTILS]: subscriptionUtils, [CHECKIN_UTILS]: checkinUtils }) => {
	const result = { ...sources };
	for (const rule of rules) {
		const source = result[rule.file];
		if (source == null || rule.isApplied(source)) continue;
		result[rule.file] = rule.apply(source).src;
	}
	return result;
};

/** The `plan` property of the object the final `return` of `name()` hands back. */
const returnedPlan = (source, name) => {
	const mask = buildCodeMask(source);
	const fn = findFunction(source, mask, name);
	const returns = findTopLevelReturns(source, mask, fn.bodyStart, fn.bodyEnd);
	assert.ok(returns.length > 0, `${name}() should still have a top-level return`);

	const objectStart = source.indexOf('{', returns[returns.length - 1]);
	const objectEnd = matchBalanced(source, mask, objectStart, '{', '}');
	const plan = findObjectProperty(source, mask, objectStart, objectEnd, 'plan');
	assert.notEqual(plan, undefined, `${name}() should hand back a top-level plan property`);

	return source.slice(plan.valueStart, plan.valueEnd);
};

test('the registry is well formed', () => {
	assert.ok(rules.length > 0, 'a pipeline with no rules would report success without changing anything');
	assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length, 'rule ids must be unique');
	assert.deepEqual(touchedFiles, [...new Set(rules.map(rule => rule.file))]);
});

test('every rule stamps its own marker into the text it rewrites', () => {
	const applied = applyAll();

	for (const rule of rules) {
		assert.ok(
			applied[rule.file].includes(markerFor(rule.id)),
			`${rule.id} did not leave its marker behind, so isApplied() could never prove it ran`,
		);
		assert.equal(rule.isApplied(applied[rule.file]), true, `${rule.id} should recognise its own output`);
	}
});

test('no rule mistakes fresh upstream code for its own output', () => {
	for (const rule of rules) {
		assert.equal(rule.isApplied(fixtureFor(rule.file)), false, `${rule.id} must not claim upstream code as its own`);
	}
});

test('isApplied ignores upstream code that merely resembles an earlier marker', () => {
	// This is the regression that matters: matching a substring such as `enterprisePlan` made the rule
	// declare itself applied whenever upstream happened to contain that name, and the build then shipped
	// without the rewrite. Only our own marker comment may satisfy isApplied().
	const rule = ruleFor('checkin-subscription-is-enterprise');
	const variants = [
		checkinUtils.replace('export function ', '// enterprisePlan handling is upstream business\nexport function '),
		checkinUtils.replace('\tlet actual:', "\tconst enterprisePlan = getSubscriptionPlan('enterprise');\n\tlet actual:"),
		checkinUtils.replace('export function ', '// local-change-typo:checkin-subscription-is-enterprise\nexport function '),
	];

	for (const variant of variants) {
		assert.equal(rule.isApplied(variant), false, 'a lookalike must not satisfy isApplied()');
		assert.ok(rule.apply(variant).src.includes(markerFor(rule.id)), 'the rule still has to be applicable');
	}
});

test('the check-in rule rewrites the returned plan, not a nested lookalike', () => {
	const source = checkinUtils.replace(
		'\treturn {\n\t\tplan: {',
		"\treturn {\n\t\tmeta: { plan: { actual: 'decoy', effective: 'decoy' } },\n\t\tplan: {",
	);
	const applied = ruleFor('checkin-subscription-is-enterprise').apply(source).src;

	assert.ok(applied.includes("meta: { plan: { actual: 'decoy', effective: 'decoy' } }"), 'the nested plan is untouched');

	const plan = returnedPlan(applied, 'getSubscriptionFromCheckIn');
	assert.ok(plan.includes(markerFor('checkin-subscription-is-enterprise')));
	assert.equal(plan.includes('community-with-account'), false, 'the returned plan is no longer the free fallback');
	assert.equal(plan.match(/'enterprise'/g).length, 2, 'both actual and effective use the forced plan');
	assert.ok(plan.includes('data.nextOptInDate'), 'the cloned call still carries upstream’s own arguments');
});

test('the check-in rule survives a final return that is not at the start of its line', () => {
	// `} else return {` used to break the old implementation, which inserted a declaration at the start of
	// the returned statement's line and produced an orphaned `else`.
	const source = `export function getSubscriptionFromCheckIn(data: GKCheckInResponse): Subscription {
	let actual: SubscriptionPlan | undefined;
	actual ??= getSubscriptionPlan('community-with-account', false, 0, undefined, undefined, undefined, data.nextOptInDate);

	if (flag) {
		return early;
	} else return {
		plan: {
			actual: actual,
			effective: actual,
		},
	};
}
`;
	const applied = ruleFor('checkin-subscription-is-enterprise').apply(source).src;

	assert.ok(applied.includes('} else return {'), 'the surrounding statement stays intact');
	assert.equal(/const enterprisePlan\b/.test(applied), false, 'no declaration is inserted any more');
	assert.ok(returnedPlan(applied, 'getSubscriptionFromCheckIn').includes(markerFor('checkin-subscription-is-enterprise')));
});

test('the check-in rule reports anchors it cannot clone', () => {
	assert.throws(
		() => ruleFor('checkin-subscription-is-enterprise').apply(checkinUtils.replace("'community-with-account'", "'community'")),
		/found no getSubscriptionPlan\('community-with-account'/,
	);
	assert.throws(
		() =>
			ruleFor('checkin-subscription-is-enterprise').apply(
				checkinUtils.replace(/\t\tplan: \{[\s\S]*?\t\t\},/, '\t\tmeta: undefined,'),
			),
		/top-level `plan` property/,
	);
});

test('the community rule clones upstream’s own call instead of hard-coding its arguments', () => {
	const widened = subscriptionUtils.replace(
		"\t\t\tactual: getSubscriptionPlan(\n\t\t\t\t'community',",
		"\t\t\tactual: getSubscriptionPlan(\n\t\t\t\t'community',\n\t\t\t\t/* new upstream argument */ true,",
	);
	const applied = ruleFor('community-subscription-is-enterprise').apply(widened).src;

	assert.ok(applied.includes('/* new upstream argument */ true'), 'the cloned call carries upstream’s own arguments');

	const plan = returnedPlan(applied, 'getCommunitySubscription');
	assert.equal(plan.match(/'community'/g), null, 'the free plan is gone');
	assert.equal(plan.match(/'enterprise'/g).length, 2, 'both plans are forced to enterprise');
	assert.ok(plan.includes('subscription?.plan?.actual?.startedOn'), 'the opt-in date expression follows upstream');
});

test('the community rule reports a missing clone anchor', () => {
	assert.throws(
		() =>
			ruleFor('community-subscription-is-enterprise').apply(
				subscriptionUtils.replace(/'community'/g, "'community-with-account'"),
			),
		/found no getSubscriptionPlan\('community'/,
	);
});

test('the sign-in gate and subscription state rules replace the whole body', () => {
	const applied = applyAll()[SUBSCRIPTION_UTILS];

	assert.match(
		applied,
		/export function isAccountAccessRequired\(_subscription: Subscription\): boolean \{\n\treturn false; \/\/ local-change:account-access-not-required\n\}/,
	);
	assert.match(
		applied,
		/export function computeSubscriptionState\(_subscription: Optional<Subscription, 'state'>\): SubscriptionState \{\n\treturn SubscriptionState\.Paid; \/\/ local-change:subscription-state-paid\n\}/,
	);
});
