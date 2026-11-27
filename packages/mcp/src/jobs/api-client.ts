import { HfApiCall } from '../hf-api-call.js';
import type { JobInfo, JobSpec, ScheduledJobInfo, ScheduledJobSpec } from './types.js';

/**
 * Interface for whoami API response
 */
interface WhoAmIResponse {
	name: string;
	id: string;
	type: 'user' | 'org';
	[key: string]: unknown;
}

const NAMESPACE_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const JOB_ID_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function encodeNamespaceSegment(namespace: string): string {
	if (!NAMESPACE_SEGMENT_PATTERN.test(namespace) || namespace === '.' || namespace === '..') {
		throw new Error('Invalid namespace');
	}
	return encodeURIComponent(namespace);
}

function encodeJobIdSegment(jobId: string): string {
	if (!JOB_ID_SEGMENT_PATTERN.test(jobId)) {
		throw new Error('Invalid job ID');
	}
	return encodeURIComponent(jobId);
}

/**
 * API client for HuggingFace Jobs API
 * Handles all HTTP interactions with the Jobs API endpoints
 */
export class JobsApiClient extends HfApiCall {
	private namespaceCache: string | null = null;

	constructor(
		hfToken?: string,
		namespace?: string,
		/** Caller cancellation applied to every request (PTC request signal). */
		private readonly signal?: AbortSignal
	) {
		// Base URL is the main HF API, we'll construct specific endpoints
		super('https://huggingface.co/api', hfToken);
		// Initialize cache with provided namespace to avoid redundant whoami calls
		this.namespaceCache = namespace || null;
	}

	protected override async fetchFromApi<T>(url: URL | string, options?: globalThis.RequestInit): Promise<T> {
		if (!this.signal) return super.fetchFromApi<T>(url, options);
		this.signal.throwIfAborted();
		const signal = options?.signal ? AbortSignal.any([options.signal, this.signal]) : this.signal;
		return super.fetchFromApi<T>(url, { ...options, signal });
	}

	/**
	 * Get the namespace (username or org) for the current user
	 * Uses cached value from constructor or /api/whoami-v2 endpoint as fallback
	 */
	async getNamespace(namespace?: string): Promise<string> {
		if (namespace) {
			return namespace;
		}

		if (this.namespaceCache) {
			return this.namespaceCache;
		}

		// Fetch from whoami endpoint only if not cached
		const whoami = await this.fetchFromApi<WhoAmIResponse>('https://huggingface.co/api/whoami-v2');
		this.namespaceCache = whoami.name;
		return this.namespaceCache;
	}

	/**
	 * Run a job
	 * POST /api/jobs/{namespace}
	 */
	async runJob(jobSpec: JobSpec, namespace?: string): Promise<JobInfo> {
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/jobs/${ns}`;

		const result = await this.fetchFromApi<JobInfo>(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(jobSpec),
		});
		return result;
	}

	/**
	 * List all jobs for a namespace
	 * GET /api/jobs/{namespace}
	 */
	async listJobs(namespace?: string, labels?: Record<string, string>): Promise<JobInfo[]> {
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/jobs/${ns}`;

		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(labels ?? {})) params.append('label', `${key}=${value}`);
		return this.fetchFromApi<JobInfo[]>(params.size ? `${url}?${params}` : url);
	}

	/**
	 * Get detailed information about a specific job
	 * GET /api/jobs/{namespace}/{jobId}
	 */
	async getJob(jobId: string, namespace?: string): Promise<JobInfo> {
		const safeJobId = encodeJobIdSegment(jobId);
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/jobs/${ns}/${safeJobId}`;

		return this.fetchFromApi<JobInfo>(url);
	}

	/**
	 * Cancel a running job
	 * POST /api/jobs/{namespace}/{jobId}/cancel
	 */
	async cancelJob(jobId: string, namespace?: string): Promise<void> {
		const safeJobId = encodeJobIdSegment(jobId);
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/jobs/${ns}/${safeJobId}/cancel`;

		await this.fetchFromApi<void>(url, {
			method: 'POST',
		});
	}

	/**
	 * Get logs URL for a job
	 * Returns the URL for SSE streaming - caller handles the actual streaming
	 */
	getLogsUrl(jobId: string, namespace: string, tail?: number): string {
		const safeJobId = encodeJobIdSegment(jobId);
		const safeNamespace = encodeNamespaceSegment(namespace);
		const base = `https://huggingface.co/api/jobs/${safeNamespace}/${safeJobId}/logs`;
		return tail !== undefined ? `${base}?tail=${String(tail)}` : base;
	}

	/**
	 * Create a scheduled job
	 * POST /api/scheduled-jobs/{namespace}
	 */
	async createScheduledJob(spec: ScheduledJobSpec, namespace?: string): Promise<ScheduledJobInfo> {
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/scheduled-jobs/${ns}`;

		return this.fetchFromApi<ScheduledJobInfo>(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(spec),
		});
	}

	/**
	 * List all scheduled jobs
	 * GET /api/scheduled-jobs/{namespace}
	 */
	async listScheduledJobs(namespace?: string, labels?: Record<string, string>): Promise<ScheduledJobInfo[]> {
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/scheduled-jobs/${ns}`;

		const entries = Object.entries(labels ?? {});
		const params = new URLSearchParams();
		const first = entries[0];
		if (first) params.append('label', `${first[0]}=${first[1]}`);
		const jobs = await this.fetchFromApi<ScheduledJobInfo[]>(params.size ? `${url}?${params}` : url);
		return jobs.filter((job) =>
			entries.every(
				([key, value]) =>
					Object.prototype.hasOwnProperty.call(job.jobSpec.labels ?? {}, key) && job.jobSpec.labels?.[key] === value
			)
		);
	}

	/**
	 * Get details of a scheduled job
	 * GET /api/scheduled-jobs/{namespace}/{scheduledJobId}
	 */
	async getScheduledJob(scheduledJobId: string, namespace?: string): Promise<ScheduledJobInfo> {
		const safeJobId = encodeJobIdSegment(scheduledJobId);
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/scheduled-jobs/${ns}/${safeJobId}`;
		return this.fetchFromApi<ScheduledJobInfo>(url);
	}

	/**
	 * Delete a scheduled job
	 * DELETE /api/scheduled-jobs/{namespace}/{scheduledJobId}
	 */
	async deleteScheduledJob(scheduledJobId: string, namespace?: string): Promise<void> {
		const safeJobId = encodeJobIdSegment(scheduledJobId);
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/scheduled-jobs/${ns}/${safeJobId}`;

		await this.fetchFromApi<void>(url, {
			method: 'DELETE',
		});
	}

	/**
	 * Suspend a scheduled job
	 * POST /api/scheduled-jobs/{namespace}/{scheduledJobId}/suspend
	 */
	async suspendScheduledJob(scheduledJobId: string, namespace?: string): Promise<void> {
		const safeJobId = encodeJobIdSegment(scheduledJobId);
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/scheduled-jobs/${ns}/${safeJobId}/suspend`;

		await this.fetchFromApi<void>(url, {
			method: 'POST',
		});
	}

	/**
	 * Resume a suspended scheduled job
	 * POST /api/scheduled-jobs/{namespace}/{scheduledJobId}/resume
	 */
	async resumeScheduledJob(scheduledJobId: string, namespace?: string): Promise<void> {
		const safeJobId = encodeJobIdSegment(scheduledJobId);
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		const url = `https://huggingface.co/api/scheduled-jobs/${ns}/${safeJobId}/resume`;

		await this.fetchFromApi<void>(url, {
			method: 'POST',
		});
	}
	/** Replace all labels; an empty object clears them. */
	async updateJobLabels(jobId: string, labels: Record<string, string>, namespace?: string): Promise<JobInfo> {
		const safeJobId = encodeJobIdSegment(jobId);
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		return this.fetchFromApi<JobInfo>(`https://huggingface.co/api/jobs/${ns}/${safeJobId}/labels`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ labels }),
		});
	}

	/** Replace all scheduled job labels; an empty object clears them. */
	async updateScheduledJobLabels(
		jobId: string,
		labels: Record<string, string>,
		namespace?: string
	): Promise<ScheduledJobInfo> {
		const safeJobId = encodeJobIdSegment(jobId);
		const ns = encodeNamespaceSegment(await this.getNamespace(namespace));
		return this.fetchFromApi<ScheduledJobInfo>(`https://huggingface.co/api/scheduled-jobs/${ns}/${safeJobId}/labels`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ labels }),
		});
	}
}
