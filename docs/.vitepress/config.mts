import { withMermaid } from 'vitepress-plugin-mermaid';
import footnote from 'markdown-it-footnote';
import tailwindcss from '@tailwindcss/vite';
import llmstxt from 'vitepress-plugin-llms';
import { HeadConfig } from 'vitepress';
// @ts-expect-error This file gets generated once docs:generate is run
import apiRoutes from '../api/index.json';

const DESCRIPTION = 'A JavaScript library for reading, writing, and converting media files. Directly in the browser,'
	+ ' and faster than anybunny else.';

// https://vitepress.dev/reference/site-config
export default withMermaid({
	title: 'Mediabunny',
	description: DESCRIPTION,
	cleanUrls: true,
	sitemap: {
		hostname: 'https://mediabunny.dev',
	},
	head: [
		['link', { rel: 'icon', type: 'image/png', href: '/mediabunny-logo.png' }],
		['link', { rel: 'icon', type: 'image/svg+xml', href: '/mediabunny-logo.svg' }],
		['meta', { property: 'og:type', content: 'website' }],
		['meta', { property: 'og:site_name', content: 'Mediabunny' }],
		['meta', { property: 'og:url', content: 'https://mediabunny.dev/' }],
		['meta', { property: 'og:image', content: 'https://mediabunny.dev/mediabunny-og-image.png' }],
		['meta', { property: 'og:locale', content: 'en-US' }],
		['meta', { property: 'og:description', content: DESCRIPTION }],
		['meta', { name: 'twitter:image', content: 'https://mediabunny.dev/mediabunny-og-image.png' }],
		['meta', { name: 'twitter:card', content: 'summary_large_image' }],
		['meta', { name: 'twitter:site', content: '@vanilagy' }],
		['meta', { name: 'twitter:description', content: DESCRIPTION }],
	],
	themeConfig: {
		logo: '/mediabunny-logo.svg',

		// https://vitepress.dev/reference/default-theme-config
		nav: [
			{ text: 'Guide', link: '/guide/introduction', activeMatch: '/guide' },
			{ text: 'API', link: '/api/', activeMatch: '/api' },
			{ text: 'LLMs', link: '/llms', activeMatch: '/llms' },
			{ text: 'Examples', link: '/examples', activeMatch: '/examples' },
			{ text: 'Sponsors', link: '/#sponsors', activeMatch: '/#sponsors' },
			{ text: 'License', link: 'https://github.com/Vanilagy/mediabunny#license' },
		],

		sidebar: {
			'/guide': [
				{
					text: 'Getting started',
					items: [
						{ text: 'Introduction', link: '/guide/introduction' },
						{ text: 'Installation', link: '/guide/installation' },
						{ text: 'Quick start', link: '/guide/quick-start' },
					],
				},
				{
					text: 'Reading',
					items: [
						{ text: 'Reading media files', link: '/guide/reading-media-files' },
						{ text: 'Media sinks', link: '/guide/media-sinks' },
						{ text: 'Input formats', link: '/guide/input-formats' },
					],
				},
				{
					text: 'Writing',
					items: [
						{ text: 'Writing media files', link: '/guide/writing-media-files' },
						{ text: 'Media sources', link: '/guide/media-sources' },
						{ text: 'Output formats', link: '/guide/output-formats' },
					],
				},
				{
					text: 'Conversion',
					items: [
						{ text: 'Converting media files', link: '/guide/converting-media-files' },
					],
				},
				{
					text: 'Miscellaneous',
					items: [
						{ text: 'Packets & samples', link: '/guide/packets-and-samples' },
						{ text: 'Supported formats & codecs', link: '/guide/supported-formats-and-codecs' },
					],
				},
				{
					text: 'Extensions',
					items: [
						{ text: 'mp3-encoder', link: '/guide/extensions/mp3-encoder' },
					],
				},
			],

			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
			'/api': apiRoutes as any,
		},

		socialLinks: [
			{ icon: 'github', link: 'https://github.com/Vanilagy/mediabunny' },
			{ icon: 'discord', link: 'https://discord.gg/hmpkyYuS4U' },
			{ icon: 'x', link: 'https://x.com/vanilagy' },
			{ icon: 'bluesky', link: 'https://bsky.app/profile/vanilagy.bsky.social' },
		],

		search: {
			provider: 'local',
		},

		outline: {
			level: [2, 3],
		},

		footer: {
			message: 'Released under the Mozilla Public License 2.0.',
			copyright: 'Copyright © 2026-present Vanilagy',
		},
	},
	markdown: {
		math: true,
		theme: { light: 'github-light', dark: 'github-dark-dimmed' },
		config(md) {
			md.use(footnote);
		},
	},
	vite: {
		plugins: [
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			tailwindcss() as any,
			llmstxt({
				ignoreFiles: [
					'api/*',
				],
			}),
		],
	},
	outDir: '../dist-docs',
	transformPageData(pageData) {
		let title = pageData.title;
		if (title !== 'Mediabunny') {
			title += ' | Mediabunny';
		}

		((pageData.frontmatter['head'] ??= []) as HeadConfig[]).push(
			['meta', { property: 'og:title', content: title }],
			['meta', { property: 'twitter:title', content: title }],
		);
	},
});
