import { createRepo, type RepoType as HubRepoType, type SpaceHardwareFlavor, type SpaceSdk } from '@huggingface/hub';
import { z } from 'zod';
import { HfApiCall } from './hf-api-call.js';
import { type ParsedRepoHfUri, parseHfFsUri } from './hf-fs.js';
import { escapeMarkdown, NO_TOKEN_INSTRUCTIONS } from './utilities.js';

const REPO_TYPES = ['model', 'dataset', 'space', 'bucket'] as const satisfies readonly HubRepoType[];
const SPACE_SDKS = ['streamlit', 'gradio', 'docker', 'static'] as const satisfies readonly SpaceSdk[];
const SPACE_HARDWARE = [
	'cpu-basic',
	'cpu-upgrade',
	'cpu-performance',
	'cpu-xl',
	'sprx8',
	'zero-a10g',
	'inf2x6',
	't4-small',
	't4-medium',
	'l4x1',
	'l4x4',
	'l40sx1',
	'l40sx4',
	'l40sx8',
	'a10g-small',
	'a10g-large',
	'a10g-largex2',
	'a10g-largex4',
	'a100-large',
	'a100x4',
	'a100x8',
] as const satisfies readonly SpaceHardwareFlavor[];
const CREATE_REPO_ACTIONS = ['created', 'duplicated'] as const;
const DEFAULT_HUB_URL = 'https://huggingface.co';

export const CREATE_REPO_TOOL_CONFIG = {
	name: 'create_repo',
	title: 'Create Hugging Face Repository',
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
		hardware: z
			.enum(SPACE_HARDWARE)
			.optional()
			.describe(
				'Space hardware to start on, for new or duplicated Spaces only. Omit for the free cpu-basic. ' +
					'Use zero-a10g for ZeroGPU, which needs sdk gradio and a PRO account (or a Team/Enterprise plan for an org-owned Space). ' +
					'suggested_hardware in the README does NOT set the hardware; only this parameter does. ' +
					'Paid flavors bill the owner from creation.'
			),
	}),
	outputSchema: createCreateRepoOutputSchema(),
	annotations: {
		title: 'Create Hugging Face Repository',
		destructiveHint: false,
		idempotentHint: false,
		readOnlyHint: false,
		openWorldHint: true,
	},
} as const;

export type CreateRepoParams = z.input<typeof CREATE_REPO_TOOL_CONFIG.schema>;
type RepoType = (typeof REPO_TYPES)[number];
type SupportedSpaceSdk = (typeof SPACE_SDKS)[number];
type SupportedSpaceHardware = (typeof SPACE_HARDWARE)[number];
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
		hardware: z.enum(SPACE_HARDWARE).optional(),
	});
}

function assertExhaustiveUnion<T extends never>(_value?: T): void {
	void _value;
}

// HubRepoType also includes kernels, which do not use this tool's repository creation API.
assertExhaustiveUnion<Exclude<RepoType, HubRepoType>>();
assertExhaustiveUnion<Exclude<SpaceSdk, SupportedSpaceSdk>>();
assertExhaustiveUnion<Exclude<SupportedSpaceSdk, SpaceSdk>>();
assertExhaustiveUnion<Exclude<SpaceHardwareFlavor, SupportedSpaceHardware>>();
assertExhaustiveUnion<Exclude<SupportedSpaceHardware, SpaceHardwareFlavor>>();

export interface CreateRepoResult {
	action: CreateRepoAction;
	uri: string;
	url: string;
	repo: string;
	repo_type: RepoType;
	id?: string;
	source_uri?: string;
	source_repo?: string;
	hardware?: SupportedSpaceHardware;
}

interface DuplicateRepoApiResponse {
	url: string;
	id?: string;
}

interface DuplicateRepoPayload {
	repository: string;
	visibility?: 'private' | 'public';
	hardware?: SupportedSpaceHardware;
}

interface CreateSpaceApiResponse {
	url: string;
	id?: string;
}

interface CreateSpacePayload {
	type: 'space';
	name: string;
	organization: string;
	sdk: SupportedSpaceSdk;
	hardware: SupportedSpaceHardware;
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

		if (params.hardware) {
			return await this.createSpaceWithHardware(params, target, params.hardware);
		}

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

	private async createSpaceWithHardware(
		params: CreateRepoParams,
		target: ParsedRepoHfUri,
		hardware: SupportedSpaceHardware
	): Promise<CreateRepoResult> {
		const [organization, name] = target.repoId.split('/');
		if (!organization || !name || !params.sdk) {
			throw new Error('Creating a Space with hardware requires an OWNER/NAME uri and an sdk.');
		}
		const payload: CreateSpacePayload = {
			type: 'space',
			name,
			organization,
			sdk: params.sdk,
			hardware,
			...(params.private === undefined ? {} : { visibility: params.private ? 'private' : 'public' }),
		};
		const response = await this.fetchFromApi<CreateSpaceApiResponse>(`${this.apiUrl}/repos/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!response?.url) {
			throw new Error('API request failed: create response did not include a url.');
		}

		return {
			action: 'created',
			uri: params.uri,
			url: response.url,
			repo: target.repoId,
			repo_type: target.repoType,
			...(response.id ? { id: response.id } : {}),
			hardware,
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
			...(params.hardware ? { hardware: params.hardware } : {}),
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
			...(params.hardware ? { hardware: params.hardware } : {}),
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
	if (!params.hardware) return;
	if (target.repoType !== 'space') {
		throw new Error('hardware is only valid for Space repositories.');
	}
	if (params.hardware.startsWith('zero-') && params.sdk !== 'gradio') {
		throw new Error(`hardware ${params.hardware} (ZeroGPU) requires sdk gradio.`);
	}
	if (!params.sdk || params.sdk === 'static') {
		throw new Error('hardware requires sdk gradio, docker or streamlit; static Spaces do not run on Space hardware.');
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
	if (params.hardware && target.repoType !== 'space') {
		throw new Error('hardware is only valid for Space repositories.');
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
	if (result.hardware) {
		lines.push(`Hardware: ${inlineCode(result.hardware)}`);
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
