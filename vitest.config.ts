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
					include: ['browser/**/flac.test.ts'],
					browser: {
						enabled: true,
						provider: 'webdriverio',
						instances: [{
							browser: 'chrome',
							capabilities: {
								'goog:chromeOptions': {
									args: ['--no-sandbox', '--disable-dev-shm-usage'],
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
