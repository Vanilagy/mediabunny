import {
	Input,
	Output,
	WebMOutputFormat,
	BufferTarget,
	Conversion,
	BlobSource,
	ALL_FORMATS,
} from "mediabunny";

const selectMediaButton = document.querySelector(
	"#select-file"
) as HTMLButtonElement;
const cropButton = document.querySelector("#crop-button") as HTMLButtonElement;
const fileNameElement = document.querySelector(
	"#file-name"
) as HTMLParagraphElement;

let selectedFile: File | null = null;
const horizontalRule = document.querySelector("hr") as HTMLHRElement;
const outputContainer = document.querySelector(
	"#output-container"
) as HTMLDivElement;
const errorElement = document.querySelector(
	"#error-element"
) as HTMLParagraphElement;
const cropTopInput = document.querySelector("#crop-top") as HTMLInputElement;
const cropLeftInput = document.querySelector("#crop-left") as HTMLInputElement;
const cropWidthInput = document.querySelector(
	"#crop-width"
) as HTMLInputElement;
const cropHeightInput = document.querySelector(
	"#crop-height"
) as HTMLInputElement;

const cropVideo = async (file: File) => {
	fileNameElement.textContent = file.name;
	horizontalRule.style.display = "";
	errorElement.textContent = "";
	outputContainer.innerHTML = "";

	try {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});

		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error("File has no video track.");
		}

		if (videoTrack.codec === null) {
			throw new Error("Unsupported video codec.");
		}

		if (!(await videoTrack.canDecode())) {
			throw new Error("Unable to decode the video track.");
		}

		const output = new Output({
			format: new WebMOutputFormat(),
			target: new BufferTarget(),
		});

		const conversion = await Conversion.init({
			input,
			output,
			video: {
				crop: {
					top: parseInt(cropTopInput.value) || 0,
					left: parseInt(cropLeftInput.value) || 0,
					width: parseInt(cropWidthInput.value) || 300,
					height: parseInt(cropHeightInput.value) || 300,
				},
			},
		});

		await conversion.execute();

		const buffer = output.target.buffer;
		if (!buffer) {
			throw new Error("Failed to generate output buffer");
		}
		const blob = new Blob([buffer], { type: "video/webm" });
		const url = URL.createObjectURL(blob);

		const video = document.createElement("video");
		video.src = url;
		video.controls = true;
		video.className = "rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800";
		outputContainer.appendChild(video);
	} catch (error) {
		console.error(error);
		errorElement.textContent = String(error);
		outputContainer.innerHTML = "";
	}
};

const updateSelectedFile = (file: File | null) => {
	selectedFile = file;
	fileNameElement.textContent = file ? file.name : "";
	cropButton.disabled = !file;
	errorElement.textContent = "";
	outputContainer.innerHTML = "";
};

selectMediaButton.addEventListener("click", () => {
	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "video/*,video/x-matroska";
	fileInput.addEventListener("change", () => {
		const file = fileInput.files?.[0];
		updateSelectedFile(file || null);
	});

	fileInput.click();
});

document.addEventListener("dragover", (event) => {
	event.preventDefault();
	event.dataTransfer!.dropEffect = "copy";
});

document.addEventListener("drop", (event) => {
	event.preventDefault();
	if (!event.dataTransfer?.files) {
		updateSelectedFile(null);
		return;
	}
	const file = event.dataTransfer.files[0] ?? null;
	updateSelectedFile(file);
});

cropButton.addEventListener("click", () => {
	if (selectedFile) {
		void cropVideo(selectedFile);
	}
});
