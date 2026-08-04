export function formatCompactNumber(value: number): string {
	return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
