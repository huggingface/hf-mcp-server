/**
 * Curated, deterministic rules for the PTC audit: concept synonym sets, resource types of
 * identifier fields (producers), identifier arguments (consumers) and the chains a model should be
 * able to follow. Edit these tables when tools change; the checks report anything they do not cover
 * (unclassified identifier outputs, unclassified inputs) so the tables cannot silently go stale.
 */

// ---------------------------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------------------------

export const REPO_TYPES = ['repo:model', 'repo:dataset', 'repo:space', 'repo:bucket'];
export const PEOPLE_TYPES = ['user', 'org'];

/** `kind` value of a record -> resource type. */
export const KIND_TO_TYPE = {
	model: 'repo:model',
	dataset: 'repo:dataset',
	space: 'repo:space',
	bucket: 'repo:bucket',
	file: 'file',
	dir: 'dir',
	paper: 'paper',
	collection: 'collection',
	doc: 'doc',
	user: 'user',
	org: 'org',
	discussion: 'discussion',
	job: 'job',
	scheduled_job: 'scheduled_job',
	sandbox: 'sandbox',
	process: 'process',
	commit: 'revision',
	branch: 'revision',
	tag: 'revision',
	convert: 'revision',
	pull_request: 'revision',
	symlink: 'sandbox_path',
	article: 'web_page',
	post: 'web_page',
};

/**
 * Records whose `kind` is an open string: the resource types the tool actually emits there
 * (from the tool source). Key: `tool:path` of the record ('' = root).
 */
export const OPEN_KIND_RECORDS = {
	'hf_trending:items[]': ['repo:model', 'repo:dataset', 'repo:space'],
	'hf_repo_fulltext_search:items[]': ['repo:model', 'repo:dataset', 'repo:space'],
	'hf_buckets_list:items[]': ['repo:bucket'],
	'hf_hub_lookup:items[]': [...REPO_TYPES, 'user', 'org', 'paper', 'collection'],
	'hf_papers_search:items[]': ['paper'],
	'hf_daily_papers:items[]': ['paper'],
	'hf_paper_get:items[]': ['paper'],
	'hf_paper_read:': ['paper'],
	'hf_paper_get:items[].linked.models.items[]': ['repo:model'],
	'hf_paper_get:items[].linked.datasets.items[]': ['repo:dataset'],
	'hf_paper_get:items[].linked.spaces.items[]': ['repo:space'],
	'hf_collections_search:items[].itemsPreview[]': [...REPO_TYPES, 'paper', 'collection'],
	'hf_collection_get:items[]': [...REPO_TYPES, 'paper', 'collection'],
	'hf_collection_get:history[].item': [...REPO_TYPES, 'paper', 'collection'],
	'hf_activity:items[].target': ['repo:model', 'repo:dataset', 'repo:space', 'paper', 'collection', 'web_page'],
	'hf_discussions_list:items[].repo': ['repo:model', 'repo:dataset', 'repo:space'],
	'hf_discussion_get:repo': ['repo:model', 'repo:dataset', 'repo:space'],
	'hf_space_tools:space': ['repo:space'],
	'hf_space_invoke:space': ['repo:space'],
	'hf_repo_create:repo': REPO_TYPES,
	'hf_repo_write_files:repo': REPO_TYPES,
	'hf_repo_write_files:changes[].file': ['file'],
};

/**
 * Scalar identifier fields (no kind/id/uri record around them). Matched on `tool:path`
 * ('*' tool matches any tool); first match wins. `form` names the value form a consumer receives.
 */
export const SCALAR_PRODUCERS = [
	// people
	// hf_whoami: handles are account.name / organizations[].name; every *.id there is a Hub ObjectId.
	{ match: /^hf_whoami:account\.name$/, type: ['user'], form: 'name' },
	{ match: /^hf_whoami:organizations\[\]\.name$/, type: ['org'], form: 'name' },
	{ match: /^hf_whoami:(account|organizations\[\])\.url$/, type: ['user', 'org'], form: 'profile_url' },
	{
		match:
			/^hf_whoami:(account|organizations\[\]|organizations\[\]\.resourceGroups\[\]|credential\.fineGrained\.scoped\[\]\.entity)\.id$/,
		type: ['hub_internal_id'],
		form: 'id',
	},
	{ match: /^hf_whoami:organizations\[\]\.resourceGroups\[\]\.name$/, type: ['resource_group'], form: 'display_name' },
	{ match: /^[^:]+:(.*\.)?author$/, type: ['user', 'org'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?owner$/, type: ['user', 'org'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?(owner|created_by)\.name$/, type: ['user', 'org'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?createdBy$/, type: ['user'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?submittedBy$/, type: ['user'], form: 'name' },
	{ match: /^hf_activity:items\[\]\.actor$/, type: ['user'], form: 'name' },
	{ match: /^hf_activity:items\[\]\.org$/, type: ['org'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?namespace$/, type: ['user', 'org'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?authors$/, type: ['person_name'], form: 'display_name' },
	// repositories as bare IDs
	{ match: /^[^:]+:(.*\.)?(space_id|spaceId)$/, type: ['repo:space'], form: 'id' },
	{ match: /^hf_repo_fulltext_search:items\[\]\.fileUri$/, type: ['file'], form: 'uri' },
	// revisions
	{ match: /^[^:]+:(.*\.)?(sha|revision|target_commit|merge_commit)$/, type: ['revision'], form: 'sha' },
	{ match: /^[^:]+:(.*\.)?lastCommit\.id$/, type: ['revision'], form: 'sha' },
	{ match: /^[^:]+:(.*\.)?commit\.oid$/, type: ['revision'], form: 'sha' },
	{ match: /^hf_repo_history:items\[\]\.ref$/, type: ['revision'], form: 'git_ref' },
	// discussions
	{ match: /^[^:]+:(.*\.)?num$/, type: ['discussion_num'], form: 'num' },
	{ match: /^hf_activity:items\[\]\.discussion\.url$/, type: ['discussion'], form: 'web_url' },
	{ match: /^hf_repo_write_files:(pull_request_url|pullRequestUrl)$/, type: ['discussion'], form: 'web_url' },
	// jobs and sandboxes
	{ match: /^hf_sandbox_\w+:(job_id|jobId)$/, type: ['job'], form: 'id' },
	{ match: /^hf_sandbox_\w+:url$/, type: ['job'], form: 'job_url' },
	{ match: /^[^:]+:(.*\.)?tag$/, type: ['process_tag'], form: 'tag' },
	{
		match: /^hf_sandbox_exec:sandbox$|^hf_sandbox_kill:sandbox$|^hf_sandbox_fs_\w+:sandbox$/,
		type: ['sandbox'],
		form: 'echo',
	},
	{ match: /^hf_sandbox_fs_\w+:path$/, type: ['sandbox_path'], form: 'path' },
	// hardware, tools, dataset coordinates
	{ match: /^hf_hardware_flavors:items\[\]\.id$/, type: ['flavor'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?flavor$/, type: ['flavor'], form: 'name' },
	{
		match: /^[^:]+:(.*\.)?runtime\.(hardware|requested_hardware|hardware\.current|hardware\.requested)$/,
		type: ['flavor'],
		form: 'name',
	},
	{ match: /^hf_space_tools:tools\[\]\.name$/, type: ['space_tool'], form: 'name' },
	{ match: /^hf_space_invoke:tool$/, type: ['space_tool'], form: 'echo' },
	{ match: /^hf_dataset_\w+:(.*\.)?config$/, type: ['dataset_config'], form: 'name' },
	{ match: /^hf_dataset_\w+:(.*\.)?split$/, type: ['dataset_split'], form: 'name' },
	{
		match: /^hf_dataset_\w+:(schema\[\]\.columns|columns|statistics\.columns)\[\]\.name$/,
		type: ['dataset_column'],
		form: 'name',
	},
	// tags and filter vocabularies
	{ match: /^[^:]+:(.*\.)?pipelineTag$/, type: ['task'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?libraryName$/, type: ['library'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?(license)$/, type: ['license'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?languages$/, type: ['language'], form: 'name' },
	{ match: /^hf_filter_values:groups\[\]\.values\[\]\.id$/, type: ['tag', 'task'], form: 'tag' },
	{ match: /^[^:]+:(.*\.)?sdk$/, type: ['sdk'], form: 'name' },
	{ match: /^[^:]+:(.*\.)?(inference_providers|inferenceProviders)\[\]\.provider$/, type: ['provider'], form: 'name' },
	{
		match: /^[^:]+:(.*\.)?(task_categories|size_categories|taskCategories|sizeCategories)$/,
		type: ['tag'],
		form: 'name',
	},
	// pagination
	{ match: /^[^:]+:(.*\.)?nextCursor$/, type: ['cursor'], form: 'cursor' },
	{ match: /^[^:]+:(.*\.)?nextOffset$/, type: ['offset'], form: 'offset' },
	// direct URLs (download or media)
	{ match: /^hf_dataset_structure:parquet\.files\[\]\.url$/, type: ['http_file'], form: 'https_url' },
	{ match: /^hf_space_invoke:media\[\]\.uri$/, type: ['http_file'], form: 'https_url' },
	{ match: /^hf_discussion_get:diffUrl$/, type: ['http_file'], form: 'https_url' },
	{
		match: /^[^:]+:(.*\.)?(avatarUrl|arxivUrl|projectPage|githubRepo|endpoint|serverUrl)$/,
		type: ['external_url'],
		form: 'https_url',
	},
	{ match: /^[^:]+:(.*\.)?(expose_urls|exposeUrls)$/, type: ['external_url'], form: 'https_url' },
	{ match: /^[^:]+:(.*\.)?socials$/, type: ['external_url'], form: 'https_url' },
	{
		match: /^[^:]+:(.*\.)?(paperswithcode_id|paperswithcodeId|subdomain|docker_image|dockerImage|image)$/,
		type: ['misc_id'],
		form: 'name',
	},
	// echoes of the caller's own value in batch error entries
	{ match: /^hf_(repo_info|paper_get):items\[\]\.ref$/, type: ['echo'], form: 'echo' },
	{ match: /^hf_profile_get:items\[\]\.ref$/, type: ['echo'], form: 'echo' },
	{ match: /^[^:]+:(.*\.)?(oid)$/, type: ['blob_oid'], form: 'sha' },
	{ match: /^[^:]+:(.*\.)?(owner|created_by)\.id$/, type: ['hub_internal_id'], form: 'id' },
	{ match: /^hf_discussion_get:comments\[\]\.id$/, type: ['hub_internal_id'], form: 'id' },
	{ match: /^hf_repo_list_files:path$/, type: ['repo_path'], form: 'path' },
	{ match: /^hf_(discussion_get:files|repo_write_files:changes)\[\]\.path$/, type: ['repo_path'], form: 'path' },
	{ match: /^[^:]+:(.*\.)?volumes\[\]\.(mount_path|mountPath|path)$/, type: ['mount_path'], form: 'path' },
	{ match: /^hf_repo_write_files:commit\.url$/, type: ['web_page'], form: 'https_url' },
	{ match: /^hf_repo_info:items\[\]\.inferenceProviders\[\]\.providerId$/, type: ['external_id'], form: 'name' },
	{
		// Token scopes: fine-grained entities and app-token entities (a repo ID or a user/org handle).
		match: /^hf_whoami:credential\.(fineGrained\.scoped\[\]\.entity|entities\[\])\.name$/,
		type: ['user', 'org', ...REPO_TYPES],
		form: 'name',
	},
	// tags that carry an arXiv ID (arxiv:2405.02730) link repositories to papers
	{ match: /^[^:]+:(.*\.)?tags$/, type: ['tag', 'paper'], form: 'tag' },
];

/** Output names that look like identifiers; every one must be covered by a record or a scalar producer. */
export const IDENTIFIER_NAME =
	/^(?!pretty_name$|full_?name$)(.*_)?(id|ids|uri|url|ref|refs|handle|name|slug|num|sha|oid|revision|cursor|path)$/;

// ---------------------------------------------------------------------------------------------
// Consumers: identifier arguments, what they should accept, and the extra arguments a dry run needs.
// ---------------------------------------------------------------------------------------------

const ALL_REPOS = REPO_TYPES;
const GIT_REPOS = ['repo:model', 'repo:dataset', 'repo:space'];

/**
 * `types`: resource types the argument names. `array`: argument is a list.
 * `extra`: other arguments for a valid dry-run call. `write`: needs a write token.
 */
export const CONSUMERS = [
	// discovery filters (bare IDs, uris tolerated)
	{ tool: 'hf_models_search', arg: 'idsAny', types: ['repo:model'], array: true },
	{ tool: 'hf_models_search', arg: 'baseModelsAll', types: ['repo:model'], array: true },
	{ tool: 'hf_models_search', arg: 'datasetsAny', types: ['repo:dataset'], array: true },
	{ tool: 'hf_models_search', arg: 'authorsAny', types: PEOPLE_TYPES, array: true },
	{ tool: 'hf_models_search', arg: 'papersAny', types: ['paper'], array: true },
	{ tool: 'hf_models_search', arg: 'task', types: ['task'] },
	{ tool: 'hf_models_search', arg: 'tagsAll', types: ['tag'], array: true },
	{ tool: 'hf_models_search', arg: 'librariesAll', types: ['library'], array: true },
	{ tool: 'hf_models_search', arg: 'licensesAll', types: ['license'], array: true },
	{ tool: 'hf_models_search', arg: 'languagesAll', types: ['language'], array: true },
	{ tool: 'hf_models_search', arg: 'providersAny', types: ['provider'], array: true },
	{ tool: 'hf_models_search', arg: 'cursor', types: ['cursor'] },
	{ tool: 'hf_datasets_search', arg: 'idsAny', types: ['repo:dataset'], array: true },
	{ tool: 'hf_datasets_search', arg: 'authorsAny', types: PEOPLE_TYPES, array: true },
	{ tool: 'hf_datasets_search', arg: 'papersAny', types: ['paper'], array: true },
	{ tool: 'hf_datasets_search', arg: 'tagsAll', types: ['tag'], array: true },
	{ tool: 'hf_datasets_search', arg: 'taskCategoriesAll', types: ['tag'], array: true },
	{ tool: 'hf_datasets_search', arg: 'cursor', types: ['cursor'] },
	{ tool: 'hf_datasets_search', arg: 'librariesAll', types: ['library'], array: true },
	{ tool: 'hf_datasets_search', arg: 'languagesAll', types: ['language'], array: true },
	{ tool: 'hf_datasets_search', arg: 'licensesAll', types: ['license'], array: true },
	{ tool: 'hf_spaces_list', arg: 'idsAny', types: ['repo:space'], array: true },
	{ tool: 'hf_spaces_list', arg: 'modelsAny', types: ['repo:model'], array: true },
	{ tool: 'hf_spaces_list', arg: 'datasetsAny', types: ['repo:dataset'], array: true },
	{ tool: 'hf_spaces_list', arg: 'authorsAny', types: PEOPLE_TYPES, array: true },
	{ tool: 'hf_spaces_list', arg: 'papersAny', types: ['paper'], array: true },
	{ tool: 'hf_spaces_list', arg: 'sdksAny', types: ['sdk'], array: true },
	{ tool: 'hf_spaces_list', arg: 'tagsAll', types: ['tag'], array: true },
	{ tool: 'hf_spaces_list', arg: 'hardwareCurrentAny', types: ['flavor'], array: true },
	{ tool: 'hf_spaces_list', arg: 'cursor', types: ['cursor'] },
	{ tool: 'hf_spaces_search', arg: 'tagsAny', types: ['tag'], array: true, extra: { query: 'audit' } },
	{ tool: 'hf_repo_fulltext_search', arg: 'idsAny', types: GIT_REPOS, array: true, extra: { query: 'audit' } },
	{ tool: 'hf_repo_fulltext_search', arg: 'authorsAny', types: PEOPLE_TYPES, array: true, extra: { query: 'audit' } },
	{ tool: 'hf_buckets_list', arg: 'owner', types: PEOPLE_TYPES },
	// repo family
	{ tool: 'hf_repo_info', arg: 'repos', types: ALL_REPOS, array: true },
	{ tool: 'hf_repo_info', arg: 'revision', types: ['revision'], extra: { repos: ['hf://models/acme/thing'] } },
	{ tool: 'hf_repo_list_files', arg: 'repo', types: [...ALL_REPOS, 'dir'] },
	{ tool: 'hf_repo_list_files', arg: 'revision', types: ['revision'], extra: { repo: 'hf://models/acme/thing' } },
	{ tool: 'hf_repo_paths_info', arg: 'repo', types: [...ALL_REPOS, 'file', 'dir'], extra: { paths: ['config.json'] } },
	{ tool: 'hf_repo_paths_info', arg: 'repo', types: ['file', 'dir'], label: 'repo (file uri, no paths)' },
	{
		tool: 'hf_repo_paths_info',
		arg: 'revision',
		types: ['revision'],
		extra: { ref: 'hf://models/acme/thing', paths: ['config.json'] },
	},
	{ tool: 'hf_repo_read_text', arg: 'uri', types: ['file'] },
	{ tool: 'hf_repo_read_image', arg: 'uri', types: ['file'], image: true },
	{ tool: 'hf_repo_history', arg: 'repo', types: GIT_REPOS },
	{ tool: 'hf_repo_history', arg: 'revision', types: ['revision'], extra: { repo: 'hf://models/acme/thing' } },
	{ tool: 'hf_dataset_structure', arg: 'dataset', types: ['repo:dataset'] },
	{
		tool: 'hf_dataset_structure',
		arg: 'config',
		types: ['dataset_config'],
		extra: { dataset: 'hf://datasets/acme/thing' },
	},
	{
		tool: 'hf_dataset_structure',
		arg: 'split',
		types: ['dataset_split'],
		extra: { dataset: 'hf://datasets/acme/thing' },
	},
	{ tool: 'hf_dataset_rows', arg: 'dataset', types: ['repo:dataset'], extra: { config: 'default', split: 'train' } },
	{
		tool: 'hf_dataset_rows',
		arg: 'config',
		types: ['dataset_config'],
		extra: { dataset: 'hf://datasets/acme/thing', split: 'train' },
	},
	{
		tool: 'hf_dataset_rows',
		arg: 'split',
		types: ['dataset_split'],
		extra: { dataset: 'hf://datasets/acme/thing', config: 'default' },
	},
	// papers, collections, docs
	{ tool: 'hf_paper_get', arg: 'papers', types: ['paper'], array: true },
	{ tool: 'hf_paper_read', arg: 'paper', types: ['paper'] },
	{ tool: 'hf_daily_papers', arg: 'submittedBy', types: ['user'] },
	{ tool: 'hf_collections_search', arg: 'contains', types: [...ALL_REPOS, 'paper'] },
	{ tool: 'hf_collections_search', arg: 'ownersAny', types: PEOPLE_TYPES, array: true },
	{ tool: 'hf_collection_get', arg: 'collection', types: ['collection'] },
	{ tool: 'hf_docs_read', arg: 'uri', types: ['doc'] },
	{ tool: 'hf_docs_search', arg: 'scope', types: ['doc'], extra: { query: 'audit' } },
	// spaces
	{ tool: 'hf_space_tools', arg: 'space', types: ['repo:space'] },
	{ tool: 'hf_space_invoke', arg: 'space', types: ['repo:space'], extra: { tool: 'predict' } },
	{ tool: 'hf_space_invoke', arg: 'tool', types: ['space_tool'], extra: { space: 'hf://spaces/acme/thing' } },
	// people
	{ tool: 'hf_profile_get', arg: 'handles', types: PEOPLE_TYPES, array: true },
	{ tool: 'hf_org_members', arg: 'handle', types: ['org'] },
	{ tool: 'hf_follow_graph', arg: 'handle', types: PEOPLE_TYPES },
	{ tool: 'hf_user_likes', arg: 'handle', types: ['user'] },
	{ tool: 'hf_repo_likers', arg: 'repo', types: GIT_REPOS },
	{ tool: 'hf_activity', arg: 'handle', types: PEOPLE_TYPES },
	{ tool: 'hf_discussions_list', arg: 'repo', types: GIT_REPOS },
	{ tool: 'hf_discussions_list', arg: 'owner', types: PEOPLE_TYPES },
	{ tool: 'hf_discussions_list', arg: 'author', types: ['user'], extra: { repo: 'hf://models/acme/thing' } },
	{ tool: 'hf_discussion_get', arg: 'discussion', types: [...GIT_REPOS, 'discussion'], extra: { num: 3 } },
	{ tool: 'hf_discussion_get', arg: 'num', types: ['discussion_num'], extra: { discussion: 'hf://models/acme/thing' } },
	// account
	{ tool: 'hf_repo_create', arg: 'repo', types: ALL_REPOS, write: true },
	{ tool: 'hf_repo_create', arg: 'source', types: GIT_REPOS, write: true, extra: { repo: 'hf://models/acme/copy' } },
	{
		tool: 'hf_repo_create',
		arg: 'flavor',
		types: ['flavor'],
		write: true,
		extra: { repo: 'hf://spaces/acme/app', sdk: 'gradio' },
	},
	{
		tool: 'hf_repo_write_files',
		arg: 'repo',
		types: ALL_REPOS,
		write: true,
		extra: { message: 'audit', changes: [{ op: 'put', path: 'a.txt', text: 'x' }] },
	},
	{
		tool: 'hf_repo_write_files',
		arg: 'parentCommit',
		types: ['revision'],
		write: true,
		extra: { repo: 'hf://models/acme/thing', message: 'audit', changes: [{ op: 'put', path: 'a.txt', text: 'x' }] },
	},
	// jobs
	{ tool: 'hf_job_run', arg: 'space', types: ['repo:space'], write: true, extra: { command: ['true'] } },
	{ tool: 'hf_job_run', arg: 'flavor', types: ['flavor'], write: true, extra: { command: ['true'] } },
	{ tool: 'hf_job_run', arg: 'namespace', types: PEOPLE_TYPES, write: true, extra: { command: ['true'] } },
	{
		tool: 'hf_job_run',
		arg: 'volumes',
		types: ALL_REPOS,
		array: true,
		mount: true,
		write: true,
		extra: { command: ['true'] },
	},
	{ tool: 'hf_job_run', arg: 'script', types: ['http_file'], write: true },
	{
		tool: 'hf_job_schedule',
		arg: 'space',
		types: ['repo:space'],
		write: true,
		extra: { schedule: '@daily', command: ['true'] },
	},
	{
		tool: 'hf_job_schedule',
		arg: 'flavor',
		types: ['flavor'],
		write: true,
		extra: { schedule: '@daily', command: ['true'] },
	},
	{
		tool: 'hf_job_schedule',
		arg: 'namespace',
		types: PEOPLE_TYPES,
		write: true,
		extra: { schedule: '@daily', command: ['true'] },
	},
	{
		tool: 'hf_job_schedule',
		arg: 'volumes',
		types: ALL_REPOS,
		array: true,
		mount: true,
		write: true,
		extra: { schedule: '@daily', command: ['true'] },
	},
	{ tool: 'hf_job_schedule', arg: 'script', types: ['http_file'], write: true, extra: { schedule: '@daily' } },
	{
		tool: 'hf_job_get',
		arg: 'namespace',
		types: PEOPLE_TYPES,
		auth: true,
		extra: { job: '68f0c0ffee0123456789abcd' },
	},
	{
		tool: 'hf_job_logs',
		arg: 'namespace',
		types: PEOPLE_TYPES,
		auth: true,
		extra: { job: '68f0c0ffee0123456789abcd' },
	},
	{
		tool: 'hf_job_cancel',
		arg: 'namespace',
		types: PEOPLE_TYPES,
		write: true,
		extra: { job: '68f0c0ffee0123456789abcd' },
	},
	{
		tool: 'hf_job_update',
		arg: 'namespace',
		types: PEOPLE_TYPES,
		write: true,
		extra: { job: '68f0c0ffee0123456789abcd', labels: {} },
	},
	{ tool: 'hf_jobs_list', arg: 'namespace', types: PEOPLE_TYPES, auth: true },
	{ tool: 'hf_job_get', arg: 'job', types: ['job'], auth: true },
	{
		tool: 'hf_job_get',
		arg: 'job',
		types: ['scheduled_job'],
		auth: true,
		extra: { kind: 'scheduled' },
		label: 'job (kind scheduled)',
	},
	{ tool: 'hf_job_get', arg: 'kind', types: ['job_kind'], auth: true, extra: { job: '68f0c0ffee0123456789abcd' } },
	{ tool: 'hf_job_logs', arg: 'job', types: ['job'], auth: true },
	{ tool: 'hf_job_cancel', arg: 'job', types: ['job'], write: true },
	{ tool: 'hf_job_update', arg: 'job', types: ['job'], write: true, extra: { labels: {} } },
	// sandboxes
	{ tool: 'hf_sandbox_create', arg: 'flavor', types: ['flavor'], write: true },
	{ tool: 'hf_sandbox_create', arg: 'bucket', types: ['repo:bucket'], write: true },
	{ tool: 'hf_sandbox_create', arg: 'namespace', types: PEOPLE_TYPES, write: true },
	{ tool: 'hf_sandbox_create', arg: 'volumes', types: ALL_REPOS, array: true, mount: true, write: true },
	{ tool: 'hf_sandbox_status', arg: 'sandbox', types: ['sandbox', 'job'], write: true },
	{ tool: 'hf_sandbox_exec', arg: 'sandbox', types: ['sandbox', 'job'], write: true, extra: { command: 'true' } },
	{ tool: 'hf_sandbox_terminate', arg: 'sandbox', types: ['sandbox', 'job'], write: true },
	{ tool: 'hf_sandbox_kill', arg: 'sandbox', types: ['sandbox', 'job'], write: true, extra: { process: 'proc-1' } },
	{ tool: 'hf_sandbox_fs_read', arg: 'sandbox', types: ['sandbox', 'job'], write: true, extra: { path: '/tmp/out' } },
	{
		tool: 'hf_sandbox_fs_write',
		arg: 'sandbox',
		types: ['sandbox', 'job'],
		write: true,
		extra: { path: '/tmp/out', text: 'x' },
	},
	{
		tool: 'hf_sandbox_kill',
		arg: 'process',
		types: ['process', 'process_tag'],
		write: true,
		extra: { sandbox: 'hfsb2:acme:68f0c0ffee0123456789abcd' },
	},
	{
		tool: 'hf_sandbox_fs_read',
		arg: 'path',
		types: ['sandbox_path'],
		write: true,
		extra: { sandbox: 'hfsb2:acme:68f0c0ffee0123456789abcd' },
	},
];

/**
 * Types a consumer is probed and linked with: its own, plus "file->repo" (a file or folder uri given
 * where a repository is expected) for single-repository arguments that do not take files already.
 */
export function effectiveTypes(consumer) {
	const types = [...consumer.types];
	if (
		consumer.types.includes('repo:model') &&
		!consumer.types.includes('file') &&
		!consumer.mount &&
		!/(_any|_all|^repo_ids)$/.test(consumer.arg)
	)
		types.push('file->repo');
	return types;
}

/** Producer types, plus "file->repo" for file/folder records. */
export function producerTypes(types) {
	return types.includes('file') || types.includes('dir') ? [...types, 'file->repo'] : types;
}

/**
 * Inputs that take free values (no producer expected). Matched on name, or `tool.arg`.
 * Anything not here and not in CONSUMERS is reported as unclassified.
 */
export const FREE_INPUTS = new Set([
	'query',
	'limit',
	'cursor',
	'offset',
	'splitsOffset',
	'schemaOffset',
	'max_bytes',
	'maxBytes',
	'maxCellChars',
	'sort',
	'direction',
	'fields',
	'include',
	'kind',
	'catalog',
	'kindsAny',
	'typesAny',
	'type',
	'mode',
	'op',
	'recursive',
	'expand',
	'glob',
	'path',
	'paths',
	'pathContains',
	'gated',
	'private',
	'scope',
	'group',
	'status',
	'relation',
	'adminsOnly',
	'includeSocials',
	'includeHistory',
	'includePrs',
	'includeFolderSize',
	'includeNonRunning',
	'mcpOnly',
	'runningOnly',
	'stagesAny',
	'stages',
	'source',
	'category',
	'product',
	'date',
	'week',
	'month',
	'tagsAnyGroups',
	'sizeCategoriesAll',
	'modalitiesAll',
	'formatsAll',
	'datasetType',
	'inference',
	'anyProvider',
	'numParametersMin',
	'numParametersMax',
	'numParametersAny',
	'createdAt',
	'baseModelRelationsAny',
	'baseModelRelation',
	'appsAny',
	'hardwareRequestedAny',
	'length',
	'where',
	'orderby',
	'search',
	'arguments',
	'comments_limit',
	'tail',
	'followSeconds',
	'waitSeconds',
	'changes',
	'message',
	'description',
	'createPr',
	'sdk',
	'sdksAny',
	'dependencies',
	'python',
	'scriptArgs',
	'command',
	'image',
	'timeout',
	'env',
	'secrets',
	'forwardHfToken',
	'labels',
	'resourceGroupId',
	'schedule',
	'suspend',
	'concurrency',
	'action',
	'lifetime',
	'name',
	'workdir',
	'stdin',
	'detach',
	'tag',
	'encoding',
	'text',
	'base64',
	'hf_sandbox_create.image',
	'hf_space_invoke.arguments',
	'hf_sandbox_exec.command',
	'hf_sandbox_fs_write.path',
	'hf_sandbox_fs_read.op',
	'hf_repo_write_files.revision',
]);

// ---------------------------------------------------------------------------------------------
// Concepts: one meaning, ideally one name. `preferred` is the name the report proposes.
// ---------------------------------------------------------------------------------------------

export const CONCEPTS = [
	{
		id: 'person_argument',
		side: 'in',
		preferred: 'handle / handles (or owner for ownership filters)',
		names: /^(user|users|handle|handles|org|orgs|entity|owner|owners|authors_any|author|namespace|submitter)$/,
	},
	{
		id: 'person_output',
		side: 'out',
		preferred: 'author (creator) / owner (owning namespace), plain handle string',
		names: /^(author|owner|actor|org|submitted_by|username|namespace|created_by)$/,
	},
	{
		id: 'repository_argument',
		side: 'in',
		preferred: 'ref / refs',
		names:
			/^(ref|refs|repo|dataset|space|contains|source|repo_ids|ids_any|models_any|datasets_any|base_models_all|bucket)$/,
		pathFilter: (f) => !(f.tool === 'hf_spaces_search' && f.name === 'source'),
	},
	{
		id: 'file_argument',
		side: 'in',
		preferred: 'uri',
		names: /^(uri|path|paths)$/,
	},
	{
		id: 'subject_record',
		side: 'out',
		preferred: 'one name for "the repository this result is about" (ref or repo)',
		names: /^(ref|repo|dataset|space)$/,
		pathFilter: (f) => f.depth === 1 && [...f.types].includes('object'),
	},
	{
		id: 'created_time',
		side: 'out',
		preferred: 'created_at',
		names: /^(created_at|createdAt|created|started_at|published_at|liked_at|time|submitted_on_daily_at)$/,
	},
	{
		id: 'modified_time',
		side: 'out',
		preferred: 'last_modified (or updated_at), one of them',
		names: /^(last_modified|lastModified|updated_at|last_updated|mtime|uploaded_at|date)$/,
	},
	{
		id: 'page_size',
		side: 'in',
		preferred: 'limit',
		names: /^(limit|length|comments_limit|tail|max_results|top_k)$/,
	},
	{
		id: 'byte_budget',
		side: 'in',
		preferred: 'max_bytes',
		names: /^(max_bytes|max_chars|max_length)$/,
	},
	{
		id: 'continuation',
		side: 'both',
		preferred: 'cursor/nextCursor (opaque) or offset/nextOffset (byte/row)',
		names: /^(cursor|nextCursor|offset|nextOffset|page|next_page)$/,
	},
	{
		id: 'count_of_returned',
		side: 'out',
		preferred: 'returnedCount',
		names: /^(returnedCount|count|num_results)$/,
	},
	{
		id: 'total_count',
		side: 'out',
		preferred: '<thing>_total or total_<thing>, one pattern',
		names: /(^total$|_total$|^total_|^num_|_count$|^estimated_total)/,
		pathFilter: (f) => f.name !== 'returnedCount',
	},
	{
		id: 'byte_size',
		side: 'out',
		preferred: 'size (bytes) / *_bytes, one pattern',
		names: /^(size|bytes|total_bytes|used_storage|parquet_bytes|memory_bytes|original_bytes)$/,
	},
	{
		id: 'hardware',
		side: 'both',
		preferred: 'flavor',
		names: /^(flavor|hardware|requested_hardware|hardware_current_any|hardware_requested_any|accelerator)$/,
	},
	{
		id: 'discriminator',
		side: 'in',
		preferred: 'kind/kinds for resource type; type/types for event or entry type',
		names: /^(kind|kinds|type|types|mode|scope|op|action|relation|dataset_type)$/,
	},
	{
		id: 'comment_count',
		side: 'out',
		preferred: 'comment_count',
		names: /^(comments|comment_count|num_comments)$/,
		pathFilter: (f) => !normalizedTypesInclude(f, 'array'),
	},
	{
		id: 'short_text',
		side: 'out',
		preferred: 'description (long) / summary (one line)',
		names: /^(description|short_description|ai_short_description|bio|ai_summary|summary|excerpt|note)$/,
	},
	{
		id: 'error_entry',
		side: 'out',
		preferred: '{ref|handle, error: code, message} (one shape)',
		names: /^(error|message)$/,
		pathFilter: (f) => f.depth <= 2 && f.parent.startsWith('items'),
	},
];

function normalizedTypesInclude(field, prefix) {
	return [...field.types].some((t) => t.startsWith(prefix));
}

// ---------------------------------------------------------------------------------------------
// Chains a model should be able to follow. Each hop: producer `tool:path` -> consumer `tool.arg`.
// ---------------------------------------------------------------------------------------------

export const CHAINS = [
	{
		id: 'search-inspect-read',
		title: 'models search -> repo info -> list files -> read file -> history',
		hops: [
			['hf_models_search:items[].uri', 'hf_repo_info.repos'],
			['hf_repo_info:items[].uri', 'hf_repo_list_files.repo'],
			['hf_repo_list_files:items[].uri', 'hf_repo_read_text.uri'],
			['hf_repo_read_text:uri', 'hf_repo_history.repo'],
			['hf_repo_history:items[].id', 'hf_repo_list_files.revision'],
		],
	},
	{
		id: 'lineage',
		title: 'model -> base model / training dataset -> dataset structure -> rows',
		hops: [
			['hf_repo_info:items[].baseModels[].uri', 'hf_repo_info.repos'],
			['hf_repo_info:items[].datasets[].uri', 'hf_dataset_structure.dataset'],
			['hf_dataset_structure:splits[].config', 'hf_dataset_rows.config'],
			['hf_dataset_structure:splits[].split', 'hf_dataset_rows.split'],
		],
	},
	{
		id: 'papers-repos',
		title: 'paper <-> models/datasets/spaces',
		hops: [
			['hf_papers_search:items[].uri', 'hf_paper_get.papers'],
			['hf_paper_get:items[].linked.models.items[].uri', 'hf_repo_info.repos'],
			['hf_paper_get:items[].id', 'hf_models_search.papersAny'],
			['hf_repo_info:items[].tags', 'hf_paper_get.papers'],
			['hf_paper_get:items[].uri', 'hf_collections_search.contains'],
			['hf_repo_info:items[].tags', 'hf_models_search.papersAny'],
		],
	},
	{
		id: 'collections',
		title: 'collections <-> items',
		hops: [
			['hf_repo_info:items[].uri', 'hf_collections_search.contains'],
			['hf_collections_search:items[].uri', 'hf_collection_get.collection'],
			['hf_collection_get:items[].uri', 'hf_repo_info.repos'],
			['hf_collection_get:items[].uri', 'hf_paper_get.papers'],
			['hf_collection_get:items[].uri', 'hf_collection_get.collection'],
			['hf_collection_get:owner', 'hf_profile_get.handles'],
		],
	},
	{
		id: 'people',
		title: 'people -> repos -> discussions -> discussion',
		hops: [
			['hf_models_search:items[].author', 'hf_profile_get.handles'],
			['hf_profile_get:items[].uri', 'hf_follow_graph.handle'],
			['hf_follow_graph:items[].uri', 'hf_user_likes.handle'],
			['hf_user_likes:items[].uri', 'hf_repo_likers.repo'],
			['hf_repo_likers:items[].uri', 'hf_profile_get.handles'],
			['hf_profile_get:items[].organizations[].uri', 'hf_org_members.handle'],
			['hf_org_members:items[].uri', 'hf_activity.handle'],
			['hf_activity:items[].target.uri', 'hf_repo_info.repos'],
			['hf_repo_info:items[].uri', 'hf_discussions_list.repo'],
			['hf_discussions_list:items[].repo.uri', 'hf_discussion_get.discussion'],
			['hf_discussions_list:items[].num', 'hf_discussion_get.num'],
			['hf_discussions_list:items[].uri', 'hf_discussion_get.discussion'],
			['hf_discussion_get:author', 'hf_profile_get.handles'],
			['hf_daily_papers:items[].submittedBy', 'hf_daily_papers.submittedBy'],
			// documented as "accepted by every handle argument"
			['hf_profile_get:items[].uri', 'hf_models_search.authorsAny'],
			['hf_profile_get:items[].organizations[].uri', 'hf_buckets_list.owner'],
			['hf_org_members:items[].uri', 'hf_collections_search.ownersAny'],
			['hf_follow_graph:items[].uri', 'hf_repo_fulltext_search.authorsAny'],
			['hf_repo_likers:items[].uri', 'hf_daily_papers.submittedBy'],
			['hf_repo_likers:items[].uri', 'hf_discussions_list.author'],
			// discussion record identity
			['hf_discussions_list:items[].id', 'hf_discussion_get.discussion'],
			['hf_activity:items[].discussion.url', 'hf_discussion_get.discussion'],
			// a file uri where a repository is expected
			['hf_repo_list_files:items[].uri', 'hf_discussions_list.repo'],
			['hf_repo_list_files:items[].uri', 'hf_repo_likers.repo'],
		],
	},
	{
		id: 'spaces',
		title: 'space search -> tools -> invoke',
		hops: [
			['hf_spaces_search:items[].uri', 'hf_space_tools.space'],
			['hf_space_tools:tools[].name', 'hf_space_invoke.tool'],
			['hf_spaces_list:items[].models[].id', 'hf_spaces_list.modelsAny'],
			['hf_repo_info:items[].spaces[].uri', 'hf_space_tools.space'],
		],
	},
	{
		id: 'jobs',
		title: 'jobs: flavor -> run -> get/logs/cancel; scheduled',
		hops: [
			['hf_hardware_flavors:items[].id', 'hf_job_run.flavor'],
			['hf_whoami:organizations[].name', 'hf_job_run.namespace'],
			['hf_job_run:job.id', 'hf_job_logs.job'],
			['hf_job_run:job.url', 'hf_job_get.job'],
			['hf_jobs_list:items[].id', 'hf_job_cancel.job'],
			['hf_jobs_list:items[].kind', 'hf_job_get.kind'],
			['hf_whoami:organizations[].name', 'hf_jobs_list.namespace'],
			['hf_job_schedule:scheduledJob.id', 'hf_job_get.job (kind scheduled)'],
		],
	},
	{
		id: 'sandbox',
		title: 'sandbox handle -> exec -> process -> kill',
		hops: [
			['hf_sandbox_create:id', 'hf_sandbox_exec.sandbox'],
			['hf_sandbox_create:jobId', 'hf_sandbox_status.sandbox'],
			['hf_sandbox_create:url', 'hf_sandbox_status.sandbox'],
			['hf_sandbox_exec:process.id', 'hf_sandbox_kill.process'],
			['hf_sandbox_fs_read:items[].id', 'hf_sandbox_fs_read.path'],
			['hf_buckets_list:items[].uri', 'hf_sandbox_create.bucket'],
		],
	},
	{
		id: 'discovery-misc',
		title: 'lookup / fulltext / trending / docs',
		hops: [
			['hf_hub_lookup:items[].uri', 'hf_repo_info.repos'],
			['hf_hub_lookup:items[].uri', 'hf_profile_get.handles'],
			['hf_repo_fulltext_search:items[].fileUri', 'hf_repo_read_text.uri'],
			['hf_repo_fulltext_search:items[].uri', 'hf_repo_fulltext_search.idsAny'],
			['hf_buckets_list:items[].uri', 'hf_collections_search.contains'],
			['hf_trending:items[].uri', 'hf_repo_info.repos'],
			['hf_docs_search:items[].uri', 'hf_docs_read.uri'],
			['hf_buckets_list:items[].uri', 'hf_repo_list_files.repo'],
			['hf_repo_write_files:changes[].file.uri', 'hf_repo_read_text.uri'],
			['hf_repo_create:repo.uri', 'hf_repo_write_files.repo'],
		],
	},
];
