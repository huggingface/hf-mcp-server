import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openCursor, sealCursor } from './hub-http.js';
import { PAGING_NOTE_FROM_PAGE, READ_ONLY, callPtcTool, definePtcTool } from './tool.js';
import { advertisedOutputSchema } from './wire-schema.js';
import { withPagingNote } from './paging.js';

const pager = definePtcTool({
	name: 'hf_test_pager',
	family: 'discovery',
	title: 'Test pager',
	description: 'Test pager.',
	input: z.object({ cursor: z.string().optional() }).strict(),
	output: z
		.object({
			n: z.number(),
			next_cursor: z.string().nullable(),
			completeness: z.object({ scope: z.literal('listing_page') }).strict(),
		})
		.strict(),
	access: 'anonymous',
	annotations: READ_ONLY,
	run: (input, ctx) => {
		const n = Number(openCursor(input.cursor, ['pager'], ctx) ?? '0');
		return Promise.resolve({
			n,
			next_cursor: sealCursor(['pager'], ctx, String(n + 1)),
			completeness: { scope: 'listing_page' as const },
		});
	},
});

describe('page counting in cursors', () => {
	it('adds a paging note from page ten on, and paging keeps working', async () => {
		let cursor: string | undefined;
		const pages: Record<string, unknown>[] = [];
		for (let page = 1; page <= PAGING_NOTE_FROM_PAGE + 1; page++) {
			const result = await callPtcTool(pager, cursor ? { cursor } : {});
			pages.push(result.structured);
			cursor = result.structured.next_cursor as string;
		}
		expect(pages[0]?.completeness).toEqual({ scope: 'listing_page' });
		expect(pages[PAGING_NOTE_FROM_PAGE - 2]?.completeness).toEqual({ scope: 'listing_page' });
		expect(pages[PAGING_NOTE_FROM_PAGE - 1]?.completeness).toMatchObject({
			page: PAGING_NOTE_FROM_PAGE,
			paging_note: expect.stringContaining('narrow the filters') as unknown,
		});
		expect(pages[PAGING_NOTE_FROM_PAGE]?.n).toBe(PAGING_NOTE_FROM_PAGE);
	});

	it('still accepts cursors minted without a page number', async () => {
		const sealed = JSON.parse(Buffer.from(sealCursor(['pager'], {}, '5'), 'base64url').toString()) as { query: string };
		const legacy = Buffer.from(JSON.stringify({ v: 1, query: sealed.query, cursor: '5' })).toString('base64url');
		const result = await callPtcTool(pager, { cursor: legacy });
		expect(result.structured.n).toBe(5);
	});

	it('validates noted results against the advertised output schema (strict completeness contracts)', async () => {
		const strict = z
			.object({ completeness: z.object({ scope: z.literal('fulltext_page') }).strict(), n: z.number() })
			.strict();
		const noted = withPagingNote({ completeness: { scope: 'fulltext_page' }, n: 1 }, PAGING_NOTE_FROM_PAGE);
		expect(strict.safeParse(noted).success).toBe(false);
		const outcome = (await advertisedOutputSchema(strict)['~standard'].validate(noted)) as {
			value?: unknown;
			issues?: unknown[];
		};
		expect(outcome.issues).toBeUndefined();
		expect(outcome.value).toEqual(noted);
		const bad = (await advertisedOutputSchema(strict)['~standard'].validate({ ...noted, n: 'x' })) as {
			issues?: unknown[];
		};
		expect(bad.issues?.length).toBeGreaterThan(0);
	});
});
