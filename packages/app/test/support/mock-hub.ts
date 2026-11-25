import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HfWhoamiResponse } from '@llmindset/hf-mcp';

export interface MockHubOptions {
	failUploadsCount?: number;
	whoamiOutage?: boolean;
}

export interface MockHubUploadedFile {
	repo: string;
	revision: string;
	path: string;
	rawContent: string;
	entries: Array<Record<string, unknown>>;
	commitOid: string;
}

export interface MockHubCommit {
	repo: string;
	revision: string;
	commitOid: string;
	summary: string;
	description?: string;
	files: MockHubUploadedFile[];
}

export interface MockHubHandle {
	baseUrl: string;
	whoamiUrl: string;
	commits: MockHubCommit[];
	uploadedFiles: MockHubUploadedFile[];
	setFailUploadsCount: (count: number) => void;
	setWhoamiOutage: (enabled: boolean) => void;
	reset: () => void;
	close: () => Promise<void>;
}

interface PreuploadFileRequest {
	path: string;
	size?: number;
	sample?: string;
}

interface PreuploadRequestBody {
	files?: PreuploadFileRequest[];
}

interface CommitHeaderLine {
	key: 'header';
	value: {
		summary?: string;
		description?: string;
	};
}

interface CommitFileLine {
	key: 'file';
	value: {
		path: string;
		content?: string;
		encoding?: 'utf-8' | 'base64';
	};
}

type CommitNdjsonLine = CommitHeaderLine | CommitFileLine | { key: string; value?: unknown };

const PREUPLOAD_PATH_RE = /^\/api\/datasets\/([^/]+\/[^/]+)\/preupload\/([^/]+)$/;
const COMMIT_PATH_RE = /^\/api\/datasets\/([^/]+\/[^/]+)\/commit\/([^/]+)$/;

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer | string) => {
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
		});
		req.on('end', () => {
			resolve(Buffer.concat(chunks).toString('utf8'));
		});
		req.on('error', reject);
	});
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(statusCode, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(payload),
	});
	res.end(payload);
}

function sanitizeTokenSuffix(raw: string): string {
	const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_');
	return cleaned.length > 0 ? cleaned : 'default';
}

function buildWhoamiResponse(token: string): HfWhoamiResponse {
	if (token.startsWith('hf_oauth_')) {
		const suffix = sanitizeTokenSuffix(token.slice('hf_oauth_'.length));
		return {
			id: `oauth-user-${suffix}`,
			type: 'user',
			name: `oauth_user_${suffix}`,
			isPro: false,
			orgs: [],
			auth: {
				type: 'oauth',
				expiresAt: '2028-01-01T00:00:00.000Z',
				accessToken: {
					displayName: 'oauth',
					role: 'write',
					createdAt: '2026-01-01T00:00:00.000Z',
				},
			},
		};
	}

	if (token.startsWith('hf_app_')) {
		const suffix = sanitizeTokenSuffix(token.slice('hf_app_'.length));
		return {
			id: `app-${suffix}`,
			type: 'app',
			name: `app_${suffix}`,
			scope: {
				role: 'contributor',
				entities: [{ type: 'dataset', name: 'org/logs' }],
			},
			auth: {
				type: 'app_token',
			},
		};
	}

	const suffix = sanitizeTokenSuffix(token.slice('hf_'.length));
	return {
		id: `pat-user-${suffix}`,
		type: 'user',
		name: `pat_user_${suffix}`,
		isPro: false,
		orgs: [],
		auth: {
			type: 'access_token',
			accessToken: {
				displayName: 'pat',
				role: 'write',
				createdAt: '2026-01-01T00:00:00.000Z',
			},
		},
	};
}

function extractBearerToken(req: IncomingMessage): string | undefined {
	const authHeader = req.headers.authorization;
	if (!authHeader) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
	return match?.[1]?.trim();
}

function parseJsonlEntries(rawContent: string): Array<Record<string, unknown>> {
	const entries: Array<Record<string, unknown>> = [];
	for (const line of rawContent.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		entries.push(JSON.parse(trimmed) as Record<string, unknown>);
	}
	return entries;
}

export async function startMockHub(options: MockHubOptions = {}): Promise<MockHubHandle> {
	const commits: MockHubCommit[] = [];
	const uploadedFiles: MockHubUploadedFile[] = [];
	let failUploadsCount = options.failUploadsCount ?? 0;
	let whoamiOutage = options.whoamiOutage ?? false;
	let commitCounter = 0;
	let baseUrl = '';

	const server = createServer((req, res) => {
		void (async () => {
			try {
				const parsedUrl = new URL(req.url ?? '/', baseUrl || 'http://127.0.0.1');
				const pathname = parsedUrl.pathname;

				if (req.method === 'GET' && pathname === '/api/whoami-v2') {
					if (whoamiOutage) {
						sendJson(res, 503, { error: 'Service Unavailable' });
						return;
					}

					const token = extractBearerToken(req);
					if (!token || token.startsWith('hf_invalid') || token.startsWith('invalid') || !token.startsWith('hf_')) {
						sendJson(res, 401, { error: 'Invalid credentials in Authorization header' });
						return;
					}

					sendJson(res, 200, buildWhoamiResponse(token));
					return;
				}

				if (req.method === 'POST') {
					const preuploadMatch = PREUPLOAD_PATH_RE.exec(pathname);
					if (preuploadMatch) {
						const rawBody = await readRequestBody(req);
						const body = (rawBody ? JSON.parse(rawBody) : {}) as PreuploadRequestBody;
						const files = (body.files ?? []).map((file) => ({
							path: file.path,
							uploadMode: 'regular' as const,
							shouldIgnore: false,
						}));
						sendJson(res, 200, { files });
						return;
					}

					const commitMatch = COMMIT_PATH_RE.exec(pathname);
					if (commitMatch) {
						// Drain request body before responding so client fetch doesn't hit ECONNRESET
						const rawBody = await readRequestBody(req);

						if (failUploadsCount > 0) {
							failUploadsCount -= 1;
							sendJson(res, 500, { error: 'Simulated Hub upload failure' });
							return;
						}

						const repo = commitMatch[1] ?? '';
						const revision = decodeURIComponent(commitMatch[2] ?? 'main');
						commitCounter += 1;
						const commitOid = commitCounter.toString(16).padStart(40, '0');

						let summary = '';
						let description: string | undefined;
						const commitFiles: MockHubUploadedFile[] = [];

						for (const line of rawBody.split('\n')) {
							const trimmed = line.trim();
							if (!trimmed) continue;
							const parsed = JSON.parse(trimmed) as CommitNdjsonLine;
							if (parsed.key === 'header') {
								const header = (parsed as CommitHeaderLine).value;
								summary = header.summary ?? '';
								description = header.description;
							} else if (parsed.key === 'file') {
								const file = (parsed as CommitFileLine).value;
								const content = file.content ?? '';
								const rawContent =
									file.encoding === 'utf-8' ? content : Buffer.from(content, 'base64').toString('utf8');
								const uploadedFile: MockHubUploadedFile = {
									repo,
									revision,
									path: file.path,
									rawContent,
									entries: parseJsonlEntries(rawContent),
									commitOid,
								};
								commitFiles.push(uploadedFile);
								uploadedFiles.push(uploadedFile);
							}
						}

						commits.push({
							repo,
							revision,
							commitOid,
							summary,
							description,
							files: commitFiles,
						});

						sendJson(res, 200, {
							commitOid,
							commitUrl: `${baseUrl}/datasets/${repo}/commit/${commitOid}`,
							hookOutput: '',
						});
						return;
					}
				}

				sendJson(res, 404, { error: `Not found: ${req.method ?? 'UNKNOWN'} ${pathname}` });
			} catch (error) {
				sendJson(res, 500, {
					error: error instanceof Error ? error.message : 'Mock Hub internal error',
				});
			}
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});

	const address = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${address.port}`;

	return {
		baseUrl,
		whoamiUrl: `${baseUrl}/api/whoami-v2`,
		commits,
		uploadedFiles,
		setFailUploadsCount(count: number) {
			failUploadsCount = count;
		},
		setWhoamiOutage(enabled: boolean) {
			whoamiOutage = enabled;
		},
		reset() {
			commits.length = 0;
			uploadedFiles.length = 0;
			failUploadsCount = 0;
			whoamiOutage = false;
			commitCounter = 0;
		},
		close() {
			return new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
		},
	};
}
