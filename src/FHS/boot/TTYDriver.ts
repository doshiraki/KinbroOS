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
     * ✨ [Revised] 本格的な Line Discipline 実装
     * 制御文字の可視化と適切なバックスペース処理を行う
     */
    private async handleCookedInput(char: string) {
        const code = char.charCodeAt(0);

        // 1. Signal Handling (ISIG)
        // Ctrl+C (ETX)
        if (code === 0x03) { 
            await this.echoString('^C\r\n');
            
            // Kernelへの通知 (論理削除)
            if (this.onSignal) this.onSignal(this.pgidForeground, 2); 

            // 🌟 追加: ストリームへの通知 (物理切断)
            // これをやらないと、read() で待ってるプロセスが永遠に起きない！
            const controller = this.mapPgidToCtl.get(this.pgidForeground);
            if (controller) {
                try {
                    // "Interrupted System Call" 相当のエラーを投げる
                    controller.error(new Error("Interrupted"));
                } catch(e) {}
                
                // マップから削除 (ストリームはもう使えない)
                this.mapPgidToCtl.delete(this.pgidForeground);
            }

            this.lineBuffer = '';
            return;
        }
        // 🌟 追加: Ctrl+Z (0x1A) - Job Suspend
        else if (code === 0x1a) {
            await this.echoString('^Z\r\n');

            // Kernelへ通知 (SIGTSTP = 20)
            if (this.onSignal) this.onSignal(this.pgidForeground, 20);

            // ストリームへの通知は... しない！
            // なぜなら、プロセスを「エラー終了」させたいわけではなく、
            // 「入力待ちのまま凍結」させたいからだ。
            // 物理的な切断はせず、単にシェルに制御を戻すきっかけを作る。
            
            this.lineBuffer = '';
            return;
        }
        // 🌟 追加実装: Ctrl+D (EOT) - EOF Handling
        else if (code === 0x04) {
            console.log(`[TTY:Cooked] Ctrl+D detected. BufferLen:${this.lineBuffer.length} FG:${this.pgidForeground}`);
            // ケースA: 入力途中の文字があるなら、それを確定させる (Flush)
            if (this.lineBuffer.length > 0) {
                this.emitToForeground(this.lineBuffer);
                this.lineBuffer = '';
            } 
            // ケースB: 入力が空なら、EOFとしてストリームを閉じる
            else {
                const controller = this.mapPgidToCtl.get(this.pgidForeground);
                if (controller) {
                    try {
                        // ストリームを正常に閉じる
                        controller.close();
                    } catch(e) {}
                    
                    // マップから削除 (このPGID用の入力チャネルは消滅)
                    this.mapPgidToCtl.delete(this.pgidForeground);
                }
            }
            return; 
        }

        // 2. Editing (BackSpace / DEL)
        else if (code === 0x7f || code === 0x08) { 
            if (this.lineBuffer.length > 0) {
                 // 消去する文字を取得
                 const charToDelete = this.lineBuffer.slice(-1);
                 this.lineBuffer = this.lineBuffer.slice(0, -1);
                 
                 // 画面上の消去処理
                 // 削除する文字が制御文字だった場合、画面上では "^A" のように2文字使っている
                 // なので2文字分消す必要がある。
                 const eraseWidth = this.calcDisplayWidth(charToDelete);
                 await this.echoBackspace(eraseWidth);
            }
            return;
        }

        // 3. Normal Processing
        // Enter (\r)
        if (char === '\r' || char === '\n') { // 両対応
             await this.echoString('\r\n');
             this.lineBuffer += '\n'; // アプリには \n で渡すのが一般的
             this.emitToForeground(this.lineBuffer);
             this.lineBuffer = '';
             return;
        }
        
        // 4. Echo Back with Caret Notation
        if (code < 32) {
             // 制御文字 (\t, \n 以外) は ^X 表記でエコーする
             if (char === '\t' || char === '\n') {
                 await this.echoString(char);
                 this.lineBuffer += char;
             } else {
                 // 例: \x01 (Ctrl+A) -> '^' + 'A'
                 const caret = '^' + String.fromCharCode(code + 64);
                 await this.echoString(caret);
                 this.lineBuffer += char; 
             }
        } else {
             // 通常文字
             await this.echoString(char);
             this.lineBuffer += char;
        }
    }

    /**
     * [Helper] 指定した幅だけバックスペース処理を行う
     * カーソルを戻し、空白で上書きし、再度戻す
     */
    private async echoBackspace(width: number) {
        if (!this.writerEcho) return;
        // 例: width=2 なら "\b\b  \b\b"
        const bs = '\b'.repeat(width);
        const space = ' '.repeat(width);
        const seq = bs + space + bs;
        await this.writerEcho.write(this.encoder.encode(seq));
    }

    /**
     * [Helper] 文字列をエコーバック
     */
    private async echoString(str: string) {
        if (this.writerEcho) {
            await this.writerEcho.write(this.encoder.encode(str));
        }
    }

    /**
     * [Helper] 文字が画面上で何文字幅を使うか計算
     */
    private calcDisplayWidth(char: string): number {
        const code = char.charCodeAt(0);
        if (code < 32) {
            if (char === '\t') return 1; // 本当はタブ位置計算が必要だが簡易的に1
            if (char === '\n') return 0; // 改行は幅なし
            return 2; // ^A などは2文字
        }
        // 本来は全角半角判定(wcwidth)が必要だが、今回は1文字=1幅とする
        return 1;
    }

    private emitToForeground(data: string) {
// 🕵️‍♀️ [Debug Log] 入力データの送信先
        // dataが制御文字ならコード表示、それ以外なら文字そのものを表示
        const debugData = data.length === 1 ? `Code:${data.charCodeAt(0)}` : `"${data.replace(/\n/g, '\\n')}"`;
        console.log(`[TTY:Input] Sending ${debugData} -> PGID:${this.pgidForeground}`);

        const controller = this.mapPgidToCtl.get(this.pgidForeground);
        if (controller) {
            try { controller.enqueue(data); } catch (e) {}
        } else {
            // 🕵️‍♀️ [Debug Log] 送り先不在！
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