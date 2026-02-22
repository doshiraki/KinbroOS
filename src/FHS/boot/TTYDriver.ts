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

// src/FHS/boot/TTYDriver.ts

import { TTYMode } from '../../dev/types/IProcess';

export class TTYDriver {
    public readonly sessionId: number;
    public pgidForeground: number;
    private mapPgidToCtl: Map<number, ReadableStreamDefaultController<string>> = new Map();
    public onSignal?: (pgid: number, signal: number) => void;

    private mode: TTYMode = TTYMode.Raw; 
    
    private lineBuffer: string = '';
    private writerEcho?: WritableStreamDefaultWriter<Uint8Array>;
    private encoder = new TextEncoder();

    constructor(sessionId: number, initialPgid: number) {
        this.sessionId = sessionId;
        this.pgidForeground = initialPgid;
    }

    public attachPhysicalIO(rsInput: ReadableStream<string>, wsOutput: WritableStream<Uint8Array>) {
        this.writerEcho = wsOutput.getWriter();
        const reader = rsInput.getReader();
        this.inputLoop(reader).catch(e => console.error("[TTY] Input Error:", e));
    }

    public setMode(mode: TTYMode) {
        this.mode = mode;
    }

    private async inputLoop(reader: ReadableStreamDefaultReader<string>) {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            if (this.mode === TTYMode.Raw) {
                this.emitToForeground(value);
            } else {
                await this.handleCookedInput(value);
            }
        }
    }

    /**
     * [Revised] Professional Line Discipline implementation
     * Visualize control characters and handle backspaces properly
     */
    private async handleCookedInput(char: string) {
        const code = char.charCodeAt(0);

        // 1. Signal Handling (ISIG)
        // Ctrl+C (ETX)
        if (code === 0x03) { 
            await this.echoString('^C\r\n');
            
            // Notify Kernel (Logical deletion)
            if (this.onSignal) this.onSignal(this.pgidForeground, 2); 

            // [Added]: Notify stream (Physical disconnection)
            // Otherwise, processes waiting in read() will hang forever!
            const controller = this.mapPgidToCtl.get(this.pgidForeground);
            if (controller) {
                try {
                    // Throw error equivalent to "Interrupted System Call"
                    controller.error(new Error("Interrupted"));
                } catch(e) {}
                
                // Remove from map (Input channel for this PGID is gone)
                this.mapPgidToCtl.delete(this.pgidForeground);
            }

            this.lineBuffer = '';
            return;
        }
        // [Added]: Ctrl+Z (0x1A) - Job Suspend
        else if (code === 0x1a) {
            await this.echoString('^Z\r\n');

            // Notify Kernel (SIGTSTP = 20)
            if (this.onSignal) this.onSignal(this.pgidForeground, 20);

            // Do NOT notify the stream!
            // We don't want to "error out" the process;
            // we want to "freeze" it while it is waiting for input.
            // Instead of physical disconnection, just trigger a return of control to the shell.
            
            this.lineBuffer = '';
            return;
        }
        // [Added Implementation]: Ctrl+D (EOT) - EOF Handling
        else if (code === 0x04) {
            console.log(`[TTY:Cooked] Ctrl+D detected. BufferLen:${this.lineBuffer.length} FG:${this.pgidForeground}`);
            // Case A: If there is partial input, flush/commit it (Commit)
            if (this.lineBuffer.length > 0) {
                this.emitToForeground(this.lineBuffer);
                this.lineBuffer = '';
            } 
            // Case B: If input is empty, close the stream as EOF
            else {
                const controller = this.mapPgidToCtl.get(this.pgidForeground);
                if (controller) {
                    try {
                        // Close the stream normally
                        controller.close();
                    } catch(e) {}
                    
                    // Remove from map (Input channel for this PGID is gone)
                    this.mapPgidToCtl.delete(this.pgidForeground);
                }
            }
            return; 
        }

        // 2. Editing (BackSpace / DEL)
        else if (code === 0x7f || code === 0x08) { 
            if (this.lineBuffer.length > 0) {
                 // Get the character to be deleted
                 const charToDelete = this.lineBuffer.slice(-1);
                 this.lineBuffer = this.lineBuffer.slice(0, -1);
                 
                 // Screen erasure processing
                 // If deleted char is a control char, it takes 2 chars (e.g., "^A") on screen
                 // Therefore, 2 characters must be erased.
                 const eraseWidth = this.calcDisplayWidth(charToDelete);
                 await this.echoBackspace(eraseWidth);
            }
            return;
        }

        // 3. Normal Processing
        // Enter (\r)
        if (char === '\r' || char === '\n') { // Support both CR and LF
             await this.echoString('\r\n');
             this.lineBuffer += '\n'; // Generally passed as to the application
             this.emitToForeground(this.lineBuffer);
             this.lineBuffer = '';
             return;
        }
        
        // 4. Echo Back with Caret Notation
        if (code < 32) {
             // Echo control chars (except \t, \n) in ^X notation
             if (char === '\t' || char === '\n') {
                 await this.echoString(char);
                 this.lineBuffer += char;
             } else {
                 // Example: \x01 (Ctrl+A) -> "^" + "A"
                 const caret = '^' + String.fromCharCode(code + 64);
                 await this.echoString(caret);
                 this.lineBuffer += char; 
             }
        } else {
             // Ordinary character
             await this.echoString(char);
             this.lineBuffer += char;
        }
    }

    /**
     * [Helper] Perform backspace for a specified width
     * Move cursor back, overwrite with space, and move back again
     */
    private async echoBackspace(width: number) {
        if (!this.writerEcho) return;
        // Example: width=2 -> "$8$8  $8$8"
        const bs = '\b'.repeat(width);
        const space = ' '.repeat(width);
        const seq = bs + space + bs;
        await this.writerEcho.write(this.encoder.encode(seq));
    }

    /**
     * [Helper] Echo back the string
     */
    private async echoString(str: string) {
        if (this.writerEcho) {
            await this.writerEcho.write(this.encoder.encode(str));
        }
    }

    /**
     * [Helper] Calculate character width on screen
     */
    private calcDisplayWidth(char: string): number {
        const code = char.charCodeAt(0);
        if (code < 32) {
            if (char === '\t') return 1; // Ideally needs tab position calculation, but simplified to 1
            if (char === '\n') return 0; // Newline has no width
            return 2; // ^A, etc. take 2 chars
        }
        // Ideally requires wcwidth check, but treated as 1 width here
        return 1;
    }

    private emitToForeground(data: string) {
// [Debug Log] Destination of input data
        // Display code if control char, otherwise display char itself
        const debugData = data.length === 1 ? `Code:${data.charCodeAt(0)}` : `"${data.replace(/\n/g, '\\n')}"`;
        console.log(`[TTY:Input] Sending ${debugData} -> PGID:${this.pgidForeground}`);

        const controller = this.mapPgidToCtl.get(this.pgidForeground);
        if (controller) {
            try { controller.enqueue(data); } catch (e) {}
        } else {
            // [Debug Log] Destination missing!
            console.warn(`[TTY:Warn] No controller found for PGID:${this.pgidForeground} (Data lost)`);
        }
    }

    public cleanup(pgid: number) {
        this.mapPgidToCtl.delete(pgid);
    }
    
    public createStreamFor(pgid: number): ReadableStream<string> {
        return new ReadableStream<string>({
            start: (controller) => {
                this.mapPgidToCtl.set(pgid, controller);
            },
            cancel: () => {
                this.mapPgidToCtl.delete(pgid);
            }
        });
    }
}
