---
outline: false
---

<script setup>
import { data } from './blog.data.ts';
import BlogAuthor from './components/BlogAuthor.vue';
</script>

<h1 class="!mb-8">Blog posts</h1>

<template v-for="(post, i) in data">
	<a :href="post.url" class="flex flex-col sm:flex-row items-start sm:gap-8 !text-inherit !no-underline ![font-weight:inherit] group">
		<div>
			<img src="./assets/on-air.png" class="shrink-0 sm:w-40 rounded" />
			<div v-if="false" class="p-1">
				<BlogAuthor :frontmatter="post.frontmatter" small />
			</div>
		</div>
		<div class="flex-1">
			<p class="!m-0 text-xs opacity-70">{{ post.frontmatter.publishedOn }}</p>
			<h3 class="!m-0 group-hover:underline">{{ post.frontmatter.title }}</h3>
			<p class="text-sm !m-0">{{ post.frontmatter.excerpt }}</p>
		</div>
	</a>
	<hr v-if="i < data.length - 1" />
</template>