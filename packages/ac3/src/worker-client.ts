/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { assert, type WorkerCommand, type WorkerResponse, type WorkerResponseData } from './shared';
// @ts-expect-error An esbuild plugin handles this, TypeScript doesn't need to understand
import createWorker from './codec.worker';

let workerPromise: Promise<Worker> | null;
let nextMessageId = 0;
const pendingMessages = new Map<number, {
	resolve: (value: WorkerResponseData) => void;
	reject: (reason?: unknown) => void;
}>();

export const sendCommand = async <T extends string>(
	command: WorkerCommand & { type: T },
	transferables?: Transferable[],
) => {
	const worker = await ensureWorker();

	return new Promise<WorkerResponseData & { type: T }>((resolve, reject) => {
		const id = nextMessageId++;
		pendingMessages.set(id, {
			resolve: resolve as (value: WorkerResponseData) => void,
			reject,
		});

		if (transferables) {
			worker.postMessage({ id, command }, transferables);
		} else {
			worker.postMessage({ id, command });
		}
	});
};

const ensureWorker = () => {
	return workerPromise ??= (async () => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		const worker = (await createWorker()) as Worker;

		const onMessage = (data: WorkerResponse) => {
			const pending = pendingMessages.get(data.id);
			assert(pending !== undefined);

			pendingMessages.delete(data.id);
			if (data.success) {
				pending.resolve(data.data);
			} else {
				pending.reject(data.error);
			}
		};

		if (worker.addEventListener) {
			worker.addEventListener('message', event => onMessage(event.data as WorkerResponse));
		} else {
			const nodeWorker = worker as unknown as {
				on: (event: string, listener: (data: never) => void) => void;
			};
			nodeWorker.on('message', onMessage);
		}

		return worker;
	})();
};
