'use client';

import * as React from 'react';
import type { ColumnDef, ColumnFiltersState, SortingState, VisibilityState } from '@tanstack/react-table';
import {
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	useReactTable,
} from '@tanstack/react-table';
import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface DataTableProps<TData, TValue> {
	columns: ColumnDef<TData, TValue>[];
	data: TData[];
	searchColumn?: string;
	searchPlaceholder?: string;
	facetFilter?: {
		column: string;
		label: string;
		options: Array<{ label: string; value: string }>;
	};
	defaultColumnVisibility?: VisibilityState;
	pageSize?: number;
	defaultSorting?: SortingState;
}

export function DataTable<TData, TValue>({
	columns,
	data,
	searchColumn,
	searchPlaceholder = 'Filter...',
	facetFilter,
	defaultColumnVisibility = {},
	pageSize = 25,
	defaultSorting = [],
}: DataTableProps<TData, TValue>) {
	const [sorting, setSorting] = React.useState<SortingState>(defaultSorting);
	const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
	const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(defaultColumnVisibility);
	const [rowSelection, setRowSelection] = React.useState({});

	// TanStack Table intentionally manages mutable callbacks; React Compiler skips this component safely.
	// eslint-disable-next-line react-hooks/incompatible-library
	const table = useReactTable({
		data,
		columns,
		onSortingChange: setSorting,
		onColumnFiltersChange: setColumnFilters,
		getCoreRowModel: getCoreRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onColumnVisibilityChange: setColumnVisibility,
		onRowSelectionChange: setRowSelection,
		initialState: {
			pagination: {
				pageSize: pageSize,
			},
		},
		state: {
			sorting,
			columnFilters,
			columnVisibility,
			rowSelection,
		},
	});

	return (
		<div className="w-full">
			<div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
				{searchColumn && (
					<Input
						placeholder={searchPlaceholder}
						value={(table.getColumn(searchColumn)?.getFilterValue() as string) ?? ''}
						onChange={(event) => table.getColumn(searchColumn)?.setFilterValue(event.target.value)}
						className="w-full sm:max-w-sm"
					/>
				)}
				{facetFilter && (
					<select
						aria-label={facetFilter.label}
						value={(table.getColumn(facetFilter.column)?.getFilterValue() as string) ?? ''}
						onChange={(event) => table.getColumn(facetFilter.column)?.setFilterValue(event.target.value || undefined)}
						className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-auto sm:min-w-52"
					>
						<option value="">{facetFilter.label}</option>
						{facetFilter.options.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline" className="sm:ml-auto">
							Columns <ChevronDown className="ml-2 h-4 w-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{table
							.getAllColumns()
							.filter((column) => column.getCanHide())
							.map((column) => {
								return (
									<DropdownMenuCheckboxItem
										key={column.id}
										className="capitalize"
										checked={column.getIsVisible()}
										onCheckedChange={(value) => column.toggleVisibility(!!value)}
									>
										{column.id}
									</DropdownMenuCheckboxItem>
								);
							})}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="rounded-xl border bg-card">
				<Table className="min-w-[760px]">
					<TableHeader>
						{table.getHeaderGroups().map((headerGroup) => (
							<TableRow key={headerGroup.id}>
								{headerGroup.headers.map((header) => {
									const sortDirection = header.column.getIsSorted();
									return (
										<TableHead
											key={header.id}
											aria-sort={
												header.column.getCanSort()
													? sortDirection === 'asc'
														? 'ascending'
														: sortDirection === 'desc'
															? 'descending'
															: 'none'
													: undefined
											}
										>
											{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
										</TableHead>
									);
								})}
							</TableRow>
						))}
					</TableHeader>
					<TableBody>
						{table.getRowModel().rows?.length ? (
							table.getRowModel().rows.map((row) => (
								<TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
									{row.getVisibleCells().map((cell) => (
										<TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
									))}
								</TableRow>
							))
						) : (
							<TableRow>
								<TableCell colSpan={columns.length} className="h-24 text-center">
									No results.
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>
			<div className="flex items-center justify-end space-x-2 pt-3">
				<div className="text-muted-foreground flex-1 text-sm">
					{table.getFilteredRowModel().rows.length} row(s) total.
				</div>
				<div className="space-x-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => table.previousPage()}
						disabled={!table.getCanPreviousPage()}
					>
						Previous
					</Button>
					<Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
						Next
					</Button>
				</div>
			</div>
		</div>
	);
}
