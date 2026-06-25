import { describe, it, expect } from 'vitest';
import { MetricsCounter, isInitializeRequest } from '../../src/shared/transport-metrics.js';

describe('isInitializeRequest', () => {
	it('should identify initialize requests', () => {
		expect(isInitializeRequest('initialize')).toBe(true);
		expect(isInitializeRequest('notifications/initialized')).toBe(false);
		expect(isInitializeRequest('tools/list')).toBe(false);
	});
});

describe('MetricsCounter', () => {
	it('buckets method details after too many distinct values for a base method', () => {
		const metrics = new MetricsCounter();

		for (let i = 0; i < 500; i++) {
			metrics.trackMethod(`resources/subscribe:skill://example/${i}`);
		}

		metrics.trackMethod('resources/subscribe:skill://example/500');
		metrics.trackMethod('resources/subscribe:skill://example/501');
		metrics.trackMethod('resources/read:skill://example/0');

		const methodMetrics = metrics.getMetrics().methods;
		expect(methodMetrics.size).toBe(502);
		expect(methodMetrics.get('resources/subscribe:skill://example/0')?.count).toBe(1);
		expect(methodMetrics.get('resources/subscribe:__unexpected__')?.count).toBe(2);
		expect(methodMetrics.get('resources/read:skill://example/0')?.count).toBe(1);
	});

	it('continues tracking previously seen method details after the bucket is full', () => {
		const metrics = new MetricsCounter();

		for (let i = 0; i < 500; i++) {
			metrics.trackMethod(`tools/call:tool_${i}`);
		}

		metrics.trackMethod('tools/call:tool_42');
		metrics.trackMethod('tools/call:tool_500');

		const methodMetrics = metrics.getMetrics().methods;
		expect(methodMetrics.get('tools/call:tool_42')?.count).toBe(2);
		expect(methodMetrics.get('tools/call:__unexpected__')?.count).toBe(1);
	});
});
