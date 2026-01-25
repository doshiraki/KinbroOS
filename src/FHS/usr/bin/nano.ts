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
// nano.ts の冒頭
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
    offsetX: number; // 🌟 新規: 水平スクロール
}

// ==========================================
// Nano Editor Class
// ==========================================

class Nano {
    private sys: SystemAPI;
    private proc: IProcess;
    private reader: BinaryReader;
    private writer: BinaryWriter;
    
    private inputQueue: number[] = [];

    // State
    private lines: string[] = [""];
    private filename: string = "";
    private isModified: boolean = false;
    private cursor: Cursor = { x: 0, y: 0 };
    private viewport: Viewport = { rows: 24, cols: 80, offsetY: 0, offsetX: 0 }; // 初期化
    private message: string = "";
    private cutBuffer: string[] = [];

    constructor(sys: SystemAPI, proc: IProcess) {
        this.sys = sys;
        this.proc = proc;
        this.reader = new BinaryReader(proc.stdin!.getByteReader());
        this.writer = new BinaryWriter(proc.stdout!.getByteWriter());
        
        const envLines = parseInt(proc.env.get('LINES') || "24");
        const envCols = parseInt(proc.env.get('COLUMNS') || "80");
        this.viewport.rows = envLines - 4;
        this.viewport.cols = envCols;
    }

    private async readByte(): Promise<number | null> {
        if (this.inputQueue.length > 0) return this.inputQueue.shift()!;
        const { value, done } = await this.reader.read();
        if (done || !value) return null;
        for (let i = 0; i < value.length; i++) this.inputQueue.push(value[i]);
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
        await this.writer.writeString('\x1b[?1049h\x1b[H'); 
    }

    public async run(): Promise<number> {
        // 🌟 【修正】インタラクティブな操作のために Raw Mode へ移行
        if (this.proc.stdin?.isTTY) {
            await this.proc.stdin.setMode(TTYMode.Raw);
        }

        await this.render();

        while (true) {
            const charCode = await this.readByte();
            if (charCode === null) break;

            if (charCode === ESC) {
                await this.handleEscapeSequence();
            } else if (charCode === 13 || charCode === 10) { 
                this.handleTyping(13); 
            } else if (charCode < 32) {
                const shouldExit = await this.handleControlKey(charCode);
                if (shouldExit) break;
            } else if (charCode === BACKSPACE) {
                this.handleBackspace();
            } else {
                this.handleTyping(charCode);
            }

            this.adjustViewport();
            await this.render();
        }

        await this.writer.writeString('\x1b[?1049l\x1b[?25h');
        // 🌟 【修正】終了時に Cooked Mode へ戻す（またはシェルに任せる）
        if (this.proc.stdin?.isTTY) {
            await this.proc.stdin.setMode(TTYMode.Cooked);
        }
        return 0;
    }

    // --- Input Handling ---

    private async handleEscapeSequence() {
        const v1 = await this.readByte();
        if (v1 !== 91) return; 

        const v2 = await this.readByte();
        if (v2 === null) return;

        switch (v2) {
            case 65: // Up
                if (this.cursor.y > 0) this.cursor.y--;
                break;
            case 66: // Down
                if (this.cursor.y < this.lines.length - 1) this.cursor.y++;
                break;
            case 67: // Right
                if (this.cursor.x < this.lines[this.cursor.y].length) this.cursor.x++;
                else if (this.cursor.y < this.lines.length - 1) {
                    this.cursor.y++;
                    this.cursor.x = 0;
                }
                break;
            case 68: // Left
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
                    const val = await this.readByte();
                    if (val === 89 || val === 121) await this.saveFile();
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

    private handleTyping(code: number) {
        const char = (code === 13) ? '\n' : String.fromCharCode(code);
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
            this.cursor.x++;
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

    // 🌟 Viewport調整 (水平スクロール対応)
    private adjustViewport() {
        // Vertical
        if (this.cursor.y < this.viewport.offsetY) {
            this.viewport.offsetY = this.cursor.y;
        } else if (this.cursor.y >= this.viewport.offsetY + this.viewport.rows) {
            this.viewport.offsetY = this.cursor.y - this.viewport.rows + 1;
        }

        // Horizontal
        // カーソルが左端より左に行ったら追従
        if (this.cursor.x < this.viewport.offsetX) {
            this.viewport.offsetX = this.cursor.x;
        } 
        // カーソルが右端を超えたら追従
        else if (this.cursor.x >= this.viewport.offsetX + this.viewport.cols) {
            this.viewport.offsetX = this.cursor.x - this.viewport.cols + 1;
        }
    }

    // 🌟 描画ロジック (水平スクロール対応)
    private async render() {
        let buffer = '\x1b[H'; 
        const title = `  GNU nano 7.2    File: ${this.filename || "New Buffer"}${this.isModified ? " *" : ""}`;
        buffer += `\x1b[7m${title.padEnd(this.viewport.cols)}\x1b[0m\r\n`;

        for (let i = 0; i < this.viewport.rows; i++) {
            const lineIdx = this.viewport.offsetY + i;
            if (lineIdx < this.lines.length) {
                let line = this.lines[lineIdx];
                
                // 🌟 表示範囲の切り出し
                let visibleLine = "";
                
                // 行が現在の表示開始位置(offsetX)より長い場合のみ表示
                if (line.length > this.viewport.offsetX) {
                    visibleLine = line.substring(this.viewport.offsetX, this.viewport.offsetX + this.viewport.cols);
                }

                // 左端に続きがある場合 '$'
                if (this.viewport.offsetX > 0 && visibleLine.length > 0) {
                    visibleLine = '$' + visibleLine.substring(1);
                }
                
                // 右端に続きがある場合 '$'
                if (line.length > this.viewport.offsetX + this.viewport.cols) {
                    visibleLine = visibleLine.substring(0, visibleLine.length - 1) + '$';
                }

                buffer += visibleLine + '\x1b[K\r\n'; 
            } else {
                buffer += '~\x1b[K\r\n'; 
            }
        }

        buffer += `\x1b[7m[ ${this.message.padEnd(this.viewport.cols - 4)} ]\x1b[0m\r\n`;
        buffer += `^G Get Help  ^O Write Out  ^K Cut Text   ^J Justify\r\n`;
        buffer += `^X Exit      ^R Read File  ^U Uncut Text ^T To Spell`;

        // 🌟 カーソル位置の計算 (オフセットを考慮)
        const cursorScreenY = (this.cursor.y - this.viewport.offsetY) + 2; 
        const cursorScreenX = (this.cursor.x - this.viewport.offsetX) + 1;
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