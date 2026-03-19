import { expect, test, beforeEach } from "vitest";
import { Input } from "../../src/input.js";
import { ALL_FORMATS } from "../../src/input-format.js";
import { BufferSource, UrlSource } from "../../src/source.js";
import { Output } from "../../src/output.js";
import { BufferTarget } from "../../src/target.js";
import { Mp4OutputFormat } from "../../src/output-format.js";
import { Conversion } from "../../src/conversion.js";
import { VideoSampleSink } from "../../src/media-sink.js";
import { QUALITY_HIGH } from "../../src/encode.js";
import { InputVideoTrack } from "../../src/input-track.js";

const VIDEOS = [
	{
		file: "1080p-portrait-derotated.mp4",
		name: `resizing natural rotation leads to correct visual size`,
	},
	{
		file: "1080p-portrait-rotated.mp4",
		name: `resizing metadata-rotationleads to incorrect visual size`,
	},
];

let blobUrls: string[] = [];

beforeEach(() => {
	document.body.innerHTML = "";
	blobUrls.forEach((blobUrl) => URL.revokeObjectURL(blobUrl));
	blobUrls = [];
});

VIDEOS.forEach(({ file, name }) => {
	test(name, async () => {
		// === Conversion stage ===
		const input = new Input({
				formats: ALL_FORMATS,
				source: new UrlSource(file),
			}),
			output = new Output({
				target: new BufferTarget(),
				format: new Mp4OutputFormat(),
			});

		const conversion = await Conversion.init({
			input,
			output,
			video: (videoTrack) => {
				console.log(videoTrack.rotation);

				return {
					bitrate: QUALITY_HIGH,
					width: 720, // should render a 720*1280 portrait video
				};
			},
		});

		await conversion.execute();

		expect(output.target.buffer).toBeDefined();
		expect(output.target.buffer!.byteLength).toBeGreaterThan(100);

		// === verify dimensions from metadata
		const renderInput = new Input({
				formats: ALL_FORMATS,
				source: new BufferSource(output.target.buffer!),
			}),
			tracks = await renderInput.getVideoTracks();

		expect(tracks.length).toBe(1);

		const videoTrack = tracks[0]! as InputVideoTrack,
			frameSink = new VideoSampleSink(videoTrack);

		const sample = await frameSink.getSample(
			await videoTrack.getFirstTimestamp(),
		);

		console.log(sample);

		expect(sample?.displayWidth).toBe(720);
		expect(sample?.displayHeight).toBe(1280);

		// === show the video in a video tag for visual reference
		const blob = new Blob([output.target.buffer!], { type: "video/mp4" }),
			blobUrl = window.URL.createObjectURL(blob),
			videoPlayer = document.createElement("video");

		blobUrls.push(blobUrl);

		document.body.append(videoPlayer);
		videoPlayer.src = blobUrl;
		videoPlayer.controls = true;
		videoPlayer.style.height = "500px";
		videoPlayer.style.width = "500px";

		const downloadButton = document.createElement("a");

		downloadButton.href = blobUrl;
		downloadButton.innerText = "Download compressed";
		downloadButton.download = "video.mp4";
		downloadButton.style.display = "block";
		document.body.prepend(downloadButton);
	});
});
