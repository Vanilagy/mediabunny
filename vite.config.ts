import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';
import tailwindcss from '@tailwindcss/vite';

const examplesDir = path.resolve(__dirname, './examples');

const exampleFolders = fs
	.readdirSync(examplesDir, { withFileTypes: true })
	.filter(dirent => dirent.isDirectory())
	.map(dirent => dirent.name);

const rollupInput = Object.fromEntries(
	exampleFolders.map(folderName => [
		folderName,
		path.resolve(examplesDir, folderName, 'index.html'),
	]),
);

export default defineConfig({
	resolve: {
		alias: {
			'mediabunny': path.resolve(__dirname, './dist/bundles/mediabunny.mjs'),
			'@mediabunny/aac-encoder':
				path.resolve(__dirname, './packages/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs'),
			'@mediabunny/flac-encoder':
				path.resolve(__dirname, './packages/flac-encoder/dist/bundles/mediabunny-flac-encoder.mjs'),
		},
	},
	plugins: [
		tailwindcss(),
	],
	server: {
		hmr: false,
		allowedHosts: true,
	},
	build: {
		outDir: 'dist-docs', // Build them directly into the docs build folder
		emptyOutDir: false,
		rollupOptions: {
			input: rollupInput,
		},
		minify: false,
	},
});
