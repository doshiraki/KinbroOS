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

import '@xterm/xterm/css/xterm.css';
import { IProcess, TTYMode } from '../../../dev/types/IProcess';
import { BinaryReader, BinaryWriter } from './StreamUtils'; // ✨ Import
import { TerminalUtils } from '../../../dev/utils/TerminalUtils';

// Type definition for completer function
export type Completer = (line: string) => Promise<string[]>;

// ✨ 1. Enum Definition
export enum ReadLineResult {
    command = 0,
    Interrupt = 1,
    Processed = 2, 
    EOF = 99
}

export type ReadLineResultType = {
    result: ReadLineResult;
    isEOF?: boolean;
    payload?: {
        command: string
    }
}
/**
 * [Class: TerminalUI]
 * Wraps xterm.js to provide an I/O interface compliant with Web Streams API.
 * Line Discipline (line editing) is handled here to maintain editing features (arrows, history, completion).
 */
export class ReadLine {
    private proc: IProcess;      // Holds a Process, not a Shell
    private fnCompleter: Completer; // Completion logic is injected

    // Line Buffering State
    private strInputBuffer: string = '';
    private valCursorPos: number = 0; // Logical cursor position within the buffer
    
    // ✨ ラッパー型を使用
    private reader: BinaryReader;
    private writer: BinaryWriter;

    // ✨ 追加: 履歴管理用
    private history: string[] = [];
    private historyIndex: number = 0;
    private currentPromptStr: string = ''; // Store prompt for screen clearing

    // ✨ 追加: 入力中の一時保存用
    private currentInputStash: string = '';
    
    /**
     * @param objShellHelper Shell instance for Tab completion calculations
     */
    constructor(proc: IProcess, completer: Completer) {
        this.proc = proc;
        this.fnCompleter = completer;        // Wrap in a helper
        this.reader = new BinaryReader(proc.stdin!.getByteReader());
        this.writer = new BinaryWriter(proc.stdout!.getByteWriter());
    }

    /**
     * [Security] Create a disposable shield
     * By creating a new WritableStream each time, even if kibsh closes it,
     * the original this.writer remains unaffected.
     */
    public getBinaryWriter(): BinaryWriter {
        const shieldStream = new WritableStream<Uint8Array>({
            write: (chunk) => {
                // Forward to original writer
                return this.writer.write(chunk);
            },
            close: () => {
                // Even if kibsh signals completion, the original is not closed.
                // This shieldStream itself will close, but since it is disposable, it is fine.
                return Promise.resolve();
            },
            abort: (reason) => {
                console.warn('[ReadLine] Shield aborted:', reason);
                return Promise.resolve();
            }
        });
        return new BinaryWriter(shieldStream.getWriter());
    }

    public getBinaryReader(): BinaryReader {
        return this.reader;
    }

    // [Method] Single line read
    public async read(promptStr: string = '$ '): Promise<ReadLineResultType> {
        // 1. Enter Raw mode
        if (this.proc.stdin?.isTTY) {
            await this.proc.stdin.setMode(TTYMode.Raw);
        }

        try {
            this.currentPromptStr = promptStr; // Store for later
            await this.writer.writeString(promptStr);
            this.strInputBuffer = ''; 
            this.valCursorPos = 0;

            this.currentInputStash = ''; // Clear stash

            // [Update] Reset history index to latest on start
            this.historyIndex = this.history.length;
            
            while (true) {
                const { value, done } = await this.reader.readString();
                if (done) return {
                    result: ReadLineResult.EOF,
                    isEOF: true
                };

                // Exit loop and return when Enter is pressed
                const result = await this.handleRawInput(value); 
                if (result.result != ReadLineResult.Processed) {
                    return result;
                }
            }

        } finally {
            // 2. Return to Cooked mode
            if (this.proc.stdin?.isTTY) {
                await this.proc.stdin.setMode(TTYMode.Cooked);
            }
        }
    }

    // --- Input Handling Logic (Existing Logic Preserved) ---

    private async handleRawInput(strData: string): Promise<ReadLineResultType> {
        // Detect special keys
        switch (strData) {
            case '\r': // CR (古い環境やペースト用)
            case '\n': // ✨ LF (TerminalUIから送られてくるのはこっち！)
            case '\r\n': // CRLF (念のため)
                return this.handleEnter();
            case '\u007F': // Backspace
                return this.handleBackspace();
            case '\x1b[D': // Left Arrow
                return this.handleArrowKey('left');
            case '\x1b[C': // Right Arrow
                return this.handleArrowKey('right');
            case '\x03': // Ctrl+C
                return {
                    result: ReadLineResult.Interrupt,
                    isEOF: false
                }
            case '\t': // Tab
                return this.handleTabCompletion();
            case '\x1b[A': // ✨ Up Arrow
                return this.handleHistory('up');
            case '\x1b[B': // ✨ Down Arrow
                return this.handleHistory('down');
            default:
                // Treat as input if not a control character
                if (strData.length >= 1 && strData.charCodeAt(0) >= 32) {
                    return this.handleInputText(strData);
                }
        }
        return {
            result: ReadLineResult.Processed
        };
    }

    private handleInputText(strText: string): ReadLineResultType {
        // Implementation of insertion mode
        const strPre = this.strInputBuffer.slice(0, this.valCursorPos);
        const strPost = this.strInputBuffer.slice(this.valCursorPos);
        
        this.strInputBuffer = strPre + strText + strPost;
        this.valCursorPos += strText.length;
        
        // Screen update: Redraw from cursor onwards
        this.writer.writeString(strText + strPost);
        
        // Move cursor back to original position
        const widthPost = TerminalUtils.calcStrWidth(strPost);
        if (widthPost > 0) {
            this.writer.writeString('\x1b[D'.repeat(widthPost));
        }

        return {
            result: ReadLineResult.Processed
        };
    }

    private handleBackspace(): ReadLineResultType {
        const prev = TerminalUtils.calcPrevGraphemeInfo(this.strInputBuffer, this.valCursorPos);
        if (prev) {
            const strHead = this.strInputBuffer.slice(0, this.valCursorPos - prev.length);
            const strTail = this.strInputBuffer.slice(this.valCursorPos);

            this.strInputBuffer = strHead + strTail;
            this.valCursorPos -= prev.length;

            // 1. Move back by the width of the deleted character
            this.writer.writeString('\x1b[D'.repeat(prev.width));
            
            // 2. Overwrite with remaining string (Tail)
            this.writer.writeString(strTail);
            
            // 3. Clear trailing residues
            this.writer.writeString(' '.repeat(prev.width));
            
            // 4. Reset cursor to intended position
            const widthTail = TerminalUtils.calcStrWidth(strTail);
            this.writer.writeString('\x1b[D'.repeat(widthTail + prev.width));
        }
        return {
            result: ReadLineResult.Processed
        };

    }    

    private handleArrowKey(dir: 'left' | 'right'): ReadLineResultType {
        switch (dir) {
            case 'left': // Left Arrow
                const prev = TerminalUtils.calcPrevGraphemeInfo(this.strInputBuffer, this.valCursorPos);
                if (prev) {
                    // Logical cursor: move back by data length (e.g., 2 for emoji)
                    this.valCursorPos -= prev.length;
                    // Visual cursor: move back by display width (e.g., 1 for emoji)
                    this.writer.writeString('\x1b[D'.repeat(prev.width)); 
                }
                break;

            case 'right': // Right Arrow
                const next = TerminalUtils.calcNextGraphemeInfo(this.strInputBuffer, this.valCursorPos);
                if (next) {
                    // Logical cursor: move forward by data length (e.g., 2 for emoji)
                    this.valCursorPos += next.length;
                    // Visual cursor: move forward by display width (e.g., 1 for emoji)
                    this.writer.writeString('\x1b[C'.repeat(next.width));
                }
                break;
        }
        return {
            result: ReadLineResult.Processed
        };
    }

    /**
         * [Handler] History navigation handler
         */
    private handleHistory(dir: 'up' | 'down'): ReadLineResultType {
        if (dir === 'up') {
            if (this.historyIndex > 0) {
                // [Stash] Save current input when starting history search from the latest position
                if (this.historyIndex === this.history.length) {
                    this.currentInputStash = this.strInputBuffer;
                }
                this.historyIndex--;
                this.replaceInputBuffer(this.history[this.historyIndex]);
            }
        } else { // down
            if (this.historyIndex < this.history.length) {
                this.historyIndex++;
                if (this.historyIndex === this.history.length) {
                    // [Restore] Restore stashed content when returning to the latest position
                    this.replaceInputBuffer(this.currentInputStash);
                } else {
                    this.replaceInputBuffer(this.history[this.historyIndex]);
                }
            }
        }
        return { result: ReadLineResult.Processed };
    }

    /**
     * Clear the current visual input and replace it with a new string
     */
    private replaceInputBuffer(newStr: string) {
        // 1. Move cursor back to the start of the current input (after the prompt)
        // Calculate distance from current valCursorPos and move left
        // (Ideally use TerminalUtils for exact width, but simplified to character count here)
        // * Note: Emojis might cause misalignment in this simplified implementation
        const currentWidth = TerminalUtils.calcStrWidth(this.strInputBuffer.slice(0, this.valCursorPos));
        if (currentWidth > 0) {
            this.writer.writeString('\x1b[D'.repeat(currentWidth));
        }

        // 2. Fill the current line with spaces to erase it
        // (Write spaces for the full width of the current input)
        const fullWidth = TerminalUtils.calcStrWidth(this.strInputBuffer);
        this.writer.writeString(' '.repeat(fullWidth));

        // 3. Reset cursor to the start again (as writing spaces advanced it)
        this.writer.writeString('\x1b[D'.repeat(fullWidth));

        // 4. Update internal buffer with the new string
        this.strInputBuffer = newStr;
        this.valCursorPos = newStr.length; // Move cursor to the end

        // 5. Render the new string
        this.writer.writeString(newStr);
    }

    private handleEnter(): ReadLineResultType {
        this.writer.writeString('\r\n'); // 改行表示
        
        const strCommand = this.strInputBuffer;
        const strTrimed = strCommand.trim();

        // Save history only if there is input
        if (strTrimed.length > 0) {
            // Note: Logic to skip duplicates (same as previous command) would be ideal
            if (this.history.length === 0 || this.history[this.history.length - 1] !== strTrimed) {
                this.history.push(strTrimed);
            }
        }

        // Reset buffer
        this.strInputBuffer = '';
        this.valCursorPos = 0;

        // [Fix] Return as "Command Finished" even for empty input
        // This allows exiting the read() loop so kibsh can re-display the prompt
        return {
            result: ReadLineResult.command,
            payload: {
                command: strTrimed // Empty string is fine (ignored by kibsh)
            }
        };
    }

    /**
     * Tab Completion: Cursor-aware \& LCP supported version
     */
    private async handleTabCompletion(): Promise<ReadLineResultType> {
        // 1. Get string up to cursor position
        const strUpToCursor = this.strInputBuffer.slice(0, this.valCursorPos);

        // 2. Extract the word immediately before the cursor (space-delimited)
        // e.g., "git comm|it" -> "git comm" -> extract "comm"
        const lastSpaceIdx = strUpToCursor.lastIndexOf(' ');
        const strTarget = strUpToCursor.slice(lastSpaceIdx + 1);

        // 3. Get completion candidates (passing only the target word)
        let arrMatches = await this.fnCompleter(strTarget);

        if (arrMatches.length === 0) {
            return { result: ReadLineResult.Processed };
        }

        // 4. Calculate LCP (Longest Common Prefix)
        const strCommon = this.determineCommonPrefix(arrMatches);

        // 5. Auto-fill
        // If LCP is longer than current input (Target), insert the suffix at the cursor
        // e.g., Target="at", Common="atest" -> Insert Suffix="est"
        if (strCommon.length > strTarget.length) {
            const strSuffix = strCommon.slice(strTarget.length);
            // handleInputText handles insertion at cursor and redrawing
            this.handleInputText(strSuffix);
        }

        // 6. If multiple candidates remain (even after LCP fill), list them
        if (arrMatches.length > 1) {
            this.writer.writeString('\r\n' + arrMatches.map(s=>s.substring(s.lastIndexOf("/", s.length-2)+1)).join('  ') + '\r\n');
            
            // Redraw prompt and current buffer (move cursor to the end)
            await this.writer.writeString(this.currentPromptStr + this.strInputBuffer);
            
            // [Critical] Restore cursor to original valCursorPos
            const fullWidth = TerminalUtils.calcStrWidth(this.strInputBuffer);
            const cursorWidth = TerminalUtils.calcStrWidth(this.strInputBuffer.slice(0, this.valCursorPos));
            
            const diff = fullWidth - cursorWidth;
            if (diff > 0) {
                this.writer.writeString('\x1b[D'.repeat(diff));
            }
        }

        return {
            result: ReadLineResult.Processed
        };
    }

    /**
     * [Helper] Find the Longest Common Prefix (LCP) of a string array
     */
    private determineCommonPrefix(arr: string[]): string {
        if (arr.length === 0) return "";
        let prefix = arr[0];
        for (let i = 1; i < arr.length; i++) {
            while (arr[i].indexOf(prefix) !== 0) {
                prefix = prefix.substring(0, prefix.length - 1);
                if (prefix === "") return "";
            }
        }
        return prefix;
    }
}
