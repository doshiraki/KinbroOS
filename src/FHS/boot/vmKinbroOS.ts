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

import { KinbroKernel } from './Kernel';
import { Process } from './Process';
import { Archiver } from './Archiver';
import { IFileSystem } from '@/dev/types/IFileSystem';

export async function main() {
    console.log("Kernel: Booting vmKinbroOS...");
    // 1. Initialize VFS via FileSystem Class
    // 3. System Launch
    const sys = new KinbroKernel();
    const proc = sys.createInitProcess();
    await initFileSystem(proc.fs);
    // 2. Install Base System Check
    if (!await proc.fs.exists('/usr/bin/kibsh.js') || !confirm(`KinbroOSのインストールが見つかりました。\n\n[OK] KinbroOSを起動\n[キャンセル] 新しいKinbroOSをインストールして起動`)) {
        console.log("Kernel: System not found. Starting Installer...");
        await promptAndInstallRootFS(proc.fs);
        console.log("Kernel: Installation Complete.");
    } else {
        console.log("Kernel: System detected. Skipping installation.");
    }

    console.log("Kernel: System Ready.");
    // 4. Init Process
    try {
        const pathInit = '/usr/bin/kibterm.js';
        
        await sys.execPath(proc, pathInit, []);
    } catch (e: any) {
        console.error("Kernel Panic: Failed to launch init process.", e);
        // 【修正 1】innerHTML を廃止して安全に要素を追加 
        const h1 = document.createElement('h1');
        h1.style.color = 'red';
        h1.textContent = 'Kernel Panic';
        
        const p = document.createElement('p');
        p.textContent = String(e); // エラー内容をテキストとして安全に表示

        document.body.appendChild(h1);
        document.body.appendChild(p);
    }
}

// ... initFileSystem は変更なし ...
async function initFileSystem(fs:IFileSystem) {
    try {
        const rootHandle = await navigator.storage.getDirectory();
        const osHandle = await rootHandle.getDirectoryHandle('KinbroOS', { create: true });
        const fsRootHandle = await osHandle.getDirectoryHandle('opfs2', { create: true });
        await fs.mount(fsRootHandle);
        console.log("Kernel: FileSystem Initialized (OPFS Mounted)");
    } catch (e) {
        console.error("Kernel: Failed to mount VFS", e);
        throw e;
    }
}

/**
 * ファイルピッカーを開き、Archiverを使って展開する
 */
async function promptAndInstallRootFS(fs:IFileSystem) {
    return new Promise<void>((resolve, reject) => {
        const installOverlay = document.createElement('div');
        Object.assign(installOverlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: '#000', color: '#0f0', display: 'flex',
            flexDirection: 'column', 
            alignItems: 'center', justifyContent: 'center',
            zIndex: '99999', fontFamily: 'monospace'
        });

        // 【修正 2】innerHTML を廃止し、DOMツリーを構築 
        // <h1>KinbroOS Installer</h1>
        const h1 = document.createElement('h1');
        h1.textContent = 'KinbroOS Installer';

        // <p>System files not found.</p>
        const p1 = document.createElement('p');
        p1.textContent = 'System files not found.';

        // <p>Please select <b>rootfs.tar.gz</b> to install.</p>
        const p2 = document.createElement('p');
        p2.append('Please select ');
        const b = document.createElement('b');
        b.textContent = 'rootfs.tar.gz';
        p2.append(b, ' to install.');

        // <input type="file" ...>
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'rootfs-picker';
        input.accept = '.gz,.tar.gz,.tar';
        input.style.marginTop = '20px';

        // <p id="install-status" ...></p>
        const status = document.createElement('p');
        status.id = 'install-status';
        status.style.marginTop = '20px';
        status.style.color = 'yellow';

        // 要素をオーバーレイに追加
        installOverlay.append(h1, p1, p2, input, status);
        document.body.appendChild(installOverlay);

        const archiver = new Archiver(fs);
        
        // イベントリスナーも input 変数を直接参照できるので getElementById 不要
        input.onchange = async () => {
            if (!input.files || input.files.length === 0) return;
            const file = input.files[0];
            
            input.disabled = true;
            status.textContent = "Processing archive...";
            try {
                const arrayBuffer = await file.arrayBuffer();
                const u8Data = new Uint8Array(arrayBuffer);

                await archiver.extract(u8Data);
                status.textContent = "Installation Complete! Booting...";
                await new Promise(r => setTimeout(r, 1000));
                
                document.body.removeChild(installOverlay);
                resolve();
            } catch (e) {
                console.error(e);
                status.textContent = `Error: ${e}`;
                status.style.color = 'red';
                input.disabled = false;
            }
        };
    });
}

main();