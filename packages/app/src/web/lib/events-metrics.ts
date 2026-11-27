import type { EventsMetricsFilters, EventsMetricsResponse } from '../../shared/events-metrics.js';

export const DEFAULT_EVENTS_FILTERS: EventsMetricsFilters = {
	window: '1h',
	client: '',
	method: 'all',
	outcome: 'all',
};

export function eventsMetricsUrl(filters: EventsMetricsFilters): string {
	return `/api/events-metrics?${new URLSearchParams({
		window: filters.window,
		client: filters.client.slice(0, 128),
		method: filters.method,
		outcome: filters.outcome,
	}).toString()}`;
}

export async function eventsMetricsFetcher(url: string): Promise<EventsMetricsResponse> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch Events metrics: ${response.status}`);
	return (await response.json()) as EventsMetricsResponse;
}
