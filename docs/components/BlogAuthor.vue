<script setup lang="ts">
import { useData } from 'vitepress';
import { computed } from 'vue';

const props = defineProps<{
	frontmatter?: Record<string, any>;
	small?: boolean;
}>();

const data = useData();
const frontmatter = computed(() => props.frontmatter ?? data.frontmatter.value);
</script>

<template>
	<a :href="frontmatter['authorLink']" class="inline-flex gap-2 items-center !no-underline !text-(--var-c-text-1) py-1">
		<img :src="frontmatter['authorImage']" class="size-10 rounded-full shadow" :class="{ '!size-8': small }" />
		<div class="pl-1">
			<p class="!m-0 font-semibold" :class="{ 'text-sm': small }">{{ frontmatter['author'] }}</p>
			<!--
			<p class="!m-0 text-sm opacity-60">{{ frontmatter['authorSubtitle'] }}</p>
			-->
		</div>
	</a>
</template>