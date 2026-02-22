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
 * Wrapper to handle ReadableStream<string> and ReadableStream<Uint8Array> uniformly.
 * Requirements:
 * 1. constructor(readable, StdinStream.UINT8ARRAY | StdinStream.STRING)
 * 2. Provide getByteReader() and getStringReader()
 * 3. Pipe Encoder/Decoder only when necessary
 */
export class StdinStream implements IStdinStream {
    // Requirement: Constants for StdinStream.UINT8ARRAY / STRING access
    static readonly UINT8ARRAY = StreamData.Uint8Array;
    static readonly STRING = StreamData.String;

    /**
     * Internal reference to the source stream.
     * Application Hungarian: rs (ReadableStream)
     */
    private rsSource: ReadableStream<string | Uint8Array>;

    /**
     * Data type of the source stream.
     * Application Hungarian: kind (Enum: Number)
     */
    private kindSource: StreamDataType;

    public readonly isTTY: boolean;
    // Update Callback Signature
    private fnSetMode?: (mode: TTYMode) => Promise<void>;

    constructor(
        rsSource: ReadableStream<string> | ReadableStream<Uint8Array>,
        kindSource: StreamDataType,
        isTTY: boolean = false,
        fnSetMode?: (mode: TTYMode) => Promise<void> // Update
    ) {
        this.rsSource = rsSource as ReadableStream<string | Uint8Array>;
        this.kindSource = kindSource;
        this.isTTY = isTTY;
        this.fnSetMode = fnSetMode;
    }

    // Update Method
    public async setMode(mode: TTYMode): Promise<void> {
        if (!this.isTTY || !this.fnSetMode) return;
        await this.fnSetMode(mode);
    }

    /**
     * Interrupt implementation
     * stream.cancel() remains effective even when locked.
     * Pending reader.read() calls will reject with the provided reason.
     */
    public async interrupt(reason?: any): Promise<void> {
        try {
            // ReadableStream has cancel() method
            await this.rsSource.cancel(reason);
        } catch (e) {
            // Ignore if already closed or similar cases
        }
    }

    /**
     * バイト列 (Uint8Array) として読むための Reader を取得する。
     * Pipe through EncoderStream only if the source is String.
     */
    public getByteReader(): ReadableStreamDefaultReader<Uint8Array> {
        this.assertNotLocked();

        if (this.kindSource === StreamData.Uint8Array) {
            // A. No Conversion: Return as is
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
     * Fix: pipeThrough keeps the source stream locked;
     * manually acquire ByteReader and wrap it for decoding.
     */
    public getStringReader(): ReadableStreamDefaultReader<string> {
        this.assertNotLocked();

        if (this.kindSource === StreamData.String) {
            return (this.rsSource as ReadableStream<string>).getReader();
        } else {
            // B. Conversion: Uint8Array -> String (Decode Manually)
            
            // 1. Acquire the ByteReader of the source stream (locking it).
            const byteReader = (this.rsSource as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();

            // 2. Create a proxy object mimicking the Reader interface.
            return {
                read: async (): Promise<ReadableStreamReadResult<string>> => {
                    const result = await byteReader.read();
                    if (result.done) {
                        return { done: true, value: undefined };
                    }
                    // Decode bytes and return (handles multi-byte splitting with {stream: true})
                    const strValue = decoder.decode(result.value, { stream: true });
                    return { done: false, value: strValue };
                },
                releaseLock: () => {
                    // [Crucial!]
                    // When the wrapper is released, release the underlying Reader as well,
                    // returning the stream to the shell.
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
     * Check the lock status
     */
    private assertNotLocked(): void {
        if (this.rsSource.locked) {
            throw new Error("StdinStream: Source stream is already locked.");
        }
    }
}


/**
 * Wrapper to handle WritableStream<string> and WritableStream<Uint8Array> uniformly.
 * * * Declares what the destination receives in the constructor,
 * * and depending on whether the writer wants to write in bytes or strings,
 * * it automatically connects by inserting an Encoder/Decoder if necessary.
 */
export class StdoutStream implements IStdoutStream{
    // Constant aliases
    static readonly UINT8ARRAY = StreamData.Uint8Array;
    static readonly STRING = StreamData.String;

    /**
     * Destination stream.
     * Application Hungarian: ws (WritableStream)
     */
    private wsDest: WritableStream<string | Uint8Array>;

    /**
     * Data type received by the destination.
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
     * Interrupt implementation
     * Calling stream.abort() rejects pending writer.write() with the reason.
     */
    public async interrupt(reason?: any): Promise<void> {
        try {
            // WritableStream has abort() method
            await this.wsDest.abort(reason);
        } catch (e) {
            // Ignore
        }
    }
    
    /**
     * バイト列 (Uint8Array) を書き込むための Writer を取得する。
     * Create a pipe that decodes written bytes only if the destination is a String.
     */
    public getByteWriter(): WritableStreamDefaultWriter<Uint8Array> {
        this.assertNotLocked();

        if (this.kindDest === StreamData.Uint8Array) {
            // A. [Writer: Byte] -> [Dest: Byte] (No Conversion)
            return (this.wsDest as WritableStream<Uint8Array>).getWriter();
        } else {
            // B. [Writer: Byte] -> (Decoder) -> [Dest: String]
            // Case: Destination expects string, but we want to write bytes
            const tsDecoder = new TextDecoderStream();
            
            // Connect the outlet of the transform stream to the actual destination
            tsDecoder.readable.pipeTo(this.wsDest as WritableStream<string>)
                .catch(e => console.error("StdoutStream Pipe Error:", e));
            
            // Return the inlet (Writer) of the transform stream
            return tsDecoder.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
        }
    }

    /**
     * 文字列 (string) を書き込むための Writer を取得する。
     * Create a pipe that encodes written characters only if the destination is a Uint8Array.
     */
    public getStringWriter(): WritableStreamDefaultWriter<string> {
        this.assertNotLocked();

        if (this.kindDest === StreamData.String) {
            // A. [Writer: String] -> [Dest: String] (No Conversion)
            return (this.wsDest as WritableStream<string>).getWriter();
        } else {
            // B. [Writer: String] -> (Encoder) -> [Dest: Byte]
            // Case: Destination expects bytes, but we want to write strings
            const tsEncoder = new TextEncoderStream();
            
            tsEncoder.readable.pipeTo(this.wsDest as WritableStream<Uint8Array>)
                .catch(e => console.error("StdoutStream Pipe Error:", e));

            return tsEncoder.writable.getWriter();
        }
    }

    /**
     * Check the lock status
     */
    private assertNotLocked(): void {
        if (this.wsDest.locked) {
            throw new Error("StdoutStream: Destination stream is already locked.");
        }
    }
}
