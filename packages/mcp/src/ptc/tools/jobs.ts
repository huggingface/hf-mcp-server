import { z } from 'zod';
import { completenessSchema } from '../core/completeness.js';
import { definePtcTool, DESTRUCTIVE, READ_ONLY, type PtcContext, type PtcTool } from '../core/tool.js';
import { PtcError } from '../core/errors.js';
import { hubFetch, openCursor, requestPage, sealCursor } from '../core/hub-http.js';
import { parseRef, personRefSchema, refSchema } from '../core/refs.js';
import { createJobSpec } from '../../jobs/commands/utils.js';
import { resolveUvCommand, UV_DEFAULT_IMAGE } from '../../jobs/commands/uv-utils.js';
import {
	collectSensitiveValues,
	redactSensitiveText,
	toHfJobOutput,
	toHfScheduledJobOutput,
} from '../../jobs/jobs-output.js';
import type { HfJobOutput, HfScheduledJobOutput } from '../../jobs/hf-jobs-output-schema.js';
import { fetchJobLogs } from '../../jobs/sse-handler.js';
import {
	jobLabelsSchema,
	jobLogTailSchema,
	type JobInfo,
	type JobSpec,
	type ScheduledJobInfo,
} from '../../jobs/types.js';

/*
 * Jobs are not hf:// resources (see toolset_v2 NOT_HF_URI): records carry kind, id,
 * namespace and the web url. Env/secret values and hfToken fields are never returned:
 * toHfJobOutput/toHfScheduledJobOutput allowlist fields and keep only variable names.
 */

const STAGES = ['RUNNING', 'SCHEDULING', 'COMPLETED', 'ERROR', 'CANCELED', 'DELETED'] as const;
const MAX_WAIT_SECONDS = 120;
const MAX_LOG_CHARS = 80_000;
const MAX_LINE_CHARS = 4_000;

// ------------------------------------------------------------------ shared helpers

function requireToken(ctx: PtcContext): string {
	if (!ctx.hfToken) throw new PtcError('AUTH_REQUIRED', 'a Hugging Face token is required for Jobs.');
	return ctx.hfToken;
}

const namespaceSchema = personRefSchema('User or org owning the jobs (name or profile uri; default: you).').optional();

async function resolveNamespace(namespace: string | undefined, ctx: PtcContext): Promise<string> {
	requireToken(ctx);
	if (namespace) return namespace;
	if (ctx.username) return ctx.username;
	const { data } = await hubFetch({ path: '/api/whoami-v2', subject: 'whoami' }, ctx);
	const name = (data as { name?: unknown } | undefined)?.name;
	if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) {
		throw new PtcError('UPSTREAM_RESPONSE', 'could not determine the token owner; pass namespace.');
	}
	return name;
}

const jobIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.describe('Job ID as returned by hf_job_run/hf_jobs_list (or the job page URL).');

/** Accept a bare ID or https://huggingface.co/jobs/NS/ID (which also fixes the namespace). */
function parseJobId(jobId: string, namespace: string | undefined): { id: string; namespace?: string } {
	const url = /^https:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\/jobs\/([\w.-]+)\/([\w-]+)\/?$/.exec(jobId);
	if (url?.[1] && url[2]) {
		if (namespace && namespace !== url[1])
			throw new PtcError('INVALID_ARGUMENT', 'namespace conflicts with the job URL.');
		return { id: url[2], namespace: url[1] };
	}
	if (!/^[\w-]{1,128}$/.test(jobId)) throw new PtcError('INVALID_ARGUMENT', 'invalid job.');
	return { id: jobId, ...(namespace ? { namespace } : {}) };
}

/** Accepts the record kind verbatim (job | scheduled_job) and the short form scheduled. */
const kindSchema = z
	.enum(['job', 'scheduled_job', 'scheduled'])
	.default('job')
	.transform((kind): 'job' | 'scheduled' => (kind === 'job' ? 'job' : 'scheduled'))
	.describe('Record kind: job (one run) or scheduled_job (recurring; scheduled works).');

function jobUrl(namespace: string, id: string): string {
	return `https://huggingface.co/jobs/${encodeURIComponent(namespace)}/${encodeURIComponent(id)}`;
}

const statusSchema = z
	.object({
		stage: z.string(),
		message: z.string().nullable().optional(),
		exposeUrls: z.array(z.string()).optional(),
	})
	.strict();

const jobRecordSchema = z
	.object({
		kind: z.literal('job'),
		id: z.string(),
		namespace: z.string(),
		// Job page on huggingface.co.
		url: z.string(),
		endpoint: z.string().optional(),
		createdAt: z.string(),
		finishedAt: z.string().optional(),
		dockerImage: z.string().optional(),
		spaceId: z.string().optional(),
		command: z.array(z.string()).optional(),
		arguments: z.array(z.string()).optional(),
		environmentVariableNames: z.array(z.string()),
		secretNames: z.array(z.string()),
		flavor: z.string(),
		status: statusSchema,
		// User or org that owns the job.
		owner: z.string(),
		// User who started the job.
		createdBy: z.string().optional(),
		tags: z.array(z.string()).optional(),
		labels: z.record(z.string(), z.string()).optional(),
		timeoutSeconds: z.number().optional(),
	})
	.strict();

const volumeSchema = z
	.object({
		kind: z.enum(['bucket', 'model', 'dataset', 'space']),
		source: z.string(),
		mountPath: z.string(),
		revision: z.string().optional(),
		readOnly: z.boolean().optional(),
		path: z.string().optional(),
	})
	.strict();

const scheduledRecordSchema = z
	.object({
		kind: z.literal('scheduled_job'),
		id: z.string(),
		namespace: z.string(),
		schedule: z.string(),
		suspended: z.boolean(),
		lastRunAt: z.string().optional(),
		nextRunAt: z.string().optional(),
		owner: z.string(),
		createdAt: z.string(),
		// Whether runs may overlap.
		concurrency: z.boolean().optional(),
		jobSpec: z
			.object({
				dockerImage: z.string().optional(),
				spaceId: z.string().optional(),
				// Absent when the image's default command runs.
				command: z.array(z.string()).optional(),
				arguments: z.array(z.string()).optional(),
				environmentVariableNames: z.array(z.string()),
				secretNames: z.array(z.string()),
				flavor: z.string(),
				timeoutSeconds: z.number().optional(),
				volumes: z.array(volumeSchema).optional(),
				labels: z.record(z.string(), z.string()).optional(),
				exposedPorts: z.array(z.number().int()).optional(),
			})
			.strict(),
	})
	.strict();
type JobRecord = z.input<typeof jobRecordSchema>;
type ScheduledRecord = z.input<typeof scheduledRecordSchema>;

/** Defined fields only: the legacy output omits absent optionals, and so do PTC records. */
function defined<T extends Record<string, unknown>>(record: T): T {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

/** camelCase PTC record from the (redacted, allowlisted) legacy hf_jobs output; people as name strings. */
function ptcJob(out: HfJobOutput, namespace: string): JobRecord {
	return defined({
		kind: 'job' as const,
		id: out.id,
		namespace,
		url: jobUrl(namespace, out.id),
		endpoint: out.endpoint,
		createdAt: out.created_at,
		finishedAt: out.finished_at,
		dockerImage: out.docker_image,
		spaceId: out.space_id,
		command: out.command,
		arguments: out.arguments,
		environmentVariableNames: out.environment_variable_names,
		secretNames: out.secret_names,
		flavor: out.flavor,
		status: defined({ stage: out.status.stage, message: out.status.message, exposeUrls: out.status.expose_urls }),
		owner: out.owner.name,
		createdBy: out.created_by?.name,
		tags: out.tags,
		labels: out.labels,
		timeoutSeconds: out.timeout_seconds,
	});
}

function ptcScheduled(out: HfScheduledJobOutput, namespace: string, concurrency: unknown): ScheduledRecord {
	const spec = out.job_spec;
	return defined({
		kind: 'scheduled_job' as const,
		id: out.id,
		namespace,
		schedule: out.schedule,
		suspended: out.suspended,
		lastRunAt: out.last_run,
		nextRunAt: out.next_run,
		owner: out.owner.name,
		createdAt: out.created_at,
		concurrency: typeof concurrency === 'boolean' ? concurrency : undefined,
		jobSpec: defined({
			dockerImage: spec.docker_image,
			spaceId: spec.space_id,
			command: spec.command,
			arguments: spec.arguments,
			environmentVariableNames: spec.environment_variable_names,
			secretNames: spec.secret_names,
			flavor: spec.flavor,
			timeoutSeconds: spec.timeout_seconds,
			volumes: spec.volumes?.map((volume) =>
				defined({
					kind: volume.type,
					source: volume.source,
					mountPath: volume.mount_path,
					revision: volume.revision,
					readOnly: volume.read_only,
					path: volume.path,
				})
			),
			labels: spec.labels,
			exposedPorts: spec.exposed_ports,
		}),
	});
}

function isJob(value: unknown): value is JobInfo {
	const job = value as Partial<JobInfo> | null;
	return Boolean(
		job &&
		typeof job === 'object' &&
		typeof job.id === 'string' &&
		typeof job.status?.stage === 'string' &&
		typeof job.owner?.name === 'string'
	);
}
function isScheduled(value: unknown): value is ScheduledJobInfo {
	const job = value as Partial<ScheduledJobInfo> | null;
	return Boolean(
		job &&
		typeof job === 'object' &&
		typeof job.id === 'string' &&
		typeof job.owner?.name === 'string' &&
		typeof job.jobSpec === 'object' &&
		job.jobSpec !== null &&
		// command is absent when the schedule runs the image's default command (OpenAPI: optional).
		(job.jobSpec.command === undefined || Array.isArray(job.jobSpec.command))
	);
}

function jobRecord(raw: unknown, namespace: string, extraSensitive: readonly (string | undefined)[] = []): JobRecord {
	if (!isJob(raw)) throw new PtcError('UPSTREAM_RESPONSE', 'malformed job object from the Hub.');
	const sensitive = collectSensitiveValues(raw, extraSensitive);
	return ptcJob(toHfJobOutput(raw, undefined, sensitive), raw.owner.name || namespace);
}

function scheduledRecord(
	raw: unknown,
	namespace: string,
	extraSensitive: readonly (string | undefined)[] = []
): ScheduledRecord {
	if (!isScheduled(raw)) throw new PtcError('UPSTREAM_RESPONSE', 'malformed scheduled job object from the Hub.');
	const sensitive = collectSensitiveValues(raw.jobSpec, extraSensitive);
	const concurrency = (raw as { concurrency?: unknown }).concurrency;
	return ptcScheduled(toHfScheduledJobOutput(raw, sensitive), raw.owner.name || namespace, concurrency);
}

function jobsPath(kind: 'job' | 'scheduled', namespace: string, id?: string, action?: string): string {
	const root = kind === 'job' ? 'jobs' : 'scheduled-jobs';
	return [
		`/api/${root}`,
		encodeURIComponent(namespace),
		...(id ? [encodeURIComponent(id)] : []),
		...(action ? [action] : []),
	].join('/');
}

async function getRaw(kind: 'job' | 'scheduled', namespace: string, id: string, ctx: PtcContext): Promise<unknown> {
	const { data } = await hubFetch(
		{ path: jobsPath(kind, namespace, id), subject: kind === 'job' ? 'job' : 'scheduled job' },
		ctx
	);
	return data;
}

// ------------------------------------------------------------------ job spec (run + schedule)

const specFields = {
	script: z
		.string()
		.min(1)
		.max(200_000)
		.optional()
		.describe('Python code for uv, a URL or a .py path in the image. Not with command.'),
	dependencies: z
		.array(z.string().min(1).max(256))
		.max(100)
		.optional()
		.describe('Extra pip packages for script (uv --with).'),
	python: z.string().max(16).optional().describe('Python version for script, e.g. "3.12".'),
	scriptArgs: z.array(z.string().max(4096)).max(100).optional().describe('Arguments passed to script.'),
	command: z
		.union([z.array(z.string().max(100_000)).min(1).max(200), z.string().min(1).max(100_000)])
		.optional()
		.describe('argv, no shell, e.g. ["/bin/sh", "-lc", "cmd | cmd"]. Not with script.'),
	image: z
		.string()
		.min(1)
		.max(512)
		.optional()
		.describe('Docker image (default python:3.12 for command, a uv image for script).'),
	space: refSchema.optional().describe('Use the Docker image of this Space instead of image.'),
	flavor: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.default('cpu-basic')
		.describe('Flavor (hf_hardware_flavors items[].id), e.g. cpu-basic, t4-small, h200.'),
	timeout: z
		.union([z.string().max(16), z.number().int().positive()])
		.default('30m')
		.describe('Maximum run time: "30m", "2h", "90s" or seconds.'),
	env: z
		.record(z.string().max(256), z.string().max(65_536))
		.optional()
		.describe('Environment variables (values never echoed).'),
	secrets: z
		.record(z.string().max(256), z.string().max(65_536))
		.optional()
		.describe('Secret env variables (never echoed). "$HF_TOKEN" needs forwardHfToken.'),
	forwardHfToken: z
		.boolean()
		.default(false)
		.describe('Pass your token to the job as secret HF_TOKEN; enables "$HF_TOKEN" in secrets.'),
	volumes: z
		.array(z.string().max(1024))
		.max(20)
		.optional()
		.describe('FUSE (~80 MB/s; repos ro, buckets rw): "hf://datasets/o/d[@rev][/p]:/data:ro".'),
	labels: jobLabelsSchema.optional().describe('Labels (keys/values: max 100 chars, letters, digits, - and _).'),
	namespace: namespaceSchema,
	resourceGroupId: z.string().max(128).optional().describe('Enterprise resource group for billing (needs namespace).'),
};

const specObject = z.object(specFields);
type SpecInput = z.output<typeof specObject>;

const TOKEN_PLACEHOLDER = /^\$(?:HF_TOKEN|\{HF_TOKEN\})$/;

/**
 * The "$HF_TOKEN" placeholder becomes the caller's token, so it is honoured only where the caller
 * opted in: as a secrets value with forwardHfToken true. Env values are stored and shown in
 * plain text on the job, so the placeholder is never substituted there.
 */
function checkTokenPlaceholders(input: SpecInput): void {
	const envKey = Object.entries(input.env ?? {}).find(([, value]) => TOKEN_PLACEHOLDER.test(value))?.[0];
	if (envKey !== undefined) {
		throw new PtcError(
			'INVALID_ARGUMENT',
			`env ${envKey}: "$HF_TOKEN" is not substituted in env (env values are visible on the job). Use forwardHfToken: true, or put it in secrets with forwardHfToken: true.`
		);
	}
	const secretKey = Object.entries(input.secrets ?? {}).find(([, value]) => TOKEN_PLACEHOLDER.test(value))?.[0];
	if (secretKey !== undefined && !input.forwardHfToken) {
		throw new PtcError(
			'INVALID_ARGUMENT',
			`secrets ${secretKey}: "$HF_TOKEN" is replaced with your token only when forwardHfToken is true.`
		);
	}
}

function buildSpec(input: SpecInput, ctx: PtcContext): JobSpec {
	const token = requireToken(ctx);
	if ((input.script === undefined) === (input.command === undefined)) {
		throw new PtcError('INVALID_ARGUMENT', 'pass exactly one of script or command.');
	}
	if (input.space && input.image) throw new PtcError('INVALID_ARGUMENT', 'pass image or space, not both.');
	if (input.command !== undefined && (input.dependencies || input.python || input.scriptArgs)) {
		throw new PtcError('INVALID_ARGUMENT', 'dependencies, python and scriptArgs only apply to script.');
	}
	if (input.resourceGroupId && !input.namespace) {
		throw new PtcError('INVALID_ARGUMENT', 'resourceGroupId requires the owning organization as namespace.');
	}
	let image = input.image ?? (input.script !== undefined ? UV_DEFAULT_IMAGE : 'python:3.12');
	if (input.space) {
		const parsed = parseRef(input.space, 'space');
		if (parsed.kind !== 'space' || parsed.path) throw new PtcError('INVALID_ARGUMENT', 'space must reference a Space.');
		image = `https://huggingface.co/spaces/${parsed.id}`;
	}
	const command =
		input.script !== undefined
			? resolveUvCommand({
					script: input.script,
					with_deps: input.dependencies,
					python: input.python,
					script_args: input.scriptArgs,
				})
			: (input.command ?? []);
	checkTokenPlaceholders(input);
	const secrets = input.forwardHfToken ? { ...input.secrets, HF_TOKEN: '$HF_TOKEN' } : input.secrets;
	try {
		return createJobSpec({
			image,
			command,
			flavor: input.flavor,
			env: input.env,
			secrets,
			timeout: String(input.timeout),
			// createJobSpec swaps a "$HF_TOKEN" value for this token: only when the caller opted in.
			...(input.forwardHfToken ? { hfToken: token } : {}),
			volumes: input.volumes,
			resourceGroupId: input.resourceGroupId,
			labels: input.labels,
		});
	} catch (error) {
		// createJobSpec errors describe the caller's own arguments (volume, timeout, command syntax).
		const message = error instanceof Error ? redactSensitiveText(error.message, [token]) : 'invalid job spec.';
		throw new PtcError('INVALID_ARGUMENT', message.slice(0, 500));
	}
}

// ------------------------------------------------------------------ logs

interface LogsResult {
	lines: string[];
	finished: boolean;
	followStopped: boolean;
	linesTruncated: boolean;
}

interface CollectLogsIdleOptions {
	idleTimeoutMs?: number;
	initialIdleTimeoutMs?: number;
}

async function collectLogs(
	namespace: string,
	id: string,
	seconds: number,
	tail: number,
	sensitive: readonly string[],
	ctx: PtcContext,
	idleOptions?: CollectLogsIdleOptions
): Promise<LogsResult> {
	let step = 0;
	// Ask upstream for tail + 5 so retry banners (`===== Job started`) do not starve the requested tail
	// and >tail truncation remains observable without replaying megabytes from line 1.
	const logsPath = `${jobsPath('job', namespace, id, 'logs')}?tail=${String(tail + 5)}`;
	// Lines are redacted, cut and budgeted while streaming (never buffered in full, never cut before redaction).
	const result = await fetchJobLogs(`https://huggingface.co${logsPath}`, {
		token: ctx.hfToken,
		maxDuration: seconds * 1000,
		maxLines: tail,
		maxChars: MAX_LOG_CHARS,
		maxLineChars: MAX_LINE_CHARS,
		redact: (text) => redactSensitiveText(text, sensitive),
		...(idleOptions?.idleTimeoutMs !== undefined ? { idleTimeoutMs: idleOptions.idleTimeoutMs } : {}),
		...(idleOptions?.initialIdleTimeoutMs !== undefined
			? { initialIdleTimeoutMs: idleOptions.initialIdleTimeoutMs }
			: {}),
		...(ctx.signal ? { signal: ctx.signal } : {}),
		onProgress: ctx.onProgress
			? (progress) =>
					ctx.onProgress?.({
						progress: progress.progress ?? ++step,
						...(progress.message ? { message: progress.message } : {}),
					})
			: undefined,
	});
	return {
		lines: result.logs,
		finished: result.finished,
		followStopped: result.truncated,
		linesTruncated: result.linesDropped,
	};
}

const logsSchema = z
	.object({
		lines: z.array(z.string()),
		finished: z.boolean(),
		followStopped: z.boolean().describe('Time limit reached; the job may still be running.'),
		linesTruncated: z
			.boolean()
			.describe('True if older lines were dropped (>tail or >80 KB) or any line exceeded 4,000 chars.'),
	})
	.strict();

// ------------------------------------------------------------------ hf_job_run

const runInput = specObject
	.extend({
		waitSeconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_WAIT_SECONDS)
			.default(0)
			.describe('Follow logs N sec (0: return at once for parallel launch; max 120, 100 lines).'),
	})
	.strict();
const runOutput = z
	.object({
		job: jobRecordSchema,
		logs: logsSchema.optional(),
		// Set when submission succeeded but optional follow-up was unavailable; the text says so.
		note: z.string().optional(),
	})
	.strict();

function checkSubmissionCancellation(ctx: PtcContext, error: unknown, id: string): void {
	if (ctx.signal?.aborted || (error instanceof PtcError && error.code === 'CANCELLED')) {
		throw new PtcError('CANCELLED', `Request cancelled after job ${id} was submitted; do not resubmit it.`);
	}
}

async function jobRun(input: z.output<typeof runInput>, ctx: PtcContext): Promise<z.input<typeof runOutput>> {
	const namespace = await resolveNamespace(input.namespace, ctx);
	const spec = buildSpec(input, ctx);
	const sensitive = collectSensitiveValues(spec, [ctx.hfToken]);
	const { data } = await hubFetch(
		{ path: jobsPath('job', namespace), method: 'POST', body: spec, subject: 'job run' },
		ctx
	);
	const job = await submittedJob(data, namespace, sensitive, ctx);
	let logs: LogsResult | undefined;
	// Only the POST creates a job. Do not turn an optional follow-up failure into a retry of that POST.
	try {
		await ctx.onProgress?.({ progress: 0, message: `Job ${job.id} submitted (${job.status.stage}).` });
		ctx.signal?.throwIfAborted();
		if (input.waitSeconds === 0) return { job };
		logs = await collectLogs(job.namespace, job.id, input.waitSeconds, 100, sensitive, ctx);
		const refreshed = jobRecord(await getRaw('job', job.namespace, job.id, ctx), namespace, sensitive);
		return { job: refreshed, logs };
	} catch (error) {
		checkSubmissionCancellation(ctx, error, job.id);
		if (logs) return { job, logs, note: 'Job submitted, but status refresh failed; check it with hf_job_get.' };
		return {
			job,
			note: 'Job submitted, but log or progress reporting failed. Use hf_job_logs with the returned job URL; do not resubmit.',
		};
	}
}

/**
 * The run is billed once the POST succeeds: an unreadable response must not read as a failed call
 * (the caller would resubmit). Read the job back by id, or fail with the id and a do-not-retry note.
 */
async function submittedJob(
	data: unknown,
	namespace: string,
	sensitive: readonly string[],
	ctx: PtcContext
): Promise<JobRecord> {
	if (isJob(data)) return jobRecord(data, namespace, sensitive);
	const id = (data as { id?: unknown } | null)?.id;
	if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) {
		throw new PtcError(
			'UPSTREAM_RESPONSE',
			'the job was probably submitted but the Hub response was unreadable; check hf_jobs_list before running it again.'
		);
	}
	try {
		return jobRecord(await getRaw('job', namespace, id, ctx), namespace, sensitive);
	} catch (error) {
		checkSubmissionCancellation(ctx, error, id);
		throw new PtcError(
			'UPSTREAM_RESPONSE',
			`job ${id} was submitted but could not be read back; do not run it again, check it with hf_job_get.`
		);
	}
}

// ------------------------------------------------------------------ hf_job_schedule

const scheduleSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.describe('Cron expression ("0 9 * * 1") or @hourly, @daily, @weekly, @monthly, @yearly.');

const scheduleInput = z
	.object({
		schedule: scheduleSchema,
		...specObject.shape,
		suspend: z.boolean().default(false).describe('Create suspended (no runs until resumed).'),
		concurrency: z.boolean().default(false).describe('Allow a new run while the previous one is still running.'),
	})
	.strict();
const scheduleOutput = z.object({ scheduledJob: scheduledRecordSchema }).strict();

async function jobSchedule(
	input: z.output<typeof scheduleInput>,
	ctx: PtcContext
): Promise<z.input<typeof scheduleOutput>> {
	const namespace = await resolveNamespace(input.namespace, ctx);
	const spec = buildSpec(input, ctx);
	const { data } = await hubFetch(
		{
			path: jobsPath('scheduled', namespace),
			method: 'POST',
			body: { schedule: input.schedule, suspend: input.suspend, concurrency: input.concurrency, jobSpec: spec },
			subject: 'scheduled job',
		},
		ctx
	);
	return { scheduledJob: scheduledRecord(data, namespace, collectSensitiveValues(spec, [ctx.hfToken])) };
}

// ------------------------------------------------------------------ hf_jobs_list

const listInput = z
	.object({
		kind: kindSchema,
		stagesAny: z.array(z.enum(STAGES)).max(6).optional().describe('Only jobs in these stages (kind job only).'),
		labels: jobLabelsSchema.optional().describe('Only jobs having all these labels.'),
		namespace: namespaceSchema,
		limit: z.number().int().min(1).max(100).default(20).describe('Page size (1-100, default 20).'),
		cursor: z.string().max(16_384).optional().describe('nextCursor from a previous call.'),
	})
	.strict();
const listOutput = z
	.object({
		items: z.array(z.union([jobRecordSchema, scheduledRecordSchema])),
		returnedCount: z.number().int(),
		nextCursor: z.string().nullable(),
		completeness: completenessSchema({
			total: z.number().int().optional().describe('Scheduled jobs matching the filters.'),
		}),
	})
	.strict();

/** Continuation state: the upstream page cursor (runs) and the offset of the next item within that page or list. */
const listStateSchema = z.object({ c: z.string().max(4096).optional(), o: z.number().int().min(0) }).strict();
type ListState = z.infer<typeof listStateSchema>;

function openListState(cursor: string | undefined, binding: unknown, ctx: PtcContext): ListState {
	const state = openCursor(cursor, binding, ctx);
	if (state === undefined) return { o: 0 };
	const parsed = listStateSchema.safeParse(JSON.parse(state));
	if (!parsed.success) throw new PtcError('INVALID_CURSOR', 'invalid cursor; repeat the call without cursor.');
	return parsed.data;
}

async function jobsList(input: z.output<typeof listInput>, ctx: PtcContext): Promise<z.input<typeof listOutput>> {
	const namespace = await resolveNamespace(input.namespace, ctx);
	const labels = Object.entries(input.labels ?? {});
	const stages = [...(input.stagesAny ?? [])].sort();
	if (input.kind === 'scheduled' && stages.length) {
		throw new PtcError('INVALID_ARGUMENT', 'stagesAny applies to kind "job" only.');
	}
	const binding = ['hf_jobs_list', input.kind, namespace, stages, [...labels].sort(([x], [y]) => x.localeCompare(y))];
	const state = openListState(input.cursor, binding, ctx);
	const seal = (next: ListState | null) => (next ? sealCursor(binding, ctx, JSON.stringify(next)) : null);
	if (input.kind === 'job') {
		const params = new URLSearchParams();
		for (const stage of stages) params.append('stage', stage);
		for (const [key, value] of labels) params.append('label', `${key}=${value}`);
		// The Hub pages runs in fixed pages of 100 and bakes stage/label filters into its opaque Link cursor.
		const page = await requestPage(jobsPath('job', namespace), params, state.c, { ...ctx, cursorOnlyLink: true }, 1000);
		const end = state.o + input.limit;
		const items = page.rows.slice(state.o, end).map((row) => jobRecord(row, namespace, [ctx.hfToken]));
		const next =
			end < page.rows.length
				? { ...(state.c ? { c: state.c } : {}), o: end }
				: page.nextCursor
					? { c: page.nextCursor, o: 0 }
					: null;
		return {
			items,
			returnedCount: items.length,
			nextCursor: seal(next),
			completeness: { hasMore: next !== null },
		};
	}
	const params = new URLSearchParams();
	// Upstream filters by a single label; the rest are matched here.
	if (labels[0]) params.append('label', `${labels[0][0]}=${labels[0][1]}`);
	const { data } = await hubFetch({ path: jobsPath('scheduled', namespace), params, subject: 'scheduled jobs' }, ctx);
	if (!Array.isArray(data)) throw new PtcError('UPSTREAM_RESPONSE', 'malformed scheduled jobs list.');
	// Upstream is unpaginated: page the filtered list here.
	const all = data
		.map((row) => scheduledRecord(row, namespace, [ctx.hfToken]))
		.filter((job) => labels.every(([key, value]) => job.jobSpec.labels?.[key] === value));
	const end = state.o + input.limit;
	const items = all.slice(state.o, end);
	const next = end < all.length ? { o: end } : null;
	return {
		items,
		returnedCount: items.length,
		nextCursor: seal(next),
		completeness: { hasMore: next !== null, total: all.length },
	};
}

// ------------------------------------------------------------------ hf_job_get / cancel / update / logs

const byIdInput = z.object({ job: jobIdSchema, kind: kindSchema, namespace: namespaceSchema }).strict();
const oneOutput = z
	.object({ job: jobRecordSchema.optional(), scheduledJob: scheduledRecordSchema.optional() })
	.strict();

async function target(input: { job: string; namespace?: string }, ctx: PtcContext) {
	const parsed = parseJobId(input.job, input.namespace);
	return { id: parsed.id, namespace: await resolveNamespace(parsed.namespace, ctx) };
}

async function readOne(kind: 'job' | 'scheduled', namespace: string, id: string, ctx: PtcContext) {
	const raw = await getRaw(kind, namespace, id, ctx);
	return kind === 'job'
		? { job: jobRecord(raw, namespace, [ctx.hfToken]) }
		: { scheduledJob: scheduledRecord(raw, namespace, [ctx.hfToken]) };
}

async function jobGet(input: z.output<typeof byIdInput>, ctx: PtcContext): Promise<z.input<typeof oneOutput>> {
	const { id, namespace } = await target(input, ctx);
	return readOne(input.kind, namespace, id, ctx);
}

const cancelOutput = z
	.object({
		action: z.enum(['canceled', 'deleted']),
		// The job after cancellation; absent (with note) if it could not be read back.
		job: jobRecordSchema.optional(),
		// The deleted scheduled job.
		scheduledJob: z
			.object({ kind: z.literal('scheduled_job'), id: z.string(), namespace: z.string() })
			.strict()
			.optional(),
		// See readBack: the text says the change was applied, so callers do not retry.
		note: z.string().optional(),
	})
	.strict();

async function jobCancel(input: z.output<typeof byIdInput>, ctx: PtcContext): Promise<z.input<typeof cancelOutput>> {
	const { id, namespace } = await target(input, ctx);
	if (input.kind === 'scheduled') {
		await hubFetch(
			{ path: jobsPath('scheduled', namespace, id), method: 'DELETE', as: 'none', subject: 'scheduled job' },
			ctx
		);
		return { action: 'deleted', scheduledJob: { kind: 'scheduled_job', id, namespace } };
	}
	await hubFetch({ path: jobsPath('job', namespace, id, 'cancel'), method: 'POST', as: 'none', subject: 'job' }, ctx);
	const after = await readBack(() => readOne('job', namespace, id, ctx));
	return { action: 'canceled', ...after };
}

/**
 * Read a record back after a successful change. A failed read must not turn the completed change
 * (possibly billed, e.g. run_now) into an error that invites a retry: report it in note instead.
 */
async function readBack<T extends object>(read: () => Promise<T>): Promise<Partial<T> & { note?: string }> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof PtcError && error.code === 'CANCELLED') throw error;
		const note = 'The change was applied, but reading the updated record failed; check it with hf_job_get.';
		return { note } as Partial<T> & { note?: string };
	}
}

const updateInput = z
	.object({
		job: jobIdSchema,
		kind: kindSchema,
		labels: jobLabelsSchema.optional().describe('Replace all labels ({} clears them).'),
		action: z
			.enum(['suspend', 'resume', 'run_now'])
			.optional()
			.describe('Scheduled jobs only: pause, resume, or trigger one run now (billed like a run).'),
		schedule: scheduleSchema.optional().describe('Scheduled jobs only: new cron expression or @hourly/@daily/...'),
		namespace: namespaceSchema,
	})
	.strict();
const updateOutput = oneOutput.extend({
	// The run started by action run_now.
	triggeredJob: jobRecordSchema.optional(),
	// See readBack.
	note: z.string().optional(),
});

async function jobUpdate(input: z.output<typeof updateInput>, ctx: PtcContext): Promise<z.input<typeof updateOutput>> {
	if (input.labels === undefined && input.action === undefined && input.schedule === undefined) {
		throw new PtcError('INVALID_ARGUMENT', 'pass at least one of labels, action or schedule.');
	}
	if (input.kind === 'job' && (input.action || input.schedule)) {
		throw new PtcError('INVALID_ARGUMENT', 'action and schedule apply to scheduled jobs only (kind "scheduled").');
	}
	const { id, namespace } = await target(input, ctx);
	const kind = input.kind;
	if (input.labels !== undefined) {
		await hubFetch(
			{
				path: jobsPath(kind, namespace, id, 'labels'),
				method: 'PUT',
				body: { labels: input.labels },
				as: 'none',
				subject: 'labels',
			},
			ctx
		);
	}
	if (input.schedule !== undefined) {
		await hubFetch(
			{
				path: jobsPath('scheduled', namespace, id, 'schedule'),
				method: 'POST',
				body: { schedule: input.schedule },
				as: 'none',
				subject: 'schedule',
			},
			ctx
		);
	}
	let triggered: JobRecord | undefined;
	if (input.action) {
		const action = input.action === 'run_now' ? 'run' : input.action;
		const { data } = await hubFetch(
			{ path: jobsPath('scheduled', namespace, id, action), method: 'POST', subject: 'scheduled job' },
			ctx
		);
		if (input.action === 'run_now' && isJob(data)) triggered = jobRecord(data, namespace, [ctx.hfToken]);
	}
	return {
		...(await readBack(() => readOne(kind, namespace, id, ctx))),
		...(triggered ? { triggeredJob: triggered } : {}),
	};
}

const logsInput = z
	.object({
		job: jobIdSchema,
		tail: jobLogTailSchema
			.default(200)
			.describe('Last N lines (default 200, max 2000; capped at 80 KB total, 4,000 chars/line).'),
		followSeconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_WAIT_SECONDS)
			.default(0)
			.describe('Seconds to keep reading a running job (0: what is available; max 120).'),
		namespace: namespaceSchema,
	})
	.strict();
const logsOutput = z
	.object({
		job: z
			.object({ kind: z.literal('job'), id: z.string(), namespace: z.string(), url: z.string(), stage: z.string() })
			.strict(),
		...logsSchema.shape,
		returnedCount: z.number().int(),
	})
	.strict();

const TERMINAL_JOB_STAGES = new Set(['COMPLETED', 'ERROR', 'CANCELED', 'DELETED']);

async function jobLogs(input: z.output<typeof logsInput>, ctx: PtcContext): Promise<z.input<typeof logsOutput>> {
	const { id, namespace } = await target(input, ctx);
	// Job metadata gives the env/secret values to redact from the log stream.
	const raw = await getRaw('job', namespace, id, ctx);
	if (!isJob(raw)) throw new PtcError('UPSTREAM_RESPONSE', 'malformed job object from the Hub.');
	const sensitive = collectSensitiveValues(raw, [ctx.hfToken]);
	const isTerminal = TERMINAL_JOB_STAGES.has(raw.status.stage);
	const idleOptions =
		input.followSeconds === 0
			? { idleTimeoutMs: 400, ...(isTerminal ? { initialIdleTimeoutMs: 600 } : {}) }
			: undefined;
	const logs = await collectLogs(namespace, id, input.followSeconds || 5, input.tail, sensitive, ctx, idleOptions);
	return {
		job: { kind: 'job', id, namespace, url: jobUrl(namespace, id), stage: raw.status.stage },
		...logs,
		finished: logs.finished || isTerminal,
		returnedCount: logs.lines.length,
	};
}

/** Hugging Face Jobs and scheduled jobs. */
export const JOBS_TOOLS: readonly PtcTool[] = [
	definePtcTool({
		name: 'hf_job_run',
		family: 'jobs',
		title: 'Run a Hugging Face Job',
		description:
			'Run Hugging Face Jobs (Python scripts, Docker containers) on cloud CPU or GPU hardware. Execute training, fine-tuning, batch inference, evaluation or data processing using a script with uv dependencies or a command in a Docker or Space image. Choose hardware (T4, L4, A100, H200), env/secrets, and on-demand hf:// FUSE volumes (~50-100 MB/s per job across many files; repos are ro, buckets default rw; shard large scans across parallel jobs with waitSeconds=0, and use large/concurrent reads). Logs retain only the last 80 KB (4,000 chars/line); write larger results to a mounted rw bucket (or upload to a repo with forwardHfToken=true). Paid compute. See hf_job_logs.',
		input: runInput,
		output: runOutput,
		access: 'write',
		annotations: DESTRUCTIVE,
		run: (input, ctx) => jobRun(input, ctx),
	}),
	definePtcTool({
		name: 'hf_job_schedule',
		family: 'jobs',
		title: 'Schedule a recurring Hugging Face Job',
		description:
			'Schedule a recurring job (cron task, periodic run) with a cron expression or hourly, daily or weekly shorthand. Use a Python script with uv dependencies or a Docker/Space command; optionally create the schedule suspended or allow overlapping runs. Each run consumes paid compute. See hf_job_run.',
		input: scheduleInput,
		output: scheduleOutput,
		access: 'write',
		annotations: DESTRUCTIVE,
		run: (input, ctx) => jobSchedule(input, ctx),
	}),
	definePtcTool({
		name: 'hf_jobs_list',
		family: 'jobs',
		title: 'List Hugging Face Jobs',
		description:
			'List Hugging Face Jobs (my runs, scheduled tasks, cron jobs) for a user or organization. Find running, completed, failed or canceled runs by stage and labels, with cursor paging. Results include job IDs, status, hardware and creation time, or recurring schedules with suspension and last/next run details when available. See hf_job_get.',
		input: listInput,
		output: listOutput,
		access: 'authenticated',
		annotations: READ_ONLY,
		run: (input, ctx) => jobsList(input, ctx),
	}),
	definePtcTool({
		name: 'hf_job_get',
		family: 'jobs',
		title: 'Get a Hugging Face Job',
		description:
			"Check one job's status and configuration by ID or job page URL. Read its stage, status message, hardware, command, labels and timing; for a scheduled job, inspect the cron schedule, suspension and last/next run when available. Environment variables and secrets appear as names only. See hf_job_logs.",
		input: byIdInput,
		output: oneOutput,
		access: 'authenticated',
		annotations: READ_ONLY,
		run: (input, ctx) => jobGet(input, ctx),
	}),
	definePtcTool({
		name: 'hf_job_logs',
		family: 'jobs',
		title: 'Read Hugging Face Job logs',
		description:
			'Read Hugging Face job logs (stdout, stderr, console output) by job ID or page URL. Tail recent lines or follow a running job within a bounded window: retains at most the last 80 KB total and 4,000 characters per line, with no forward offset or cursor once older lines are dropped. Format structured stdout as lines under 4,000 chars totaling under ~65 KB, or write larger outputs to a mounted rw bucket (or upload to a repo with forwardHfToken=true). Returns lines, count, finished state, and followStopped/linesTruncated flags. See hf_job_get.',
		input: logsInput,
		output: logsOutput,
		access: 'authenticated',
		annotations: READ_ONLY,
		run: (input, ctx) => jobLogs(input, ctx),
	}),
	definePtcTool({
		name: 'hf_job_cancel',
		family: 'jobs',
		title: 'Cancel a job or delete a schedule',
		description:
			'Cancel a running or pending job, or delete a recurring job schedule, by ID or job page URL. This stops the run or removes the schedule. Returns the cancellation or deletion action and the corresponding job details. See hf_job_update.',
		input: byIdInput,
		output: cancelOutput,
		access: 'write',
		annotations: DESTRUCTIVE,
		run: (input, ctx) => jobCancel(input, ctx),
	}),
	definePtcTool({
		name: 'hf_job_update',
		family: 'jobs',
		title: 'Update a job or schedule',
		description:
			"Replace or clear a job's labels by ID, or modify a recurring schedule: suspend (pause), resume, change its cron timing or trigger a run now. Triggering a run consumes paid compute. Returns the updated job or schedule and, for an immediate trigger, the started run. See hf_job_cancel.",
		input: updateInput,
		output: updateOutput,
		access: 'write',
		// Same rule as every PTC write tool: anything that can bill compute or overwrite/delete is
		// DESTRUCTIVE (clients confirm it). run_now bills a run and labels replaces all labels.
		annotations: DESTRUCTIVE,
		run: (input, ctx) => jobUpdate(input, ctx),
	}),
];
