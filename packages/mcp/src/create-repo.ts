import { createRepo, type RepoType as HubRepoType, type SpaceHardwareFlavor, type SpaceSdk } from '@huggingface/hub';
import { z } from 'zod';
import { HfApiCall, HfApiError } from './hf-api-call.js';
import { type ParsedRepoHfUri, parseHfFsUri } from './hf-fs.js';
import { escapeMarkdown, NO_TOKEN_INSTRUCTIONS } from './utilities.js';

const REPO_TYPES = ['model', 'dataset', 'space', 'bucket'] as const satisfies readonly HubRepoType[];
const SPACE_SDKS = ['streamlit', 'gradio', 'docker', 'static'] as const satisfies readonly SpaceSdk[];
// hints only, the hub validates hardware so new flavors need no schema change
const SPACE_HARDWARE_HINTS = [
	'cpu-upgrade',
	'zero-a10g',
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
	'rtx-pro-6000',
	'rtx-pro-6000x2',
	'rtx-pro-6000x4',
	'rtx-pro-6000x8',
];
const ZERO_GPU_HARDWARE = 'zero-a10g';
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
		sdk: z
			.enum(SPACE_SDKS)
			.optional()
			.describe(
				'Space SDK for new empty Spaces. When duplicating (source_uri set), the Space keeps the source sdk; omit sdk or pass the same value.'
			),
		hardware: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Space hardware to start on, for new or duplicated Spaces only (rejected for other repo types). Omit for the free cpu-basic. ' +
					`Examples: ${SPACE_HARDWARE_HINTS.join(', ')}. ` +
					'Use zero-a10g for ZeroGPU, which needs sdk gradio (the default for new ZeroGPU Spaces) and a PRO account (or a Team/Enterprise plan for an org-owned Space). ' +
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
		sdk: z.enum(SPACE_SDKS).optional(),
		hardware: z
			.object({
				requested: z.string(),
				current: z.string().optional(),
				stage: z.string().optional(),
				confirmed: z.boolean(),
			})
			.optional(),
	});
}

function assertExhaustiveUnion<T extends never>(_value?: T): void {
	void _value;
}

// HubRepoType also includes kernels, which do not use this tool's repository creation API.
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
	sdk?: SupportedSpaceSdk;
	hardware?: CreateRepoHardwareResult;
}

export interface CreateRepoHardwareResult {
	/** Hardware the Hub recorded for the Space, or the requested value when the runtime could not be read. */
	requested: string;
	/** Hardware the Space is running on; usually absent straight after creation while it builds. */
	current?: string;
	stage?: string;
	/** True when requested/current/stage were read back from the Space runtime. */
	confirmed: boolean;
}

interface SpaceRuntimeApiResponse {
	stage?: string;
	hardware?: {
		current?: string | null;
		requested?: string | null;
	};
}

interface DuplicateRepoApiResponse {
	url: string;
	id?: string;
}

interface SpaceSdkApiResponse {
	sdk?: string;
}

interface DuplicateRepoPayload {
	repository: string;
	visibility?: 'private' | 'public';
	hardware?: string;
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

		// ZeroGPU only runs Gradio Spaces, and the hub library would otherwise default the sdk to static
		const sdk = params.sdk ?? (params.hardware === ZERO_GPU_HARDWARE ? 'gradio' : undefined);
		const result = await createRepo({
			accessToken: this.accessToken,
			repo: target.repo,
			private: params.private,
			...(target.repoType === 'space' && sdk ? { sdk } : {}),
			...(params.hardware ? { hardware: params.hardware as SpaceHardwareFlavor } : {}),
			...(this.hubUrl !== DEFAULT_HUB_URL ? { hubUrl: this.hubUrl } : {}),
		});

		return {
			action: 'created',
			uri: params.uri,
			url: result.repoUrl,
			repo: target.repoId,
			repo_type: target.repoType,
			id: result.id,
			...(target.repoType === 'space' && sdk ? { sdk } : {}),
			...(params.hardware ? { hardware: await this.readSpaceHardware(target.repoId, params.hardware) } : {}),
		};
	}

	private async duplicate(
		params: CreateRepoParams,
		target: ParsedRepoHfUri,
		source: ParsedRepoHfUri
	): Promise<CreateRepoResult> {
		validateDuplicateParams(params, target, source);
		if (params.sdk) {
			await this.assertSourceSpaceSdk(source, params.sdk);
		}

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
		).catch((error: unknown) => {
			throw withHubErrorDetail(error, `Duplicating ${source.repoId} to ${target.repoId} failed`);
		});
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
			...(params.hardware ? { hardware: await this.readSpaceHardware(target.repoId, params.hardware) } : {}),
		};
	}

	// the repo already exists at this point, so a failed runtime read must not fail the call
	private async readSpaceHardware(repoId: string, requested: string): Promise<CreateRepoHardwareResult> {
		try {
			const runtime = await this.fetchFromApi<SpaceRuntimeApiResponse>(
				`${this.apiUrl}/spaces/${repoIdPath(repoId)}/runtime`
			);
			if (!runtime?.hardware?.requested) {
				return { requested, confirmed: false };
			}
			return {
				requested: runtime.hardware.requested,
				...(runtime.hardware.current ? { current: runtime.hardware.current } : {}),
				...(runtime.stage ? { stage: runtime.stage } : {}),
				confirmed: true,
			};
		} catch {
			return { requested, confirmed: false };
		}
	}

	// a duplicate keeps the source sdk, so sdk is only accepted when it matches
	private async assertSourceSpaceSdk(source: ParsedRepoHfUri, sdk: string): Promise<void> {
		const info = await this.fetchFromApi<SpaceSdkApiResponse>(
			`${this.apiUrl}/spaces/${repoIdPath(source.repoId)}`
		).catch((error: unknown) => {
			throw withHubErrorDetail(error, `Reading the source Space ${source.repoId} failed`);
		});
		if (info?.sdk !== sdk) {
			throw new Error(
				`sdk (${sdk}) does not match the source Space sdk (${info?.sdk ?? 'unknown'}). A duplicated Space keeps the source sdk; omit sdk when duplicating.`
			);
		}
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
		throw new Error('sdk is only valid for Space repositories.');
	}
	validateHardwareTarget(params, target);
}

function validateHardwareTarget(params: CreateRepoParams, target: ParsedRepoHfUri): void {
	if (params.hardware && target.repoType !== 'space') {
		throw new Error('hardware is only valid for Space repositories.');
	}
}

function validateDuplicateParams(params: CreateRepoParams, target: ParsedRepoHfUri, source: ParsedRepoHfUri): void {
	if (source.repoType === 'bucket') {
		throw new Error('Duplicating bucket repositories is not supported.');
	}
	if (target.repoType === 'bucket') {
		throw new Error('A duplicated repo target must be a model, dataset, or Space URI.');
	}
	if (source.repoType !== target.repoType) {
		throw new Error(`source_uri type (${source.repoType}) must match uri type (${target.repoType}).`);
	}
	if (params.sdk && target.repoType !== 'space') {
		throw new Error('sdk is only valid for Space repositories.');
	}
	validateHardwareTarget(params, target);
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

// the hub library's createRepo already surfaces the hub's reason; do the same for direct api calls
function withHubErrorDetail(error: unknown, context: string): unknown {
	if (!(error instanceof HfApiError)) return error;
	const detail = hubErrorDetail(error.responseBody);
	return new HfApiError(
		`${context} (${error.status.toString()}${error.statusText ? ` ${error.statusText}` : ''})${detail ? `: ${detail}` : '.'}`,
		error.status,
		error.statusText,
		error.responseBody
	);
}

function hubErrorDetail(body: string | undefined): string | undefined {
	const trimmed = body?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
		const detail = typeof parsed.error === 'string' ? parsed.error : parsed.message;
		return typeof detail === 'string' && detail.trim() ? detail.trim() : undefined;
	} catch {
		return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
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
	if (result.sdk) {
		lines.push(`SDK: ${inlineCode(result.sdk)}`);
	}
	if (result.hardware) {
		lines.push(...formatHardware(result.hardware));
	}
	lines.push(`URL: ${result.url}`);
	if (result.id) {
		lines.push(`ID: ${inlineCode(result.id)}`);
	}
	return lines.join('\n');
};

function formatHardware(hardware: CreateRepoHardwareResult): string[] {
	if (!hardware.confirmed) {
		return [
			`Hardware requested: ${inlineCode(hardware.requested)} (not confirmed; the Space runtime could not be read)`,
		];
	}
	return [
		`Hardware requested: ${inlineCode(hardware.requested)}`,
		`Hardware current: ${hardware.current ? inlineCode(hardware.current) : 'none yet (Space is not running)'}`,
		...(hardware.stage ? [`Stage: ${inlineCode(hardware.stage)}`] : []),
	];
}

function inlineCode(value: string): string {
	return `\`${escapeMarkdown(value)}\``;
}
