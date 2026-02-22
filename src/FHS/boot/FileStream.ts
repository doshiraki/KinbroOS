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
 * Wraps internal kernel file handles,
 * providing fast reading (Ring Buffer) and efficient writing (Linear Buffer).
 * * [Architecture: Read (Ring Buffer)]
 * File -> [ Head ... Data ... Tail ] -> UserBuffer
 * ^ Write           ^ Read
 * * 1. Uses an internal fixed-length ring buffer to pre-read (Fill) data from files.
 * 2. Passes a copy (or View) of the ring buffer to the user, achieving near zero-copy performance.
 * 3. ReadPolicy.Exact allows choosing the behavior to "wait until required bytes are available".
 * * [Architecture: Write (Linear Buffer & Flush)]
 * UserData -> [ Buffer ... ] -> (Flush) -> File
 * * 1. Accumulates small writes in the internal buffer to reduce system calls.
 * 2. Writes to disk when the buffer overflows or is explicitly flush()ed.
 * 3. autoFlush: true bypasses the buffer and writes directly to disk (e.g., for logging).
 */
export class FileStream implements IFileStream {
    private readonly hFile: fs.FileHandle;

    // ==========================================
    // Read Context (Ring Buffer)
    // ==========================================
    // Uses a ring buffer for reading to retain past data and provide it seamlessly.
    private readonly bufReadRing: Uint8Array;
    private readonly limReadRing: number;
    private idxReadHead: number = 0; // File -> Ring (Write Pointer)
    private idxReadTail: number = 0; // Ring -> User (Read Pointer)
    private cntReadValid: number = 0;
    
    // User Attached Buffer (Read Only)
    // User-provided buffer for reading and its state
    private bufUserRead: Uint8Array | null = null;
    private idxUserReadCursor: number = 0;

    // ==========================================
    // Write Context (Linear Buffer)
    // ==========================================
    // Uses a simple and fast linear buffer for writing to accumulate and flush all at once.
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

    // File pointer (manages OS-side cursor position)
    private idxFilePosRead: number = 0;
    private idxFilePosWrite: number = 0;
    private isEof: boolean = false;

    /**
     * @param handle File handle
     * @param sizeBuffer Internal buffer size (Allocated separately for Read/Write. Default 64KB)
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
     * Update configuration
     */
    public config(options: StreamConfig): void {
        this.optCurrent = { ...this.optCurrent, ...options };
    }

    /**
     * Attach read buffer
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

        // 1. Calculate remaining buffer capacity
        // Application Hungarian: cnt (Count), rem (Remaining)
        const cntBufferRem = this.bufUserRead.byteLength - this.idxUserReadCursor;
        
        // Requested size (Fill all remaining if unspecified)
        const cntReq = cntLength === undefined ? cntBufferRem : cntLength;

        // 2. Overflow check (Crucial modification point!)
        // Error if called when "cannot accumulate more" or if requested amount exceeds remaining capacity
        if (cntBufferRem === 0 || cntReq > cntBufferRem) {
            throw new Error("BufferOverflow: User buffer is full or insufficient space.");
        }

        if (cntReq <= 0) {
            return { cntRead: 0, data: new Uint8Array(0) };
        }

        // --- Ring buffer transfer logic (Adjusting existing logic) ---

        let cntRemainingToRead = cntReq;
        let cntTotalRead = 0;
        
        // Remember write start position for this operation
        const idxStart = this.idxUserReadCursor;

        while (cntRemainingToRead > 0) {
            // A. Buffer replenishment (Draw from file if Ring Buffer is empty)
            if (this.cntReadValid === 0) {
                if (this.isEof) break;
                
                const { filled } = await this.fillReadBuffer();
                if (filled === 0) break; // EOF
            }

            // B. Transfer (Ring -> User Buffer)
            const cntCopy = Math.min(cntRemainingToRead, this.cntReadValid);
            this.copyRingToUser(this.idxUserReadCursor, cntCopy);

            // C. Update cursor & counter
            this.idxReadTail = (this.idxReadTail + cntCopy) % this.limReadRing;
            this.cntReadValid -= cntCopy;
            
            this.idxUserReadCursor += cntCopy; // [Accumulate]: Advance user buffer cursor
            
            cntRemainingToRead -= cntCopy;
            cntTotalRead += cntCopy;

            // D. Partial Policy: Return immediately if any data is retrieved (Avoid blocking)
            if (this.optCurrent.readPolicy === ReadPolicy.Partial && this.cntReadValid === 0) {
                // Return once ring buffer is empty, even if requested amount is not met
                // (Can read the rest in the next read call)
                break; 
            }
        }

        // Exact Policy Check: Error if requested amount is not met (used for struct reading, etc.)
        if (this.optCurrent.readPolicy === ReadPolicy.Exact && cntTotalRead < cntReq) {
             throw new Error(`UnexpectedEOF: Expected ${cntReq} bytes, but only got ${cntTotalRead}.`);
        }

        // 3. Extract result (SubArray)
        // Return a View of the accumulated portion without memory copying
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

        // Write loop to linear buffer
        while (remaining > 0) {
            const available = this.limWrite - this.idxWriteCursor;

            // If buffer is full, flush existing contents to empty it
            if (available === 0) {
                await this.flush();
                continue; 
            }

            // Pack as much data as possible into the buffer
            const toWrite = Math.min(remaining, available);
            this.bufWrite.set(data.subarray(offsetSrc, offsetSrc + toWrite), this.idxWriteCursor);

            this.idxWriteCursor += toWrite;
            offsetSrc += toWrite;
            remaining -= toWrite;
        }

        // [Auto Flush]
        // "Flush the current data immediately, not the previous data"
        // Persist the data written to the buffer immediately to disk
        if (this.optCurrent.autoFlush) {
            await this.flush();
        }
    }

    /**
     * Force flush write buffer
     */
    public async flush(): Promise<void> {
        if (this.idxWriteCursor === 0) return; // Nothing to write out

        // Valid data in buffer
        const bufToFlush = this.bufWrite.subarray(0, this.idxWriteCursor);
        
        // [Fix]: 4th argument (position) is fixed to null.
        // This ensures writing follows ZenFS internal cursor (end of file if in Append mode).
        const { bytesWritten } = await this.hFile.write(bufToFlush, 0, this.idxWriteCursor, this.idxFilePosWrite);
        
        // Update internal counter for reference, but do not use for write position control.
        this.idxFilePosWrite += bytesWritten;
        
        // Reset cursor (linear buffer, so just return to start).
        this.idxWriteCursor = 0;
    }

    // ==========================================
    // Internal Helpers
    // ==========================================

    /**
     * Replenish data from File to Ring Buffer
     */
    private async fillReadBuffer(): Promise<{ filled: number }> {
        // Calculate "physical" contiguous writable size of the ring buffer
        const cntToTerm = this.limReadRing - this.idxReadHead;
        // Logical free capacity
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
     * Copy data from Ring Buffer to User Buffer
     * (Consider ring wrap-around [Wrap] during copy)
     */
    private copyRingToUser(idxDst: number, cnt: number): void {
        if (!this.bufUserRead) return;

        const cntToTerm = this.limReadRing - this.idxReadTail;

        if (cnt <= cntToTerm) {
            // No wrap: single copy operation
            const sub = this.bufReadRing.subarray(this.idxReadTail, this.idxReadTail + cnt);
            this.bufUserRead.set(sub, idxDst);
        } else {
            // With wrap: copy to end + copy from start
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
        // Always flush remaining data before closing
        try {
            await this.flush();
        } catch (e) {
            // Flush errors on close are usually logged, but
            // can be thrown here to notify the caller.
            // Swallowing the error is also a design choice.
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
