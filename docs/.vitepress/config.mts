/* eslint-disable @stylistic/max-len */
import { withMermaid } from 'vitepress-plugin-mermaid';
import footnote from 'markdown-it-footnote';
import tailwindcss from '@tailwindcss/vite';
import llmstxt from 'vitepress-plugin-llms';
import { HeadConfig } from 'vitepress';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore This file gets generated once docs:generate is run
import apiRoutes from '../api/index.json';
import m3u8Grammar from './m3u8-grammar.json' with { type: 'json' };
import fs from 'node:fs/promises';
import path from 'node:path';

const DESCRIPTION = 'A JavaScript library for reading, writing, and converting media files. Directly in the browser,'
	+ ' and faster than anybunny else.';
const ORIGIN = 'https://mediabunny.dev';

// https://vitepress.dev/reference/site-config
export default withMermaid({
	title: 'Mediabunny',
	description: DESCRIPTION,
	cleanUrls: true,
	sitemap: {
		hostname: ORIGIN,
		transformItems: async (items) => {
			const entries = await fs.readdir('./examples');
			for (const entry of entries) {
				const isDirectory = await fs.stat(path.join('./examples', entry)).then(stat => stat.isDirectory());
				if (isDirectory) {
					items.push({
						url: `/examples/${entry}/`, // With trailing slash
					});
				}
			}

			return items;
		},
	},
	// lastUpdated: true,
	head: [
		['link', { rel: 'icon', type: 'image/png', href: '/mediabunny-logo.png' }],
		['link', { rel: 'icon', type: 'image/svg+xml', href: '/mediabunny-logo.svg' }],
		['meta', { property: 'og:site_name', content: 'Mediabunny' }],
		['meta', { property: 'og:image', content: `${ORIGIN}/mediabunny-og-image.png` }],
		['meta', { property: 'og:locale', content: 'en-US' }],
		['meta', { name: 'twitter:image', content: `${ORIGIN}/mediabunny-og-image.png` }],
		['meta', { name: 'twitter:card', content: 'summary_large_image' }],
		['meta', { name: 'twitter:site', content: '@vanilagy' }],
	],
	themeConfig: {
		logo: '/mediabunny-logo.svg',

		// https://vitepress.dev/reference/default-theme-config
		nav: [
			{ text: 'Guide', link: '/guide/introduction', activeMatch: '/guide' },
			{ text: 'API', link: '/api/', activeMatch: '/api/' }, // Trailing slash because it's index.html from there
			{ text: 'LLMs', link: '/llms', activeMatch: '/llms' },
			{ text: 'Examples', link: '/examples', activeMatch: '/examples' },
			{ text: 'Blog', link: '/blog', activeMatch: '/blog' },
			{ text: 'Sponsors', link: '/#sponsors', activeMatch: '/#sponsors' },
			{ text: 'License', link: 'https://github.com/Vanilagy/mediabunny#license', rel: 'noopener' },
			{
				text: 'More',
				items: [
					{ text: 'Codec Registry', link: '/codec-registry/overview' },
				],
			},
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
					text: 'HLS',
					items: [
						{ text: 'Reading HLS', link: '/guide/reading-hls' },
						{ text: 'Writing HLS', link: '/guide/writing-hls' },
					],
				},
				{
					text: 'Extensions',
					items: [
						{ text: 'server', link: '/guide/extensions/server' },
						{ text: 'mp3-encoder', link: '/guide/extensions/mp3-encoder' },
						{ text: 'aac-encoder', link: '/guide/extensions/aac-encoder' },
						{ text: 'ac3', link: '/guide/extensions/ac3' },
						{ text: 'flac-encoder', link: '/guide/extensions/flac-encoder' },
					],
				},
			],

			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
			'/api': apiRoutes as any,

			'/codec-registry': [
				{
					text: 'Codec registry',
					items: [
						{ text: 'Overview', link: '/codec-registry/overview' },
					],
				},
				{
					text: 'Video',
					items: [
						{ text: 'AVC (H.264)', link: '/codec-registry/avc' },
						{ text: 'HEVC (H.265)', link: '/codec-registry/hevc' },
						{ text: 'VP8', link: '/codec-registry/vp8' },
						{ text: 'VP9', link: '/codec-registry/vp9' },
						{ text: 'AV1', link: '/codec-registry/av1' },
						{ text: 'VVC (H.266)', link: '/codec-registry/vvc' },
					],
				},
				{
					text: 'Audio',
					items: [
						{ text: 'AAC', link: '/codec-registry/aac' },
						{ text: 'Opus', link: '/codec-registry/opus' },
						{ text: 'MP3', link: '/codec-registry/mp3' },
						{ text: 'Vorbis', link: '/codec-registry/vorbis' },
						{ text: 'FLAC', link: '/codec-registry/flac' },
						{ text: 'AC-3', link: '/codec-registry/ac3' },
						{ text: 'E-AC-3', link: '/codec-registry/eac3' },
						{ text: 'DTS', link: '/codec-registry/dts' },
						{ text: 'Dolby TrueHD', link: '/codec-registry/truehd' },
						{ text: 'ALAC', link: '/codec-registry/alac' },
						{ text: 'Linear PCM', link: '/codec-registry/pcm' },
						{ text: 'μ-law PCM', link: '/codec-registry/ulaw' },
						{ text: 'A-law PCM', link: '/codec-registry/alaw' },
					],
				},
			],
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
			copyright: `Copyright © ${new Date().getFullYear()}-present Vanilagy`,
		},
	},
	markdown: {
		math: true,
		theme: { light: 'github-light', dark: 'github-dark-dimmed' },
		shikiSetup: (shiki) => {
			shiki.loadLanguageSync(m3u8Grammar);
		},
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
					'examples.md',
					'llms.md',
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

		const canonicalUrl = `${ORIGIN}/${pageData.relativePath}`
			.replace(/index\.md$/, '')
			.replace(/\.md$/, '');
		const isBlogPost = canonicalUrl.includes('/blog/');

		const breadcrumbs: object[] = [];

		if (canonicalUrl.includes('/guide/')) {
			breadcrumbs.push({
				'@type': 'ListItem',
				'position': 1,
				'name': 'Guide',
				'item': `${ORIGIN}/guide`,
			}, {
				'@type': 'ListItem',
				'position': 2,
				'name': pageData.title,
			});
		}

		if (canonicalUrl.includes('/api/')) {
			breadcrumbs.push({
				'@type': 'ListItem',
				'position': 1,
				'name': 'API docs',
				'item': `${ORIGIN}/api/`,
			}, {
				'@type': 'ListItem',
				'position': 2,
				'name': pageData.title,
			});
		}

		if (canonicalUrl.includes('/codec-registry/')) {
			breadcrumbs.push({
				'@type': 'ListItem',
				'position': 1,
				'name': 'Codec registry',
				'item': `${ORIGIN}/codec-registry/overview`,
			}, {
				'@type': 'ListItem',
				'position': 2,
				'name': pageData.title,
			});
		}

		((pageData.frontmatter['head'] ??= []) as HeadConfig[]).push(
			['meta', { property: 'og:type', content: isBlogPost ? 'article' : 'website' }],
			['meta', { property: 'og:title', content: title }],
			['meta', { property: 'og:description', content: pageData.description || DESCRIPTION }],
			['meta', { property: 'og:url', content: canonicalUrl }],
			['meta', { name: 'twitter:title', content: title }],
			['meta', { name: 'twitter:description', content: pageData.description || DESCRIPTION }],
			['link', { rel: 'canonical', href: canonicalUrl }],
		);

		if (isBlogPost) {
			((pageData.frontmatter['head'] ??= []) as HeadConfig[]).push(
				['meta', { property: 'article:published_time', content: String(pageData.frontmatter['publishedOnIso']) }],
				['meta', { property: 'article:author', content: String(pageData.frontmatter['author']) }],
			);

			breadcrumbs.push({
				'@type': 'ListItem',
				'position': 1,
				'name': 'Blog posts',
				'item': `${ORIGIN}/blog`,
			}, {
				'@type': 'ListItem',
				'position': 2,
				'name': pageData.title,
			});
		}

		if (breadcrumbs.length > 0) {
			((pageData.frontmatter['head'] ??= []) as HeadConfig[]).push(
				['script', { type: 'application/ld+json' }, JSON.stringify({
					'@context': 'https://schema.org',
					'@type': 'BreadcrumbList',
					'itemListElement': breadcrumbs,
				})],
			);
		}
	},
	buildEnd: async () => {
		const files = await fs.readdir('./docs/api');

		for (const file of files) {
			await fs.copyFile('./docs/api/' + file, './dist-docs/api/' + file);
		}
	},
});
