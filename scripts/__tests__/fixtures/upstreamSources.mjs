/**
 * Miniature stand-ins for the two upstream files the rules rewrite.
 *
 * They are shaped like the real GitLens sources — same function names, same nesting, same cloned
 * anchors — but tiny, so the tests stay hermetic (no network, no upstream checkout) and can assert on
 * the exact generated text. When upstream restructures one of these functions, update the fixture
 * *and* the rule together.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SUBSCRIPTION_UTILS = 'src/plus/gk/utils/subscription.utils.ts';
export const CHECKIN_UTILS = 'src/plus/gk/utils/checkin.utils.ts';

export const subscriptionUtils = `import { SubscriptionState } from '../../../constants.subscription';

export function isAccountAccessRequired(subscription: Subscription): boolean {
	return subscription.account == null || subscription.account.verified === false;
}

export function computeSubscriptionState(subscription: Optional<Subscription, 'state'>): SubscriptionState {
	if (subscription.account?.verified === false) return SubscriptionState.VerificationRequired;

	return SubscriptionState.Community;
}

export function getSubscriptionPlan(
	id: SubscriptionPlanIds,
	bundle: boolean,
	trialReactivationCount: number,
	organizationId: string | undefined,
	startedOn: Date | undefined,
	endedOn: Date | undefined,
	cancelled: boolean,
): SubscriptionPlan {
	return { id: id, bundle: bundle, startedOn: startedOn };
}

export function getCommunitySubscription(subscription?: Subscription): Subscription {
	return {
		...subscription,
		plan: {
			actual: getSubscriptionPlan(
				'community',
				false,
				0,
				undefined,
				subscription?.plan?.actual?.startedOn != null
					? new Date(subscription.plan.actual.startedOn)
					: undefined,
			),
			effective: getSubscriptionPlan(
				'community',
				false,
				0,
				undefined,
				subscription?.plan?.actual?.startedOn != null
					? new Date(subscription.plan.actual.startedOn)
					: undefined,
			),
		},
		account: undefined,
		activeOrganization: undefined,
		state: SubscriptionState.Community,
	};
}
`;

export const checkinUtils = `export function getSubscriptionFromCheckIn(data: GKCheckInResponse): Subscription {
	let actual: SubscriptionPlan | undefined;
	actual ??= getSubscriptionPlan(
		'community-with-account',
		false,
		0,
		undefined,
		data.user.firstGitLensCheckIn != null
			? new Date(data.user.firstGitLensCheckIn)
			: data.user.createdDate != null
				? new Date(data.user.createdDate)
				: undefined,
		undefined,
		undefined,
		data.nextOptInDate,
	);

	return {
		plan: {
			actual: actual,
			effective: actual,
		},
		account: account,
		activeOrganization: activeOrganization,
	};
}
`;

export const sources = {
	[SUBSCRIPTION_UTILS]: subscriptionUtils,
	[CHECKIN_UTILS]: checkinUtils,
};

/** Writes the fixture files — and a matching package.json — into `root`. */
export function writeCheckout(root, files = sources, version = '19.4.0') {
	for (const [file, contents] of Object.entries(files)) {
		const target = join(root, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, contents);
	}
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gitlens', version: version }, null, '\t'));
}
