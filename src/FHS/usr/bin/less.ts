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
import { IProcess, TTYMode } from '../../../dev/types/IProcess'; // TTYModeが必要
import { CommandParser } from '../lib/CommandParser';
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils';
import { createFileSourceStream } from '../lib/FileStreamAdapter';

/**
 * [Command: less]
 * テキストファイル閲覧のためのページャー。
 * Nanoの実装を参考に、Rawモードでのキー制御とAlternate Screen Bufferを提供する。
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'less',
        usage: '[FILE]...',
        desc: 'Opposite of more',
        options: [
            { short: 'N', long: 'LINE-NUMBERS', desc: 'Show line numbers' },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    if (parser.has(undefined, 'help')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        await writer.close();
        return 0;
    }

    const targetFiles = parser.args;
    let content = '';
    let filename = '';

    // 1. Load Content
    try {
        if (targetFiles.length > 0) {
            // File Mode
            filename = targetFiles[0];
            const handle = await proc.fs.open(filename, 'r');
            const stream = createFileSourceStream(handle);
            content = await readAll(stream);
        } else {
            // Stdin Mode
            filename = 'Stdin';
            if (!proc.stdin) throw new Error('Stdin not available');
            const reader = proc.stdin.getByteReader();
            content = await readAllFromReader(reader);
        }
    } catch (e: any) {
        const err = new BinaryWriter(proc.stderr!.getByteWriter());
        await err.writeString(`less: ${e.message}\n`);
        await err.close();
        return 1;
    }

    // 2. Start Viewer (Raw Mode Control)
    const viewer = new LessViewer(proc, content, filename, parser.has('N'));
    
    // 🌟 重要: Rawモードへ切り替え (nanoと同様)
    if (proc.stdin && proc.stdin.setMode) {
        await proc.stdin.setMode(TTYMode.Raw);
    }

    try {
        await viewer.start();
    } finally {
        // 🌟 重要: Cookedモードへ復帰 (これを忘れるとシェルが壊れる)
        if (proc.stdin && proc.stdin.setMode) {
            await proc.stdin.setMode(TTYMode.Cooked);
        }
    }

    return 0;
}

// --- Helpers ---

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    return readAllFromReader(reader);
}

async function readAllFromReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    let result = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            result += decoder.decode(value, { stream: true });
        }
        result += decoder.decode(); // flush
    } finally {
        reader.releaseLock();
    }
    return result;
}

// --- Viewer Class ---

class LessViewer {
    private lines: string[];
    private topRow: number = 0;
    private colOffset: number = 0;
    private rows: number = 24;
    private cols: number = 80;
    
    private writer: BinaryWriter;
    private reader: BinaryReader;
    
    private message: string = '';
    private searchPattern: string = '';
    
    private showLineNumbers: boolean;

    constructor(private proc: IProcess, content: string, private filename: string, showLineNumbers: boolean) {
        this.lines = content.replace(/\r\n/g, '\n').split('\n');
        this.writer = new BinaryWriter(proc.stdout!.getByteWriter());
        this.reader = new BinaryReader(proc.stdin!.getByteReader());
        this.showLineNumbers = showLineNumbers;

        // 環境変数からサイズ取得
        this.rows = parseInt(proc.env.get('LINES') || '24');
        this.cols = parseInt(proc.env.get('COLUMNS') || '80');
    }

    public async start() {
        // Alternate Screen Buffer ON & Cursor Hide & Home
        await this.writeRaw('\x1b[?1049h\x1b[?25l\x1b[H');

        try {
            await this.render();
            await this.inputLoop();
        } finally {
            // Cleanup: Cursor Show & Alt Buffer OFF
            await this.writeRaw('\x1b[?25h\x1b[?1049l');
            await this.writer.close();
            this.reader.releaseLock();
        }
    }

    private async writeRaw(str: string) {
        await this.writer.writeString(str);
    }

    private async render() {
        // 画面クリアは Alt Buffer 切替直後やスクロール時に行うが、
        // ちらつき防止のため全消去ではなく行ごとの上書きを基本とする。
        // ただし簡易実装として毎回クリアする
        await this.writeRaw('\x1b[2J\x1b[H');

        const maxDigit = this.lines.length.toString().length;
        const gutterWidth = this.showLineNumbers ? maxDigit + 2 : 0;
        const contentWidth = this.cols - gutterWidth;

        // Draw Lines
        // ステータスライン用に1行空ける
        for (let i = 0; i < this.rows - 1; i++) {
            const lineIdx = this.topRow + i;
            await this.writeRaw(`\x1b[${i + 1};1H`); // Move cursor

            if (lineIdx < this.lines.length) {
                let line = this.lines[lineIdx];
                
                // 行番号
                if (this.showLineNumbers) {
                    const numStr = (lineIdx + 1).toString().padStart(maxDigit, ' ');
                    await this.writeRaw(`\x1b[33m${numStr}  \x1b[39m`);
                }

                // 横スクロール
                if (line.length > this.colOffset) {
                    line = line.slice(this.colOffset);
                } else {
                    line = '';
                }
                
                // 幅制限
                if (line.length > contentWidth) {
                    line = line.slice(0, contentWidth);
                }

                // 検索ハイライト
                if (this.searchPattern && line.includes(this.searchPattern)) {
                    const parts = line.split(this.searchPattern);
                    const highlighted = parts.join(`\x1b[7m${this.searchPattern}\x1b[27m`);
                    await this.writeRaw(highlighted);
                } else {
                    await this.writeRaw(line);
                }

            } else {
                // End of file marker (~)
                await this.writeRaw('\x1b[34m~\x1b[39m');
            }
        }

        // Status Line (Bottom)
        await this.writeRaw(`\x1b[${this.rows};1H\x1b[7m`); // Inverse
        if (this.message) {
            await this.writeRaw(this.message.padEnd(this.cols, ' '));
            this.message = ''; 
        } else {
            const pct = Math.floor(((this.topRow + this.rows - 1) / this.lines.length) * 100);
            const status = `${this.filename} ${this.topRow + 1}/${this.lines.length} lines (${pct}%) ${this.searchPattern ? `/${this.searchPattern}` : ''}`;
            await this.writeRaw(status.padEnd(this.cols, ' '));
        }
        await this.writeRaw('\x1b[27m'); // Reset
    }

    private async inputLoop() {
        while (true) {
            // Raw Mode なので1バイトずつ即座に来る
            const key = await this.readKey();

            if (key === 'q' || key === 'Q') return;

            // Navigation
            switch (key) {
                case 'j':
                case '\r': 
                case '\n':
                case 'ArrowDown':
                    this.scroll(1);
                    break;
                case 'k':
                case 'ArrowUp':
                    this.scroll(-1);
                    break;
                case ' ':
                case 'f':
                case 'PageDown':
                    this.scrollPage(1);
                    break;
                case 'b':
                case 'PageUp':
                    this.scrollPage(-1);
                    break;
                case 'd':
                    this.scroll(Math.floor(this.rows / 2));
                    break;
                case 'u':
                    this.scroll(-Math.floor(this.rows / 2));
                    break;
                case 'g':
                case 'Home':
                    this.scrollTo(0);
                    break;
                case 'G':
                case 'End':
                    this.scrollTo(this.lines.length - (this.rows - 1));
                    break;
                case 'ArrowRight':
                    this.hScroll(1);
                    break;
                case 'ArrowLeft':
                    this.hScroll(-1);
                    break;
                
                case '/': // Search Mode
                    await this.promptSearch();
                    break;
                case 'n': // Next
                    this.findNext(1);
                    break;
                case 'N': // Prev
                    this.findNext(-1);
                    break;
            }
            await this.render();
        }
    }

    // --- Search Logic ---

    private async promptSearch() {
        let pattern = '';
        
        // 簡易行編集モードに入る
        while (true) {
            // ステータス行に入力欄を表示
            await this.writeRaw(`\x1b[${this.rows};1H\x1b[K/${pattern}`);
            
            const key = await this.readKey();
            
            if (key === '\r' || key === '\n') {
                break;
            } else if (key === 'Backspace' || key === '\x7f') {
                pattern = pattern.slice(0, -1);
            } else if (key === 'Escape') {
                pattern = ''; // Cancel
                break;
            } else if (key.length === 1) {
                pattern += key;
            }
        }

        if (pattern) {
            this.searchPattern = pattern;
            this.findNext(1);
        }
    }

    private findNext(dir: number) {
        if (!this.searchPattern) {
            this.message = 'No search pattern';
            return;
        }
        
        let start = this.topRow + dir;
        // 範囲外ならラップアラウンドさせてもいいが、今回は単純に止める
        if (start < 0) start = 0;
        if (start >= this.lines.length) start = this.lines.length - 1;

        let found = -1;
        if (dir > 0) {
            for (let i = start; i < this.lines.length; i++) {
                if (this.lines[i].includes(this.searchPattern)) {
                    found = i;
                    break;
                }
            }
        } else {
            for (let i = start; i >= 0; i--) {
                if (this.lines[i].includes(this.searchPattern)) {
                    found = i;
                    break;
                }
            }
        }

        if (found !== -1) {
            this.topRow = found;
        } else {
            this.message = 'Pattern not found';
        }
    }


    // --- Core Logic ---
    private scroll(delta: number) {
        this.topRow += delta;
        this.clamp();
    }
    private scrollPage(dir: number) {
        this.topRow += dir * (this.rows - 1);
        this.clamp();
    }
    private hScroll(delta: number) {
        this.colOffset += delta;
        if (this.colOffset < 0) this.colOffset = 0;
    }
    private scrollTo(y: number) {
        this.topRow = y;
        this.clamp();
    }
    private clamp() {
        if (this.topRow < 0) this.topRow = 0;
        const max = Math.max(0, this.lines.length - (this.rows - 1));
        if (this.topRow > max) this.topRow = max;
    }

    // --- Key Reader (Nano Style) ---
    private async readKey(): Promise<string> {
        const { value, done } = await this.reader.read();
        if (done) return 'q';
        
        // 1バイトだけとは限らないが、エスケープシーケンス判定のため先頭を見る
        // WebStreamsからの入力はチャンクになっている可能性がある
        // 簡易実装として、チャンクの先頭バイトで判断し、足りなければ追加で読む
        
        const u8 = value;
        if (u8.length === 0) return '';
        
        const charCode = u8[0];

        if (charCode === 27) { // ESC
            if (u8.length === 1) {
                // 単独のESCキーかもしれないし、シーケンスの途中かもしれない
                // 本当はタイムアウト判定が必要だが、ここでは「次にすぐデータが来る」と仮定して読む
                // (readKeyFromStreamで1文字ずつ読む設計の方が安全だが、今回はチャンクを信じる)
                
                // Note: read() はロックするので、非同期で待つのは難しい。
                // Nano.ts を参考に、ここだけはブロックして追加読み込みする
                const next = await this.reader.read(); // wait next
                if (next.done || !next.value) return 'Escape';
                const seq = next.value;
                return this.parseEscape(seq);
            } else {
                // 同じチャンクに入っている場合
                return this.parseEscape(u8.subarray(1));
            }
        }

        if (charCode === 127 || charCode === 8) return 'Backspace';
        if (charCode === 13) return '\r';
        if (charCode === 10) return '\n';

        return new TextDecoder().decode(u8);
    }

    private parseEscape(seq: Uint8Array): string {
        const char = String.fromCharCode(seq[0]);
        if (char === '[') {
            const cmd = String.fromCharCode(seq[1]);
            switch (cmd) {
                case 'A': return 'ArrowUp';
                case 'B': return 'ArrowDown';
                case 'C': return 'ArrowRight';
                case 'D': return 'ArrowLeft';
                case 'H': return 'Home';
                case 'F': return 'End';
                case '5': return 'PageUp'; // ~ は省略
                case '6': return 'PageDown';
            }
        }
        return 'Escape'; // Unhandled
    }
}