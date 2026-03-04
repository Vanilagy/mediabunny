/// <reference types="@vitest/browser/providers/webdriverio" />

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	resolve: {
		alias: {
			'mediabunny': path.resolve(__dirname, './src/index.ts'),
			'@mediabunny/ac3': path.resolve(__dirname, './packages/ac3/dist/bundles/mediabunny-ac3.mjs'),
			'@mediabunny/aac-encoder':
				path.resolve(__dirname, './packages/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs'),
			'@mediabunny/flac-encoder':
				path.resolve(__dirname, './packages/flac-encoder/dist/bundles/mediabunny-flac-encoder.mjs'),
			'@mediabunny/mp3-encoder':
				path.resolve(__dirname, './packages/mp3-encoder/dist/bundles/mediabunny-mp3-encoder.mjs'),
		},
	},
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'node',
					root: 'test',
					include: ['node/**/*.test.ts'],
					environment: 'node',
				},
			},
			{
				extends: true,
				test: {
					name: 'browser',
					root: 'test',
					include: ['browser/**/*.test.ts'],
					browser: {
						enabled: true,
						provider: 'webdriverio',
						instances: [{
							browser: 'chrome',
						}],
						headless: false, // A bunch of features need the head
						screenshotFailures: false,
					},
				},
			},
		],
	},
});
