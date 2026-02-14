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

// 🌟 Interface: アーカイブ内のエントリ情報 (構造化)
export interface ITarEntry {
    name: string;
    size: number;
    type: string;
    mode: number;
    uid: number;
    gid: number;
    mtime: number; // Unix Timestamp (sec)
}

// src/dev/types/IArchiver.ts
export interface IArchiver {
    /** 指定ディレクトリに展開 */
    extract(source: Uint8Array | ReadableStream<Uint8Array>, destDir?: string): Promise<void>;
    /** 指定パスを .tar.gz ストリームとしてアーカイブ */
    archive(sourcePaths: string[]): ReadableStream<Uint8Array>;

    list(
            source: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
            onEntry: (entry: ITarEntry) => Promise<void>
    ): Promise<void>;

}
