# Mediabunny and LLMs

<div class="grid place-items-center my-14">
    <div class="relative">
        <div class="absolute top-0 left-0 size-full rounded-full" style="background: var(--vp-home-hero-image-background-image); filter: var(--vp-home-hero-image-filter)"></div>
        <img src="./assets/mechabunny.svg" width="250" class="relative">
    </div>
</div>

While Mediabunny is proudly human-coded, we want to encourage any and all usage of Mediabunny, even when the vibes are high.

Mediabunny is still new and is unlikely to be in the training data of modern LLMs, but we can still make the AI perform extremely well by just giving it a little more context.

---

Give one or more of these files to your LLM:

### [mediabunny.d.ts](/mediabunny.d.ts)

This file contains the entire public TypeScript API of Mediabunny and is commented extremely thoroughly.

### [llms.txt](/llms.txt)

This file provides an index of Mediabunny's guide, which the AI can then further dive into if it wants to.

### [llms-full.txt](/llms-full.txt)

This is just the entire Mediabunny guide in a single file.
