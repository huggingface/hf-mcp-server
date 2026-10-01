import type { SkillsMetricsFilters, SkillsMetricsResponse } from '../../shared/skills-metrics.js';

export const DEFAULT_SKILLS_FILTERS: SkillsMetricsFilters = {
	window: '1h',
	client: '',
	method: 'all',
	outcome: 'all',
};

export function skillsMetricsUrl(filters: SkillsMetricsFilters): string {
	return `/api/skills-metrics?${new URLSearchParams({
		window: filters.window,
		client: filters.client.slice(0, 128),
		method: filters.method,
		outcome: filters.outcome,
	}).toString()}`;
}

export async function skillsMetricsFetcher(url: string): Promise<SkillsMetricsResponse> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch Skills metrics: ${response.status}`);
	return (await response.json()) as SkillsMetricsResponse;
}
