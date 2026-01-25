javascript:(async () => {
    const BOOT_FILENAME = "vmKinbroOS.js";

    /* 📁 OPFSのセットアップ */
    const root = await navigator.storage.getDirectory();
    const kRoot = await root.getDirectoryHandle("KinbroOS", { create: true });
    const opfs1 = await kRoot.getDirectoryHandle("opfs1", { create: true });

    /* 💾 ファイル選択＆保存＆ロードを行うヘルパー */
    const uploadAndRun = () => {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.js';
            input.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;

                try {
                    /* OPFSに保存 (上書き) */
                    const fileHandle = await opfs1.getFileHandle(BOOT_FILENAME, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(file);
                    await writable.close();
                    console.log("💾 [Installer] Kernel saved to OPFS.");

                    /* 起動 */
                    run(file, kRoot);
                    resolve();
                } catch (err) {
                    alert("保存または起動に失敗しました: " + err.message);
                }
            };
            input.click();
        });
    };

    /* 🚀 カーネル起動処理 */
    async function run(blob, rootHandle) {
        console.log("🚀 [Boot] Importing Kernel...");
        
        /* OS側に渡すハンドルを準備 */
        window.KinbroOS = { 
            bootHandles: { 
                root: rootHandle, 
                opfs1: await rootHandle.getDirectoryHandle("opfs1"), 
            } 
        };

        const url = URL.createObjectURL(new Blob([await blob.text()], { type: 'text/javascript' }));

        try {
            await import(url);
            console.log("✅ [Boot] Kernel Launched.");
        } catch (e) {
            console.error(e);
            alert("起動エラー: " + e.message);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    /* 🔀 メインロジック */
    try {
        /* 1. カーネルが存在するか確認 */
        const fileHandle = await opfs1.getFileHandle(BOOT_FILENAME);
        
        /* 2. 存在する場合: プロンプトで分岐 */
        if (confirm(`既存のカーネルが見つかりました。\n\n[OK] 既存のカーネルを起動\n[キャンセル] 新しいカーネルをアップロードして更新`)) {
            /* [OK] -> そのままロード */
            const file = await fileHandle.getFile();
            run(file, kRoot);
        } else {
            /* [キャンセル] -> アップロードして保存してロード */
            await uploadAndRun();
        }

    } catch (e) {
        /* 1-Error. 存在しない場合 (NotFoundErrorなど) */
        if (e.name === 'NotFoundError') {
            /* アップロードして保存してロード */
            await uploadAndRun();
        } else {
            console.error(e);
            alert("エラーが発生しました: " + e.message);
        }
    }
})();