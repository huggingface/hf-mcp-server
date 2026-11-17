import {
	defaultModelFields,
	defaultDatasetFields,
	defaultSpaceFields,
	type ModelsInput,
	type DatasetsInput,
	type SpacesListInput,
	type SpacesSearchInput,
} from './schemas.js';

type ListingInput = ModelsInput | DatasetsInput | SpacesListInput;
function any(values: readonly string[]): string {
	return values.length === 1 ? (values[0] ?? '') : `or:${values.join(',')}`;
}
function setAny(params: URLSearchParams, key: string, values: readonly string[] | undefined): void {
	if (values) params.set(key, any(values));
}
function base(input: ListingInput, fields: readonly string[]): URLSearchParams {
	const params = new URLSearchParams();
	if (input.query) params.set('search', input.query);
	setAny(params, 'author', input.authors_any);
	setAny(params, 'id', input.ids_any);
	setAny(params, 'arxivIds', input.arxiv_ids);
	params.set(
		'sort',
		input.sort === 'rows' ? 'datasetsServerInfo.numRows' : input.sort === 'bytes' ? 'mainSize' : input.sort
	);
	params.set('direction', input.direction === 'asc' ? '1' : '-1');
	params.set('limit', String(input.limit));
	for (const field of [...new Set(fields)]) params.append('expand', field);
	return params;
}
function tags(input: ListingInput): string[] {
	return [...(input.tags_all ?? []), ...(input.tags_any_groups ?? []).map((group) => `or:(${group.join(',')})`)];
}
function addFacets(target: string[], values: string[] | undefined, prefix = ''): void {
	target.push(...(values ?? []).map((value) => `${prefix}${value}`));
}
function finish(params: URLSearchParams, filters: string[]): URLSearchParams {
	// A literal may contain "/" outside scoped OR, but never comma or "or:".
	if (filters.length) params.set('filter', filters.join(','));
	return params;
}
export function modelQuery(v: ModelsInput): URLSearchParams {
	const params = base(v, v.fields?.length ? v.fields : defaultModelFields);
	const filters = tags(v);
	if (v.task) params.set('pipeline_tag', v.task);
	addFacets(filters, v.libraries);
	addFacets(filters, v.languages);
	addFacets(filters, v.licenses, 'license:');
	addFacets(filters, v.base_models_all, v.base_model_relation ? `base_model:${v.base_model_relation}:` : 'base_model:');
	if (v.gated !== undefined) params.set('gated', String(v.gated));
	if (v.providers_any) params.set('inference_provider', v.providers_any.join(','));
	if (v.any_provider) params.set('inference_provider', 'all');
	if (v.inference) params.set('inference', v.inference);
	const counts = (v.parameters_exact ?? []).map(String);
	if (v.parameters_min !== undefined) counts.push(`min:${String(v.parameters_min)}`);
	if (v.parameters_max !== undefined) counts.push(`max:${String(v.parameters_max)}`);
	if (counts.length) params.set('num_parameters', counts.join(','));
	for (const [bound, date] of Object.entries(v.created_at ?? {})) {
		if (date) params.set(`createdAt[${bound}]`, date);
	}
	if (v.base_model_relations) params.set('base_model_relation', v.base_model_relations.join(','));
	setAny(params, 'datasets', v.datasets_any);
	if (v.apps_any) params.set('apps', v.apps_any.join(','));
	return finish(params, filters);
}
export function datasetQuery(v: DatasetsInput): URLSearchParams {
	const params = base(v, v.fields?.length ? v.fields : defaultDatasetFields);
	const filters = tags(v);
	addFacets(filters, v.task_categories, 'task_categories:');
	addFacets(filters, v.size_categories, 'size_categories:');
	addFacets(filters, v.modalities, 'modality:');
	addFacets(filters, v.formats, 'format:');
	addFacets(filters, v.libraries, 'library:');
	addFacets(filters, v.languages, 'language:');
	addFacets(filters, v.licenses, 'license:');
	if (v.dataset_type)
		filters.push(
			{ benchmark: 'benchmark:official', 'agent-traces': 'format:agent-traces', 'rl-environment': 'rl-environment' }[
				v.dataset_type
			]
		);
	if (v.gated !== undefined) params.set('gated', String(v.gated));
	return finish(params, filters);
}
export function spaceListQuery(v: SpacesListInput): URLSearchParams {
	const params = base(v, v.fields?.length ? v.fields : defaultSpaceFields);
	const filters = tags(v);
	if (v.mcp_only) filters.push('mcp-server');
	setAny(params, 'cardData.sdk', v.sdks);
	setAny(params, 'runtime.stage', v.running_only ? ['RUNNING', 'RUNNING_BUILDING'] : v.stages_any);
	setAny(params, 'runtime.hardware.current', v.hardware_current_any);
	setAny(params, 'runtime.hardware.requested', v.hardware_requested_any);
	setAny(params, 'models', v.models_any);
	setAny(params, 'datasets', v.datasets_any);
	return finish(params, filters);
}
export function spaceSearchQuery(v: SpacesSearchInput): URLSearchParams {
	const params = new URLSearchParams();
	if (v.query) params.set('q', v.query);
	if (v.category) params.set('category', v.category);
	params.set('includeNonRunning', String(v.include_non_running));
	for (const sdk of v.sdks ?? []) params.append('sdk', sdk);
	// Appending mcp-server to tags_any would widen an OR. With explicit tags,
	// enforce MCP locally. Without tags we can also narrow upstream candidates.
	for (const tag of v.tags_any ?? (v.mcp_only ? ['mcp-server'] : [])) params.append('filter', tag);
	return params;
}
