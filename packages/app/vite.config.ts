import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// https://vite.dev/config/
export default defineConfig(() => {
	const plugins = [react(), tailwindcss()];

	const buildTarget = process.env.VITE_BUILD_TARGET;
	const isMcpWelcomeBuild = buildTarget === 'mcp-welcome';

	if (isMcpWelcomeBuild) {
		plugins.push(viteSingleFile());
	}

	return {
		plugins,
		resolve: {
			alias: {
				'@': path.resolve(__dirname, './src/web'),
			},
		},
		build: {
			outDir: path.resolve(__dirname, './dist/web'),
			emptyOutDir: false, // This prevents deleting mcp-server.js during builds
			rollupOptions: {
				input: isMcpWelcomeBuild
					? { mcpWelcome: path.resolve(__dirname, './src/web/mcp-welcome.html') }
					: { main: path.resolve(__dirname, './src/web/index.html') },
			},
		},
		root: path.resolve(__dirname, './src/web'),
	};
});
