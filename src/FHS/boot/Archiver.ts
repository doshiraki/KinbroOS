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

import { fs } from '@zenfs/core';
import { IFileSystem } from '@/dev/types/IFileSystem';

/**
 * [Kernel Module: Archiver (GNU/Modern Edition)]
 * .tar.gz の展開と作成、リスト表示を担当する。
 * GNU LongLink拡張に対応し、100バイトを超える長いパスや
 * マルチバイト文字を含むパスを正しくストリーム処理する。
 */
export class Archiver {
    constructor(private fsManager: IFileSystem) {}

    /**
     * 📦 解凍: .tar.gz (Stream/Uint8Array) を指定ディレクトリに展開
     */
    public async extract(source: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, destDir: string = '/'): Promise<void> {
        console.log(`[Archiver] Extracting stream to ${destDir} (GNU Supported)...`);

        let srcStream: ReadableStream<Uint8Array>;
        if (source instanceof Uint8Array) {
            srcStream = new Blob([source]).stream();
        } else {
            srcStream = source;
        }

        const gunzipStream = srcStream.pipeThrough(new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>);
        await this.processTarStream(gunzipStream, async (header, buffer) => {
            const fullPath = (destDir === '/' ? '' : destDir) + '/' + header.name;

            if (header.type === '5') {
                // 📂 ディレクトリ
                await this.fsManager.makeDir(fullPath, true);
            } else {
                try {
                    if ((await this.fsManager.getStat(fullPath)).isFile()) {
                        await this.fsManager.unlink(fullPath);
                    }
                    //this.touchFile(pathResolved);
                } catch (e) { }
                // 📄 ファイル ('0' or '\0')
                const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
                if (parentDir) await this.fsManager.makeDir(parentDir, true);

                if (header.size > 0) {
                    await this.pipeToFile(buffer, fullPath, header.size);
                } else {
                    await this.fsManager.touchFile(fullPath);
                }
            }

        });
    }

    /**
     * 📜 リスト: アーカイブ内のファイル一覧を表示 (展開しない)
     */
    public async list(source: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, writer: WritableStreamDefaultWriter<string>): Promise<void> {
        const srcStream = this.normalizeStream(source);
        const gunzipStream = srcStream.pipeThrough(new DecompressionStream('gzip') as any) as ReadableStream<Uint8Array>;
        console.log("aa");
        await this.processTarStream(gunzipStream, async (header, buffer) => {
            // シンプルにファイル名を出力 (ls -l風にするならここで header.size や mtime を使う)
            console.log(header.name);
            await writer.write(`${header.name}\n`);
            await this.pipeToNone(buffer, header.size);

        });
    }

    /**
     * 🎁 圧縮: 指定パス群を .tar.gz ストリームとして返す
     * Multiple Sources 対応版
     */
    public archive(sourcePaths: string[]): ReadableStream<Uint8Array> {
        console.log(`[Archiver] Archiving ${sourcePaths.length} sources...`);

        const tarStream = new ReadableStream({
            start: async (controller) => {
                try {
                    await this.streamTar(sourcePaths, controller);
                    controller.close();
                } catch (err) {
                    controller.error(err);
                }
            }
        });

        return tarStream.pipeThrough(new CompressionStream('gzip'));
    }

    private normalizeStream(source: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
        if (source instanceof Uint8Array) {
            return new Blob([source]).stream();
        }
        return source;
    }

    // ========================================================================
    // 🕵️‍♀️ Private: Unified Tar Stream Processor
    // ========================================================================

    private async processTarStream(
        stream: ReadableStream<Uint8Array>,
        callback: (header: TarHeader, buffer: StreamBuffer) => Promise<void>
    ): Promise<void> {
        const reader = stream.getReader();
        const buffer = new StreamBuffer(reader);
        const dec = new TextDecoder();

        // 🌟 GNU LongLink用の状態保持変数
        // Type 'L' が来たらここに次回用の名前が入る
        let strNextLongName: string | null = null;

        while (true) {
            const header = await buffer.readExact(512);
            if (!header) break;

            // ファイル名 (一旦取得するが、LongNameがあればそちら優先)
            let name = dec.decode(header.subarray(0, 100)).replace(/\0/g, '').trim();
            if (!name) break; // End of Tar

            // サイズ (8進数)
            const sizeStr = dec.decode(header.subarray(124, 136)).trim();
            const size = parseInt(sizeStr, 8);

            // タイプフラグ ( '0':File, '5':Dir, 'L':GNU LongName )
            const type = String.fromCharCode(header[156]);

            // GNU LongLink (Type 'L') の処理
            if (type === 'L') {
                // コンテンツ部分(=本当のファイル名)を読み込む
                // ファイル名はメモリに乗るサイズなのでreadExactでOK
                const bufName = await buffer.readExact(size);
                if (!bufName) throw new Error("Unexpected EOF in LongLink");
                
                strNextLongName = dec.decode(bufName).replace(/\0/g, '');

                // パディング読み飛ばし
                const padding = (512 - (size % 512)) % 512;
                if (padding > 0) await buffer.readExact(padding);

                // ※ ここではファイル作成せず、次のヘッダーループへ進む
                continue;
            }

            // --- ここから通常のファイル/ディレクトリ処理 ---

            // LongNameがあればそれを使用し、変数をリセット
            const finalName = strNextLongName ? strNextLongName : name;
            strNextLongName = null; // 消費完了

            // パス解決
            const cleanName = finalName.startsWith('/') ? finalName.slice(1) : finalName;

            console.log("cleanName"+ cleanName);
            await callback({name:cleanName, size, type}, buffer);

            // パディング読み飛ばし (ファイル本体のパディング)
            const padding = (512 - (size % 512)) % 512;
            if (padding > 0) await buffer.readExact(padding);
        }

        reader.releaseLock();

    }

    private async pipeToNone(buffer: StreamBuffer, size: number): Promise<void> {
        let remaining = size;
        const CHUNK_SIZE = 64 * 1024; // 64KBずつ捨てる

        while (remaining > 0) {
            const readSize = Math.min(remaining, CHUNK_SIZE);
            const chunk = await buffer.readExact(readSize);
            
            if (!chunk) throw new Error("Unexpected EOF while skipping");
            remaining -= chunk.byteLength;
        }
    }

    private async pipeToFile(buffer: StreamBuffer, path: string, size: number): Promise<void> {
        // Raw FS Stream を使う (Userland互換のため)
        // ※ 本来は fsManager.open() 経由推奨だが、書き込み速度優先でNode互換APIを使用
        const writeStream = fs.createWriteStream(path);
        let remaining = size;
        
        while (remaining > 0) {
            const chunk = await buffer.readExact(remaining);
            if (!chunk) throw new Error("Unexpected EOF");
            if (!writeStream.write(chunk)) {
                await new Promise(r => writeStream.once('drain', r));
            }
            remaining -= chunk.byteLength;
        }
        writeStream.end();
        await new Promise((r, j) => { writeStream.on('finish', r); writeStream.on('error', j); });
    }

    // ========================================================================
    // 📦 Private: Tar Creation Logic
    // ========================================================================

    private async streamTar(sourcePaths: string[], controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
        const enc = new TextEncoder();
        
        for (const rootPath of sourcePaths) {
            try {
                // 絶対パス化されている前提だが、もし相対ならFSが解決する
                const stat = await this.fsManager.getStat(rootPath);
                let files: string[] = [];
                
                if (stat.isDirectory()) {
                    files = await this.fsManager.findRecursive(rootPath);
                } else {
                    files = [rootPath];
                }

                for (const path of files) {
                    try {
                        // 🌟 エントリ名決定ロジック
                        // 常に「先頭の / を除去したフルパス」をエントリ名とする
                        // 例: /home/geek/file -> home/geek/file
                        // これにより、複数指定時も構造が維持される
                        let entryName = path;
                        if (entryName.startsWith('/')) entryName = entryName.slice(1);
                        
                        const itemStat = await this.fsManager.getStat(path);
                        const isDir = itemStat.isDirectory();
                        
                        if (isDir && !entryName.endsWith('/')) entryName += '/';
                        
                        const bufPath = enc.encode(entryName);
                        const size = isDir ? 0 : itemStat.size;

                        // 1. LongLink Check
                        if (bufPath.byteLength > 100) {
                            controller.enqueue(this.createHeaderBlock('././@LongLink', bufPath.byteLength, 'L'));
                            controller.enqueue(bufPath);
                            this.pad(controller, bufPath.byteLength);
                        }

                        // 2. Header
                        const truncatedName = entryName.length > 100 ? entryName.substring(0, 100) : entryName;
                        controller.enqueue(this.createHeaderBlock(truncatedName, size, isDir ? '5' : '0'));

                        // 3. Body
                        if (!isDir && size > 0) {
                            await this.pipeFromFileToController(path, controller);
                            this.pad(controller, size);
                        }
                    } catch (e) {
                        console.warn(`[Archiver] Skip: ${path}`, e);
                    }
                }
            } catch (e) {
                console.warn(`[Archiver] Cannot access root: ${rootPath}`, e);
            }
        }
        
        // End of Archive (Block x 2)
        controller.enqueue(new Uint8Array(1024));
    }

    private pad(controller: ReadableStreamDefaultController<Uint8Array>, size: number) {
        const padSize = (512 - (size % 512)) % 512;
        if (padSize > 0) controller.enqueue(new Uint8Array(padSize));
    }

    private async pipeFromFileToController(path: string, controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
        const handle = await this.fsManager.open(path, 'r');
        try {
            const buf = new Uint8Array(64 * 1024);
            handle.attach(buf);
            while (true) {
                const { cntRead, data } = await handle.read();
                if (cntRead === 0) break;
                controller.enqueue(new Uint8Array(data));
            }
        } finally {
            await handle.close();
        }
    }

    private createHeaderBlock(name: string, size: number, type: string): Uint8Array {
        const enc = new TextEncoder();
        const header = new Uint8Array(512);
        
        header.set(enc.encode(name).subarray(0, 100), 0);
        header.set(enc.encode('0000777\0'), 100); // Mode
        header.set(enc.encode('0000000\0'), 108); // UID
        header.set(enc.encode('0000000\0'), 116); // GID
        header.set(enc.encode(size.toString(8).padStart(11, '0') + ' '), 124); // Size
        header.set(enc.encode(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' '), 136); // MTime
        header.set(enc.encode('        '), 148); // Checksum Space
        header.set(enc.encode(type), 156); // Type
        header.set(enc.encode('ustar  \0'), 257); // Magic

        // Checksum
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += header[i];
        header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);

        return header;
    }
}

interface TarHeader { name: string; size: number; type: string; }

class StreamBuffer {
    private chunks: Uint8Array[] = [];
    private totalBytes: number = 0;

    constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

    public async readExact(cntSize: number): Promise<Uint8Array | null> {
        const dstBuffer = new Uint8Array(cntSize);
        let cntOffset = 0;

        while (cntOffset < cntSize) {
            // 内部バッファが空なら補充する
            if (this.chunks.length === 0) {
                const { done, value } = await this.reader.read();
                if (done) break; 
                if (value) {
                    this.chunks.push(value);
                    this.totalBytes += value.byteLength;
                }
            }

            if (this.chunks.length === 0) break;

            const srcChunk = this.chunks[0];
            const cntRemainingNeeded = cntSize - cntOffset;
            const cntAvailable = srcChunk.byteLength;

            if (cntAvailable <= cntRemainingNeeded) {
                // チャンク丸ごとコピー
                dstBuffer.set(srcChunk, cntOffset);
                cntOffset += cntAvailable;
                this.totalBytes -= cntAvailable;
                this.chunks.shift(); // 使い切ったので削除
            } else {
                // チャンクの一部だけコピー
                dstBuffer.set(srcChunk.subarray(0, cntRemainingNeeded), cntOffset);
                // 残った分をチャンクに戻す
                this.chunks[0] = srcChunk.subarray(cntRemainingNeeded);
                cntOffset += cntRemainingNeeded;
                this.totalBytes -= cntRemainingNeeded;
            }
        }

        // 指定サイズに満たなかった場合は null を返す（ファイル末尾など）
        if (cntOffset < cntSize) {
            console.warn(`[Archiver] Unexpected end of stream. Expected ${cntSize}, got ${cntOffset}`);
            return null;
        }

        return dstBuffer;
    }

}