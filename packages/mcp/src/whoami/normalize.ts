import {
	hfWhoamiOutputSchema,
	type HfWhoamiCredential,
	type HfWhoamiOrganizationMembership,
	type HfWhoamiOutput,
} from './output-schema.js';
import type { HfWhoamiResponse } from './response-schema.js';
import { getGrantedOAuthScopes } from './oauth-scopes.js';

type PersonalAccessTokenCredential = Extract<HfWhoamiCredential, { type: 'personal_access_token' }>;
type FineGrainedPermissions = NonNullable<PersonalAccessTokenCredential['permissions']>;
type AppTokenCredential = Extract<HfWhoamiCredential, { type: 'app_token' }>;
type AppEntity = AppTokenCredential['entities'][number];

export const AUTHENTICATION_UNVERIFIED_GUIDANCE =
	'A Hugging Face credential was supplied, but its status could not be verified. Retry shortly.';

const FINE_GRAINED_ENTITY_TYPES = new Set([
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
const APP_ENTITY_TYPES = new Set(['model', 'dataset', 'space', 'bucket', 'kernel', 'org']);

type RawFineGrainedEntityType =
	'model' | 'dataset' | 'space' | 'bucket' | 'kernel' | 'collection' | 'org' | 'user' | 'resource-group' | 'oauth-app';
type AppEntityType = NonNullable<AppEntity['type']>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function optionalString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
	const value = record?.[key];
	return typeof value === 'boolean' ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function isRawFineGrainedEntityType(value: string | undefined): value is RawFineGrainedEntityType {
	return value !== undefined && FINE_GRAINED_ENTITY_TYPES.has(value);
}

function normalizeFineGrainedEntityType(
	type: RawFineGrainedEntityType
): FineGrainedPermissions['scoped'][number]['entity']['type'] {
	switch (type) {
		case 'resource-group':
			return 'resource_group';
		case 'oauth-app':
			return 'oauth_app';
		default:
			return type;
	}
}

function isAppEntityType(value: string | undefined): value is AppEntityType {
	return value !== undefined && APP_ENTITY_TYPES.has(value);
}

function organizationFromWhoami(value: unknown): HfWhoamiOrganizationMembership | undefined {
	const org = asRecord(value);
	const id = optionalString(org, 'id');
	const name = optionalString(org, 'name');
	if (!id || !name) {
		return undefined;
	}

	const role = optionalString(org, 'roleInOrg');
	const rawRestrictions = org?.securityRestrictions;
	const securityRestrictions = Array.isArray(rawRestrictions)
		? rawRestrictions.filter((value): value is string => typeof value === 'string' && value.length > 0)
		: undefined;
	const rawResourceGroups = org?.resourceGroups;
	const resourceGroups = Array.isArray(rawResourceGroups)
		? rawResourceGroups.flatMap((value) => {
				const group = asRecord(value);
				const groupId = optionalString(group, 'id');
				const groupName = optionalString(group, 'name');
				const groupRole = optionalString(group, 'role');
				if (!groupId || !groupName || !groupRole) {
					return [];
				}
				return [{ id: groupId, name: groupName, role: groupRole }];
			})
		: undefined;
	const plan = optionalString(org, 'plan');

	return {
		id,
		name,
		display_name: optionalString(org, 'fullname') ?? name,
		url: `https://huggingface.co/${encodeURIComponent(name)}`,
		...(role ? { role } : {}),
		...(plan ? { plan } : {}),
		...(securityRestrictions?.length ? { security_restrictions: securityRestrictions } : {}),
		...(resourceGroups?.length ? { resource_groups: resourceGroups } : {}),
	};
}

function normalizeTimestamp(value: unknown): string | undefined {
	if (value instanceof Date && !Number.isNaN(value.valueOf())) {
		return value.toISOString();
	}
	if (typeof value === 'string' && value.length > 0) {
		const date = new Date(value);
		return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
	}
	return undefined;
}

function buildFineGrainedPermissions(value: unknown): FineGrainedPermissions | undefined {
	const fineGrained = asRecord(value);
	const globalPermissions = stringArray(fineGrained?.global);
	const canReadGatedRepos = optionalBoolean(fineGrained, 'canReadGatedRepos');
	if (!fineGrained || !Array.isArray(fineGrained.scoped)) {
		return undefined;
	}

	const scoped = fineGrained.scoped.flatMap((value) => {
		const scope = asRecord(value);
		const entity = asRecord(scope?.entity);
		const id = optionalString(entity, '_id');
		const rawType = optionalString(entity, 'type');
		const permissions = stringArray(scope?.permissions);
		if (!id || !isRawFineGrainedEntityType(rawType) || !permissions) {
			return [];
		}

		const name = optionalString(entity, 'name');
		const rawPatterns = scope?.patterns;
		const restrictions = Array.isArray(rawPatterns)
			? rawPatterns.flatMap((value) => {
					const pattern = asRecord(value);
					const resourceType = optionalString(pattern, 'resourceType');
					const wildcardPatterns = stringArray(pattern?.wildcardPatterns);
					if (resourceType !== 'inference-endpoint' || !wildcardPatterns?.length) {
						return [];
					}
					return [{ resource_type: 'inference_endpoint' as const, patterns: wildcardPatterns }];
				})
			: undefined;

		return [
			{
				entity: {
					id,
					type: normalizeFineGrainedEntityType(rawType),
					...(name ? { name } : {}),
				},
				permissions,
				...(restrictions?.length ? { restrictions } : {}),
			},
		];
	});

	return {
		scoped,
		...(globalPermissions !== undefined ? { global: globalPermissions } : {}),
		...(canReadGatedRepos !== undefined ? { can_read_gated_repos: canReadGatedRepos } : {}),
	};
}

function buildAppCredentialFields(value: unknown): Pick<AppTokenCredential, 'role' | 'entities'> {
	const scope = asRecord(value);
	const role = optionalString(scope, 'role');
	const entities = Array.isArray(scope?.entities)
		? scope.entities.flatMap((value): AppEntity[] => {
				if (typeof value === 'string' && value.length > 0) {
					return [{ name: value }];
				}
				const entity = asRecord(value);
				const type = optionalString(entity, 'type');
				const name = optionalString(entity, 'name');
				if (!isAppEntityType(type) || !name) {
					return [];
				}
				return [{ type, name }];
			})
		: [];

	return {
		...(role ? { role } : {}),
		entities,
	};
}

function buildCredential(
	userDetails: HfWhoamiResponse,
	hfToken: string | undefined,
	details: Record<string, unknown>
): HfWhoamiCredential {
	const auth = asRecord(details.auth);
	const authenticationType = optionalString(auth, 'type') ?? 'unknown';
	const accessToken = asRecord(auth?.accessToken);
	const rawRole = optionalString(accessToken, 'role');

	if (
		authenticationType === 'access_token' &&
		accessToken &&
		(rawRole === 'read' || rawRole === 'write' || rawRole === 'fineGrained')
	) {
		const role = rawRole === 'fineGrained' ? 'fine_grained' : rawRole;
		const createdAt = normalizeTimestamp(accessToken.createdAt);
		const permissions = rawRole === 'fineGrained' ? buildFineGrainedPermissions(accessToken.fineGrained) : undefined;
		return {
			type: 'personal_access_token',
			role,
			...(createdAt ? { created_at: createdAt } : {}),
			...(permissions ? { permissions } : {}),
		};
	}

	if (authenticationType === 'oauth') {
		const grantedScopes = getGrantedOAuthScopes(hfToken);
		const expiresAt = normalizeTimestamp(auth?.expiresAt);
		return {
			type: 'oauth',
			...(expiresAt ? { expires_at: expiresAt } : {}),
			...(grantedScopes.status === 'available' && grantedScopes.scopes !== null
				? { scopes: grantedScopes.scopes }
				: {}),
		};
	}

	if (userDetails.type === 'app') {
		return {
			type: 'app_token',
			...buildAppCredentialFields(details.scope),
		};
	}

	const expiresAt = normalizeTimestamp(auth?.expiresAt);
	return {
		type: 'other',
		...(expiresAt ? { expires_at: expiresAt } : {}),
	};
}

export function createHfWhoamiOutput(
	userDetails: HfWhoamiResponse | undefined,
	hfToken: string | undefined,
	anonymousGuidance: string
): HfWhoamiOutput {
	if (!userDetails) {
		const credentialWasSupplied = hfToken !== undefined;
		return hfWhoamiOutputSchema.parse({
			status: credentialWasSupplied ? 'authentication_unverified' : 'anonymous',
			account: null,
			organizations: [],
			credential: null,
			guidance: credentialWasSupplied ? AUTHENTICATION_UNVERIFIED_GUIDANCE : anonymousGuidance,
		});
	}

	const details = asRecord(userDetails) ?? {};
	const rawOrganizations = userDetails.type === 'user' ? userDetails.orgs : [];
	const organizations = rawOrganizations.flatMap((org) => {
		const organization = organizationFromWhoami(org);
		return organization ? [organization] : [];
	});
	const accountType = userDetails.type;
	const isPro = optionalBoolean(details, 'isPro');

	return hfWhoamiOutputSchema.parse({
		status: 'authenticated',
		account: {
			id: userDetails.id,
			type: accountType,
			name: userDetails.name,
			...(accountType === 'user' || accountType === 'org'
				? { url: `https://huggingface.co/${encodeURIComponent(userDetails.name)}` }
				: {}),
			...(isPro !== undefined ? { is_pro: isPro } : {}),
		},
		organizations,
		credential: buildCredential(userDetails, hfToken, details),
	});
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_[\]<>]/g, '\\$&');
}

function escapeInlineCode(value: string): string {
	return value.replace(/[`\\]/g, '\\$&');
}

function entityTypeLabel(type: string): string {
	return type
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function formatCredential(credential: HfWhoamiCredential): string[] {
	const lines = ['## Current credential', ''];

	switch (credential.type) {
		case 'personal_access_token': {
			lines.push('- **Type:** personal access token', `- **Role:** \`${credential.role}\``);
			if (credential.created_at) {
				lines.push(`- **Created:** ${credential.created_at}`);
			}

			if (credential.role !== 'fine_grained') {
				lines.push(
					'',
					'The Hub reports this token’s role but does not provide an expanded permission list for ordinary read/write tokens.'
				);
				return lines;
			}

			const permissions = credential.permissions;
			if (!permissions) {
				lines.push('', 'Fine-grained permission details were not returned by the Hub.');
				return lines;
			}

			if (permissions.can_read_gated_repos !== undefined) {
				lines.push(
					`- **Can read accessible public gated repositories:** ${permissions.can_read_gated_repos ? 'yes' : 'no'}`
				);
			}
			lines.push('', '### Scoped permissions', '');
			if (permissions.scoped.length === 0) {
				lines.push('None.');
			} else {
				for (const scope of permissions.scoped) {
					const entityName = scope.entity.name ? `: \`${escapeInlineCode(scope.entity.name)}\`` : '';
					lines.push(`#### ${entityTypeLabel(scope.entity.type)}${entityName}`, '');
					lines.push(`- **Entity ID:** \`${escapeInlineCode(scope.entity.id)}\``);
					if (!scope.entity.name) {
						lines.push('- **Name:** unavailable');
					}
					lines.push('- **Permissions:**');
					if (scope.permissions.length === 0) {
						lines.push('  - None');
					} else {
						lines.push(...scope.permissions.map((permission) => `  - \`${escapeInlineCode(permission)}\``));
					}
					if (scope.restrictions?.length) {
						lines.push('- **Resource name restrictions:**');
						for (const restriction of scope.restrictions) {
							lines.push(
								`  - **${entityTypeLabel(restriction.resource_type)}:** ${restriction.patterns
									.map((pattern) => `\`${escapeInlineCode(pattern)}\``)
									.join(', ')}`
							);
						}
					}
					lines.push('');
				}
			}

			lines.push('### Global permissions', '');
			if (permissions.global === undefined) {
				lines.push('Unavailable: global permission details were not returned by the Hub.');
			} else if (permissions.global.length === 0) {
				lines.push('None.');
			} else {
				lines.push(...permissions.global.map((permission) => `- \`${escapeInlineCode(permission)}\``));
			}
			return lines;
		}

		case 'oauth':
			lines.push('- **Type:** OAuth access token');
			if (credential.expires_at) {
				lines.push(`- **Expires:** ${credential.expires_at}`);
			}
			lines.push('', '### Granted OAuth scopes', '');
			if (credential.scopes === undefined) {
				lines.push('Unavailable: the authenticated OAuth token’s scope claim could not be read.');
			} else if (credential.scopes.length > 0) {
				lines.push(...credential.scopes.map((scope) => `- \`${escapeInlineCode(scope)}\``));
			} else {
				lines.push('This OAuth token has no explicit scopes.');
			}
			return lines;

		case 'app_token':
			lines.push('- **Type:** application token');
			if (credential.role) {
				lines.push(`- **Role:** \`${escapeInlineCode(credential.role)}\``);
			}
			lines.push('', '### Scoped entities', '');
			if (credential.entities.length === 0) {
				lines.push('None.');
			} else {
				lines.push(
					...credential.entities.map(
						(entity) =>
							`- **${entity.type ? entityTypeLabel(entity.type) : 'Entity'}:** \`${escapeInlineCode(entity.name)}\``
					)
				);
			}
			return lines;

		case 'other':
			lines.push('- **Type:** other authenticated credential');
			if (credential.expires_at) {
				lines.push(`- **Expires:** ${credential.expires_at}`);
			}
			return lines;
	}
}

function formatOrganizations(organizations: HfWhoamiOrganizationMembership[]): string[] {
	const lines = ['## Organization memberships', ''];
	if (organizations.length === 0) {
		lines.push('No organization memberships are visible to the current authentication method.');
		return lines;
	}

	for (const organization of organizations) {
		lines.push(`### [${escapeMarkdown(organization.display_name)}](${organization.url})`, '');
		lines.push(
			`- **Organization name:** \`${escapeInlineCode(organization.name)}\``,
			`- **Organization ID:** \`${escapeInlineCode(organization.id)}\``
		);
		if (organization.role) {
			lines.push(`- **Role:** \`${escapeInlineCode(organization.role)}\``);
		}
		if (organization.plan) {
			lines.push(`- **Plan:** \`${escapeInlineCode(organization.plan)}\``);
		}
		if (organization.security_restrictions?.length) {
			lines.push(
				'- **Current access restrictions:**',
				...organization.security_restrictions.map((restriction) => `  - \`${escapeInlineCode(restriction)}\``)
			);
		}
		if (organization.resource_groups?.length) {
			lines.push('', '#### Resource groups', '');
			for (const group of organization.resource_groups) {
				lines.push(
					`- **${escapeMarkdown(group.name)}**`,
					`  - ID: \`${escapeInlineCode(group.id)}\``,
					`  - Role: \`${escapeInlineCode(group.role)}\``
				);
			}
		}
		lines.push('');
	}
	return lines;
}

export function formatHfWhoamiMarkdown(result: HfWhoamiOutput): string {
	const lines = ['# Hugging Face authentication', ''];

	if (result.status === 'anonymous') {
		lines.push(
			'The Hugging Face tools are being used anonymously and may be rate limited.',
			'',
			result.guidance ?? 'Configure Hugging Face authentication to access authenticated features.'
		);
		return lines.join('\n').trim();
	}

	if (result.status === 'authentication_unverified') {
		lines.push(
			'A Hugging Face credential was supplied, but its authentication status could not be verified.',
			'',
			result.guidance
		);
		return lines.join('\n').trim();
	}

	if (!result.account || !result.credential) {
		throw new Error('Authenticated hf_whoami output is missing an account or credential.');
	}

	const accountName = escapeInlineCode(result.account.name);
	lines.push(
		result.account.url
			? `Authenticated as [@${escapeMarkdown(result.account.name)}](${result.account.url}) (\`${accountName}\`).`
			: `Authenticated as \`${accountName}\`.`,
		'',
		`- **Account ID:** \`${escapeInlineCode(result.account.id)}\``,
		`- **Account type:** \`${result.account.type}\``
	);
	if (result.account.is_pro !== undefined) {
		lines.push(`- **Pro account:** ${result.account.is_pro ? 'yes' : 'no'}`);
	}

	lines.push('', ...formatCredential(result.credential), '', ...formatOrganizations(result.organizations));
	return lines.join('\n').trim();
}
