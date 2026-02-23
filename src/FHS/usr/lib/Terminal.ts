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

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Kibsh } from '../bin/kibsh';
import { ReadableStreamDefaultController } from 'node:stream/web';

/**
 * [Class: TerminalUI]
 * Wraps xterm.js and provides an I/O interface compliant with Web Streams API.
 * Handles Line Discipline to maintain features like arrow keys, history, and completion.
 */
export class TerminalUI {
    public readonly readable: ReadableStream<string>;
    public readonly writable: WritableStream<Uint8Array>;

    private objTerm: Terminal;
    private objFit: FitAddon;

    // [Update] Encoder/Decoder for stream conversion
    private encoder = new TextEncoder();
    private decoder = new TextDecoder();    

    // Stream Controller
    private controllerInput?: ReadableStreamDefaultController<string>;

    /**
     * @param objShellHelper Shell instance for Tab completion calculations
     */
    constructor() {

        this.encoder = new TextEncoder();
        // 1. xterm.js Setup
        this.objTerm = new Terminal({
            cursorBlink: true,
            fontFamily: '"BIZ UDGothic", "Cascadia Code", Menlo, monospace',
            fontSize: 14,
            convertEol: true, // \n を \r\n に変換して表示
            theme: {
                background: '#1a1b26',
                foreground: '#a9b1d6',
                cursor: '#c0caf5',
            },
            allowProposedApi: true
        });
        this.objFit = new FitAddon();
        this.objTerm.loadAddon(this.objFit);

        // 2. Input Stream (Keyboard -> Shell)
        this.readable = new ReadableStream<string>({
            start: (controller) => {
                this.controllerInput = controller;
            }
        });

        // 3. Output Stream (Shell -> Display)
        // Shell (Uint8Array) -> Decoder -> xterm (String)
        this.writable = new WritableStream({
            write: (chunk) => {
                return new Promise<void>((resolve) => {
                    // [Render] Decode bytes to string and write to terminal
                    const strChunk = this.decoder.decode(chunk, { stream: true });
                    this.objTerm.write(strChunk, () => resolve());
                });
            }
        });
        // 4. Event Listeners
        this.objTerm.onData(this.handleRawInput.bind(this));
        
        // Resize Handler
        window.addEventListener('resize', () => this.resize());
    }

    public mount(domContainer: HTMLElement): void {
        this.objTerm.open(domContainer);
        this.resize();
        // Prompts are managed by the Shell; no action or only initial message here.
    }

    public resize(): void {
        this.objFit.fit();
    }

    // --- Input Handling Logic (Existing Logic Preserved) ---

    private handleRawInput(strData: string): void {
        if (this.controllerInput) {
            // CR -> LF conversion (ICRNL)
            // Performing this here removes the need for conversion in kibsh.
            const normalized = strData.replace(/\r/g, '\n');
            this.controllerInput.enqueue(normalized);
        }
    }
}
