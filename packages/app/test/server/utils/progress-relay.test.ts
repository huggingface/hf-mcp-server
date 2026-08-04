import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { createProgressRelay } from '../../../src/server/utils/progress-relay.js';

type HandlerExtra = ServerContext;

function makeExtra(
	progressToken: unknown,
	sendNotification = vi.fn().mockResolvedValue(undefined),
	signal = new AbortController().signal
): { extra: HandlerExtra; sendNotification: typeof sendNotification } {
	const extra = {
		mcpReq: {
			_meta: { progressToken },
			signal,
			notify: sendNotification,
		},
	} as unknown as HandlerExtra;

	return { extra, sendNotification };
}

describe('createProgressRelay', () => {
	it.each(['progress-token', 42])('relays valid progress token %j', async (progressToken) => {
		const { extra, sendNotification } = makeExtra(progressToken);
		const relay = createProgressRelay(extra);

		expect(relay).toBeDefined();
		await relay?.({ progress: 3, total: 10, message: 'Working' });

		expect(sendNotification).toHaveBeenCalledWith({
			method: 'notifications/progress',
			params: {
				progressToken,
				progress: 3,
				total: 10,
				message: 'Working',
			},
		});
	});

	it.each([undefined, null, true, 1.5, Number.NaN, Number.POSITIVE_INFINITY, {}, []])(
		'ignores missing or invalid token %j',
		(progressToken) => {
			const extra = progressToken === undefined ? undefined : makeExtra(progressToken).extra;
			expect(createProgressRelay(extra)).toBeUndefined();
		}
	);

	it('uses a monotonically increasing fallback when progress is omitted', async () => {
		const { extra, sendNotification } = makeExtra('token');
		const relay = createProgressRelay(extra);

		await relay?.({ message: 'First' });
		await relay?.({ message: 'Second' });

		expect(sendNotification.mock.calls.map(([notification]) => notification.params.progress)).toEqual([1, 2]);
	});

	it('continues fallback progress from an explicit starting value', async () => {
		const { extra, sendNotification } = makeExtra('token');
		const relay = createProgressRelay(extra);

		await relay?.({ progress: 0, message: 'Submitting' });
		await relay?.({ message: 'Running' });

		expect(sendNotification.mock.calls.map(([notification]) => notification.params.progress)).toEqual([0, 1]);
	});

	it('does not send after the request is aborted', async () => {
		const abortController = new AbortController();
		abortController.abort();
		const { extra, sendNotification } = makeExtra(
			'token',
			vi.fn().mockResolvedValue(undefined),
			abortController.signal
		);

		await createProgressRelay(extra)?.({ progress: 1 });

		expect(sendNotification).not.toHaveBeenCalled();
	});

	it('disables subsequent notifications after a send failure', async () => {
		const sendNotification = vi.fn().mockRejectedValue(new Error('Disconnected'));
		const { extra } = makeExtra('token', sendNotification);
		const relay = createProgressRelay(extra);

		await expect(relay?.({ progress: 1 })).resolves.toBeUndefined();
		await expect(relay?.({ progress: 2 })).resolves.toBeUndefined();

		expect(sendNotification).toHaveBeenCalledOnce();
	});
});
