<script setup lang="ts">
import { useData } from 'vitepress';

const data = useData();
</script>

<template>
	<div class="flex gap-2 items-center">
		<img :src="data.frontmatter.value['authorImage']" class="size-12 rounded-full" />
		<p>{{ data.frontmatter.value['author'] }}</p>
	</div>
</template>