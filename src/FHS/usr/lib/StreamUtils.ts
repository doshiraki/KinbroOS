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

/**
 * [Library: StreamUtils]
 * Web Streams API Wrapper
 * バイナリ(Uint8Array)と文字列(String)の相互変換を簡略化するユーティリティ。
 */

// --- Interfaces ---

export interface IBinaryReader {
    /** 生のReaderを取得 (Escape Hatch) */
    readonly raw: ReadableStreamDefaultReader<Uint8Array>;
    
    /** 生のバイト列として読み込む */
    read(): Promise<ReadableStreamReadResult<Uint8Array>>;
    
    /** 文字列として読み込む (自動デコード) */
    readString(): Promise<{ value: string, done: boolean }>;
    
    /** ロックを解放する */
    releaseLock(): void;
}

export interface IBinaryWriter {
    /** 生のWriterを取得 (Escape Hatch) */
    readonly raw: WritableStreamDefaultWriter<Uint8Array>;
    
    /** 生のバイト列を書き込む */
    write(chunk: Uint8Array): Promise<void>;
    
    /** 文字列を書き込む (自動エンコード) */
    writeString(str: string): Promise<void>;
    
    /** ロックを解放する */
    releaseLock(): void;
    
    /** ストリームを閉じる */
    close(): Promise<void>;
}


// --- Implementations ---

export class BinaryReader implements IBinaryReader {
    private _reader: ReadableStreamDefaultReader<Uint8Array>;
    private decoder: TextDecoder;

    constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
        this._reader = reader;
        this.decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
    }

    public get raw(): ReadableStreamDefaultReader<Uint8Array> {
        return this._reader;
    }

    public async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
        return this._reader.read();
    }

    public async readString(): Promise<{ value: string, done: boolean }> {
        const { value, done } = await this._reader.read();
        if (done) {
            const strLeftover = this.decoder.decode(undefined, { stream: false });
            return { value: strLeftover, done: true };
        }
        const strChunk = this.decoder.decode(value, { stream: true });
        return { value: strChunk, done: false };
    }

    public releaseLock(): void {
        this._reader.releaseLock();
    }
}

export class BinaryWriter implements IBinaryWriter {
    private _writer: WritableStreamDefaultWriter<Uint8Array>;
    private encoder: TextEncoder;

    constructor(writer: WritableStreamDefaultWriter<Uint8Array>) {
        this._writer = writer;
        this.encoder = new TextEncoder();
    }

    public get raw(): WritableStreamDefaultWriter<Uint8Array> {
        return this._writer;
    }

    public async write(chunk: Uint8Array): Promise<void> {
        return this._writer.write(chunk);
    }

    public async writeString(str: string): Promise<void> {
        const chunk = this.encoder.encode(str);
        return this._writer.write(chunk);
    }

    public releaseLock(): void {
        this._writer.releaseLock();
    }

    public async close(): Promise<void> {
        return this._writer.close();
    }
}