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
import { IProcess } from '../../../dev/types/IProcess';

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const writer = proc.stdout!.getStringWriter();
    const reader = proc.stdin!.getStringReader();

    // 1. 入力を取得 (パイプ対応)
    let prompt = '';
    if (args.length > 0) {
        prompt = args.join(' ');
    } else {
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                prompt += value;
            }
        } catch (e) {}
    }

    prompt = prompt.trim();
    if (!prompt) {
        await writer.write('Usage: echo "Message" | gemini\r\n');
        await writer.close();
        return 0;
    }

    // 2. RPAロジック: DOM操作
    try {
        await writer.write('\x1b[33mInjecting prompt into DOM...\x1b[0m\r\n');

        // --- Step A: 入力エリアを探して書き込む ---
        // rich-textarea > div.ql-editor
        const editorSelector = 'rich-textarea .ql-editor';
        const inputArea = document.querySelector(editorSelector) as HTMLElement;

        if (!inputArea) throw new Error(`Input area (${editorSelector}) not found.`);

        // フォーカスしてテキストを入力
        inputArea.focus();
        const pTag = inputArea.querySelector('p');
        if (pTag) {
            pTag.textContent = prompt;
        } else {
            inputArea.textContent = prompt;
        }

        // Angular/Frameworkに入力を検知させる
        inputArea.dispatchEvent(new Event('input', { bubbles: true }));
        inputArea.dispatchEvent(new Event('change', { bubbles: true }));
        
        // UIの更新待ち
        await new Promise(r => setTimeout(r, 500));

        // --- Step B: 送信ボタンを押す ---
        const btnSelector = 'button[aria-label="プロンプトを送信"]';
        const sendBtn = document.querySelector(btnSelector) as HTMLElement;

        if (!sendBtn) throw new Error('Send button not found.');
        if (sendBtn.getAttribute('aria-disabled') === 'true') {
             throw new Error('Send button is disabled. Is Gemini thinking?');
        }

        sendBtn.click();
        await writer.write('\x1b[32mSent! Waiting for response...\x1b[0m\r\n');

        // --- Step C: 回答の完了を待機 ---
        await waitForGeminiResponse();

        // --- Step D: 最新の回答を取得 ---
        const responseText = extractLatestResponse();
        
        // --- Step E: 表示 ---
        const rendered = renderMarkdown(responseText);
        await writer.write('\r\n' + rendered + '\r\n');

    } catch (e: any) {
        await writer.write(`\x1b[31mRPA Error: ${e.message}\x1b[0m\r\n`);
        await writer.close();
        return 1;
    }

    await writer.close();
    return 0;
}

/**
 * Geminiが回答生成を終えるのを待つ
 */
async function waitForGeminiResponse(): Promise<void> {
    return new Promise((resolve) => {
        // 0.5秒ごとにチェック
        const timer = setInterval(() => {
            const btnSelector = 'button[aria-label="プロンプトを送信"]';
            const sendBtn = document.querySelector(btnSelector);

            // 送信ボタンが存在し、かつ aria-disabled が false (or なし) なら完了
            if (sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true') {
                // さらに念のため、テキストが空でないか確認
                const text = extractLatestResponse();
                if (text.length > 0 && !text.includes("Response not found")) {
                    clearInterval(timer);
                    resolve();
                }
            }
        }, 500);
    });
}

/**
 * 最新のモデル回答をDOMから抽出する
 * ✨ 修正ポイント: 提供されたHTML構造に合わせてセレクタを調整
 */
function extractLatestResponse(): string {
    // <message-content> の中にある <div class="markdown"> を探す
    const responseContainers = document.querySelectorAll('message-content .markdown');

    if (responseContainers.length > 0) {
        // 最新のものを取得
        const lastResponse = responseContainers[responseContainers.length - 1] as HTMLElement;
        return lastResponse.innerText;
    }

    return "(Response not found. DOM structure might have changed.)";
}


// --- Markdown Renderer ---

function renderMarkdown(text: string): string {
    const lines = text.split('\n');
    let outLines: string[] = [];
    let inCodeBlock = false;
    let tableBuffer: string[] = [];

    const flushTable = () => {
        if (tableBuffer.length === 0) return;
        outLines.push(renderTable(tableBuffer));
        tableBuffer = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.trim().startsWith('```')) {
            flushTable();
            inCodeBlock = !inCodeBlock;
            outLines.push(`\x1b[36m${line}\x1b[0m`);
            continue;
        }
        if (inCodeBlock) {
            outLines.push(`\x1b[36m${line}\x1b[0m`);
            continue;
        }

        if (line.trim().startsWith('|')) {
            tableBuffer.push(line);
            continue;
        } else {
            flushTable();
        }

        let formatted = line;
        formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '\x1b[1m$1\x1b[0m');
        formatted = formatted.replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[0m');
        formatted = formatted.replace(/^(#{1,6})\s+(.*)$/, (m, h, c) => `\x1b[1;35m${c}\x1b[0m`);
        formatted = formatted.replace(/^(\s*)-\s+(.*)$/, '$1\x1b[32m•\x1b[0m $2');

        outLines.push(formatted);
    }
    flushTable();

    return outLines.join('\n');
}

function renderTable(rows: string[]): string {
    const data = rows.map(row => {
        const content = row.trim().replace(/^\||\|$/g, '');
        return content.split('|').map(cell => cell.trim());
    });

    if (data.length === 0) return '';

    const colWidths: number[] = [];
    data.forEach(row => {
        row.forEach((cell, idx) => {
            const isSeparator = /^[-:]+$/.test(cell);
            const len = isSeparator ? 0 : getStringWidth(cell);
            colWidths[idx] = Math.max(colWidths[idx] || 0, len);
        });
    });

    return data.map((row, rIdx) => {
        const isSeparatorRow = row.every(c => /^[-:]+$/.test(c));
        if (isSeparatorRow) {
            return '  ' + colWidths.map(w => '-'.repeat(w)).join('   ');
        }
        const line = row.map((cell, cIdx) => {
            const width = colWidths[cIdx] || 0;
            return padString(cell, width);
        }).join('   ');
        return '  ' + line; 
    }).filter(l => l.trim().length > 0).join('\n');
}

function getStringWidth(str: string): number {
    let width = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        width += (code > 255) ? 2 : 1;
    }
    return width;
}

function padString(str: string, width: number): string {
    const w = getStringWidth(str);
    const pad = Math.max(0, width - w);
    return str + ' '.repeat(pad);
}