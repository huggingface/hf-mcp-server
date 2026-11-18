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
/** Our sort values are record field names (NAMING-SPEC R3); the Hub's sort keys differ for these. */
const HUB_SORT: Record<string, string> = {
	numParameters: 'num_parameters',
	numRows: 'datasetsServerInfo.numRows',
	mainSize: 'mainSize',
};
/** Record field name -> Hub expand[] name, where they differ. */
const HUB_EXPAND: Record<string, string> = {
	pipelineTag: 'pipeline_tag',
	libraryName: 'library_name',
	inferenceProviders: 'inferenceProviderMapping',
	paperswithcodeId: 'paperswithcode_id',
	title: 'cardData',
	emoji: 'cardData',
	shortDescription: 'cardData',
};
function any(values: readonly string[]): string {
	return values.length === 1 ? (values[0] ?? '') : `or:${values.join(',')}`;
}
function setAny(params: URLSearchParams, key: string, values: readonly string[] | undefined): void {
	if (values) params.set(key, any(values));
}
function base(input: ListingInput, fields: readonly string[]): URLSearchParams {
	const params = new URLSearchParams();
	if (input.query) params.set('search', input.query);
	setAny(params, 'author', input.authorsAny);
	setAny(params, 'id', input.idsAny);
	setAny(params, 'arxivIds', input.papersAny);
	params.set('sort', HUB_SORT[input.sort] ?? input.sort);
	params.set('direction', input.direction === 'asc' ? '1' : '-1');
	params.set('limit', String(input.limit));
	for (const field of [...new Set(fields.map((name) => HUB_EXPAND[name] ?? name))]) params.append('expand', field);
	return params;
}
function tags(input: ListingInput): string[] {
	return [...(input.tagsAll ?? []), ...(input.tagsAnyGroups ?? []).map((group) => `or:(${group.join(',')})`)];
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
	// A model's linked datasets are derived from its dataset:ID tags.
	const fields = (v.fields?.length ? v.fields : defaultModelFields).map((field) =>
		field === 'datasets' ? 'tags' : field
	);
	const params = base(v, fields);
	const filters = tags(v);
	if (v.task) params.set('pipeline_tag', v.task);
	addFacets(filters, v.librariesAll);
	addFacets(filters, v.languagesAll);
	addFacets(filters, v.licensesAll, 'license:');
	addFacets(filters, v.baseModelsAll, v.baseModelRelation ? `base_model:${v.baseModelRelation}:` : 'base_model:');
	if (v.gated !== undefined) params.set('gated', String(v.gated));
	if (v.providersAny) params.set('inference_provider', v.providersAny.join(','));
	if (v.anyProvider) params.set('inference_provider', 'all');
	if (v.inference) params.set('inference', v.inference);
	const counts = (v.numParametersAny ?? []).map(String);
	if (v.numParametersMin !== undefined) counts.push(`min:${String(v.numParametersMin)}`);
	if (v.numParametersMax !== undefined) counts.push(`max:${String(v.numParametersMax)}`);
	if (counts.length) params.set('num_parameters', counts.join(','));
	for (const [bound, date] of Object.entries(v.createdAt ?? {})) {
		if (date) params.set(`createdAt[${bound}]`, date);
	}
	if (v.baseModelRelationsAny) params.set('base_model_relation', v.baseModelRelationsAny.join(','));
	setAny(params, 'datasets', v.datasetsAny);
	if (v.appsAny) params.set('apps', v.appsAny.join(','));
	return finish(params, filters);
}
export function datasetQuery(v: DatasetsInput): URLSearchParams {
	const params = base(v, v.fields?.length ? v.fields : defaultDatasetFields);
	const filters = tags(v);
	addFacets(filters, v.taskCategoriesAll, 'task_categories:');
	addFacets(filters, v.sizeCategoriesAll, 'size_categories:');
	addFacets(filters, v.modalitiesAll, 'modality:');
	addFacets(filters, v.formatsAll, 'format:');
	addFacets(filters, v.librariesAll, 'library:');
	addFacets(filters, v.languagesAll, 'language:');
	addFacets(filters, v.licensesAll, 'license:');
	if (v.datasetType)
		filters.push(
			{ benchmark: 'benchmark:official', 'agent-traces': 'format:agent-traces', 'rl-environment': 'rl-environment' }[
				v.datasetType
			]
		);
	if (v.gated !== undefined) params.set('gated', String(v.gated));
	return finish(params, filters);
}
export function spaceListQuery(v: SpacesListInput): URLSearchParams {
	const params = base(v, v.fields?.length ? v.fields : defaultSpaceFields);
	const filters = tags(v);
	if (v.mcpOnly) filters.push('mcp-server');
	setAny(params, 'cardData.sdk', v.sdksAny);
	setAny(params, 'runtime.stage', v.runningOnly ? ['RUNNING', 'RUNNING_BUILDING'] : v.stagesAny);
	setAny(params, 'runtime.hardware.current', v.hardwareCurrentAny);
	setAny(params, 'runtime.hardware.requested', v.hardwareRequestedAny);
	setAny(params, 'models', v.modelsAny);
	setAny(params, 'datasets', v.datasetsAny);
	return finish(params, filters);
}
export function spaceSearchQuery(v: SpacesSearchInput): URLSearchParams {
	const params = new URLSearchParams();
	if (v.query) params.set('q', v.query);
	if (v.category) params.set('category', v.category);
	params.set('includeNonRunning', String(v.includeNonRunning));
	for (const sdk of v.sdksAny ?? []) params.append('sdk', sdk);
	// Appending mcp-server to tagsAny would widen an OR. With explicit tags,
	// enforce MCP locally. Without tags we can also narrow upstream candidates.
	for (const tag of v.tagsAny ?? (v.mcpOnly ? ['mcp-server'] : [])) params.append('filter', tag);
	return params;
}
