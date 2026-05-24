import { createContentLoader, type ContentData } from 'vitepress';

const getPublishedOnTimestamp = (post: ContentData) => {
	const frontmatter = post.frontmatter as Record<string, unknown>;
	const publishedOnIso = frontmatter['publishedOnIso'];

	return typeof publishedOnIso === 'string'
		? Date.parse(publishedOnIso)
		: 0;
};

export default createContentLoader('blog/*.md', {
	transform: posts => posts.sort((a, b) =>
		getPublishedOnTimestamp(b) - getPublishedOnTimestamp(a),
	),
});
