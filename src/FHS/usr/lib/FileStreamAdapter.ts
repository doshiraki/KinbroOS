/*
 * Copyright 2026 @doshiraki
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// src/FHS/lib/FileStreamAdapter.ts
import { IFileStream } from '../../../dev/types/IFileStream';

/**
 * [Adapter] IFileStream -> ReadableStream
 * 積み上げReadを利用して、効率的にデータを吸い出す。
 */
export function createFileSourceStream(fsHandle: IFileStream, bufferSize: number = 64 * 1024): ReadableStream<Uint8Array> {
    // GC対策: 固定バッファを1つだけ確保
    const sharedBuf = new Uint8Array(bufferSize);
    fsHandle.attach(sharedBuf);

    return new ReadableStream({
        async pull(controller) {
            try {
                // IFileStream.read() の新仕様 (積み上げ & Result返却) を利用
                const { cntRead, data } = await fsHandle.read();

                if (cntRead === 0) {
                    controller.close();
                    await fsHandle.close();
                    return;
                }

                // Web Streamsの世界へデータを流す
                // ※下流で即座に消費される前提なら data (SubArray) をそのまま渡してZero-Copy
                // ※安全策なら slice() するが、Kinoはパフォーマンス重視でそのまま渡す！
                controller.enqueue(data);

            } catch (e: any) {
                if (e.message === "BufferOverflow") {
                    // バッファ溢れ発生時は、設計次第だがここではエラーとして扱うか、
                    // あるいは一度closeしてre-openするなどの制御を入れる場所
                    console.warn("[Adapter] Buffer Overflow. Closing stream.");
                    controller.error(e);
                    await fsHandle.close();
                } else {
                    controller.error(e);
                    await fsHandle.close();
                }
            }
        },
        async cancel() {
            await fsHandle.close();
        }
    });
}

/**
 * [Adapter] IFileStream -> WritableStream
 * バックプレッシャーを効かせながらファイルへ書き込む。
 */
export function createFileSinkStream(fsHandle: IFileStream): WritableStream<Uint8Array> {
    return new WritableStream({
        async write(chunk) {
            if (chunk.byteLength === 0) return;
            // fsHandle.write は内部バッファがいっぱいになるとFlush待ち(await)するので
            // ここで自然とバックプレッシャーがかかる
            await fsHandle.write(chunk);
        },
        async close() {
            await fsHandle.close(); // 内部でFlushされる
        },
        async abort() {
            try { await fsHandle.close(); } catch {}
        }
    });
}