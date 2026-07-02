import { createRepo, type RepoType as HubRepoType, type SpaceSdk } from '@huggingface/hub';
import { z } from 'zod';
import { HfApiCall } from './hf-api-call.js';
import { type ParsedRepoHfUri, parseHfFsUri } from './hf-fs.js';
import { escapeMarkdown, NO_TOKEN_INSTRUCTIONS } from './utilities.js';

const REPO_TYPES = ['model', 'dataset', 'space', 'bucket'] as const satisfies readonly HubRepoType[];
const SPACE_SDKS = ['streamlit', 'gradio', 'docker', 'static'] as const satisfies readonly SpaceSdk[];
const CREATE_REPO_ACTIONS = ['created', 'duplicated'] as const;
const DEFAULT_HUB_URL = 'https://huggingface.co';

export const CREATE_REPO_TOOL_CONFIG = {
	name: 'hf_create_repo',
	description: '',
	schema: z.object({
		uri: z.string().min(1).describe('Destination repo URI in the form hf://models|datasets|spaces|buckets/OWNER/NAME.'),
		source_uri: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional source repo URI to duplicate, in the form hf://models|datasets|spaces/OWNER/NAME. Must use the same repo type as uri.'
			),
		private: z
			.boolean()
			.optional()
			.describe(
				'Visibility for the new repo. For duplication, omit to preserve the source visibility; set true for private or false for public.'
			),
		sdk: z.enum(SPACE_SDKS).optional().describe('Space SDK for new empty Spaces. Not used when source_uri is set.'),
	}),
	outputSchema: createCreateRepoOutputSchema(),
	annotations: {
		title: 'Create Hugging Face Repository',
		destructiveHint: false,
		readOnlyHint: false,
		openWorldHint: true,
	},
} as const;

export type CreateRepoParams = z.input<typeof CREATE_REPO_TOOL_CONFIG.schema>;
type RepoType = (typeof REPO_TYPES)[number];
type SupportedSpaceSdk = (typeof SPACE_SDKS)[number];
type CreateRepoAction = (typeof CREATE_REPO_ACTIONS)[number];

function createCreateRepoOutputSchema() {
	return z.object({
		action: z.enum(CREATE_REPO_ACTIONS),
		uri: z.string(),
		url: z.string(),
		repo: z.string(),
		repo_type: z.enum(REPO_TYPES),
		id: z.string().optional(),
		source_uri: z.string().optional(),
		source_repo: z.string().optional(),
	});
}

function assertExhaustiveUnion<T extends never>(_value?: T): void {
	void _value;
}

assertExhaustiveUnion<Exclude<HubRepoType, RepoType>>();
assertExhaustiveUnion<Exclude<RepoType, HubRepoType>>();
assertExhaustiveUnion<Exclude<SpaceSdk, SupportedSpaceSdk>>();
assertExhaustiveUnion<Exclude<SupportedSpaceSdk, SpaceSdk>>();

export interface CreateRepoResult {
	action: CreateRepoAction;
	uri: string;
	url: string;
	repo: string;
	repo_type: RepoType;
	id?: string;
	source_uri?: string;
	source_repo?: string;
}

interface DuplicateRepoApiResponse {
	url: string;
	id?: string;
}

interface DuplicateRepoPayload {
	repository: string;
	visibility?: 'private' | 'public';
}

export class CreateRepoTool extends HfApiCall<CreateRepoParams, CreateRepoResult> {
	private readonly accessToken?: string;
	private readonly hubUrl: string;

	constructor(hfToken?: string, hubUrl = DEFAULT_HUB_URL) {
		const normalizedHubUrl = hubUrl.replace(/\/+$/, '');
		super(`${normalizedHubUrl}/api`, hfToken);
		this.accessToken = hfToken;
		this.hubUrl = normalizedHubUrl;
	}

	static createToolConfig(): Omit<typeof CREATE_REPO_TOOL_CONFIG, 'description'> & { description: string } {
		return {
			...CREATE_REPO_TOOL_CONFIG,
			description:
				'Create a Hugging Face model, dataset, Space, or bucket repository using an hf:// destination URI. ' +
				'Set source_uri to duplicate an existing model, dataset, or Space server-side.',
		};
	}

	async create(params: CreateRepoParams): Promise<CreateRepoResult> {
		if (!this.accessToken) throw new Error(NO_TOKEN_INSTRUCTIONS);

		const target = parseRepoUri(params.uri, 'uri');
		if (params.source_uri) {
			const source = parseRepoUri(params.source_uri, 'source_uri');
			return await this.duplicate(params, target, source);
		}

		validateCreateParams(params, target);

		const result = await createRepo({
			accessToken: this.accessToken,
			repo: target.repo,
			private: params.private,
			...(target.repoType === 'space' && params.sdk ? { sdk: params.sdk } : {}),
			...(this.hubUrl !== DEFAULT_HUB_URL ? { hubUrl: this.hubUrl } : {}),
		});

		return {
			action: 'created',
			uri: params.uri,
			url: result.repoUrl,
			repo: target.repoId,
			repo_type: target.repoType,
			id: result.id,
		};
	}

	private async duplicate(
		params: CreateRepoParams,
		target: ParsedRepoHfUri,
		source: ParsedRepoHfUri
	): Promise<CreateRepoResult> {
		validateDuplicateParams(params, target, source);

		const payload: DuplicateRepoPayload = {
			repository: target.repoId,
			...(params.private === undefined ? {} : { visibility: params.private ? 'private' : 'public' }),
		};
		const response = await this.fetchFromApi<DuplicateRepoApiResponse>(
			`${this.apiUrl}/${repoApiPrefix(source.repoType)}/${repoIdPath(source.repoId)}/duplicate`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			}
		);
		if (!response?.url) {
			throw new Error('API request failed: duplicate response did not include a url.');
		}

		return {
			action: 'duplicated',
			uri: params.uri,
			url: response.url,
			repo: target.repoId,
			repo_type: target.repoType,
			...(response.id ? { id: response.id } : {}),
			source_uri: params.source_uri,
			source_repo: source.repoId,
		};
	}
}

function parseRepoUri(uri: string, fieldName: 'uri' | 'source_uri'): ParsedRepoHfUri {
	const parsed = parseHfFsUri(uri);
	if (parsed.kind === 'namespace') {
		throw new Error(`${fieldName} must point to a repository, not a namespace.`);
	}
	if (parsed.path) {
		throw new Error(`${fieldName} must point to a repository, not a file path.`);
	}
	if (parsed.revision) {
		throw new Error(`${fieldName} must point to a repository and must not include a revision.`);
	}
	return parsed;
}

function validateCreateParams(params: CreateRepoParams, target: ParsedRepoHfUri): void {
	if (params.sdk && target.repoType !== 'space') {
		throw new Error('sdk is only valid when creating a Space repository.');
	}
}

function validateDuplicateParams(params: CreateRepoParams, target: ParsedRepoHfUri, source: ParsedRepoHfUri): void {
	if (params.sdk) {
		throw new Error('sdk is only valid when creating a new empty Space, not when duplicating.');
	}
	if (source.repoType === 'bucket') {
		throw new Error('Duplicating bucket repositories is not supported.');
	}
	if (target.repoType === 'bucket') {
		throw new Error('A duplicated repo target must be a model, dataset, or Space URI.');
	}
	if (source.repoType !== target.repoType) {
		throw new Error(`source_uri type (${source.repoType}) must match uri type (${target.repoType}).`);
	}
}

function repoApiPrefix(repoType: RepoType): 'models' | 'datasets' | 'spaces' {
	switch (repoType) {
		case 'model':
			return 'models';
		case 'dataset':
			return 'datasets';
		case 'space':
			return 'spaces';
		case 'bucket':
			throw new Error('Duplicating bucket repositories is not supported.');
	}
}

function repoIdPath(repoId: string): string {
	return repoId.split('/').map(encodeURIComponent).join('/');
}

export const formatCreateRepoResult = (result: CreateRepoResult): string => {
	const lines = [
		`# create_repo ${result.action}`,
		'',
		`URI: ${inlineCode(result.uri)}`,
		`Repo: ${inlineCode(result.repo)}`,
		`Type: ${inlineCode(result.repo_type)}`,
	];
	if (result.source_uri) {
		lines.push(`Source: ${inlineCode(result.source_uri)}`);
	}
	lines.push(`URL: ${result.url}`);
	if (result.id) {
		lines.push(`ID: ${inlineCode(result.id)}`);
	}
	return lines.join('\n');
};

function inlineCode(value: string): string {
	return `\`${escapeMarkdown(value)}\``;
}
