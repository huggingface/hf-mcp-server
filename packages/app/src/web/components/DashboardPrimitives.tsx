import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

interface MetricTileProps {
	label: string;
	value: ReactNode;
	detail?: ReactNode;
	icon?: ReactNode;
	tone?: 'neutral' | 'amber' | 'blue' | 'green' | 'red' | 'violet';
}

const toneClasses = {
	neutral: 'bg-slate-50 text-slate-700 dark:bg-slate-900/60 dark:text-slate-200',
	amber: 'bg-amber-50 text-amber-800 dark:bg-amber-950/35 dark:text-amber-200',
	blue: 'bg-blue-50 text-blue-800 dark:bg-blue-950/35 dark:text-blue-200',
	green: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-200',
	red: 'bg-red-50 text-red-800 dark:bg-red-950/35 dark:text-red-200',
	violet: 'bg-violet-50 text-violet-800 dark:bg-violet-950/35 dark:text-violet-200',
} as const;

export function MetricTile({ label, value, detail, icon, tone = 'neutral' }: MetricTileProps) {
	return (
		<div className="rounded-xl border bg-card p-4 shadow-xs">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
					<div className="mt-2 text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
					{detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
				</div>
				{icon && <div className={cn('rounded-lg p-2.5', toneClasses[tone])}>{icon}</div>}
			</div>
		</div>
	);
}

interface SectionHeaderProps {
	title: string;
	description?: string;
	aside?: ReactNode;
}

export function SectionHeader({ title, description, aside }: SectionHeaderProps) {
	return (
		<div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
			<div>
				<h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
				{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
			</div>
			{aside}
		</div>
	);
}
