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

import { TerminalUI } from '../lib/Terminal';
import { WindowManager } from '../lib/WindowManager';
import type { SystemAPI } from '../../../dev/types/SystemAPI';
import type { IProcess } from '../../../dev/types/IProcess';
import { StreamData } from '../../../dev/types/IProcess';

import cssTerminal from '../include/terminal.css?inline';
import cssXterm from '@xterm/xterm/css/xterm.css?inline';

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    console.log(`Bg [Userland] kibterm started (PID: ${proc.pid})`);

    const wm = new WindowManager();
    const { domWindow, domContent, domCloseBtn } = wm.createWindow('🐚 Kibterm');
    const coder = new TextEncoder();
    

    const styleApp = document.createElement('style');
    styleApp.textContent = `
        ${cssXterm}
        ${cssTerminal}
    `;
    domContent.appendChild(styleApp);

    // 4. Terminal UI (Device)
    const term = new TerminalUI();
    term.mount(domContent);
    wm.makeFloating(domWindow, () => term.resize());


    
    // 🌟 2. Writerの確保 (これ一本でいく！)
    const termWriter = term.writable.getWriter();

    // Proxy: シェルからの出力を termWriter に流す
    const createTermProxy = () => new WritableStream<Uint8Array>({
        write(chunk) {
            return termWriter.write(chunk);
        }
    });

    // --- Execute Shell via Kernel ---
    const pathShell = '/usr/bin/kibsh';
    let pidChild = -1;

    // 🌟 初期メッセージ
    await termWriter.write(coder.encode(`Welcome to KinbroOS (Userland)\r\n`));

    try {
        console.log(`Bg [kibterm] Spawning ${pathShell}...`);
        
        // 🌟 3. startProcess で非同期起動 & newSession 指定
        // 注意: Session未作成で spawn するため、TTYからの自動 stdin 割り当てが効かない。
        // だから手動で stdin を渡してあげる必要がある。
        const procShell = await sys.startProcess(
            proc, 
            pathShell, 
            [], 
            true, 
            {
                // 🌟 手動Stdin: まだセッションがないので、TermのReadableから直接ストリームを作る
                stdin: proc.createStdinStream(term.readable, StreamData.Uint8Array, true),
                stdout: proc.createStdoutStream(createTermProxy(), StreamData.Uint8Array), 
                stderr: proc.createStdoutStream(createTermProxy(), StreamData.Uint8Array)  
            },
            { 
                newGroup: true,
                newSession: true // ✨ これで PID=3 が SessionLeader になる！
            }
        );

        const pidChild = procShell.pid;
        console.log(`Bg [kibterm] Child process started. PID: ${pidChild}`);

        // 初期メッセージ補足
        await termWriter.write(coder.encode(`Kernel: vmKinbroOS / PID: ${pidChild} (Session Leader)\r\n`));

        // 🌟 5. 終了待機
        await procShell.wait();

    } catch (e:any) {
        console.error("Shell Spawn Error:", e); // errorレベルで出す
        // エラー時も termWriter を使う
        termWriter.write(coder.encode(`Error: Failed to exec ${pathShell}\n`));
        termWriter.write(coder.encode(e.toString()));
        termWriter.releaseLock();
        return 1; 
    }

    // ※ ここで releaseLock() するとシェルからの出力も止まるので、
    // セッション終了時まで握ったままにするか、Proxyの管理に任せる。
    // 今回はkibtermが死ぬまで握りっぱなしでOK。

    return new Promise((resolve) => {
        domCloseBtn.onclick = () => {
            if(confirm('Terminate Session?')) {
                domWindow.remove();
                termWriter.releaseLock();
                resolve(0);
            }
        };
    });
}