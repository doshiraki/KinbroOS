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
 * .tar.gz の展開と作成を担当する。
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
        await this.streamUntar(gunzipStream, destDir);
    }

    /**
     * 🎁 圧縮: 指定パスを .tar.gz ストリームとして返す
     */
    public archive(sourcePath: string): ReadableStream<Uint8Array> {
        console.log(`[Archiver] Archiving ${sourcePath} (Stream/GNU)...`);

        const tarStream = new ReadableStream({
            start: async (controller) => {
                try {
                    await this.streamTar(sourcePath, controller);
                    controller.close();
                } catch (err) {
                    controller.error(err);
                }
            }
        });

        return tarStream.pipeThrough(new CompressionStream('gzip'));
    }

    // ========================================================================
    // 🕵️‍♀️ Private: Streaming Untar Implementation
    // ========================================================================

    private async streamUntar(stream: ReadableStream<Uint8Array>, destRoot: string): Promise<void> {
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
            const fullPath = (destRoot === '/' ? '' : destRoot) + '/' + cleanName;

            if (type === '5') {
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

                if (size > 0) {
                    await this.pipeToFile(buffer, fullPath, size);
                } else {
                    await this.fsManager.touchFile(fullPath);
                }
            }

            // パディング読み飛ばし (ファイル本体のパディング)
            const padding = (512 - (size % 512)) % 512;
            if (padding > 0) await buffer.readExact(padding);
        }

        reader.releaseLock();
    }

    private async pipeToFile(buffer: StreamBuffer, path: string, size: number): Promise<void> {
        const writeStream = fs.createWriteStream(path);
        let remaining = size;
        while (remaining > 0) {
            const chunk = await buffer.readExact(remaining);
            if (!chunk) throw new Error("Unexpected EOF while reading file content");
            const canContinue = writeStream.write(chunk);
            if (!canContinue) {
                await new Promise(resolve => writeStream.once('drain', resolve));
            }
            remaining -= chunk.byteLength;
        }
        writeStream.end();
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
    }

    // ========================================================================
    // 📦 Private: Streaming Tar Implementation
    // ========================================================================

    private async streamTar(sourcePath: string, controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
        const enc = new TextEncoder();
        
        let files: string[] = [];
        const stat = await this.fsManager.getStat(sourcePath);
        
        if (stat.isDirectory()) {
            files = await this.fsManager.findRecursive(sourcePath);
        } else {
            files = [sourcePath];
        }

        for (const path of files) {
            // パス計算
            let relPath = path;
            if (sourcePath !== '/' && path.startsWith(sourcePath)) {
                relPath = path.slice(sourcePath.length);
            }
            if (relPath.startsWith('/')) relPath = relPath.slice(1);
            if (!relPath) continue;

            const itemStat = await this.fsManager.getStat(path);
            const isDir = itemStat.isDirectory();
            if (isDir && !relPath.endsWith('/')) relPath += '/';
            
            // バイト列に変換して長さをチェック
            const bufPath = enc.encode(relPath);

            // 🌟 GNU LongLink 対応ロジック
            if (bufPath.byteLength > 100) {
                // 1. LongLinkヘッダーを作成 (Type 'L')
                // 名前は '././@LongLink' 固定
                const longLinkHeader = this.createHeaderBlock(
                    '././@LongLink',
                    bufPath.byteLength, // サイズはパス文字列の長さ
                    'L', // Type L
                    false // ディレクトリではない
                );
                controller.enqueue(longLinkHeader);

                // 2. LongLinkボディ (パス本体) を書き込む
                controller.enqueue(bufPath);

                // 3. パディング (512B境界)
                const padSize = (512 - (bufPath.byteLength % 512)) % 512;
                if (padSize > 0) controller.enqueue(new Uint8Array(padSize));
            }

            // 4. 本体のヘッダー作成
            // 名前が100byte超える場合は、前方100byteだけ切り詰めて書く（どうせ無視される）
            // Typeは通常通り '0' or '5'
            const truncatedName = relPath.length > 100 ? relPath.substring(0, 100) : relPath;
            const size = isDir ? 0 : itemStat.size;

            const mainHeader = this.createHeaderBlock(
                truncatedName,
                size,
                isDir ? '5' : '0',
                isDir
            );
            controller.enqueue(mainHeader);

            // 5. ファイル本体のストリーミング
            if (!isDir && size > 0) {
                await this.pipeFromFileToController(path, controller);
                const padSize = (512 - (size % 512)) % 512;
                if (padSize > 0) controller.enqueue(new Uint8Array(padSize));
            }
        }

        // End of Archive
        controller.enqueue(new Uint8Array(1024));
    }

    /**
     * 共通ヘッダーブロック生成 (512 bytes)
     */
    private createHeaderBlock(name: string, size: number, type: string, isDir: boolean): Uint8Array {
        const enc = new TextEncoder();
        const header = new Uint8Array(512);

        // Name (100B)
        // 文字列が長すぎる場合は呼び出し元で処理済みとするが、念のためslice
        header.set(enc.encode(name).subarray(0, 100), 0);

        // Mode (8B)
        header.set(enc.encode('0000777\0'), 100);

        // UID/GID (8B)
        header.set(enc.encode('0000000\0'), 108);
        header.set(enc.encode('0000000\0'), 116);

        // Size (12B) - Octal string
        const sizeStr = size.toString(8).padStart(11, '0');
        header.set(enc.encode(sizeStr + ' '), 124);

        // MTime (12B)
        const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
        header.set(enc.encode(mtime + ' '), 136);

        // Checksum (8B) - Placeholder
        header.set(enc.encode('        '), 148);

        // Type (1B)
        header.set(enc.encode(type), 156);

        // Magic (6B) - ustar
        // GNU tar も通常 ustar マジックを使用する
        header.set(enc.encode('ustar  \0'), 257);

        // Checksum Calc
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += header[i];
        const chkStr = checksum.toString(8).padStart(6, '0') + '\0 ';
        header.set(enc.encode(chkStr), 148);

        return header;
    }

    private async pipeFromFileToController(path: string, controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
        const readStream = fs.createReadStream(path);
        for await (const chunk of readStream) {
            controller.enqueue(chunk as Uint8Array);
        }
    }
}

// StreamBuffer Class は前回と同じなので省略（必要なら再掲するよ！）
class StreamBuffer {
    private chunks: Uint8Array[] = [];
    private totalBytes: number = 0;
    
    constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

    /**
     * 指定したバイト数（size）を正確に読み取る
     * Application Hungarian: cnt (Counter), dst (Destination)
     */
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