/// <reference types="@vitest/browser/providers/webdriverio" />

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'node',
					root: 'test',
					include: ['node/**/*.test.ts'],
					environment: 'node',
				},
			},
			{
				test: {
					name: 'browser',
					root: 'test',
					include: ['browser/**/*.test.ts'],
					browser: {
						enabled: true,
						provider: 'webdriverio',
						instances: [{
							browser: 'chrome',
							capabilities: {
								'goog:chromeOptions': {
									args: [
										'--enable-webgl',
										'--ignore-gpu-blocklist',
										'--enable-gpu',
										'--use-gl=swiftshader',
										'--use-angle=swiftshader-webgl',
									],
								},
							},
						}],
						headless: false, // A bunch of features need the head
						screenshotFailures: false,
					},
				},
			},
		],
	},
});
