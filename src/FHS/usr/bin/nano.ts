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

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess, TTYMode  } from '../../../dev/types/IProcess';
import { CommandParser } from '../lib/CommandParser';
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils';

// ==========================================
// Constants & Types
// ==========================================

const CTRL_X = 24; 
const CTRL_O = 15;
const CTRL_K = 11;
const CTRL_U = 21;
const CTRL_C = 3; 
const BACKSPACE = 127;
const ESC = 27;

interface Cursor { x: number; y: number; }
interface Viewport { 
    rows: number; 
    cols: number; 
    offsetY: number; // 垂直スクロール
    offsetX: number; // 水平スクロール
}

// ==========================================
// Nano Editor Class
// ==========================================

class Nano {
    private sys: SystemAPI;
    private proc: IProcess;
    private reader: BinaryReader;
    private writer: BinaryWriter;
    
    private inputQueue: string[] = [];

    // State
    private lines: string[] = [""];
    private filename: string = "";
    private isModified: boolean = false;
    private cursor: Cursor = { x: 0, y: 0 };
    private viewport: Viewport = { rows: 24, cols: 80, offsetY: 0, offsetX: 0 }; 
    private message: string = "";
    private cutBuffer: string[] = [];

    constructor(sys: SystemAPI, proc: IProcess) {
        this.sys = sys;
        this.proc = proc;
        this.reader = new BinaryReader(proc.stdin!.getByteReader());
        this.writer = new BinaryWriter(proc.stdout!.getByteWriter());
        
        const envLines = parseInt(proc.env.get('LINES') || "24");
        const envCols = parseInt(proc.env.get('COLUMNS') || "80");
        
        // 画面上下のUI領域 (Title + Status + Help*2) = 4行分を引く
        this.viewport.rows = Math.max(1, envLines - 4);
        this.viewport.cols = envCols;
    }

    /**
     * ✨ [Fix] 入力読み込みの堅牢化
     * UTF-8の断片的なバイト列が来ても、文字として完成するまで待機する
     */
    private async readToken(): Promise<string | null> {
        // キューに既に文字があればそれを返す
        if (this.inputQueue.length > 0) return this.inputQueue.shift()!;
        
        while (true) {
            // ストリームからデータを読む
            const { value, done } = await this.reader.readString();
            if (done) return null;
            
            // valueが空文字の場合（デコーダがバッファリング中など）、次のデータを待つ
            if (value && value.length > 0) {
                const chars = [...value]; // サロゲートペアを考慮して分割
                this.inputQueue.push(...chars);
                break;
            }
        }
        
        return this.inputQueue.shift()!;
    }

    public async init(file?: string) {
        if (file) {
            this.filename = file;
            try {
                const content = await this.proc.fs.readFile(file, 'utf8') as string;
                this.lines = content.split(/\r?\n/);
                if (this.lines.length === 0) this.lines = [""];
            } catch (e) {
                this.message = "New File";
            }
        }
        // Alternate Screen Buffer に切り替え
        await this.writer.writeString('\x1b[?1049h'); 
    }

    public async run(): Promise<number> {
        if (this.proc.stdin?.isTTY) {
            await this.proc.stdin.setMode(TTYMode.Raw);
        }

        await this.render();

        while (true) {
            const char = await this.readToken();
            if (char === null) break;

            const code = char.charCodeAt(0);

            if (code === ESC) {
                await this.handleEscapeSequence();
            } else if (char === '\r' || char === '\n') { 
                this.handleTyping('\n'); 
            } else if (code < 32 && char !== '\t') { 
                const shouldExit = await this.handleControlKey(code);
                if (shouldExit) break;
            } else if (code === BACKSPACE || code === 8) {
                this.handleBackspace();
            } else {
                this.handleTyping(char);
            }

            this.adjustViewport();
            await this.render();
        }

        // 終了処理: 画面クリアして復帰
        await this.writer.writeString('\x1b[?1049l\x1b[?25h');
        if (this.proc.stdin?.isTTY) {
            await this.proc.stdin.setMode(TTYMode.Cooked);
        }
        return 0;
    }

    // --- Input Handling ---

    private async handleEscapeSequence() {
        const v1 = await this.readToken();
        if (v1 !== '[') return; 

        const v2 = await this.readToken();
        if (v2 === null) return;

        switch (v2) {
            case 'A': // Up
                if (this.cursor.y > 0) this.cursor.y--;
                break;
            case 'B': // Down
                if (this.cursor.y < this.lines.length - 1) this.cursor.y++;
                break;
            case 'C': // Right
                if (this.cursor.x < this.lines[this.cursor.y].length) this.cursor.x++;
                else if (this.cursor.y < this.lines.length - 1) {
                    this.cursor.y++;
                    this.cursor.x = 0;
                }
                break;
            case 'D': // Left
                if (this.cursor.x > 0) this.cursor.x--;
                else if (this.cursor.y > 0) {
                    this.cursor.y--;
                    this.cursor.x = this.lines[this.cursor.y].length;
                }
                break;
        }
        const currentLineLen = this.lines[this.cursor.y].length;
        if (this.cursor.x > currentLineLen) this.cursor.x = currentLineLen;
    }

    private async handleControlKey(code: number): Promise<boolean> {
        this.message = "";
        switch (code) {
            case CTRL_X:
                if (this.isModified) {
                    this.message = "Save modified buffer? (Y/N)";
                    await this.render();
                    const val = await this.readToken();
                    if (val === 'y' || val === 'Y') await this.saveFile();
                }
                return true;
            case CTRL_O: await this.saveFile(); break;
            case CTRL_K:
                if (this.lines.length > 0) {
                    const removed = this.lines.splice(this.cursor.y, 1);
                    this.cutBuffer = removed;
                    if (this.lines.length === 0) this.lines = [""];
                    if (this.cursor.y >= this.lines.length) this.cursor.y = this.lines.length - 1;
                    this.isModified = true;
                    this.message = "Cut Line";
                }
                break;
            case CTRL_U:
                if (this.cutBuffer.length > 0) {
                    this.lines.splice(this.cursor.y, 0, ...this.cutBuffer);
                    this.cursor.y += this.cutBuffer.length;
                    this.isModified = true;
                    this.message = "Pasted Line";
                }
                break;
            case CTRL_C:
                this.message = `Line ${this.cursor.y + 1}/${this.lines.length} Col ${this.cursor.x + 1}`;
                break;
        }
        return false;
    }

    private handleBackspace() {
        if (this.cursor.x > 0) {
            const line = this.lines[this.cursor.y];
            this.lines[this.cursor.y] = line.slice(0, this.cursor.x - 1) + line.slice(this.cursor.x);
            this.cursor.x--;
            this.isModified = true;
        } else if (this.cursor.y > 0) {
            const currentLine = this.lines[this.cursor.y];
            const prevLine = this.lines[this.cursor.y - 1];
            this.cursor.x = prevLine.length;
            this.lines[this.cursor.y - 1] = prevLine + currentLine;
            this.lines.splice(this.cursor.y, 1);
            this.cursor.y--;
            this.isModified = true;
        }
    }

    private handleTyping(char: string) {
        const line = this.lines[this.cursor.y];
        
        if (char === '\n') {
            const left = line.slice(0, this.cursor.x);
            const right = line.slice(this.cursor.x);
            this.lines[this.cursor.y] = left;
            this.lines.splice(this.cursor.y + 1, 0, right);
            this.cursor.y++;
            this.cursor.x = 0;
        } else {
            this.lines[this.cursor.y] = line.slice(0, this.cursor.x) + char + line.slice(this.cursor.x);
            this.cursor.x += char.length; 
        }
        this.isModified = true;
    }

    private async saveFile() {
        if (!this.filename) this.filename = "newfile.txt"; 
        try {
            const content = this.lines.join('\n');
            await this.proc.fs.writeFile(this.filename, content);
            this.isModified = false;
            this.message = `Wrote ${this.lines.length} lines to ${this.filename}`;
        } catch (e: any) {
            this.message = `Error writing file: ${e.message}`;
        }
    }

    // 簡易文字幅計算 (全角=2)
    private getCharWidth(char: string): number {
        const code = char.charCodeAt(0);
        if ((code >= 0x00 && code <= 0xff) || (code >= 0xff61 && code <= 0xff9f)) {
            return 1;
        }
        return 2;
    }

    private getStringWidth(str: string): number {
        let width = 0;
        for (const char of str) {
            width += this.getCharWidth(char);
        }
        return width;
    }

    private adjustViewport() {
        if (this.cursor.y < this.viewport.offsetY) {
            this.viewport.offsetY = this.cursor.y;
        } else if (this.cursor.y >= this.viewport.offsetY + this.viewport.rows) {
            this.viewport.offsetY = this.cursor.y - this.viewport.rows + 1;
        }

        if (this.cursor.x < this.viewport.offsetX) {
            this.viewport.offsetX = this.cursor.x;
        }
        
        const line = this.lines[this.cursor.y] || "";
        const strBeforeCursor = line.slice(this.viewport.offsetX, this.cursor.x);
        const visualWidth = this.getStringWidth(strBeforeCursor);
        
        if (visualWidth >= this.viewport.cols) {
            while (this.getStringWidth(line.slice(this.viewport.offsetX, this.cursor.x)) >= this.viewport.cols) {
                this.viewport.offsetX++;
            }
        }
        
        if (this.cursor.x > 0 && this.viewport.offsetX > this.cursor.x) {
             this.viewport.offsetX = this.cursor.x;
        }
    }

    // 🌟 [Fix] 絶対配置レンダリング
    // \r\n で改行するとターミナルが勝手にスクロールしてしまうリスクがあるため、
    // 全ての行を \x1b[y;1H で絶対指定して描画する。
    private async render() {
        let buffer = ""; // バッファリングして一括送信

        // 1. Title Bar (Line 1)
        const title = `  GNU nano 7.2    File: ${this.filename || "New Buffer"}${this.isModified ? " *" : ""}`;
        buffer += `\x1b[1;1H\x1b[7m${title.padEnd(this.viewport.cols)}\x1b[0m`;

        // 2. Content Area (Line 2 ~ rows+1)
        for (let i = 0; i < this.viewport.rows; i++) {
            const lineIdx = this.viewport.offsetY + i;
            const screenRow = i + 2;
            
            // 行頭へ移動 + 行消去
            buffer += `\x1b[${screenRow};1H\x1b[K`;

            if (lineIdx < this.lines.length) {
                let line = this.lines[lineIdx];
                let visibleLine = "";
                
                if (line.length > this.viewport.offsetX) {
                    visibleLine = line.slice(this.viewport.offsetX);
                    
                    let currentWidth = 0;
                    let trimIdx = 0;
                    for (const char of visibleLine) {
                        const w = this.getCharWidth(char);
                        if (currentWidth + w > this.viewport.cols) break;
                        currentWidth += w;
                        trimIdx += char.length;
                    }
                    visibleLine = visibleLine.slice(0, trimIdx);
                }

                if (this.viewport.offsetX > 0 && visibleLine.length > 0) {
                    visibleLine = '$' + visibleLine.substring(1);
                }
                
                if (line.length > this.viewport.offsetX + visibleLine.length) {
                    visibleLine = visibleLine.substring(0, visibleLine.length - 1) + '$';
                }

                buffer += visibleLine;
            } else {
                buffer += '~'; // Empty line marker
            }
        }

        // 3. Status Bar (Line rows+2)
        const statusRow = this.viewport.rows + 2;
        buffer += `\x1b[${statusRow};1H\x1b[K`;
        buffer += `\x1b[7m[ ${this.message.padEnd(this.viewport.cols - 4)} ]\x1b[0m`;

        // 4. Help Area (Line rows+3, rows+4)
        buffer += `\x1b[${statusRow + 1};1H\x1b[K^G Get Help  ^O Write Out  ^K Cut Text   ^J Justify`;
        buffer += `\x1b[${statusRow + 2};1H\x1b[K^X Exit      ^R Read File  ^U Uncut Text ^T To Spell`;

        // 5. Cursor Placement
        const line = this.lines[this.cursor.y] || "";
        const strBeforeCursor = line.slice(this.viewport.offsetX, this.cursor.x);
        const visualX = this.getStringWidth(strBeforeCursor);

        const cursorScreenY = (this.cursor.y - this.viewport.offsetY) + 2; 
        const cursorScreenX = visualX + 1;

        buffer += `\x1b[${cursorScreenY};${cursorScreenX}H`;

        await this.writer.writeString(buffer);
    }
}

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'nano',
        usage: '[options] [[+line[,column]] file]...',
        desc: "Nano's ANOther editor, inspired by Pico",
        options: [
            { short: 'v', long: 'view', desc: 'View mode (read-only)' },
            { long: 'help', desc: 'Display this help and exit' }
        ]
    });

    if (parser.has(undefined, 'help')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        await writer.close();
        return 0;
    }

    const editor = new Nano(sys, proc);
    
    if (parser.args.length > 0) await editor.init(parser.args[0]);
    else await editor.init();

    try {
        return await editor.run();
    } catch (e: any) {
        const writer = new BinaryWriter(proc.stderr!.getByteWriter());
        await writer.writeString(`nano: crashed: ${e.message}\n`);
        return 1;
    }
}