import { z } from 'zod';
import type { ToolResult } from './types/tool-result.js';
import { ModelDetailTool } from './model-detail.js';
import { DatasetDetailTool } from './dataset-detail.js';
import { spaceInfo } from '@huggingface/hub';
import { formatDate } from './utilities.js';
import { DatasetViewerInspector } from './dataset-viewer-inspect.js';

const HUB_INSPECT_OPERATIONS = ['overview', 'dataset_structure', 'dataset_preview'] as const;

export const HUB_REPO_DETAILS_TOOL_CONFIG = {
	name: 'hub_repo_details',
	title: 'Hub Repository Details',
	description:
		'Get details for one or more Hugging Face repos (model, dataset, or space): card metadata, license, downloads, files, Space hardware/status, dataset configs, splits, columns and preview rows. ' +
		'Auto-detects type unless specified. For datasets, use operations: overview, dataset_structure, dataset_preview. ' +
		'Use dataset_structure first to discover configs, splits, sizes, and schema. Use dataset_preview only when ' +
		'config and split are known, unless the dataset has a single config/split.',
	schema: z.object({
		repo_ids: z
			.array(z.string().min(1))
			.min(1, 'Provide at least one id')
			.max(10, 'Provide at most 10 repo ids')
			.describe('Repo IDs for (models|dataset/space) - usually in author/name format (e.g. openai/gpt-oss-120b)'),
		repo_type: z.enum(['model', 'dataset', 'space']).optional().describe('Specify lookup type; otherwise auto-detects'),
		operations: z
			.array(z.enum(HUB_INSPECT_OPERATIONS))
			.optional()
			.describe(
				'Details to return. Defaults to ["overview"]. For datasets, prefer ["overview", "dataset_structure"] first; then call ["dataset_preview"] with config and split.'
			),
		config: z
			.string()
			.optional()
			.describe(
				'Dataset Viewer config. Required for dataset_preview when the dataset has multiple config/split options. Discover via dataset_structure.'
			),
		split: z
			.string()
			.optional()
			.describe(
				'Dataset Viewer split. Required for dataset_preview when the dataset has multiple config/split options. Discover via dataset_structure.'
			),
		offset: z.number().int().nonnegative().optional().describe('Row offset for dataset_preview. Defaults to 0.'),
		limit: z
			.number()
			.int()
			.optional()
			.describe('Row count for dataset_preview. Defaults to 5 and is clamped to 1-100.'),
	}),
	annotations: {
		title: 'Hub Repository Details',
		destructiveHint: false,
		idempotentHint: false,
		readOnlyHint: true,
		openWorldHint: true,
	},
} as const;

export type HubInspectParams = z.infer<typeof HUB_REPO_DETAILS_TOOL_CONFIG.schema>;

export class HubInspectTool {
	private readonly modelDetail: ModelDetailTool;
	private readonly datasetDetail: DatasetDetailTool;
	private readonly datasetViewer: DatasetViewerInspector;
	private readonly hubUrl?: string;

	constructor(hfToken?: string, hubUrl?: string) {
		this.modelDetail = new ModelDetailTool(hfToken, hubUrl);
		this.datasetDetail = new DatasetDetailTool(hfToken, hubUrl);
		this.datasetViewer = new DatasetViewerInspector(hfToken, { hubUrl });
		this.hubUrl = hubUrl;
	}

	async inspect(params: HubInspectParams): Promise<ToolResult> {
		const parts: string[] = [];
		let successCount = 0;

		for (const id of params.repo_ids) {
			try {
				const section = await this.inspectSingle(id, params);
				parts.push(section);
				successCount += 1;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// Improve error message formatting
				const cleanMsg = msg.replace(/Invalid username or password/g, 'Not found or authentication required');
				parts.push(`# ${id}\n\n- Error: ${cleanMsg}`);
			}
		}

		return {
			formatted: parts.join('\n\n---\n\n'),
			totalResults: params.repo_ids.length,
			resultsShared: successCount,
		};
	}

	private async inspectSingle(repoId: string, params: HubInspectParams): Promise<string> {
		const type = params.repo_type;
		const operations = normalizeOperations(params.operations);
		const hasDatasetOperation = operations.some(
			(operation) => operation === 'dataset_structure' || operation === 'dataset_preview'
		);

		// If caller constrained the type, do only that
		if (type === 'model') {
			if (hasDatasetOperation) return operationMismatch(repoId, 'model', operations);
			return (await this.modelDetail.getDetails(repoId)).formatted;
		}
		if (type === 'dataset') {
			return await this.getDatasetDetails(repoId, params, operations);
		}
		if (type === 'space') {
			if (hasDatasetOperation) return operationMismatch(repoId, 'space', operations);
			return await this.getSpaceDetails(repoId);
		}

		if (hasDatasetOperation) {
			return await this.getDatasetDetails(repoId, params, operations);
		}

		// Auto-detect: attempt all three and aggregate. The same id may exist for multiple types.
		const matches: string[] = [];

		try {
			const r = await this.modelDetail.getDetails(repoId);
			matches.push(`**Type: Model**\n\n${r.formatted}`);
		} catch {
			/* not a model */
		}

		try {
			const r = await this.datasetDetail.getDetails(repoId);
			matches.push(`**Type: Dataset**\n\n${r.formatted}`);
		} catch {
			/* not a dataset */
		}

		try {
			const r = await this.getSpaceDetails(repoId);
			matches.push(`**Type: Space**\n\n${r}`);
		} catch {
			/* not a space */
		}

		if (matches.length === 0) {
			throw new Error(`Could not find repo '${repoId}' as model, dataset, or space.`);
		}

		return matches.join('\n\n---\n\n');
	}

	private async getDatasetDetails(
		repoId: string,
		params: HubInspectParams,
		operations: HubInspectOperation[]
	): Promise<string> {
		const sections: string[] = [];
		if (operations.includes('overview')) {
			const overview = (await this.datasetDetail.getDetails(repoId)).formatted;
			sections.push(`${overview}\n\n${datasetDrillDownHint()}`);
		}
		if (operations.includes('dataset_structure')) {
			sections.push(await this.datasetViewer.getStructure(repoId, { config: params.config, split: params.split }));
		}
		if (operations.includes('dataset_preview')) {
			sections.push(
				await this.datasetViewer.getPreview(repoId, {
					config: params.config,
					split: params.split,
					offset: params.offset,
					limit: params.limit,
				})
			);
		}
		return sections.join('\n\n');
	}

	private async getSpaceDetails(spaceId: string): Promise<string> {
		const additionalFields = ['author', 'tags', 'runtime', 'subdomain', 'sha'] as const;
		const info = await spaceInfo<(typeof additionalFields)[number]>({
			name: spaceId,
			additionalFields: Array.from(additionalFields),
			...(this.hubUrl && { hubUrl: this.hubUrl }),
		});

		const lines: string[] = [];
		lines.push(`# ${info.name}`);
		lines.push('');
		lines.push('## Overview');
		interface SpaceExtra {
			author?: string;
			tags?: readonly string[] | string[];
			runtime?: unknown;
			subdomain?: string;
			sha?: string;
		}
		const extra = info as Partial<SpaceExtra>;
		if (extra.author) lines.push(`- **Author:** ${extra.author}`);
		if (info.sdk) lines.push(`- **SDK:** ${info.sdk}`);
		lines.push(`- **Likes:** ${info.likes}`);
		lines.push(`- **Updated:** ${formatDate(info.updatedAt)}`);
		const tags = Array.isArray(extra.tags) ? extra.tags : undefined;
		if (tags && tags.length) lines.push(`- **Tags:** ${tags.join(', ')}`);
		lines.push('');
		lines.push(`**Link:** [https://hf.co/spaces/${info.name}](https://hf.co/spaces/${info.name})`);
		return lines.join('\n');
	}
}

type HubInspectOperation = (typeof HUB_INSPECT_OPERATIONS)[number];

function normalizeOperations(operations: readonly HubInspectOperation[] | undefined): HubInspectOperation[] {
	return operations && operations.length > 0 ? [...new Set(operations)] : ['overview'];
}

function operationMismatch(repoId: string, type: 'model' | 'space', operations: HubInspectOperation[]): string {
	const requested = operations.filter((operation) => operation.startsWith('dataset_')).join(', ');
	return `# ${repoId}\n\nRequested dataset operation(s) \`${requested}\`, but this repo was requested as a ${type}. Dataset Viewer operations only apply to dataset repos.`;
}

function datasetDrillDownHint(): string {
	return [
		'## Available deeper inspections',
		'Call `hub_repo_details` with:',
		'- `operations: ["dataset_structure"]` for configs, splits, sizes, parquet exports, and schema.',
		'- `operations: ["dataset_preview"]` with `config` and `split` for sample rows.',
	].join('\n');
}
