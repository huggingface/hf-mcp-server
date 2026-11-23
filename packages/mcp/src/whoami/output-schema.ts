import { z } from 'zod';

const optionalNonEmptyStringSchema = z.string().min(1).optional();

const accountSchema = z
	.object({
		id: z.string().min(1),
		type: z.enum(['user', 'org', 'app']),
		name: z.string().min(1),
		url: z.string().url().optional(),
		is_pro: z.boolean().optional(),
	})
	.strict();

const resourceGroupSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		role: z.string().min(1),
	})
	.strict();

const organizationMembershipSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		display_name: z.string().min(1),
		url: z.string().url(),
		role: optionalNonEmptyStringSchema,
		plan: optionalNonEmptyStringSchema,
		security_restrictions: z.array(z.string().min(1)).optional(),
		resource_groups: z.array(resourceGroupSchema).optional(),
	})
	.strict();

const fineGrainedEntityTypeSchema = z.enum([
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
]);

const fineGrainedEntitySchema = z
	.object({
		id: z.string().min(1),
		type: fineGrainedEntityTypeSchema,
		name: optionalNonEmptyStringSchema,
	})
	.strict();

const fineGrainedRestrictionSchema = z
	.object({
		resource_type: z.literal('inference_endpoint'),
		patterns: z.array(z.string().min(1)),
	})
	.strict();

const scopedPermissionSchema = z
	.object({
		entity: fineGrainedEntitySchema,
		permissions: z.array(z.string().min(1)),
		restrictions: z.array(fineGrainedRestrictionSchema).optional(),
	})
	.strict();

const fineGrainedPermissionsSchema = z
	.object({
		scoped: z.array(scopedPermissionSchema),
		global: z.array(z.string().min(1)).optional(),
		can_read_gated_repos: z.boolean().optional(),
	})
	.strict();

const personalAccessTokenCredentialSchema = z
	.object({
		type: z.literal('personal_access_token'),
		role: z.enum(['read', 'write', 'fine_grained']),
		created_at: z.iso.datetime().optional(),
		permissions: fineGrainedPermissionsSchema.optional(),
	})
	.strict()
	.superRefine((credential, context) => {
		const hasPermissions = credential.permissions !== undefined;
		if (credential.role !== 'fine_grained' && hasPermissions) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Only fine-grained personal access tokens may include permissions.',
				path: ['permissions'],
			});
		}
	});

const oauthCredentialSchema = z
	.object({
		type: z.literal('oauth'),
		expires_at: z.iso.datetime().optional(),
		scopes: z.array(z.string().min(1)).optional(),
	})
	.strict();

const appEntitySchema = z
	.object({
		type: z.enum(['model', 'dataset', 'space', 'bucket', 'kernel', 'org']).optional(),
		name: z.string().min(1),
	})
	.strict();

const appTokenCredentialSchema = z
	.object({
		type: z.literal('app_token'),
		role: optionalNonEmptyStringSchema,
		entities: z.array(appEntitySchema),
	})
	.strict();

const otherCredentialSchema = z
	.object({
		type: z.literal('other'),
		expires_at: z.iso.datetime().optional(),
	})
	.strict();

const credentialSchema = z.discriminatedUnion('type', [
	personalAccessTokenCredentialSchema,
	oauthCredentialSchema,
	appTokenCredentialSchema,
	otherCredentialSchema,
]);

/** The `authenticated` branch alone: the only shape a token-required caller (PTC hf_whoami) returns. */
export const hfWhoamiAuthenticatedOutputSchema = z
	.object({
		status: z.literal('authenticated'),
		account: accountSchema,
		organizations: z.array(organizationMembershipSchema),
		credential: credentialSchema,
	})
	.strict();

const anonymousOutputSchema = z
	.object({
		status: z.literal('anonymous'),
		account: z.null(),
		organizations: z.array(organizationMembershipSchema),
		credential: z.null(),
		guidance: z.string().min(1),
	})
	.strict();

const authenticationUnverifiedOutputSchema = z
	.object({
		status: z.literal('authentication_unverified'),
		account: z.null(),
		organizations: z.array(organizationMembershipSchema),
		credential: z.null(),
		guidance: z.string().min(1),
	})
	.strict();

export const hfWhoamiOutputSchema = z.discriminatedUnion('status', [
	hfWhoamiAuthenticatedOutputSchema,
	anonymousOutputSchema,
	authenticationUnverifiedOutputSchema,
]);

export type HfWhoamiOutput = z.infer<typeof hfWhoamiOutputSchema>;
export type HfWhoamiAuthenticatedOutput = z.infer<typeof hfWhoamiAuthenticatedOutputSchema>;
export type HfWhoamiCredential = NonNullable<HfWhoamiOutput['credential']>;
export type HfWhoamiOrganizationMembership = HfWhoamiOutput['organizations'][number];
