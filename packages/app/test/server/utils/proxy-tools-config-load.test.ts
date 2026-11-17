import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	readFile: vi.fn(),
	connect: vi.fn(),
	listTools: vi.fn(),
	close: vi.fn(),
	transport: vi.fn(),
	fetchWithProfile: vi.fn(),
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('@modelcontextprotocol/client', () => ({
	Client: class {
		connect = mocks.connect;
		listTools = mocks.listTools;
		close = mocks.close;
	},
	StreamableHTTPClientTransport: class {
		constructor(url: URL, options: unknown) {
			mocks.transport(url, options);
		}
	},
}));
vi.mock('@llmindset/hf-mcp/network', async (importOriginal) => ({
	...(await importOriginal<typeof import('@llmindset/hf-mcp/network')>()),
	fetchWithProfile: mocks.fetchWithProfile,
}));
vi.mock('../../../src/server/utils/logger.js', () => ({ logger: mocks.logger }));

import { parseProxyToolsCsv } from '../../../src/server/utils/proxy-tools-config.js';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('proxy tools CSV policy parsing', () => {
	it.each(['JSON', 'sse'])('materializes legacy defaults for headerless %s rows', (responseType) => {
		expect(parseProxyToolsCsv(`legacy,https://example.com/mcp,${responseType}`)).toEqual([
			{
				proxyId: 'legacy',
				url: 'https://example.com/mcp',
				responseType: responseType.toUpperCase(),
				allowAnonymous: false,
				forwardHfToken: true,
			},
		]);
		expect(mocks.logger.warn).not.toHaveBeenCalled();
	});

	it.each([
		['true', 'true', true, true],
		['true', 'false', true, false],
		['false', 'true', false, true],
		['false', 'false', false, false],
		[' TrUe ', ' FaLsE ', true, false],
	])('parses independent policies %s / %s', (anonymous, forward, allowAnonymous, forwardHfToken) => {
		expect(parseProxyToolsCsv(`policy,https://example.com/mcp,JSON,${anonymous},${forward}`)).toEqual([
			expect.objectContaining({ allowAnonymous, forwardHfToken }),
		]);
	});

	it.each([
		['', false, true],
		[',', false, true],
		[',,', false, true],
		[',   ,   ', false, true],
		[',"",""', false, true],
		[',true', true, true],
		[',true,', true, true],
		[',,false', false, false],
		[',false,   ', false, true],
	])('defaults omitted or blank optional values in %j', (suffix, allowAnonymous, forwardHfToken) => {
		expect(parseProxyToolsCsv(`policy,https://example.com/mcp,JSON${suffix}`)).toEqual([
			expect.objectContaining({ allowAnonymous, forwardHfToken }),
		]);
		expect(mocks.logger.warn).not.toHaveBeenCalled();
	});

	it.each(['yes', 'no', '1', '0', 'null', 'undefined', 'truthy', 'false-ish'])(
		'warns and skips invalid nonempty flags %j in either column',
		(value) => {
			expect(
				parseProxyToolsCsv(
					`invalid_anonymous,https://example.com/mcp,JSON,${value},false\n` +
						`invalid_forward,https://example.com/mcp,JSON,true,${value}`
				)
			).toEqual([]);
			expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
			expect(mocks.logger.warn).toHaveBeenCalledWith(
				{ proxyId: 'invalid_forward' },
				expect.stringContaining('forward_hf_token')
			);
		}
	);

	it.each(['proxy_id', 'tool_name', 'PROXY_ID', 'TOOL_NAME'])(
		'accepts positional %s headers, comments, CRLF and quoted fields',
		(header) => {
			const csv = [
				'',
				'  # CSV configuration',
				`"${header}",url,response_type,allow_anonymous,forward_hf_token`,
				'"proxy, ""quoted""","https://example.com/mcp?q=one,two","sse","TRUE","FALSE"',
				'  ',
				'# end',
			].join('\r\n');

			expect(parseProxyToolsCsv(csv)).toEqual([
				{
					proxyId: 'proxy, "quoted"',
					url: 'https://example.com/mcp?q=one,two',
					responseType: 'SSE',
					allowAnonymous: true,
					forwardHfToken: false,
				},
			]);
			expect(mocks.logger.warn).not.toHaveBeenCalled();
		}
	);

	it.each(['proxy_id', 'tool_name'])('accepts legacy three-column %s headers', (header) => {
		expect(parseProxyToolsCsv(`${header},url,response_type\nlegacy,https://example.com/mcp,JSON`)).toEqual([
			expect.objectContaining({ proxyId: 'legacy', allowAnonymous: false, forwardHfToken: true }),
		]);
		expect(mocks.logger.warn).not.toHaveBeenCalled();
	});

	it('retains URL, response type, required-field and duplicate validation', () => {
		const csv = [
			'not,enough',
			'missing,,JSON',
			'bad_url,not-a-url,JSON',
			'bad_type,https://example.com/mcp,XML',
			'valid,https://example.com/mcp,JSON,true,false',
			'valid,https://other.example/mcp,SSE,false,true',
		].join('\n');
		expect(parseProxyToolsCsv(csv)).toEqual([
			expect.objectContaining({ proxyId: 'valid', allowAnonymous: true, forwardHfToken: false }),
		]);
		expect(mocks.logger.warn).toHaveBeenCalledTimes(5);
	});

	it('does not reserve an id when a row has invalid policy', () => {
		expect(
			parseProxyToolsCsv('same,https://example.com/mcp,JSON,true,yes\nsame,https://example.com/mcp,JSON,false,false')
		).toEqual([expect.objectContaining({ proxyId: 'same', allowAnonymous: false, forwardHfToken: false })]);
		expect(mocks.logger.warn).toHaveBeenCalledOnce();
	});
});

describe('proxy tools CSV discovery loading', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.stubEnv('PROXY_TOOLS_CSV', '/test/proxy-tools.csv');
		vi.stubEnv('PROXY_TOKEN', undefined);
		vi.stubEnv('DEFAULT_HF_TOKEN', 'hf_default_secret');
		vi.stubEnv('HF_TOKEN', 'hf_user_secret');
		vi.stubEnv('LOGGING_HF_TOKEN', 'hf_logging_secret');
		mocks.connect.mockResolvedValue(undefined);
		mocks.close.mockResolvedValue(undefined);
		mocks.listTools.mockReset();
		mocks.listTools.mockResolvedValue({
			tools: [{ name: 'upstream', inputSchema: { type: 'object', properties: {} } }],
		});
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('propagates each source policy to every discovered tool, including legacy defaults', async () => {
		mocks.readFile.mockResolvedValue(
			[
				'private,https://private.example/mcp,JSON,false,false',
				'public,https://public.example/mcp,SSE,true,true',
				'legacy,https://legacy.example/mcp,JSON',
			].join('\n')
		);
		mocks.listTools.mockResolvedValue({
			tools: [
				{ name: 'first', inputSchema: { type: 'object' } },
				{ name: 'second', inputSchema: { type: 'object' } },
			],
		});
		const { loadProxyToolsConfig, getProxyToolsConfig } =
			await import('../../../src/server/utils/proxy-tools-config.js');
		const tools = await loadProxyToolsConfig();

		expect(tools).toEqual(
			[
				{ proxyId: 'private', allowAnonymous: false, forwardHfToken: false },
				{ proxyId: 'public', allowAnonymous: true, forwardHfToken: true },
				{ proxyId: 'legacy', allowAnonymous: false, forwardHfToken: true },
			].flatMap((policy) =>
				['first', 'second'].map((name) =>
					expect.objectContaining({ ...policy, toolName: name, upstreamToolName: name })
				)
			)
		);
		expect(mocks.close).toHaveBeenCalledTimes(3);
		expect(getProxyToolsConfig()).toBe(tools);
		expect(await loadProxyToolsConfig()).toBe(tools);
		expect(mocks.readFile).toHaveBeenCalledOnce();
	});

	it.each([
		['true', 'true'],
		['true', 'false'],
		['false', 'true'],
		['false', 'false'],
	])('uses explicit PROXY_TOKEN for discovery regardless of policies %s / %s', async (anonymous, forward) => {
		vi.stubEnv('PROXY_TOKEN', 'hf_explicit_discovery');
		mocks.readFile.mockResolvedValue(`single,https://example.com/mcp,JSON,${anonymous},${forward}`);
		const { loadProxyToolsConfig } = await import('../../../src/server/utils/proxy-tools-config.js');

		expect(await loadProxyToolsConfig()).toEqual([
			expect.objectContaining({
				toolName: 'single',
				upstreamToolName: 'upstream',
				allowAnonymous: anonymous === 'true',
				forwardHfToken: forward === 'true',
			}),
		]);
		expect(mocks.transport).toHaveBeenCalledExactlyOnceWith(new URL('https://example.com/mcp'), {
			requestInit: {
				headers: {
					Authorization: 'Bearer hf_explicit_discovery',
					'X-HF-Authorization': 'Bearer hf_explicit_discovery',
				},
			},
		});
	});

	it.each(['', ',true,true', ',false,false'])(
		'never falls back to DEFAULT_HF_TOKEN, HF_TOKEN or logging credentials for discovery (%j)',
		async (suffix) => {
			mocks.readFile.mockResolvedValue(`single,https://example.com/mcp,JSON${suffix}`);
			const { loadProxyToolsConfig } = await import('../../../src/server/utils/proxy-tools-config.js');

			expect(await loadProxyToolsConfig()).toHaveLength(1);
			expect(mocks.transport).toHaveBeenCalledExactlyOnceWith(new URL('https://example.com/mcp'), {
				requestInit: undefined,
			});
		}
	);

	it('does not discover tools for invalid policies, especially an invalid forwarding flag', async () => {
		mocks.readFile.mockResolvedValue('unsafe,https://example.com/mcp,JSON,true,yes');
		const { loadProxyToolsConfig } = await import('../../../src/server/utils/proxy-tools-config.js');

		expect(await loadProxyToolsConfig()).toEqual([]);
		expect(mocks.logger.warn).toHaveBeenCalledOnce();
		expect(mocks.transport).not.toHaveBeenCalled();
		expect(mocks.listTools).not.toHaveBeenCalled();
	});

	it('loads HTTPS CSV policy without sending any credentials to the CSV host', async () => {
		vi.stubEnv('PROXY_TOOLS_CSV', 'https://config.example/proxy-tools.csv');
		vi.stubEnv('PROXY_TOKEN', 'hf_explicit_discovery');
		mocks.fetchWithProfile.mockResolvedValue({
			response: new Response('public,https://example.com/mcp,JSON,true,false'),
		});
		const { loadProxyToolsConfig } = await import('../../../src/server/utils/proxy-tools-config.js');

		expect(await loadProxyToolsConfig()).toEqual([
			expect.objectContaining({ allowAnonymous: true, forwardHfToken: false }),
		]);
		expect(mocks.fetchWithProfile).toHaveBeenCalledExactlyOnceWith(
			'https://config.example/proxy-tools.csv',
			expect.any(Object),
			{ timeoutMs: 10_000 }
		);
		expect(mocks.readFile).not.toHaveBeenCalled();
		expect(mocks.transport).toHaveBeenCalledWith(
			new URL('https://example.com/mcp'),
			expect.objectContaining({
				requestInit: {
					headers: {
						Authorization: 'Bearer hf_explicit_discovery',
						'X-HF-Authorization': 'Bearer hf_explicit_discovery',
					},
				},
			})
		);
	});
});
