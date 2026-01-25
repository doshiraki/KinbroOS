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

// 補完関数の型定義
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
 * xterm.js をラップし、Web Streams API 準拠の入出力インターフェースを提供する。
 * 既存の編集機能(矢印キー、履歴、補完)を維持するため、Line Discipline(行編集)はここで行う。
 */
export class ReadLine {
    private proc: IProcess;      // ShellではなくProcessを持つ
    private fnCompleter: Completer; // 補完ロジックは注入される

    // Line Buffering State
    private strInputBuffer: string = '';
    private valCursorPos: number = 0; // バッファ内の論理カーソル位置
    
    // ✨ ラッパー型を使用
    private reader: BinaryReader;
    private writer: BinaryWriter;

    // ✨ 追加: 履歴管理用
    private history: string[] = [];
    private historyIndex: number = 0;
    private currentPromptStr: string = ''; // 画面クリア用にプロンプトを覚えておく

    // ✨ 追加: 入力中の一時保存用
    private currentInputStash: string = '';
    
    /**
     * @param objShellHelper Tab補完計算用のシェルインスタンス
     */
    constructor(proc: IProcess, completer: Completer) {
        this.proc = proc;
        this.fnCompleter = completer;        // ラッパーで包む
        this.reader = new BinaryReader(proc.stdin!.getByteReader());
        this.writer = new BinaryWriter(proc.stdout!.getByteWriter());
    }

    /**
     * 🛡️ 使い捨てシールドを作成
     * 毎回新しい WritableStream を作ることで、kibsh がそれを close しても
     * this.writer (本物) は影響を受けない。
     */
    public getBinaryWriter(): BinaryWriter {
        const shieldStream = new WritableStream<Uint8Array>({
            write: (chunk) => {
                // 本物に流す
                return this.writer.write(chunk);
            },
            close: () => {
                // kibsh が「終わった！」と言ってきても、本物は閉じない。
                // この shieldStream 自体は閉じることになるが、それは使い捨てなのでOK。
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

    // ✨ 単発読み込みメソッド
    public async read(promptStr: string = '$ '): Promise<ReadLineResultType> {
        // 1. Rawモードへ
        if (this.proc.stdin?.isTTY) {
            await this.proc.stdin.setMode(TTYMode.Raw);
        }

        try {
            this.currentPromptStr = promptStr; // ✨ 覚える
            await this.writer.writeString(promptStr);
            this.strInputBuffer = ''; 
            this.valCursorPos = 0;

            this.currentInputStash = ''; // ✨ クリア

            // ✨ 追加: 読み込み開始時は常に「最新(履歴の末尾)」にインデックスを合わせる
            this.historyIndex = this.history.length;
            
            while (true) {
                const { value, done } = await this.reader.readString();
                if (done) return {
                    result: ReadLineResult.EOF,
                    isEOF: true
                };

                // Enterが押されたらループを抜けて返す
                const result = await this.handleRawInput(value); 
                if (result.result != ReadLineResult.Processed) {
                    return result;
                }
            }

        } finally {
            // 2. Cookedモードへ戻す
            if (this.proc.stdin?.isTTY) {
                await this.proc.stdin.setMode(TTYMode.Cooked);
            }
        }
    }

    // --- Input Handling Logic (Existing Logic Preserved) ---

    private async handleRawInput(strData: string): Promise<ReadLineResultType> {
        // 特殊キーの判定
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
                // 制御文字以外なら入力として扱う
                if (strData.length >= 1 && strData.charCodeAt(0) >= 32) {
                    return this.handleInputText(strData);
                }
        }
        return {
            result: ReadLineResult.Processed
        };
    }

    private handleInputText(strText: string): ReadLineResultType {
        // 挿入モードの実装
        const strPre = this.strInputBuffer.slice(0, this.valCursorPos);
        const strPost = this.strInputBuffer.slice(this.valCursorPos);
        
        this.strInputBuffer = strPre + strText + strPost;
        this.valCursorPos += strText.length;
        
        // 画面更新: カーソル以降を再描画
        this.writer.writeString(strText + strPost);
        
        // カーソルを戻す
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

            // 1. 削除する文字の幅分だけ戻る
            this.writer.writeString('\x1b[D'.repeat(prev.width));
            
            // 2. 残りの文字列(Tail)で上書きする
            this.writer.writeString(strTail);
            
            // 3. 末尾のゴミを消す
            this.writer.writeString(' '.repeat(prev.width));
            
            // 4. カーソルを本来の位置に戻す
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
                    // 論理カーソル: データ長分戻る (絵文字なら2)
                    this.valCursorPos -= prev.length;
                    // 見た目のカーソル: 幅分戻る (絵文字なら1)
                    this.writer.writeString('\x1b[D'.repeat(prev.width)); 
                }
                break;

            case 'right': // Right Arrow
                const next = TerminalUtils.calcNextGraphemeInfo(this.strInputBuffer, this.valCursorPos);
                if (next) {
                    // 論理カーソル: データ長分進む (絵文字なら2)
                    this.valCursorPos += next.length;
                    // 見た目のカーソル: 幅分進む (絵文字なら1)
                    this.writer.writeString('\x1b[C'.repeat(next.width));
                }
                break;
        }
        return {
            result: ReadLineResult.Processed
        };
    }

    /**
         * ✨ 履歴操作ハンドラ
         */
    private handleHistory(dir: 'up' | 'down'): ReadLineResultType {
        if (dir === 'up') {
            if (this.historyIndex > 0) {
                // ✨ 探索開始時(最新位置にいる時)に、現在の入力を退避する
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
                    // ✨ 最新に戻ったら、退避していた内容を復元する
                    this.replaceInputBuffer(this.currentInputStash);
                } else {
                    this.replaceInputBuffer(this.history[this.historyIndex]);
                }
            }
        }
        return { result: ReadLineResult.Processed };
    }

    /**
     * ✨ 画面上の現在の入力を消去し、新しい文字列に置き換える
     */
    private replaceInputBuffer(newStr: string) {
        // 1. カーソルを現在の入力の先頭(プロンプトの直後)まで戻す
        // 現在のカーソル位置(valCursorPos)から逆算して左へ移動
        // (本来はTerminalUtilsで正確な表示幅を計算すべきだが、簡易的に文字数分戻る)
        // ※ 絵文字などが入るとズレる可能性があるが、今回は簡易実装で行く
        const currentWidth = TerminalUtils.calcStrWidth(this.strInputBuffer.slice(0, this.valCursorPos));
        if (currentWidth > 0) {
            this.writer.writeString('\x1b[D'.repeat(currentWidth));
        }

        // 2. 現在の行を空白で塗りつぶして消す
        // (入力されている文字列の全幅分スペースを書く)
        const fullWidth = TerminalUtils.calcStrWidth(this.strInputBuffer);
        this.writer.writeString(' '.repeat(fullWidth));

        // 3. 再びカーソルを先頭に戻す (スペースを書いた分進んでしまっているため)
        this.writer.writeString('\x1b[D'.repeat(fullWidth));

        // 4. 新しい文字列で内部バッファを更新
        this.strInputBuffer = newStr;
        this.valCursorPos = newStr.length; // カーソルは末尾へ

        // 5. 新しい文字列を描画
        this.writer.writeString(newStr);
    }

    private handleEnter(): ReadLineResultType {
        this.writer.writeString('\r\n'); // 改行表示
        
        const strCommand = this.strInputBuffer;
        const strTrimed = strCommand.trim();

        // 履歴保存は入力がある時だけ
        if (strTrimed.length > 0) {
            // 直前のコマンドと同じなら保存しない、というロジックを入れると綺麗
            if (this.history.length === 0 || this.history[this.history.length - 1] !== strTrimed) {
                this.history.push(strTrimed);
            }
        }

        // バッファリセット
        this.strInputBuffer = '';
        this.valCursorPos = 0;

        // ✨ 修正: 空入力でも「コマンド完了」として返す
        // これにより read() ループを脱出し、呼び出し元(kibsh)がループしてプロンプトを再表示できる
        return {
            result: ReadLineResult.command,
            payload: {
                command: strTrimed // 空文字でもOK (kibsh側で無視される)
            }
        };
    }

    /**
     * Tab補完: カーソル位置考慮 & LCP対応版
     */
    private async handleTabCompletion(): Promise<ReadLineResultType> {
        // 1. カーソル位置までの文字列を取得
        const strUpToCursor = this.strInputBuffer.slice(0, this.valCursorPos);

        // 2. カーソル直前の単語を抽出 (簡易的にスペース区切り)
        // "git comm|it" の場合、"git comm" -> "comm" を抽出
        const lastSpaceIdx = strUpToCursor.lastIndexOf(' ');
        const strTarget = strUpToCursor.slice(lastSpaceIdx + 1);

        // 3. 補完候補取得 (ターゲットとなる単語のみを渡す)
        const arrMatches = await this.fnCompleter(strTarget);

        if (arrMatches.length === 0) {
            return { result: ReadLineResult.Processed };
        }

        // 4. LCP (最長共通接頭辞) の計算
        const strCommon = this.determineCommonPrefix(arrMatches);

        // 5. 自動入力
        // LCPが現在の入力(Target)より長ければ、その差分をカーソル位置に挿入する
        // 例: Target="at", Common="atest" -> Suffix="est" を挿入
        if (strCommon.length > strTarget.length) {
            const strSuffix = strCommon.slice(strTarget.length);
            // handleInputText はカーソル位置への挿入と再描画を行う既存メソッド
            this.handleInputText(strSuffix);
        }

        // 6. 候補が複数ある場合 (またはLCP補完後もまだ候補が残る場合) は一覧表示
        if (arrMatches.length > 1) {
            this.writer.writeString('\r\n' + arrMatches.join('  ') + '\r\n');
            
            // プロンプトと現在のバッファ内容を再描画 (カーソルは行末へ)
            await this.writer.writeString(this.currentPromptStr + this.strInputBuffer);
            
            // 🌟 重要: カーソル位置を元の位置(valCursorPos)に戻す
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
     * [Helper] 文字列配列の最長共通接頭辞を求める
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