import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		env: {
			NODE_ENV: 'test',
		},
		typecheck: {
			tsconfig: './tsconfig.test.json',
		},
	},
	resolve: {
		alias: {
			'@/lib/utils': path.resolve(import.meta.dirname, './src/web/lib/utils.ts'),
			'@': path.resolve(import.meta.dirname, './src'),
			'@llmindset/hf-mcp/network': path.resolve(import.meta.dirname, '../mcp/src/network/index.ts'),
		},
	},
});
