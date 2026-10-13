import { RecoverableConversion, type ConversionCheckpoint } from '../../src/conversion-recovery.js';
import { BufferTarget } from '../../src/target.js';

self.onmessage = async (
	event: MessageEvent<{
		source: Uint8Array;
		database: string;
		finish: boolean;
		midCommit: boolean;
		copy: boolean;
	}>,
) => {
	try {
		const { source, database, finish, midCommit } = event.data;
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(database, 1);
			request.onupgradeneeded = () => request.result.createObjectStore('recovery');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
		});
		const read = <T>(key: IDBValidKey) =>
			new Promise<T>((resolve, reject) => {
				const request = db.transaction('recovery').objectStore('recovery').get(key);
				request.onsuccess = () => resolve(request.result as T);
				request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
			});
		const checkpoint = await read<ConversionCheckpoint | undefined>('checkpoint');
		const recovery = await RecoverableConversion.init({
			source,
			segmentDuration: 0.2,
			conversion: event.data.copy
				? { copy: { mode: 'forced', boundaryTolerance: Infinity, shiftTolerance: Infinity } }
				: {
						video: { discard: true },
						audio: { codec: 'aac', sampleRate: 48000 },
						trim: { start: 0, end: 3 },
					},
			checkpoint,
			store: {
				readSegment: index => read<Uint8Array>(index),
				commit: (index, bytes, next) =>
					new Promise<void>((resolve, reject) => {
						const transaction = db.transaction('recovery', 'readwrite');
						transaction.objectStore('recovery').put(bytes, index);
						if (midCommit && index === 1) {
							// Keep this uncommitted transaction alive until the main thread kills the worker.
							const keepAlive = () => {
								transaction.objectStore('recovery').get(index).onsuccess = keepAlive;
							};
							keepAlive();
							self.postMessage({ midCommit: true });
							return;
						}
						transaction.objectStore('recovery').put(next, 'checkpoint');
						transaction.oncomplete = () => resolve();
						transaction.onerror = () =>
							reject(transaction.error ?? new Error('IndexedDB transaction failed'));
					}),
			},
		});
		if (!finish) {
			await recovery.step();
			if (midCommit) {
				await recovery.step();
			}
			self.postMessage({ committed: recovery.checkpoint.segments.length });
			// Deliberately leave objects alive. Main thread terminates this worker, without cleanup.
			return;
		}
		const resumed = recovery.checkpoint.segments.length;
		const target = new BufferTarget();
		await recovery.execute(target);
		self.postMessage({ resumed, buffer: target.buffer }, { transfer: [target.buffer!] });
		recovery.dispose();
		db.close();
	} catch (error) {
		self.postMessage({ error: String(error) });
	}
};
