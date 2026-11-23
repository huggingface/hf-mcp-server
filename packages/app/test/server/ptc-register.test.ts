import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { callPtcTool, PtcError } from '@llmindset/hf-mcp';
import { redactLoggedValue, registerPtcTools } from '../../src/server/ptc/register.js';
import * as queryLogger from '../../src/server/utils/query-logger.js';
import * as metrics from '../../src/server/ptc/metrics.js';

vi.mock('@llmindset/hf-mcp', async (importOriginal) => ({
	...(await importOriginal<typeof import('@llmindset/hf-mcp')>()),
	callPtcTool: vi.fn(),
}));

type Handler = (params: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
interface Registered {
	config: { inputSchema: { '~standard': { validate: (value: unknown) => unknown } } };
	handler: Handler;
}

function register(): Map<string, Registered> {
	const tools = new Map<string, Registered>();
	const server = {
		registerTool: (name: string, config: Registered['config'], handler: Handler) => {
			tools.set(name, { config, handler });
		},
	} as unknown as McpServer;
	registerPtcTools(server, {
		hfToken: 'hf_writetoken123456',
		user: { name: 'alice', auth: { accessToken: { role: 'write' } } } as never,
		disabledTools: new Set(),
		logOptions: {},
	});
	return tools;
}

const CTX = { mcpReq: { signal: new AbortController().signal, _meta: {} } };

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(callPtcTool).mockReset();
});

describe('PTC handler observability', () => {
	it('returns a completed call even when query logging and metrics throw', async () => {
		vi.spyOn(queryLogger, 'logToolQuery').mockImplementation(() => {
			throw new Error('logger down');
		});
		vi.spyOn(metrics, 'recordPtcToolCall').mockImplementation(() => {
			throw new Error('metrics down');
		});
		vi.mocked(callPtcTool).mockResolvedValue({
			structured: { job: { id: 'job1' } },
			content: [{ type: 'text', text: '{}' }],
			isError: false,
		});
		const tools = register();
		const result = await tools.get('hf_job_run')?.handler({ command: ['ls'] }, CTX);
		expect(result).toMatchObject({ structuredContent: { job: { id: 'job1' } } });
		expect(result?.isError).toBeUndefined();
		expect(callPtcTool).toHaveBeenCalledTimes(1);
	});

	it('defers argument validation to callPtcTool so failures carry the ptc-error code and are counted', async () => {
		const record = vi.spyOn(metrics, 'recordPtcToolCall');
		vi.mocked(callPtcTool).mockRejectedValue(new PtcError('INVALID_ARGUMENT', 'invalid input. limit: too big'));
		const tools = register();
		const entry = tools.get('hf_models_search');
		// The advertised schema no longer rejects at the SDK layer...
		expect(entry?.config.inputSchema['~standard'].validate({ limit: 'nope' })).toEqual({ value: { limit: 'nope' } });
		// ...so the handler reports it with the code, and metrics see it.
		const result = await entry?.handler({ limit: 'nope' }, CTX);
		expect(result).toMatchObject({
			isError: true,
			_meta: { 'huggingface.co/ptc-error': { code: 'INVALID_ARGUMENT', retryable: false } },
		});
		expect(record).toHaveBeenCalledWith(expect.anything(), 'hf_models_search', expect.any(Number), 'INVALID_ARGUMENT');
	});

	it('logs only the error code when a diagnostic includes a rejected signed URL', async () => {
		const log = vi.spyOn(queryLogger, 'logToolQuery').mockImplementation(() => undefined);
		const ref = 'https://files.example.invalid/resource?sig=sample-private-signature';
		const message = `not a valid Hugging Face reference: ${ref}`;
		vi.mocked(callPtcTool).mockRejectedValue(new PtcError('INVALID_ARGUMENT', message));
		const result = await register().get('hf_repo_info')?.handler({ repo: ref }, CTX);
		expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: message }] });
		expect(log).toHaveBeenCalledWith(
			'ptc:hf_repo_info',
			'https://files.example.invalid/resource?sig=<redacted>',
			{},
			expect.objectContaining({ success: false, error: 'INVALID_ARGUMENT' })
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain('sample-private-signature');
	});

	it('logs uri/ref values without credentials', async () => {
		const log = vi.spyOn(queryLogger, 'logToolQuery').mockImplementation(() => undefined);
		vi.mocked(callPtcTool).mockResolvedValue({ structured: {}, content: [], isError: false });
		const tools = register();
		await tools
			.get('hf_repo_info')
			?.handler({ uri: 'https://user:pa55@huggingface.co/org/model?token=hf_abcdefghijklmnop&revision=main' }, CTX);
		const logged = String(log.mock.calls[0]?.[1]);
		expect(logged).not.toContain('pa55');
		expect(logged).not.toContain('hf_abcdefghijklmnop');
		expect(logged).toContain('revision=main');
	});
});

describe('redactLoggedValue', () => {
	it('removes userinfo, token-like parameters and bare HF tokens', () => {
		expect(redactLoggedValue('https://a:b@host/x')).toBe('https://<redacted>@host/x');
		expect(redactLoggedValue('https://h/p?X-Amz-Signature=abc&api_key=k&sig=s&q=ok')).toBe(
			'https://h/p?X-Amz-Signature=<redacted>&api_key=<redacted>&sig=<redacted>&q=ok'
		);
		expect(redactLoggedValue('use hf_AbCdEfGh12345678 please')).toBe('use hf_<redacted> please');
		expect(redactLoggedValue('hf://models/org/name')).toBe('hf://models/org/name');
		expect(redactLoggedValue('bert base uncased')).toBe('bert base uncased');
	});
});
