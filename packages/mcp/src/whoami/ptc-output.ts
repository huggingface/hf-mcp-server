/**
 * The PTC hf_whoami output: the standard tool's `authenticated` result (createHfWhoamiOutput is the
 * single normaliser) mapped field by field to the PTC camelCase convention.
 *
 * Every mapper destructures its input completely and passes the remainder to `noOtherKeys`, so a
 * field added to the standard schema fails to compile here until it is mapped. Enum values keep the
 * standard spelling (PTC enum values are snake_case too). `credential.permissions` becomes
 * `credential.fineGrained`, so `permissions` is always a list of permission strings.
 */
import { z } from 'zod';
import type {
	HfWhoamiAuthenticatedOutput,
	HfWhoamiCredential,
	HfWhoamiOrganizationMembership,
} from './output-schema.js';

const nonEmpty = z.string().min(1);

const resourceGroupSchema = z.object({ id: nonEmpty, name: nonEmpty, role: nonEmpty }).strict();

const organizationSchema = z
	.object({
		// Hub internal ObjectId, not the handle.
		id: nonEmpty,
		name: nonEmpty.describe('Organization handle: use as namespace or author.'),
		displayName: nonEmpty,
		url: z.string().url(),
		role: nonEmpty.optional(),
		plan: nonEmpty.optional(),
		securityRestrictions: z.array(nonEmpty).optional(),
		resourceGroups: z.array(resourceGroupSchema).optional(),
	})
	.strict();

const fineGrainedSchema = z
	.object({
		scoped: z.array(
			z
				.object({
					entity: z
						.object({
							id: nonEmpty,
							type: z.enum([
								'model',
								'dataset',
								'space',
								'bucket',
								'kernel',
								'collection',
								'org',
								'user',
								'resource_group',
								'oauth_app',
							]),
							name: nonEmpty.optional(),
						})
						.strict(),
					permissions: z.array(nonEmpty),
					restrictions: z
						.array(z.object({ resourceType: z.literal('inference_endpoint'), patterns: z.array(nonEmpty) }).strict())
						.optional(),
				})
				.strict()
		),
		global: z.array(nonEmpty).optional(),
		canReadGatedRepos: z.boolean().optional(),
	})
	.strict();

const credentialSchema = z.discriminatedUnion('type', [
	z
		.object({
			type: z.literal('personal_access_token'),
			role: z.enum(['read', 'write', 'fine_grained']),
			createdAt: z.iso.datetime().optional(),
			fineGrained: fineGrainedSchema.optional().describe('Only for fine_grained tokens.'),
		})
		.strict(),
	z
		.object({
			type: z.literal('oauth'),
			expiresAt: z.iso.datetime().optional(),
			scopes: z.array(nonEmpty).optional().describe('Absent when the scope claim could not be read.'),
		})
		.strict(),
	z
		.object({
			type: z.literal('app_token'),
			role: nonEmpty.optional(),
			entities: z.array(
				z
					.object({
						type: z.enum(['model', 'dataset', 'space', 'bucket', 'kernel', 'org']).optional(),
						name: nonEmpty,
					})
					.strict()
			),
		})
		.strict(),
	z.object({ type: z.literal('other'), expiresAt: z.iso.datetime().optional() }).strict(),
]);

const accountSchema = z
	.object({
		// Hub internal ObjectId, not the username.
		id: nonEmpty,
		type: z.enum(['user', 'org', 'app']),
		name: nonEmpty.describe('Username: use as namespace, author or owner.'),
		url: z.string().url().optional(),
		isPro: z.boolean().optional(),
	})
	.strict();

/**
 * One strict object for both cases. Signed in: account and credential are set, no guidance.
 * Signed out (no token, or the Hub rejected it): account and credential are null, organizations
 * is empty and guidance says what to do.
 */
export const ptcWhoamiOutputSchema = z
	.object({
		signedIn: z.boolean(),
		account: accountSchema.nullable().describe('null when signed out.'),
		organizations: z.array(organizationSchema),
		credential: credentialSchema
			.nullable()
			.describe('The current credential (type, role, scopes); never its value. null when signed out.'),
		guidance: nonEmpty.optional().describe('Only when signed out: how to sign in.'),
	})
	.strict()
	.superRefine((value, context) => {
		const consistent = value.signedIn
			? value.account !== null && value.credential !== null && value.guidance === undefined
			: value.account === null &&
				value.credential === null &&
				value.organizations.length === 0 &&
				value.guidance !== undefined;
		if (!consistent) {
			context.addIssue({ code: 'custom', message: 'signedIn does not match account, credential and guidance.' });
		}
	});

export type PtcWhoamiOutput = z.infer<typeof ptcWhoamiOutputSchema>;
type PtcCredential = NonNullable<PtcWhoamiOutput['credential']>;
type PtcOrganization = PtcWhoamiOutput['organizations'][number];
type FineGrained = NonNullable<Extract<HfWhoamiCredential, { type: 'personal_access_token' }>['permissions']>;
type PtcFineGrained = NonNullable<Extract<PtcCredential, { type: 'personal_access_token' }>['fineGrained']>;

/** Compile-time exhaustiveness: the rest of a full destructure must be empty. */
function noOtherKeys(_rest: Record<string, never>): void {}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function mapOrganization(org: HfWhoamiOrganizationMembership): PtcOrganization {
	const { id, name, display_name, url, role, plan, security_restrictions, resource_groups, ...rest } = org;
	noOtherKeys(rest);
	return {
		id,
		name,
		displayName: display_name,
		url,
		...optional('role', role),
		...optional('plan', plan),
		...optional('securityRestrictions', security_restrictions),
		...optional(
			'resourceGroups',
			resource_groups?.map((group) => {
				const { id: groupId, name: groupName, role: groupRole, ...groupRest } = group;
				noOtherKeys(groupRest);
				return { id: groupId, name: groupName, role: groupRole };
			})
		),
	};
}

function mapFineGrained(permissions: FineGrained): PtcFineGrained {
	const { scoped, global, can_read_gated_repos, ...rest } = permissions;
	noOtherKeys(rest);
	return {
		scoped: scoped.map((scope) => {
			const { entity, permissions: granted, restrictions, ...scopeRest } = scope;
			noOtherKeys(scopeRest);
			const { id, type, name, ...entityRest } = entity;
			noOtherKeys(entityRest);
			return {
				entity: { id, type, ...optional('name', name) },
				permissions: granted,
				...optional(
					'restrictions',
					restrictions?.map((restriction) => {
						const { resource_type, patterns, ...restrictionRest } = restriction;
						noOtherKeys(restrictionRest);
						return { resourceType: resource_type, patterns };
					})
				),
			};
		}),
		...optional('global', global),
		...optional('canReadGatedRepos', can_read_gated_repos),
	};
}

function mapCredential(credential: HfWhoamiCredential): PtcCredential {
	switch (credential.type) {
		case 'personal_access_token': {
			const { type, role, created_at, permissions, ...rest } = credential;
			noOtherKeys(rest);
			return {
				type,
				role,
				...optional('createdAt', created_at),
				...optional('fineGrained', permissions && mapFineGrained(permissions)),
			};
		}
		case 'oauth': {
			const { type, expires_at, scopes, ...rest } = credential;
			noOtherKeys(rest);
			return { type, ...optional('expiresAt', expires_at), ...optional('scopes', scopes) };
		}
		case 'app_token': {
			const { type, role, entities, ...rest } = credential;
			noOtherKeys(rest);
			return {
				type,
				...optional('role', role),
				entities: entities.map((entity) => {
					const { type: entityType, name, ...entityRest } = entity;
					noOtherKeys(entityRest);
					return { ...optional('type', entityType), name };
				}),
			};
		}
		case 'other': {
			const { type, expires_at, ...rest } = credential;
			noOtherKeys(rest);
			return { type, ...optional('expiresAt', expires_at) };
		}
	}
}

/** Map the standard `authenticated` hf_whoami result to the PTC camelCase record. */
export function toPtcWhoamiOutput(result: HfWhoamiAuthenticatedOutput): PtcWhoamiOutput {
	// `status` is always 'authenticated' here; it becomes signedIn.
	const { status: _status, account, organizations, credential, ...rest } = result;
	noOtherKeys(rest);
	const { id, type, name, url, is_pro, ...accountRest } = account;
	noOtherKeys(accountRest);
	return {
		signedIn: true,
		account: { id, type, name, ...optional('url', url), ...optional('isPro', is_pro) },
		organizations: organizations.map(mapOrganization),
		credential: mapCredential(credential),
	};
}

/** The signed-out record: no account, credential or organizations, plus fixed guidance. */
export function signedOutPtcWhoamiOutput(guidance: string): PtcWhoamiOutput {
	return { signedIn: false, account: null, organizations: [], credential: null, guidance };
}
