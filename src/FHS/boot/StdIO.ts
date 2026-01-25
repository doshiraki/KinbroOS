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

import { IStdinStream, IStdoutStream, StreamData, StreamDataType, TTYMode } from "../../dev/types/IProcess";



/**
 * ReadableStream<string> と ReadableStream<Uint8Array> を統一的に扱うラッパー。
 * 要件:
 * 1. constructor(readable, StdinStream.UINT8ARRAY | StdinStream.STRING)
 * 2. getByteReader() / getStringReader() を提供
 * 3. 必要な場合のみ Encoder/Decoder をパイプする
 */
export class StdinStream implements IStdinStream {
    // 要件: StdinStream.UINT8ARRAY / STRING でアクセス可能にする定数
    static readonly UINT8ARRAY = StreamData.Uint8Array;
    static readonly STRING = StreamData.String;

    /**
     * 保持する元のストリーム。
     * Application Hungarian: rs (ReadableStream)
     */
    private rsSource: ReadableStream<string | Uint8Array>;

    /**
     * 元ストリームのデータ種別。
     * Application Hungarian: kind (Enum: Number)
     */
    private kindSource: StreamDataType;

    public readonly isTTY: boolean;
    // ✨ Update Callback Signature
    private fnSetMode?: (mode: TTYMode) => Promise<void>;

    constructor(
        rsSource: ReadableStream<string> | ReadableStream<Uint8Array>,
        kindSource: StreamDataType,
        isTTY: boolean = false,
        fnSetMode?: (mode: TTYMode) => Promise<void> // ✨ Update
    ) {
        this.rsSource = rsSource as ReadableStream<string | Uint8Array>;
        this.kindSource = kindSource;
        this.isTTY = isTTY;
        this.fnSetMode = fnSetMode;
    }

    // ✨ Update Method
    public async setMode(mode: TTYMode): Promise<void> {
        if (!this.isTTY || !this.fnSetMode) return;
        await this.fnSetMode(mode);
    }

    /**
     * ✨ Interrupt 実装
     * ロックされている場合でも stream.cancel() は有効。
     * これにより、reader.read() で待機している箇所が reason で Reject される。
     */
    public async interrupt(reason?: any): Promise<void> {
        try {
            // ReadableStream には cancel() がある
            await this.rsSource.cancel(reason);
        } catch (e) {
            // すでに閉じている場合などは無視
        }
    }

    /**
     * バイト列 (Uint8Array) として読むための Reader を取得する。
     * 元が String の場合のみ EncoderStream をパイプする。
     */
    public getByteReader(): ReadableStreamDefaultReader<Uint8Array> {
        this.assertNotLocked();

        if (this.kindSource === StreamData.Uint8Array) {
            // A. No Conversion: そのまま返す
            return (this.rsSource as ReadableStream<Uint8Array>).getReader();
        } else {
            // B. Conversion: String -> Uint8Array (Encode)
            return (this.rsSource as ReadableStream<string>)
                .pipeThrough(new TextEncoderStream())
                .getReader();
        }
    }


    /**
     * 文字列 (string) として読むための Reader を取得する。
     * 修正: pipeThroughを使うと元ストリームがロックされたままになるため、
     * 手動でByteReaderを取得し、ラップしてデコードする。
     */
    public getStringReader(): ReadableStreamDefaultReader<string> {
        this.assertNotLocked();

        if (this.kindSource === StreamData.String) {
            return (this.rsSource as ReadableStream<string>).getReader();
        } else {
            // B. Conversion: Uint8Array -> String (Decode Manually)
            
            // 1. 元のストリームのバイトReaderを取得（これでロックする）
            const byteReader = (this.rsSource as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();

            // 2. Readerインターフェースを偽装したプロキシオブジェクトを作成
            return {
                read: async (): Promise<ReadableStreamReadResult<string>> => {
                    const result = await byteReader.read();
                    if (result.done) {
                        return { done: true, value: undefined };
                    }
                    // バイトをデコードして返す ({stream: true} でマルチバイト分断に対応)
                    const strValue = decoder.decode(result.value, { stream: true });
                    return { done: false, value: strValue };
                },
                releaseLock: () => {
                    // ★ここが最重要！
                    // ラッパーが解放されたら、裏にある本当のReaderも解放して、
                    // シェルにストリームを返してあげる。
                    byteReader.releaseLock();
                },
                cancel: async (reason?: any) => {
                    await byteReader.cancel(reason);
                },
                closed: byteReader.closed.then(() => undefined)
            } as ReadableStreamDefaultReader<string>;
        }
    }

    /**
     * ロック状態のチェック
     */
    private assertNotLocked(): void {
        if (this.rsSource.locked) {
            throw new Error("StdinStream: Source stream is already locked.");
        }
    }
}


/**
 * WritableStream<string> と WritableStream<Uint8Array> を統一的に扱うラッパー。
 * * 出力先（Destination）が何を受け取るかをコンストラクタで宣言し、
 * 書き込み側（Writer）が「バイトで書きたい」か「文字列で書きたい」かに応じて
 * 必要なら自動的に Encoder/Decoder を挟んで接続する。
 */
export class StdoutStream implements IStdoutStream{
    // 定数エイリアス
    static readonly UINT8ARRAY = StreamData.Uint8Array;
    static readonly STRING = StreamData.String;

    /**
     * 書き込み先のストリーム（Destination）。
     * Application Hungarian: ws (WritableStream)
     */
    private wsDest: WritableStream<string | Uint8Array>;

    /**
     * 出力先が受け取るデータ種別。
     * Application Hungarian: kind (Enum: Number)
     */
    private kindDest: StreamDataType;

    public readonly isTTY: boolean;

    constructor(
        wsDest: WritableStream<string> | WritableStream<Uint8Array>,
        kindDest: StreamDataType,
        isTTY: boolean = false
    ) {
        this.wsDest = wsDest as WritableStream<string | Uint8Array>;
        this.kindDest = kindDest;
        this.isTTY = isTTY;
    }


    /**
     * ✨ Interrupt 実装
     * stream.abort() を呼ぶと、writer.write() で待機している箇所が reason で Reject される。
     */
    public async interrupt(reason?: any): Promise<void> {
        try {
            // WritableStream には abort() がある
            await this.wsDest.abort(reason);
        } catch (e) {
            // 無視
        }
    }
    
    /**
     * バイト列 (Uint8Array) を書き込むための Writer を取得する。
     * 出力先が String の場合のみ、書き込んだバイトをデコードして流すパイプを作る。
     */
    public getByteWriter(): WritableStreamDefaultWriter<Uint8Array> {
        this.assertNotLocked();

        if (this.kindDest === StreamData.Uint8Array) {
            // A. [Writer: Byte] -> [Dest: Byte] (No Conversion)
            return (this.wsDest as WritableStream<Uint8Array>).getWriter();
        } else {
            // B. [Writer: Byte] -> (Decoder) -> [Dest: String]
            // 出力先が文字列を求めているのに、バイトを書き込みたい場合
            const tsDecoder = new TextDecoderStream();
            
            // 変換ストリームの出口を、本来の出力先に繋ぐ
            tsDecoder.readable.pipeTo(this.wsDest as WritableStream<string>)
                .catch(e => console.error("StdoutStream Pipe Error:", e));
            
            // 変換ストリームの入り口(Writer)を返す
            return tsDecoder.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
        }
    }

    /**
     * 文字列 (string) を書き込むための Writer を取得する。
     * 出力先が Uint8Array の場合のみ、書き込んだ文字をエンコードして流すパイプを作る。
     */
    public getStringWriter(): WritableStreamDefaultWriter<string> {
        this.assertNotLocked();

        if (this.kindDest === StreamData.String) {
            // A. [Writer: String] -> [Dest: String] (No Conversion)
            return (this.wsDest as WritableStream<string>).getWriter();
        } else {
            // B. [Writer: String] -> (Encoder) -> [Dest: Byte]
            // 出力先がバイトを求めているのに、文字列を書き込みたい場合
            const tsEncoder = new TextEncoderStream();
            
            tsEncoder.readable.pipeTo(this.wsDest as WritableStream<Uint8Array>)
                .catch(e => console.error("StdoutStream Pipe Error:", e));

            return tsEncoder.writable.getWriter();
        }
    }

    /**
     * ロック状態のチェック
     */
    private assertNotLocked(): void {
        if (this.wsDest.locked) {
            throw new Error("StdoutStream: Destination stream is already locked.");
        }
    }
}