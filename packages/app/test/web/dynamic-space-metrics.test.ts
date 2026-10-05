import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DynamicSpaceLiveMetricsResponse } from '../../src/shared/dynamic-space-metrics.js';
import { DynamicSpaceLiveMetricsCard } from '../../src/web/components/DynamicSpaceLiveMetricsCard.js';

function fixture(): DynamicSpaceLiveMetricsResponse {
	return {
		reportingSchema: 'dynamic_space_outcome_v1',
		calls: { total: 0, succeeded: 0, failed: 0 },
		operations: {
			help: { total: 0, succeeded: 0, failed: 0 },
			find: { total: 0, succeeded: 0, failed: 0 },
			discover: { total: 0, succeeded: 0, failed: 0 },
			view_parameters: { total: 0, succeeded: 0, failed: 0 },
			invoke: { total: 0, succeeded: 0, failed: 0 },
			unknown: { total: 0, succeeded: 0, failed: 0 },
		},
		failuresByStage: {
			request: 0,
			configuration: 0,
			metadata: 0,
			schema: 0,
			selection: 0,
			validation: 0,
			invocation: 0,
			operation: 0,
			unexpected: 0,
		},
		lastUpdated: null,
	};
}

function render(metrics: DynamicSpaceLiveMetricsResponse) {
	return renderToStaticMarkup(React.createElement(DynamicSpaceLiveMetricsCard, { metrics }));
}

describe('Dynamic Spaces live panel', () => {
	it('renders an honest zero state and explicit accounting scope', () => {
		const html = render(fixture());
		expect(html).toContain('Dynamic Spaces live');
		expect(html).toContain('No completed dynamic_space calls yet.');
		expect(html).toContain('0 succeeded · 0 failed');
		expect(html).not.toContain('%');
		expect(html).not.toContain('NaN');
		expect(html).not.toContain('Failures by stage');
		expect(html).toContain(
			'Completed dynamic_space handler outcomes since this server process started, not task success.'
		);
		expect(html).toContain('Excludes pre-handler SDK validation and direct Gradio tools (gr_*)');
		expect(html).toContain('including direct image generation');
	});

	it('renders aggregate calls, invocation outcomes, all operations and only nonzero failure stages', () => {
		const metrics = fixture();
		metrics.calls = { total: 12, succeeded: 8, failed: 4 };
		metrics.operations.help = { total: 1, succeeded: 1, failed: 0 };
		metrics.operations.find = { total: 2, succeeded: 2, failed: 0 };
		metrics.operations.discover = { total: 1, succeeded: 1, failed: 0 };
		metrics.operations.view_parameters = { total: 1, succeeded: 1, failed: 0 };
		metrics.operations.invoke = { total: 6, succeeded: 3, failed: 3 };
		metrics.operations.unknown = { total: 1, succeeded: 0, failed: 1 };
		metrics.failuresByStage.invocation = 3;
		metrics.failuresByStage.request = 1;
		metrics.lastUpdated = '2026-10-05T12:00:00Z';
		const html = render(metrics);
		expect(html).toContain('8 succeeded · 4 failed');
		expect(html).toContain('3 succeeded · 3 failed');
		expect(html).toMatch(/Calls<\/p><p[^>]*>12<\/p>/);
		expect(html).toMatch(/Invocations<\/p><p[^>]*>6<\/p>/);
		for (const [operation, counts] of Object.entries(metrics.operations)) {
			expect(html).toMatch(
				new RegExp(
					`${operation}</th><td[^>]*>${counts.total}</td><td[^>]*>${counts.succeeded}</td><td[^>]*>${counts.failed}</td>`
				)
			);
		}
		expect(html).toContain('request · 1');
		expect(html).toContain('invocation · 3');
		for (const stage of ['configuration', 'metadata', 'schema', 'selection', 'validation', 'operation', 'unexpected']) {
			expect(html).not.toContain(`${stage} ·`);
		}
		expect(html).not.toContain('No completed');
		expect(html).not.toContain('%');
	});

	it('does not render extra payload fields or identifiers', () => {
		const metrics = {
			...fixture(),
			prompt: 'PRIVATE_PROMPT',
			space: 'PRIVATE_SPACE',
			clientId: 'PRIVATE_CLIENT',
		};
		expect(render(metrics)).not.toContain('PRIVATE_');
	});
});
