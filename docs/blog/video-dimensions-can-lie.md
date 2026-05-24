---
title: Why video dimensions can lie
description: "What I learned building vertical video feeds: width and height alone are not enough to choose the right fit behavior."
publishedOn: May 24, 2026
publishedOnIso: "2026-05-24"
author: Hirbod Mirjavadi
authorImage: https://github.com/hirbod.png
authorLink: https://github.com/hirbod
authorSubtitle: Creator of expo-video-metadata
thumbnail: /blog/video-dimensions-can-lie.svg
excerpt: "In vertical video feeds, choosing between cover and contain looks like a simple aspect-ratio check. Then rotation metadata shows up, and width and height stop telling the full story."
---

<script setup>
import BlogAuthor from '../components/BlogAuthor.vue';
</script>

<img :src="$frontmatter.thumbnail" width="640" height="360" alt="A coded portrait video frame rotated into a landscape display frame" class="rounded-2xl mb-2">

<p class="!m-0 opacity-70">{{ $frontmatter.publishedOn }}</p>

<h1>{{ $frontmatter.title }}</h1>

<BlogAuthor />

After building a few vertical video apps, I expected the painful parts to be compression, downscaling, bitrate, and upload speed. Those are real problems. But the thing that wasted a surprising amount of my time was much smaller: deciding how a video should fit inside the player.

In a vertical feed, some videos should fill the screen. Others should be shown fully, even if that means letterboxing. My first version was exactly what you would expect:

```ts
function chooseObjectFit(width: number, height: number) {
	if (height > width) {
		return 'cover';
	}

	return 'contain';
}
```

Then the logic got a little more careful. Square and near-square videos usually shouldn't be cropped aggressively, because too much useful content can disappear. So only videos that were clearly portrait should use `cover`; everything else should use `contain`:

```ts
function chooseFeedFit(width: number, height: number) {
	const aspectRatio = width / height;

	if (height > width && aspectRatio <= 0.8) {
		return 'cover';
	}

	return 'contain';
}
```

That seemed good enough. It was not.

## The bug that didn't look like one

The bug showed up as videos that were clearly landscape, but the app treated them like portrait videos. The annoying part was that the numbers seemed to agree with the app. The stored width and height said the video was taller than it was wide.

So we checked the upload pipeline. We checked the player. We checked the database values. We changed the thresholds. None of that fixed it.

The missing piece was rotation metadata.

Video files can store frames one way, then describe how those frames should be presented. A file can have coded frames that are 1080x1920, but also say: rotate this by 90 degrees when displaying it. Depending on which values the app reads, the same file can look portrait in one part of the system and landscape in another.

That distinction matters:

```ts
const video = {
	codedWidth: 1080,
	codedHeight: 1920,
	rotation: 90,
	displayWidth: 1920,
	displayHeight: 1080,
};
```

If your app only looks at `codedWidth` and `codedHeight`, it sees a portrait video. If the player applies the rotation during playback, the user sees a landscape video. That's how you end up with the wrong `objectFit` even though every individual value looks "correct."

## Coded size is not display size

The practical lesson is simple: a video can have more than one size.

- `codedWidth` and `codedHeight` tell you how the frames are stored.
- `rotation` tells you how those frames should be presented.
- `displayWidth` and `displayHeight` tell you what shape the user actually sees.

For a feed UI, `displayWidth` and `displayHeight` are the values you usually want. They answer the question the player actually cares about: what shape is this video on screen?

So the fit logic should use display dimensions, not raw coded dimensions:

```ts
type VideoDisplayMetadata = {
	displayWidth: number;
	displayHeight: number;
};

function chooseFeedFit(metadata: VideoDisplayMetadata) {
	const aspectRatio = metadata.displayWidth / metadata.displayHeight;

	if (metadata.displayHeight > metadata.displayWidth && aspectRatio <= 0.8) {
		return 'cover';
	}

	return 'contain';
}
```

The threshold can be whatever makes sense for your product. The important part is where the ratio comes from. It should be calculated from the dimensions after presentation metadata has been applied.

## Extract the metadata before playback

I also don't think this should be figured out over and over again inside every video player instance. By the time someone scrolls to a video, the app should already know how that asset should be rendered.

A much cleaner flow is:

1. Read the video metadata during upload or ingestion.
2. Store the display dimensions, coded dimensions, rotation, and other useful technical metadata with the asset.
3. Use those stored values when rendering the feed.

This does not have to happen in the browser. If your upload already goes through a backend, Mediabunny can run there too via [`@mediabunny/server`](../guide/extensions/server), so you can extract the same metadata in Node, Bun, or Deno as part of your ingestion pipeline.

That keeps the player simple, and it makes the behavior consistent across clients. You're no longer relying on each platform to expose the same playback metadata in the same way at the same time.

## Mediabunny gives you the missing values

This is one of the reasons I like [Mediabunny](https://mediabunny.dev/). It exposes the video track values you need directly: coded dimensions, display dimensions, and rotation. The display dimensions also account for pixel aspect ratio, which is another detail I don't want UI code to rediscover.

```ts
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

export async function readVideoDisplayMetadata(file: File) {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) {
		return null;
	}

	const [
		codedWidth,
		codedHeight,
		displayWidth,
		displayHeight,
		rotation,
	] = await Promise.all([
		videoTrack.getCodedWidth(),
		videoTrack.getCodedHeight(),
		videoTrack.getDisplayWidth(),
		videoTrack.getDisplayHeight(),
		videoTrack.getRotation(),
	]);

	return {
		codedWidth,
		codedHeight,
		displayWidth,
		displayHeight,
		rotation,
	};
}
```

It's not a lot of data, but it removes a lot of guessing.

## Expo apps can use the same idea

For Expo and React Native apps, I built [expo-video-metadata](https://github.com/hirbod/expo-video-metadata) around this exact problem. It uses Mediabunny to expose video metadata across iOS, Android, and web, so you can collect these values during upload before the asset ever appears in a feed.

```ts
import { getVideoInfoAsync } from 'expo-video-metadata';

const info = await getVideoInfoAsync(videoUri);
const primaryVideoTrack = info.tracks.find((track) => track.type === 'video');

if (primaryVideoTrack?.type === 'video') {
	const fit = chooseFeedFit({
		displayWidth: primaryVideoTrack.displayWidth,
		displayHeight: primaryVideoTrack.displayHeight,
	});

	// Store `fit`, display dimensions, coded dimensions, and rotation
	// with the uploaded asset metadata.
}
```

Once this is stored, rendering becomes boring in the best way. The feed reads the asset metadata, decides the fit mode, and passes it to the player.

## The lesson

For vertical video apps, "is this video portrait?" is not the same question as "is height greater than width?"

The better question is: after presentation metadata is applied, what shape does the user actually see?

If you answer that during upload and store the result, `objectFit` stops being a runtime guess. Mediabunny gives you the low-level video facts you need, and `expo-video-metadata` makes those facts easy to use in Expo apps.
