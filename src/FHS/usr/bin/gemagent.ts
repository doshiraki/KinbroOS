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

// src/FHS/usr/bin/gemagent.ts

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { Kibsh } from './kibsh';
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils';

/**
 * [Stable Recursive Integrated Edition] GemAgent
 * Integrates stable block extraction and recursive command expansion.
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const writer = proc.stdout!.getStringWriter();
    const reader = proc.stdin!.getStringReader();

    let userPrompt = '';
    if (args.length > 0) {
        userPrompt = args.join(' ');
    } else {
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                userPrompt += value;
            }
        } catch (e) {}
    }
    userPrompt = userPrompt.trim();

    if (!userPrompt) {
        await writer.write('Usage: gemagent "Task"\r\n');
        await writer.close();
        return 0;
    }

    const SYSTEM_INSTRUCTION = `
(System Note: コマンドを実行する際は、必ず以下のフォーマットを厳守してください。
[To KinbroOS]
\`\`\`bash
$ command 1
$ command 2
$ . /topath/file.sh
\`\`\`
※ . のソースコマンドはgemagentがファイルを読み込んで展開する。
※ kibshの再帰呼出しは未サポート。
※ ツール一式は/usr/binにおいてある。
※ 環境変数やワイルドカードのシェル展開は未サポート。
※ 必ずコードブロックを使用し、1行につき1つのコマンドを書いてください。)`;

    let currentInput = `${userPrompt}\n\n${SYSTEM_INSTRUCTION}`;
    const MAX_LOOPS = 100;

    try {
        await writer.write(`\x1b[1;36m[Agent] Task: "${userPrompt}"\x1b[0m\r\n`);

        for (let i = 0; i < MAX_LOOPS; i++) {
            await writer.write('\x1b[33mThinking...\x1b[0m\r');
            const responseText = await interactWithGemini(currentInput);
            await writer.write('\x1b[2K\r'); 

            // [Logic] Use recommended stable logic
            const cmdBlock = extractCommandBlock(responseText);

            if (!cmdBlock || cmdBlock.commands.length === 0) {
                const rendered = renderMarkdown(responseText);
                await writer.write('\r\n' + rendered + '\r\n');
                break; 
            }

            const thoughtText = responseText.substring(0, responseText.indexOf(cmdBlock.fullMatch)).trim();
            if (thoughtText) {
                await writer.write(`\x1b[2m${renderMarkdown(thoughtText)}\x1b[0m\r\n`);
            }
            await writer.write(`\x1b[1;35m[Agent] Executing Commands...\x1b[0m\r\n`);

            // [Engine] Execution engine (supports recursion and comments)
            const resultText = await executeCommandsRealtime(cmdBlock.commands, sys, proc, writer);

            currentInput = formatResultBlock(resultText);
        }

    } catch (e: any) {
        await writer.write(`\x1b[1;31mError: ${e.message}\x1b[0m\r\n`);
        return 1;
    } finally {
        await writer.close();
    }

    return 0;
}

// [Regex] Assumes $ has been removed from the queue
const RE_COMMENT = /^\s*#/;           
const RE_SOURCE  = /^\s*\.\s+/;       

/**
 * [Logic] Command execution engine (recursive preprocessor)
 */
async function executeCommandsRealtime(commands: string[], sys: SystemAPI, parentProc: IProcess, terminalWriter: any): Promise<string> {
    let fullLog = '';
    const decoder = new TextDecoder();
    const shell = new Kibsh(sys, parentProc);

    // [Recursion] Support recursive expansion using unshift
    const queueCommands = [...commands];

    while (queueCommands.length > 0) {
        const cmdExec = queueCommands.shift()!;
        const cmdTrimmed = cmdExec.trim();
        if (!cmdTrimmed || cmdTrimmed.startsWith('```')) continue;

        // --- 1. Comment detection ---
        if (RE_COMMENT.test(cmdTrimmed)) {
            const strComment = `${cmdTrimmed}\n`;
            await terminalWriter.write(`\x1b[2m${strComment}\x1b[0m`);
            fullLog += strComment;
            continue; // Skip without passing to shell
        }

        // --- 2. Source detection (recursive expansion) ---
        const matchSource = cmdTrimmed.match(RE_SOURCE);
        if (matchSource) {
            const pathTarget = cmdTrimmed.slice(matchSource[0].length).trim();
            try {
                const strContent = await parentProc.fs.readFile(pathTarget, 'utf8') as string;
                const arrNewLines = strContent.split('\n').map(l => l.trim()).filter(l => l !== '');
                
                queueCommands.unshift(...arrNewLines); // Prepend to the front of the queue
                const strMsg = `# [Agent] Sourced ${arrNewLines.length} lines from ${pathTarget}\n`;
                await terminalWriter.write(`\x1b[32m${strMsg}\x1b[0m`);
                fullLog += strMsg;
            } catch (e: any) {
                const strErr = `# [Error] Failed to source ${pathTarget}: ${e.message}\n`;
                await terminalWriter.write(`\x1b[31m${strErr}\x1b[0m`);
                fullLog += strErr;
            }
            continue;
        }

        // --- 3. Normal execution ---
        await terminalWriter.write(`\x1b[1;32m${cmdExec}\n\x1b[0m`);
        fullLog += `$ ${cmdExec}\n`; // For Gemini reporting

        let cmdOutput = '';
        const streamLog = new WritableStream<Uint8Array>({
            write(chunk) { 
                const text = decoder.decode(chunk, { stream: true });
                cmdOutput += text;
                terminalWriter.write(text);
            }
        });
        
        const writerRaw = streamLog.getWriter();
        const logWriter = new BinaryWriter(writerRaw);
        const nullReader = new BinaryReader(new ReadableStream<Uint8Array>({
            start(controller) { controller.close(); }
        }).getReader());

        try {
            await shell.executeLogic(cmdExec, nullReader, logWriter);
            await new Promise(resolve => setTimeout(resolve, 500));
            await writerRaw.close().catch(() => {});
            if (!cmdOutput.endsWith('\n') && cmdOutput.length > 0) {
                await terminalWriter.write('\n');
                cmdOutput += '\n';
            }
        } catch (e: any) {
            const errMsg = `Error: ${e.message}\n`;
            await terminalWriter.write(`\x1b[31m${errMsg}\x1b[0m`);
            cmdOutput += errMsg;
            try { await writerRaw.abort(errMsg); } catch {}
        }
        fullLog += cmdOutput;
    }
    return fullLog.trim();
}

/**
 * [Parser] Recommended stable logic
 */
function extractCommandBlock(text: string): { fullMatch: string, commands: string[] } | null {
    const marker = "[To KinbroOS]";
    const idx = text.indexOf(marker);
    if (idx === -1) return null;
    const fullMatch = text.substring(idx);
    const content = text.slice(idx + marker.length);
    const commands: string[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        // Extract content from lines starting with $
        if (trimmed.startsWith('$')) {
            commands.push(trimmed.slice(1).trim());
        }
    }
    if (commands.length === 0) return null;
    return { fullMatch, commands };
}

function formatResultBlock(resultContent: string): string {
    return `[To Gemini]\n${resultContent}`;
}

async function interactWithGemini(prompt: string): Promise<string> {
    const editorSelector = 'rich-textarea .ql-editor';
    const inputArea = document.querySelector(editorSelector) as HTMLElement;
    if (!inputArea) throw new Error("Input area not found");
    inputArea.focus();
    const pTag = inputArea.querySelector('p');
    if (pTag) pTag.textContent = prompt;
    else inputArea.textContent = prompt;
    inputArea.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 5000));
    const btnSelector = 'button[aria-label="プロンプトを送信"]';
    const sendBtn = document.querySelector(btnSelector) as HTMLElement;
    if (!sendBtn) throw new Error("Send button not found");
    sendBtn.click();
    await waitForGeminiResponse();
    return extractLatestResponse();
}

async function waitForGeminiResponse(): Promise<void> {
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            const btn = document.querySelector("mat-icon[fonticon='stop']");
            if (btn == null) {
                clearInterval(timer);
                resolve();
            }
        }, 500);
    });
}

function extractLatestResponse(): string {
    const containers = document.querySelectorAll('message-content .markdown');
    if (containers.length === 0) return "";
    const target = containers[containers.length - 1] as HTMLElement;
    return target.innerText;
}

function renderMarkdown(text: string): string {
    return text
        .replace(/\*\*([^*]+)\*\*/g, '\x1b[1m$1\x1b[0m')
        .replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[0m')
        .replace(/^(#{1,6})\s+(.*)$/gm, '\x1b[1;35m$2\x1b[0m');
}
