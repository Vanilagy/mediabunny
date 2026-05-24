import { createContentLoader } from 'vitepress';

export default createContentLoader('blog/*.md', {
	transform: posts => posts.sort((a, b) =>
		Date.parse(b.frontmatter.publishedOnIso) - Date.parse(a.frontmatter.publishedOnIso)
	),
});
