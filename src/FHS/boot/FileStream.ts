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

// src/FHS/lib/FileStream.ts
import { IFileStream, StreamConfig, ReadPolicy, IFileStreamResult } from '../../dev/types/IFileStream';
import { promises as fs, Stats } from '@zenfs/core';


/**
 * [Class: FileStream]
 * カーネル内部のファイルハンドルをラップし、
 * 高速な読み込み(Ring Buffer)と効率的な書き込み(Linear Buffer)を提供する。
 * * [Architecture: Read (Ring Buffer)]
 * File -> [ Head ... Data ... Tail ] -> UserBuffer
 * ^ Write           ^ Read
 * * 1. 内部に固定長リングバッファを持ち、ファイルからデータを先読み(Fill)する。
 * 2. ユーザーにはリングバッファのコピー(またはView)を渡し、Zero-copyに近い性能を出す。
 * 3. ReadPolicy.Exact により、「必要なバイト数が揃うまで待つ」挙動も選択可能。
 * * [Architecture: Write (Linear Buffer & Flush)]
 * UserData -> [ Buffer ... ] -> (Flush) -> File
 * * 1. 小さな書き込みは内部バッファに溜め込み(Accumulate)、システムコール回数を減らす。
 * 2. バッファが溢れるか、明示的に flush() された時にディスクへ書き込む。
 * 3. autoFlush: true の場合はバッファをスルーして直接ディスクへ書く(ログ用途など)。
 */
export class FileStream implements IFileStream {
    private readonly hFile: fs.FileHandle;

    // ==========================================
    // Read Context (Ring Buffer)
    // ==========================================
    // 読み込みは「過去のデータを保持し、切れ目なく提供する」ためリングバッファを採用
    private readonly bufReadRing: Uint8Array;
    private readonly limReadRing: number;
    private idxReadHead: number = 0; // File -> Ring (Write Pointer)
    private idxReadTail: number = 0; // Ring -> User (Read Pointer)
    private cntReadValid: number = 0;
    
    // User Attached Buffer (Read Only)
    // 読み込み先としてユーザーから預かったバッファとその状態
    private bufUserRead: Uint8Array | null = null;
    private idxUserReadCursor: number = 0;

    // ==========================================
    // Write Context (Linear Buffer)
    // ==========================================
    // 書き込みは「溜めて一気に吐き出す」ためシンプルかつ高速なリニアバッファを採用
    private readonly bufWrite: Uint8Array;
    private readonly limWrite: number;
    private idxWriteCursor: number = 0;

    // ==========================================
    // Common State & Config
    // ==========================================
    private optCurrent: StreamConfig = { 
        readPolicy: ReadPolicy.Partial,
        autoFlush: false 
    };

    // ファイルポインタ (OS側のカーソル位置を管理)
    private idxFilePosRead: number = 0;
    private idxFilePosWrite: number = 0;
    private isEof: boolean = false;

    /**
     * @param handle ファイルハンドル
     * @param sizeBuffer 内部バッファサイズ (Read/Write個別にこのサイズで確保される。デフォルト64KB)
     */
    constructor(handle: fs.FileHandle, sizeBuffer: number = 64 * 1024) {
        this.hFile = handle;
        
        // Init Read Ring Buffer
        this.limReadRing = sizeBuffer;
        this.bufReadRing = new Uint8Array(sizeBuffer);

        // Init Write Linear Buffer
        this.limWrite = sizeBuffer;
        this.bufWrite = new Uint8Array(sizeBuffer);
    }

    /**
     * 設定の更新
     */
    public config(options: StreamConfig): void {
        this.optCurrent = { ...this.optCurrent, ...options };
    }

    /**
     * 読み込み用バッファのアタッチ
     */
    public attach(buffer: Uint8Array): void {
        this.bufUserRead = buffer;
        this.idxUserReadCursor = 0;
    }

    // ==========================================
    // Read Implementation (Accumulate Strategy)
    // ==========================================
    public async read(cntLength?: number): Promise<IFileStreamResult> {
        if (!this.bufUserRead) {
            throw new Error("BufferNotAttached: Please call attach() before reading.");
        }

        // 1. バッファ残量の計算
        // Application Hungarian: cnt (Count), rem (Remaining)
        const cntBufferRem = this.bufUserRead.byteLength - this.idxUserReadCursor;
        
        // 要求サイズ (指定なしなら残り全部埋める気概で)
        const cntReq = cntLength === undefined ? cntBufferRem : cntLength;

        // 2. オーバーフロー判定 (ここが改修のキモ！)
        // 「これ以上積めない」状態での呼び出し、または「要求量が残量を超えた」場合はエラー
        if (cntBufferRem === 0 || cntReq > cntBufferRem) {
            throw new Error("BufferOverflow: User buffer is full or insufficient space.");
        }

        if (cntReq <= 0) {
            return { cntRead: 0, data: new Uint8Array(0) };
        }

        // --- 以下、リングバッファからの転送ロジック (既存ロジックを流用しつつ調整) ---

        let cntRemainingToRead = cntReq;
        let cntTotalRead = 0;
        
        // 今回の書き込み開始位置を記憶
        const idxStart = this.idxUserReadCursor;

        while (cntRemainingToRead > 0) {
            // A. バッファ補充 (Ring Bufferが空ならファイルから吸う)
            if (this.cntReadValid === 0) {
                if (this.isEof) break;
                
                const { filled } = await this.fillReadBuffer();
                if (filled === 0) break; // EOF
            }

            // B. 転送 (Ring -> User Buffer)
            const cntCopy = Math.min(cntRemainingToRead, this.cntReadValid);
            this.copyRingToUser(this.idxUserReadCursor, cntCopy);

            // C. カーソル & カウンタ更新
            this.idxReadTail = (this.idxReadTail + cntCopy) % this.limReadRing;
            this.cntReadValid -= cntCopy;
            
            this.idxUserReadCursor += cntCopy; // ★積み上げ: ユーザーバッファのカーソルを進める
            
            cntRemainingToRead -= cntCopy;
            cntTotalRead += cntCopy;

            // D. Partial Policy: データが少しでも取れたら即リターン (ブロッキング回避)
            if (this.optCurrent.readPolicy === ReadPolicy.Partial && this.cntReadValid === 0) {
                // まだ要求量に達していなくても、リングバッファが空になった時点で一旦返す
                // (次回のreadで続きを読めば良い)
                break; 
            }
        }

        // Exact Policy Check: 要求量を満たせなかったらエラー (構造体読み込みなどで使う)
        if (this.optCurrent.readPolicy === ReadPolicy.Exact && cntTotalRead < cntReq) {
             throw new Error(`UnexpectedEOF: Expected ${cntReq} bytes, but only got ${cntTotalRead}.`);
        }

        // 3. 結果の切り出し (SubArray)
        // メモリコピーせず、積み上げた部分だけのViewを返す
        const subResult = this.bufUserRead.subarray(idxStart, this.idxUserReadCursor);

        return {
            cntRead: cntTotalRead,
            data: subResult
        };
    }

    // ==========================================
    // Write Implementation (Smart Buffer Strategy)
    // ==========================================
    public async write(data: Uint8Array): Promise<void> {
        let offsetSrc = 0;
        let remaining = data.byteLength;

        // リニアバッファへの書き込みループ
        while (remaining > 0) {
            const available = this.limWrite - this.idxWriteCursor;

            // バッファがいっぱいなら、今ある分を吐き出して空にする
            if (available === 0) {
                await this.flush();
                continue; 
            }

            // バッファに詰め込めるだけ詰め込む
            const toWrite = Math.min(remaining, available);
            this.bufWrite.set(data.subarray(offsetSrc, offsetSrc + toWrite), this.idxWriteCursor);

            this.idxWriteCursor += toWrite;
            offsetSrc += toWrite;
            remaining -= toWrite;
        }

        // [Auto Flush]
        // 「前回分ではなく、今回分を即flushする」
        // バッファに書き込んだデータを、即座にディスクへ永続化する
        if (this.optCurrent.autoFlush) {
            await this.flush();
        }
    }

    /**
     * 書き込みバッファの強制排出
     */
    public async flush(): Promise<void> {
        if (this.idxWriteCursor === 0) return; // 書き出すものがない

        // バッファ内の有効データ
        const bufToFlush = this.bufWrite.subarray(0, this.idxWriteCursor);
        
        // 🌟 Fix: 第4引数(position)は null 固定。
        // これにより ZenFS の内部カーソル（Appendモードなら末尾）に従って書き込まれる。
        const { bytesWritten } = await this.hFile.write(bufToFlush, 0, this.idxWriteCursor, null);
        
        // 参考までに内部カウンタは更新するが、書き込み位置制御には使用しない
        this.idxFilePosWrite += bytesWritten;
        
        // カーソルをリセット（リニアバッファなので先頭に戻すだけ）
        this.idxWriteCursor = 0;
    }

    // ==========================================
    // Internal Helpers
    // ==========================================

    /**
     * File -> Ring Buffer へのデータ補充
     */
    private async fillReadBuffer(): Promise<{ filled: number }> {
        // リングバッファの「物理的な」連続書き込み可能サイズを計算
        const cntToTerm = this.limReadRing - this.idxReadHead;
        // 論理的な空き容量
        const cntFree = this.limReadRing - this.cntReadValid;
        
        const cntToRead = Math.min(cntFree, cntToTerm);
        if (cntToRead === 0) return { filled: 0 };

        const { bytesRead } = await this.hFile.read(this.bufReadRing, this.idxReadHead, cntToRead, this.idxFilePosRead);
        
        if (bytesRead > 0) {
            this.idxReadHead = (this.idxReadHead + bytesRead) % this.limReadRing;
            this.cntReadValid += bytesRead;
            this.idxFilePosRead += bytesRead;
        } else {
            this.isEof = true;
        }
        return { filled: bytesRead };
    }

    /**
     * Ring Buffer -> User Buffer へのデータコピー
     * (リングの折り返し[Wrap]を考慮してコピーする)
     */
    private copyRingToUser(idxDst: number, cnt: number): void {
        if (!this.bufUserRead) return;

        const cntToTerm = this.limReadRing - this.idxReadTail;

        if (cnt <= cntToTerm) {
            // 折り返しなし: 一回でコピー
            const sub = this.bufReadRing.subarray(this.idxReadTail, this.idxReadTail + cnt);
            this.bufUserRead.set(sub, idxDst);
        } else {
            // 折り返しあり: 終端まで + 先頭から
            const sub1 = this.bufReadRing.subarray(this.idxReadTail, this.limReadRing);
            this.bufUserRead.set(sub1, idxDst);

            const cntRem = cnt - cntToTerm;
            const sub2 = this.bufReadRing.subarray(0, cntRem);
            this.bufUserRead.set(sub2, idxDst + cntToTerm);
        }
    }

    // ==========================================
    // Standard I/O Methods
    // ==========================================

    public async stat(): Promise<Stats> {
        return await this.hFile.stat();
    }
    
    public async close(): Promise<void> { 
        // 閉じる前に必ず残存データを吐き出す
        try {
            await this.flush();
        } catch (e) {
            // Close時のFlushエラーはログ等に留めるのが一般的だが、
            // ここでは呼び出し元に伝えるためスローしても良い。
            // 状況に応じて握りつぶす設計もアリ。
            throw e;
        } finally {
            this.bufUserRead = null;
            await this.hFile.close(); 
        }
    }
    public setWriteCursor(pos: number): void {
        this.idxFilePosWrite = pos;
    }
}