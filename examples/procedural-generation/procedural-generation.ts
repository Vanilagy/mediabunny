import {
	Output,
	BufferTarget,
	Mp4OutputFormat,
	CanvasSource,
	AudioBufferSource,
	QUALITY_HIGH,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
	OutputFormat,
} from 'mediabunny';

const durationSlider = document.querySelector('#duration-slider') as HTMLInputElement;
const durationValue = document.querySelector('#duration-value') as HTMLParagraphElement;
const ballsSlider = document.querySelector('#balls-slider') as HTMLInputElement;
const ballsValue = document.querySelector('#balls-value') as HTMLParagraphElement;
const renderButton = document.querySelector('#render-button') as HTMLButtonElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const progressBarContainer = document.querySelector('#progress-bar-container') as HTMLDivElement;
const progressBar = document.querySelector('#progress-bar') as HTMLDivElement;
const progressText = document.querySelector('#progress-text') as HTMLParagraphElement;
const resultVideo = document.querySelector('#result-video') as HTMLVideoElement;
const videoInfo = document.querySelector('#video-info') as HTMLParagraphElement;
const errorElement = document.querySelector('#error-element') as HTMLParagraphElement;

// We render using OffscreenCanvas, but a canvas element would also do
const renderCanvas = new OffscreenCanvas(1280, 720);
const renderCtx = renderCanvas.getContext('2d', { alpha: false })!;

// Stuff we need for rendering audio
let audioContext: OfflineAudioContext;
let globalGainNode: GainNode;
let dryGain: GainNode;
let wetGain: GainNode;
let reverbConvolver: ConvolverNode;

// Scales are defined as semitone offsets from A440
const scaleProgression = [
	[-24, -12, -10, -8, -7, -5, -3, -1, 0, 2, 4, 5, 7, 9, 11, 12],
	[-22, -12, -10, -8, -7, -5, -3, -1, 0, 2, 4, 5, 7, 9, 11, 14],
	[-29, -17, -15, -13, -12, -10, -8, -5, -3, -1, 0, 2, 4, 5, 7, 16],
	[-26, -14, -12, -10, -9, -7, -5, -2, 0, 2, 3, 5, 7, 9, 10, 12],
];
const scaleHues = [
	215,
	151,
	273,
	335,
];

const wallWidth = 10;
const frameRate = 60;
const numberOfChannels = 2;
const sampleRate = 48000;

let balls: Ball[] = [];
let currentScaleIndex = 0;
let collisionCount = 0;
let collisionsPerScale = 0;

let output: Output<OutputFormat, BufferTarget>;

/** === MAIN VIDEO FILE GENERATION LOGIC === */

const generateVideo = async () => {
	let progressInterval = -1;

	try {
		// Let's set some DOM state
		renderButton.disabled = true;
		renderButton.textContent = 'Generating...';
		horizontalRule.style.display = '';
		progressBarContainer.style.display = '';
		progressText.style.display = '';
		progressText.textContent = 'Initializing...';
		resultVideo.style.display = 'none';
		resultVideo.src = '';
		videoInfo.style.display = 'none';
		errorElement.textContent = '';

		const duration = Number(durationSlider.value);
		const totalFrames = duration * frameRate;

		// Let's init the scene
		initScene(duration);

		// Create a new output file
		output = new Output({
			target: new BufferTarget(), // Stored in memory
			format: new Mp4OutputFormat(),
		});

		// Retrieve the first video codec supported by this browser that can be contained in the output format
		const videoCodec = await getFirstEncodableVideoCodec(output.format.getSupportedVideoCodecs(), {
			width: renderCanvas.width,
			height: renderCanvas.height,
		});
		if (!videoCodec) {
			throw new Error('Your browser doesn\'t support video encoding.');
		}

		// For video, we use a CanvasSource for convenience, as we're rendering to a canvas
		const canvasSource = new CanvasSource(renderCanvas, {
			codec: videoCodec,
			bitrate: QUALITY_HIGH,
		});
		output.addVideoTrack(canvasSource, { frameRate });

		// For audio, we use ArrayBufferSource, because we'll be creating an ArrayBuffer with OfflineAudioContext
		let audioBufferSource: AudioBufferSource | null = null;

		// Retrieve the first audio codec supported by this browser that can be contained in the output format
		const audioCodec = await getFirstEncodableAudioCodec(output.format.getSupportedAudioCodecs(), {
			numberOfChannels,
			sampleRate,
		});
		if (audioCodec) {
			audioBufferSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: QUALITY_HIGH,
			});
			output.addAudioTrack(audioBufferSource);
		} else {
			alert('Your browser doesn\'t support audio encoding, so we won\'t include audio in the output file.');
		}

		await output.start();

		let currentFrame = 0;

		// Start an interval that updates the progress bar
		progressInterval = window.setInterval(() => {
			const videoProgress = currentFrame / totalFrames;
			const overallProgress = videoProgress * (audioBufferSource ? 0.9 : 0.95);
			progressBar.style.width = `${overallProgress * 100}%`;

			if (currentFrame === totalFrames && audioBufferSource) {
				progressText.textContent = 'Rendering audio...';
			} else {
				progressText.textContent = `Rendering frame ${currentFrame}/${totalFrames}`;
			}
		}, 1000 / 60);

		// Now, let's crank through all frames in a tight loop and render them as fast as possible
		for (currentFrame; currentFrame < totalFrames; currentFrame++) {
			const currentTime = currentFrame / frameRate;

			// Update the scene
			updateScene(currentTime);

			// Add the current state of the canvas as a frame to the video. Using `await` here is crucial to
			// automatically slow down the rendering loop when the encoder can't keep up.
			await canvasSource.add(currentTime, 1 / frameRate);
		}

		// Signal to the output that no more video frames are coming (not necessary, but recommended)
		canvasSource.close();

		if (audioBufferSource) {
			// Let's render the audio. Ideally, the audio is rendered before the video (or concurrently to it), but for
			// simplicity, we're rendering it after we've cranked through all frames.
			const audioBuffer = await audioContext.startRendering();
			await audioBufferSource.add(audioBuffer);
			audioBufferSource.close();
		}

		clearInterval(progressInterval);

		// Finalize the file
		progressText.textContent = 'Finalizing file...';
		progressBar.style.width = '95%';
		await output.finalize();

		// The file is now ready!

		progressBar.style.width = '100%';
		progressBarContainer.style.display = 'none';
		progressText.style.display = 'none';
		resultVideo.style.display = '';
		videoInfo.style.display = '';

		// Display and play the resulting media file
		const videoBlob = new Blob([output.target.buffer!], { type: output.format.mimeType });
		resultVideo.src = URL.createObjectURL(videoBlob);
		void resultVideo.play();

		const fileSizeMiB = (videoBlob.size / (1024 * 1024)).toPrecision(3);
		videoInfo.textContent = `File size: ${fileSizeMiB} MiB`;
	} catch (error) {
		console.error(error);

		await output?.cancel();

		clearInterval(progressInterval);
		errorElement.textContent = String(error);
		progressBarContainer.style.display = 'none';
		progressText.style.display = 'none';
	} finally {
		renderButton.disabled = false;
		renderButton.textContent = 'Generate video';
	}
};

/** === SCENE SIMULATION LOGIC === */

const initScene = (duration: number) => {
	audioContext = new OfflineAudioContext(numberOfChannels, duration * sampleRate, sampleRate);

	// Create reverb effect
	reverbConvolver = audioContext.createConvolver();
	reverbConvolver.buffer = createReverbImpulse(5);

	globalGainNode = audioContext.createGain();
	dryGain = audioContext.createGain();
	wetGain = audioContext.createGain();

	globalGainNode.connect(dryGain);
	globalGainNode.connect(reverbConvolver);
	reverbConvolver.connect(wetGain);
	dryGain.connect(audioContext.destination);
	wetGain.connect(audioContext.destination);

	globalGainNode.gain.setValueAtTime(0.8, 0);
	dryGain.gain.setValueAtTime(0.5, 0);
	wetGain.gain.setValueAtTime(0.5, 0);

	// Let's init the balls
	const numBalls = Number(ballsSlider.value);
	balls = [];
	collisionsPerScale = Math.max(10, Math.ceil(numBalls ** 1.5));
	collisionCount = 0;
	currentScaleIndex = 0;

	for (let i = 0; i < numBalls; i++) {
		const scaleIndex = Math.floor(Math.random() * scaleProgression[0]!.length);
		balls.push(new Ball(0, 0, scaleIndex));
	}

	// Sort balls by size (largest first), so that the following placement algorithm works better
	balls.sort((a, b) => b.radius - a.radius);

	// Now randomly place each ball without overlapping with previously placed balls
	for (let i = 0; i < balls.length; i++) {
		const ball = balls[i]!;

		for (let attempts = 0; attempts < 100; attempts++) {
			ball.x = ball.radius + Math.random() * (renderCanvas.width - 2 * ball.radius);
			ball.y = ball.radius + Math.random() * (renderCanvas.height - 2 * ball.radius);

			const overlapsOtherBall = balls.some((otherBall, index) => {
				if (index >= i) {
					return false; // This ball hasn't been placed yet
				}

				const dx = ball.x - otherBall.x;
				const dy = ball.y - otherBall.y;
				const distanceSquared = dx * dx + dy * dy;
				return distanceSquared < (ball.radius + otherBall.radius + 5) ** 2;
			});

			if (!overlapsOtherBall) {
				break;
			}
		}
	}
};

const updateScene = (currentTime: number) => {
	renderCtx.clearRect(0, 0, renderCanvas.width, renderCanvas.height);

	// Draw the walls
	renderCtx.beginPath();
	renderCtx.rect(0, 0, wallWidth, renderCanvas.height);
	renderCtx.rect(renderCanvas.width - wallWidth, 0, wallWidth, renderCanvas.height);
	renderCtx.rect(0, 0, renderCanvas.width, wallWidth);
	renderCtx.rect(0, renderCanvas.height - wallWidth, renderCanvas.width, wallWidth);
	renderCtx.fillStyle = '#27272a';
	renderCtx.fill();

	// Update balls
	for (const ball of balls) {
		ball.update(currentTime, renderCanvas.width, renderCanvas.height);
	}

	// Check collisions between all pairs of balls
	for (let i = 0; i < balls.length - 1; i++) {
		for (let j = i + 1; j < balls.length; j++) {
			const ballI = balls[i]!;
			const ballJ = balls[j]!;

			if (ballI.checkCollision(ballJ)) {
				ballI.collideWith(ballJ);
				ballI.lastHitTime = currentTime;
				ballJ.lastHitTime = currentTime;
				ballI.scheduleSound(currentTime);
				ballJ.scheduleSound(currentTime);

				collisionCount++;
			}
		}
	}

	// Check if it's time to change scale
	if (collisionCount >= collisionsPerScale) {
		currentScaleIndex = (currentScaleIndex + 1) % scaleProgression.length;
		collisionCount = 0;
	}

	// Draw balls
	for (const ball of balls) {
		ball.draw(renderCtx, currentTime);
	}
};

const ballHitAnimationDuration = 0.2;

class Ball {
	x: number;
	y: number;
	scaleIndex: number;
	vx: number;
	vy: number;
	lastHitTime: number;
	radius: number;

	constructor(x: number, y: number, scaleIndex: number) {
		this.x = x;
		this.y = y;
		this.scaleIndex = scaleIndex;
		this.vx = (Math.random() - 0.5) * 700; // Random velocity
		this.vy = (Math.random() - 0.5) * 700;
		this.lastHitTime = -Infinity;

		const baseRadius = 40;
		this.radius = lerp(
			2 * baseRadius,
			0.3 * baseRadius,
			(this.scaleIndex / (scaleProgression[0]!.length - 1)) ** 0.5,
		);
	}

	getColorFromScale() {
		// Lower indices (bass notes) are darker, higher are brighter
		const hue = scaleHues[currentScaleIndex];
		const lightness = 25 + (this.scaleIndex / 15) * 50;
		return `hsl(${hue}, 50%, ${lightness}%)`;
	}

	update(currentTime: number, canvasWidth: number, canvasHeight: number) {
		// Integrate
		this.x += this.vx / frameRate;
		this.y += this.vy / frameRate;

		let wallHit = false;

		// Wall collisions
		if (this.x - this.radius <= wallWidth || this.x + this.radius >= canvasWidth - wallWidth) {
			this.vx = -this.vx;
			this.x = Math.max(wallWidth + this.radius, Math.min(canvasWidth - wallWidth - this.radius, this.x));
			wallHit = true;
			collisionCount++;
		}
		if (this.y - this.radius <= wallWidth || this.y + this.radius >= canvasHeight - wallWidth) {
			this.vy = -this.vy;
			this.y = Math.max(wallWidth + this.radius, Math.min(canvasHeight - wallWidth - this.radius, this.y));
			wallHit = true;
			collisionCount++;
		}

		if (wallHit) {
			this.lastHitTime = currentTime;
			this.scheduleSound(currentTime);
		}
	}

	draw(ctx: OffscreenCanvasRenderingContext2D, currentTime: number) {
		const timeSinceHit = currentTime - this.lastHitTime;
		const progress = clamp(timeSinceHit / ballHitAnimationDuration, 0, 1);

		const radius = this.radius * (1 + (1 - progress) * 0.1);

		ctx.beginPath();
		ctx.arc(this.x, this.y, radius, 0, Math.PI * 2);

		const color = this.getColorFromScale();

		ctx.fillStyle = color;
		ctx.globalAlpha = 0.333;
		ctx.fill();

		const lineWidth = 0.15 * radius;
		ctx.beginPath();
		ctx.arc(this.x, this.y, radius - lineWidth / 2, 0, Math.PI * 2);

		ctx.globalAlpha = 1;
		ctx.strokeStyle = color;
		ctx.lineWidth = lineWidth;
		ctx.stroke();

		if (progress < 1) {
			const intensity = 1 - progress;
			ctx.globalAlpha = intensity * 0.8;
			ctx.strokeStyle = 'white';
			ctx.stroke();
		}

		ctx.globalAlpha = 1;
	}

	checkCollision(other: Ball) {
		const dx = this.x - other.x;
		const dy = this.y - other.y;
		const distance = Math.sqrt(dx * dx + dy * dy);
		return distance < (this.radius + other.radius);
	}

	collideWith(other: Ball) {
		const dx = other.x - this.x;
		const dy = other.y - this.y;
		const distance = Math.hypot(dx, dy);

		const nx = dx / distance;
		const ny = dy / distance;

		const rvx = other.vx - this.vx;
		const rvy = other.vy - this.vy;

		// Relative velocity along collision normal
		const speed = rvx * nx + rvy * ny;

		if (speed > 0) {
			// Objects separating
			return;
		}

		const thisMass = this.radius ** 2;
		const otherMass = other.radius ** 2;

		const impulse = 2 * speed / (thisMass + otherMass);

		this.vx += impulse * otherMass * nx;
		this.vy += impulse * otherMass * ny;
		other.vx -= impulse * thisMass * nx;
		other.vy -= impulse * thisMass * ny;

		const overlap = (this.radius + other.radius) - distance;
		if (overlap > 0) {
			// Separate balls
			const separateX = nx * overlap * 0.5;
			const separateY = ny * overlap * 0.5;

			this.x -= separateX;
			this.y -= separateY;
			other.x += separateX;
			other.y += separateY;
		}
	}

	scheduleSound(currentTime: number) {
		const oscillator = audioContext.createOscillator();
		const gainNode = audioContext.createGain();
		const pannerNode = audioContext.createStereoPanner();

		// Calculate pan based on x position
		const panValue = ((this.x / renderCanvas.width) - 0.5) * Math.SQRT2;

		oscillator.connect(gainNode);
		gainNode.connect(pannerNode);
		pannerNode.connect(globalGainNode);

		const frequency = getFrequencyFromScaleIndex(this.scaleIndex);
		oscillator.frequency.setValueAtTime(frequency, currentTime);
		oscillator.type = 'sine';
		pannerNode.pan.setValueAtTime(panValue, currentTime);

		// Create a nice envelope
		gainNode.gain.setValueAtTime(0, currentTime);
		gainNode.gain.linearRampToValueAtTime(0.08, currentTime + 0.01);
		gainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + 0.4);
		gainNode.gain.linearRampToValueAtTime(0, currentTime + 0.5);

		oscillator.start(currentTime);
		oscillator.stop(currentTime + 0.6);
	}
}

/** === UTILS === */

const clamp = (value: number, min: number, max: number) => {
	return Math.min(Math.max(value, min), max);
};

const lerp = (a: number, b: number, t: number) => {
	return a + (b - a) * t;
};

const semitoneToFreq = (semitones: number) => {
	return 440 * Math.pow(2, semitones / 12); // Equal temperament
};

const getCurrentScale = () => {
	return scaleProgression[currentScaleIndex]!;
};

const getFrequencyFromScaleIndex = (scaleIndex: number) => {
	const currentScale = getCurrentScale();
	return semitoneToFreq(currentScale[scaleIndex]!);
};

const createReverbImpulse = (duration: number) => {
	const length = sampleRate * duration;
	const impulse = audioContext.createBuffer(numberOfChannels, length, sampleRate);

	for (let channel = 0; channel < 2; channel++) {
		const channelData = impulse.getChannelData(channel);
		for (let i = 0; i < length; i++) {
			const decayFactor = Math.pow(0.001, i / length);

			// Add multiple delay lines for rich reverb
			let sample = 0;
			sample += (Math.random() * 2 - 1) * decayFactor;
			sample += (Math.random() * 2 - 1) * decayFactor * 0.7;
			sample += (Math.random() * 2 - 1) * decayFactor * 0.5;
			channelData[i] = sample * 0.5; // Scale down
		}
	}

	return impulse;
};

/** === DOM LOGIC === */

// Update slider displays
const updateSliderDisplays = () => {
	durationValue.textContent = `${durationSlider.value} seconds`;
	ballsValue.textContent = `${ballsSlider.value} ${ballsSlider.value === '1' ? 'ball' : 'balls'}`;
};

durationSlider.addEventListener('input', updateSliderDisplays);
ballsSlider.addEventListener('input', updateSliderDisplays);

// Initialize displays
updateSliderDisplays();

renderButton.addEventListener('click', () => {
	void generateVideo();
});
