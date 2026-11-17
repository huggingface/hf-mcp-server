import { z } from 'zod';
import { definePtcTool, DESTRUCTIVE, READ_ONLY, type PtcContext, type PtcTool } from '../core/tool.js';
import { PtcError } from '../core/errors.js';
import { hubFetch, requestPage } from '../core/hub-http.js';
import { parseRef, personRefSchema, refSchema } from '../core/refs.js';
import { createJobSpec } from '../../jobs/commands/utils.js';
import { resolveUvCommand, UV_DEFAULT_IMAGE } from '../../jobs/commands/uv-utils.js';
import {
	collectSensitiveValues,
	redactSensitiveText,
	toHfJobOutput,
	toHfScheduledJobOutput,
} from '../../jobs/jobs-output.js';
import { HF_JOB_OUTPUT_SCHEMA, HF_SCHEDULED_JOB_OUTPUT_SCHEMA } from '../../jobs/hf-jobs-output-schema.js';
import { fetchJobLogs } from '../../jobs/sse-handler.js';
import { jobLabelsSchema, type JobInfo, type JobSpec, type ScheduledJobInfo } from '../../jobs/types.js';

/*
 * Jobs are not hf:// resources (see toolset_v2 NOT_HF_URI): records carry kind, id,
 * namespace and the web url. Env/secret values and hfToken fields are never returned:
 * toHfJobOutput/toHfScheduledJobOutput allowlist fields and keep only variable names.
 */

const STAGES = ['RUNNING', 'SCHEDULING', 'COMPLETED', 'ERROR', 'CANCELED', 'DELETED'] as const;
const MAX_WAIT_SECONDS = 120;
const MAX_LOG_CHARS = 80_000;
const MAX_LINE_CHARS = 4_000;
const MAX_SCHEDULED = 200;

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
	if (!/^[\w-]{1,128}$/.test(jobId)) throw new PtcError('INVALID_ARGUMENT', 'invalid job_id.');
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

const jobRecordSchema = HF_JOB_OUTPUT_SCHEMA.extend({
	kind: z.literal('job'),
	namespace: z.string(),
	url: z.string().describe('Job page on huggingface.co.'),
});
const scheduledRecordSchema = HF_SCHEDULED_JOB_OUTPUT_SCHEMA.extend({
	kind: z.literal('scheduled_job'),
	namespace: z.string(),
	concurrency: z.boolean().optional().describe('Whether runs may overlap.'),
});
type JobRecord = z.input<typeof jobRecordSchema>;
type ScheduledRecord = z.input<typeof scheduledRecordSchema>;

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
	const ns = raw.owner.name || namespace;
	return { ...toHfJobOutput(raw, undefined, sensitive), kind: 'job', namespace: ns, url: jobUrl(ns, raw.id) };
}

function scheduledRecord(
	raw: unknown,
	namespace: string,
	extraSensitive: readonly (string | undefined)[] = []
): ScheduledRecord {
	if (!isScheduled(raw)) throw new PtcError('UPSTREAM_RESPONSE', 'malformed scheduled job object from the Hub.');
	const sensitive = collectSensitiveValues(raw.jobSpec, extraSensitive);
	const concurrency = (raw as { concurrency?: unknown }).concurrency;
	return {
		...toHfScheduledJobOutput(raw, sensitive),
		kind: 'scheduled_job',
		namespace: raw.owner.name || namespace,
		...(typeof concurrency === 'boolean' ? { concurrency } : {}),
	};
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
	script_args: z.array(z.string().max(4096)).max(100).optional().describe('Arguments passed to script.'),
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
		.describe('Flavor (hf_hardware_flavors items[].name), e.g. cpu-basic, t4-small, h200.'),
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
		.describe('Secret env variables (never echoed). "$HF_TOKEN" needs forward_hf_token.'),
	forward_hf_token: z
		.boolean()
		.default(false)
		.describe('Pass your token to the job as secret HF_TOKEN; enables "$HF_TOKEN" in secrets.'),
	volumes: z
		.array(z.string().max(1024))
		.max(20)
		.optional()
		.describe('Hub mounts, e.g. "hf://datasets/org/ds:/data:ro".'),
	labels: jobLabelsSchema.optional().describe('Labels (keys/values: max 100 chars, letters, digits, - and _).'),
	namespace: namespaceSchema,
	resource_group_id: z
		.string()
		.max(128)
		.optional()
		.describe('Enterprise resource group for billing (needs namespace).'),
};

const specObject = z.object(specFields);
type SpecInput = z.output<typeof specObject>;

const TOKEN_PLACEHOLDER = /^\$(?:HF_TOKEN|\{HF_TOKEN\})$/;

/**
 * The "$HF_TOKEN" placeholder becomes the caller's token, so it is honoured only where the caller
 * opted in: as a secrets value with forward_hf_token true. Env values are stored and shown in
 * plain text on the job, so the placeholder is never substituted there.
 */
function checkTokenPlaceholders(input: SpecInput): void {
	const envKey = Object.entries(input.env ?? {}).find(([, value]) => TOKEN_PLACEHOLDER.test(value))?.[0];
	if (envKey !== undefined) {
		throw new PtcError(
			'INVALID_ARGUMENT',
			`env ${envKey}: "$HF_TOKEN" is not substituted in env (env values are visible on the job). Use forward_hf_token: true, or put it in secrets with forward_hf_token: true.`
		);
	}
	const secretKey = Object.entries(input.secrets ?? {}).find(([, value]) => TOKEN_PLACEHOLDER.test(value))?.[0];
	if (secretKey !== undefined && !input.forward_hf_token) {
		throw new PtcError(
			'INVALID_ARGUMENT',
			`secrets ${secretKey}: "$HF_TOKEN" is replaced with your token only when forward_hf_token is true.`
		);
	}
}

function buildSpec(input: SpecInput, ctx: PtcContext): JobSpec {
	const token = requireToken(ctx);
	if ((input.script === undefined) === (input.command === undefined)) {
		throw new PtcError('INVALID_ARGUMENT', 'pass exactly one of script or command.');
	}
	if (input.space && input.image) throw new PtcError('INVALID_ARGUMENT', 'pass image or space, not both.');
	if (input.command !== undefined && (input.dependencies || input.python || input.script_args)) {
		throw new PtcError('INVALID_ARGUMENT', 'dependencies, python and script_args only apply to script.');
	}
	if (input.resource_group_id && !input.namespace) {
		throw new PtcError('INVALID_ARGUMENT', 'resource_group_id requires the owning organization as namespace.');
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
					script_args: input.script_args,
				})
			: (input.command ?? []);
	checkTokenPlaceholders(input);
	const secrets = input.forward_hf_token ? { ...input.secrets, HF_TOKEN: '$HF_TOKEN' } : input.secrets;
	try {
		return createJobSpec({
			image,
			command,
			flavor: input.flavor,
			env: input.env,
			secrets,
			timeout: String(input.timeout),
			// createJobSpec swaps a "$HF_TOKEN" value for this token: only when the caller opted in.
			...(input.forward_hf_token ? { hfToken: token } : {}),
			volumes: input.volumes,
			resourceGroupId: input.resource_group_id,
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
	follow_stopped: boolean;
	lines_truncated: boolean;
}

async function collectLogs(
	namespace: string,
	id: string,
	seconds: number,
	tail: number,
	sensitive: readonly string[],
	ctx: PtcContext
): Promise<LogsResult> {
	let step = 0;
	// Lines are redacted, cut and budgeted while streaming (never buffered in full, never cut before redaction).
	const result = await fetchJobLogs(`https://huggingface.co${jobsPath('job', namespace, id, 'logs')}`, {
		token: ctx.hfToken,
		maxDuration: seconds * 1000,
		maxLines: tail,
		maxChars: MAX_LOG_CHARS,
		maxLineChars: MAX_LINE_CHARS,
		redact: (text) => redactSensitiveText(text, sensitive),
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
		follow_stopped: result.truncated,
		lines_truncated: result.linesDropped,
	};
}

const logsSchema = z
	.object({
		lines: z.array(z.string()),
		finished: z.boolean().describe('The job finished while logs were read.'),
		follow_stopped: z.boolean().describe('Reading stopped at the time limit; the job may still be running.'),
		lines_truncated: z.boolean().describe('Older lines were dropped (tail or size budget).'),
	})
	.strict();

// ------------------------------------------------------------------ hf_job_run

const runInput = specObject
	.extend({
		wait_seconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_WAIT_SECONDS)
			.default(0)
			.describe('Seconds to follow logs before returning (0: return at once; max 120).'),
	})
	.strict();
const runOutput = z.object({ job: jobRecordSchema, logs: logsSchema.optional() }).strict();

async function jobRun(input: z.output<typeof runInput>, ctx: PtcContext): Promise<z.input<typeof runOutput>> {
	const namespace = await resolveNamespace(input.namespace, ctx);
	const spec = buildSpec(input, ctx);
	const sensitive = collectSensitiveValues(spec, [ctx.hfToken]);
	const { data } = await hubFetch(
		{ path: jobsPath('job', namespace), method: 'POST', body: spec, subject: 'job run' },
		ctx
	);
	let job = await submittedJob(data, namespace, sensitive, ctx);
	await ctx.onProgress?.({ progress: 0, message: `Job ${job.id} submitted (${job.status.stage}).` });
	if (input.wait_seconds === 0) return { job };
	const logs = await collectLogs(job.namespace, job.id, input.wait_seconds, 100, sensitive, ctx);
	try {
		job = jobRecord(await getRaw('job', job.namespace, job.id, ctx), namespace, sensitive);
	} catch {
		// Keep the submission record when the status refresh fails.
	}
	return { job, logs };
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
	} catch {
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
const scheduleOutput = z.object({ scheduled_job: scheduledRecordSchema }).strict();

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
	return { scheduled_job: scheduledRecord(data, namespace, collectSensitiveValues(spec, [ctx.hfToken])) };
}

// ------------------------------------------------------------------ hf_jobs_list

const listInput = z
	.object({
		kind: kindSchema,
		stages: z.array(z.enum(STAGES)).max(6).optional().describe('Only jobs in these stages (kind job only).'),
		labels: jobLabelsSchema.optional().describe('Only jobs having all these labels.'),
		namespace: namespaceSchema,
		cursor: z.string().max(16_384).optional().describe('next_cursor from a previous call (kind job only).'),
	})
	.strict();
const listOutput = z
	.object({
		items: z.array(z.union([jobRecordSchema, scheduledRecordSchema])),
		returned_count: z.number().int(),
		next_cursor: z.string().nullable(),
		completeness: z
			.object({
				scope: z.string(),
				global_complete: z.literal(false),
				pagination_blocked_reason: z.string().optional(),
			})
			.strict(),
	})
	.strict();

async function jobsList(input: z.output<typeof listInput>, ctx: PtcContext): Promise<z.input<typeof listOutput>> {
	const namespace = await resolveNamespace(input.namespace, ctx);
	const labels = Object.entries(input.labels ?? {});
	if (input.kind === 'job') {
		const params = new URLSearchParams();
		for (const stage of input.stages ?? []) params.append('stage', stage);
		for (const [key, value] of labels) params.append('label', `${key}=${value}`);
		const page = await requestPage(jobsPath('job', namespace), params, input.cursor, ctx, 1000);
		const items = page.rows.map((row) => jobRecord(row, namespace, [ctx.hfToken]));
		return {
			items,
			returned_count: items.length,
			next_cursor: page.nextCursor,
			completeness: { scope: 'listing_page', global_complete: false },
		};
	}
	if (input.stages || input.cursor) {
		throw new PtcError('INVALID_ARGUMENT', 'stages and cursor apply to kind "job" only.');
	}
	const params = new URLSearchParams();
	// Upstream filters by a single label; the rest are matched here.
	if (labels[0]) params.append('label', `${labels[0][0]}=${labels[0][1]}`);
	const { data } = await hubFetch({ path: jobsPath('scheduled', namespace), params, subject: 'scheduled jobs' }, ctx);
	if (!Array.isArray(data)) throw new PtcError('UPSTREAM_RESPONSE', 'malformed scheduled jobs list.');
	const all = data
		.map((row) => scheduledRecord(row, namespace, [ctx.hfToken]))
		.filter((job) => labels.every(([key, value]) => job.job_spec.labels?.[key] === value));
	const items = all.slice(0, MAX_SCHEDULED);
	return {
		items,
		returned_count: items.length,
		next_cursor: null,
		completeness: {
			scope: 'scheduled_jobs',
			global_complete: false,
			...(all.length > items.length
				? { pagination_blocked_reason: `upstream is unpaginated; first ${MAX_SCHEDULED} returned.` }
				: {}),
		},
	};
}

// ------------------------------------------------------------------ hf_job_get / cancel / update / logs

const byIdInput = z.object({ job_id: jobIdSchema, kind: kindSchema, namespace: namespaceSchema }).strict();
const oneOutput = z
	.object({ job: jobRecordSchema.optional(), scheduled_job: scheduledRecordSchema.optional() })
	.strict();

async function target(input: { job_id: string; namespace?: string }, ctx: PtcContext) {
	const parsed = parseJobId(input.job_id, input.namespace);
	return { id: parsed.id, namespace: await resolveNamespace(parsed.namespace, ctx) };
}

async function readOne(kind: 'job' | 'scheduled', namespace: string, id: string, ctx: PtcContext) {
	const raw = await getRaw(kind, namespace, id, ctx);
	return kind === 'job'
		? { job: jobRecord(raw, namespace, [ctx.hfToken]) }
		: { scheduled_job: scheduledRecord(raw, namespace, [ctx.hfToken]) };
}

async function jobGet(input: z.output<typeof byIdInput>, ctx: PtcContext): Promise<z.input<typeof oneOutput>> {
	const { id, namespace } = await target(input, ctx);
	return readOne(input.kind, namespace, id, ctx);
}

const cancelOutput = z
	.object({
		action: z.enum(['canceled', 'deleted']),
		job: jobRecordSchema.optional().describe('The job after cancellation (absent if it could not be read back).'),
		scheduled_job: z
			.object({ kind: z.literal('scheduled_job'), id: z.string(), namespace: z.string() })
			.strict()
			.optional()
			.describe('The deleted scheduled job.'),
		note: z.string().optional().describe('Set when the change succeeded but the record could not be read back.'),
	})
	.strict();

async function jobCancel(input: z.output<typeof byIdInput>, ctx: PtcContext): Promise<z.input<typeof cancelOutput>> {
	const { id, namespace } = await target(input, ctx);
	if (input.kind === 'scheduled') {
		await hubFetch(
			{ path: jobsPath('scheduled', namespace, id), method: 'DELETE', as: 'none', subject: 'scheduled job' },
			ctx
		);
		return { action: 'deleted', scheduled_job: { kind: 'scheduled_job', id, namespace } };
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
		job_id: jobIdSchema,
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
	triggered_job: jobRecordSchema.optional().describe('The run started by action run_now.'),
	note: z.string().optional().describe('Set when the change succeeded but the record could not be read back.'),
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
		...(triggered ? { triggered_job: triggered } : {}),
	};
}

const logsInput = z
	.object({
		job_id: jobIdSchema,
		tail: z
			.number()
			.int()
			.min(1)
			.max(2000)
			.default(200)
			.describe('Return at most the last N lines (default 200, max 2000).'),
		follow_seconds: z
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
		returned_count: z.number().int(),
	})
	.strict();

async function jobLogs(input: z.output<typeof logsInput>, ctx: PtcContext): Promise<z.input<typeof logsOutput>> {
	const { id, namespace } = await target(input, ctx);
	// Job metadata gives the env/secret values to redact from the log stream.
	const raw = await getRaw('job', namespace, id, ctx);
	if (!isJob(raw)) throw new PtcError('UPSTREAM_RESPONSE', 'malformed job object from the Hub.');
	const sensitive = collectSensitiveValues(raw, [ctx.hfToken]);
	const logs = await collectLogs(namespace, id, input.follow_seconds || 5, input.tail, sensitive, ctx);
	return {
		job: { kind: 'job', id, namespace, url: jobUrl(namespace, id), stage: raw.status.stage },
		...logs,
		returned_count: logs.lines.length,
	};
}

/** Hugging Face Jobs and scheduled jobs. */
export const JOBS_TOOLS: readonly PtcTool[] = [
	definePtcTool({
		name: 'hf_job_run',
		family: 'jobs',
		title: 'Run a Hugging Face Job',
		description:
			'Run Hugging Face Jobs (Python scripts, Docker containers) on cloud CPU or GPU hardware. Execute training, fine-tuning, batch inference, evaluation or data processing using a script with uv dependencies or a command in a Docker or Space image. Choose hardware such as T4, L4, A100 or H200, configure environment variables and secrets, and mount hf:// volumes. Returns a job ID and page URL. Runs consume paid compute. See hf_job_logs.',
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
			'List Hugging Face Jobs (my runs, scheduled tasks, cron jobs) for a user or organization. Find running, completed, failed or canceled runs by stage and labels, with cursor paging for runs. Results include job IDs, status, hardware and creation time, or recurring schedules with suspension and last/next run details when available. See hf_job_get.',
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
			'Read Hugging Face job logs (stdout, stderr, console output) by job ID or page URL. Tail recent lines or follow a running job to watch training or processing progress within a bounded reading window. Returns log lines, their count, whether the job finished during reading, and flags for reaching the time limit or dropping older lines. See hf_job_get.',
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
