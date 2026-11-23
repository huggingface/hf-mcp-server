import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);
const isoDateTimeSchema = z.iso.datetime();

const resourceGroupSchema = z.looseObject({
	id: nonEmptyStringSchema,
	name: nonEmptyStringSchema,
	role: nonEmptyStringSchema,
});

const organizationSchema = z.looseObject({
	id: nonEmptyStringSchema,
	type: z.literal('org'),
	name: nonEmptyStringSchema,
	fullname: nonEmptyStringSchema.optional(),
	plan: nonEmptyStringSchema.optional(),
	roleInOrg: nonEmptyStringSchema.optional(),
	securityRestrictions: z.array(nonEmptyStringSchema).optional(),
	resourceGroups: z.array(resourceGroupSchema).optional(),
});

const fineGrainedEntityTypeSchema = z.enum([
	'model',
	'dataset',
	'space',
	'bucket',
	'kernel',
	'collection',
	'org',
	'user',
	'resource-group',
	'oauth-app',
]);

const fineGrainedPatternSchema = z.looseObject({
	resourceType: z.literal('inference-endpoint'),
	wildcardPatterns: z.array(nonEmptyStringSchema).min(1),
});

const fineGrainedScopeSchema = z.looseObject({
	entity: z.looseObject({
		_id: nonEmptyStringSchema,
		type: fineGrainedEntityTypeSchema,
		name: nonEmptyStringSchema.optional(),
	}),
	permissions: z.array(nonEmptyStringSchema),
	patterns: z.array(fineGrainedPatternSchema).optional(),
});

const fineGrainedPermissionsSchema = z.looseObject({
	scoped: z.array(fineGrainedScopeSchema),
	global: z.array(nonEmptyStringSchema).optional(),
	canReadGatedRepos: z.boolean().optional(),
});

const accessTokenSchema = z.looseObject({
	displayName: z.string(),
	role: nonEmptyStringSchema,
	createdAt: isoDateTimeSchema,
	fineGrained: fineGrainedPermissionsSchema.optional(),
});

const authenticationSchema = z.looseObject({
	type: nonEmptyStringSchema,
	accessToken: accessTokenSchema.optional(),
	expiresAt: isoDateTimeSchema.optional(),
	resource: z.looseObject({ sub: nonEmptyStringSchema }).optional(),
});

const appScopeEntitySchema = z.looseObject({
	type: z.enum(['model', 'dataset', 'space', 'bucket', 'kernel', 'org']),
	name: nonEmptyStringSchema,
});

const appScopeSchema = z.looseObject({
	role: nonEmptyStringSchema,
	entities: z.array(z.union([appScopeEntitySchema, nonEmptyStringSchema])),
});

const userResponseSchema = z.looseObject({
	id: nonEmptyStringSchema,
	type: z.literal('user'),
	name: nonEmptyStringSchema,
	isPro: z.boolean().optional(),
	orgs: z.array(organizationSchema),
	auth: authenticationSchema,
});

const appResponseSchema = z.looseObject({
	id: nonEmptyStringSchema,
	type: z.literal('app'),
	name: nonEmptyStringSchema,
	scope: appScopeSchema.optional(),
	auth: authenticationSchema,
});

// Retain the legacy organization-principal shape accepted by the previous SDK
// type. The Hub API currently returns user or app principals from whoami-v2.
const organizationResponseSchema = z.looseObject({
	id: nonEmptyStringSchema,
	type: z.literal('org'),
	name: nonEmptyStringSchema,
	auth: authenticationSchema,
});

/**
 * Runtime contract owned by this server for the Hub API's /api/whoami-v2.
 *
 * Upstream objects are deliberately loose so additive API fields neither break
 * authentication nor become public output accidentally. The hf_whoami mapper
 * separately allowlists every field exposed through MCP.
 */
export const hfWhoamiResponseSchema = z.discriminatedUnion('type', [
	userResponseSchema,
	appResponseSchema,
	organizationResponseSchema,
]);

export type HfWhoamiResponse = z.infer<typeof hfWhoamiResponseSchema>;
export type HfWhoamiAuthentication = z.infer<typeof authenticationSchema>;
