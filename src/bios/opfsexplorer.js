javascript:(async () => {
    /*
     * OPFS Explorer Sidebar v5.4
     * Features: Add File, Download, Trusted Types Safe (No innerHTML)
     */
    class OpfsExplorer {
        constructor() {
            this.hdlRoot = null;
            this.stkHistory = []; 
            this.domContainer = null;
            this.domLauncher = null;
            this.domPreviewPane = null;
            this.domPreviewTitle = null;
            
            this.STYLE_ID = 'opfs-explorer-style';
            this.CONTAINER_ID = 'opfs-explorer-root';
            this.LAUNCHER_ID = 'opfs-explorer-launcher';
        }

        async init() {
            const domExistingContainer = document.getElementById(this.CONTAINER_ID);
            if (domExistingContainer) domExistingContainer.remove();
            const domExistingLauncher = document.getElementById(this.LAUNCHER_ID);
            if (domExistingLauncher) domExistingLauncher.remove();

            try {
                this.hdlRoot = await navigator.storage.getDirectory();
                this.stkHistory.push(this.hdlRoot);
                this.injectStyles();
                this.createUI();
                await this.refreshList();
                console.log("🚀 OPFS Explorer v5.4 (Strict Security Mode) launched!");
            } catch (e) {
                console.error("Failed to initialize OPFS:", e);
                alert("OPFSへのアクセスに失敗しました。");
            }
        }

        injectStyles() {
            if (document.getElementById(this.STYLE_ID)) return;
            const css = `
                #${this.CONTAINER_ID} {
                    position: fixed; top: 0; right: 0; width: 350px; height: 100vh;
                    background: #1e1e1e; color: #e0e0e0; z-index: 99999;
                    font-family: monospace; box-shadow: -2px 0 10px rgba(0,0,0,0.5);
                    display: flex; flex-direction: column; border-left: 1px solid #333;
                    font-size: 13px; transition: opacity 0.2s, transform 0.2s;
                }
                #${this.CONTAINER_ID}.hidden { opacity: 0; pointer-events: none; transform: translateX(20px); }
                #${this.CONTAINER_ID} * { box-sizing: border-box; }
                .header { padding: 10px; background: #2d2d2d; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; height: 40px; }
                .window-controls { display: flex; gap: 8px; }
                .btn-ctrl { cursor: pointer; padding: 2px 6px; border-radius: 4px; color: #aaa; font-size: 14px; }
                .btn-ctrl:hover { background: #444; color: #fff; }
                .list-container { flex: 1; overflow-y: auto; padding: 0; border-bottom: 1px solid #333; }
                .item { display: flex; align-items: center; padding: 6px 10px; cursor: pointer; border-bottom: 1px solid #2a2a2a; }
                .item:hover { background: #333; }
                .item.active { background: #37373d; }
                .icon { margin-right: 8px; width: 20px; text-align: center; }
                .details { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
                .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .meta { font-size: 10px; color: #888; }
                .action-btn { padding: 2px 5px; margin-left: 5px; cursor: pointer; opacity: 0.6; }
                .action-btn:hover { opacity: 1; }
                .preview-container { height: 40%; display: flex; flex-direction: column; background: #1a1a1a; border-top: 2px solid #333; }
                .preview-header { padding: 5px 10px; background: #252526; border-bottom: 1px solid #333; font-size: 11px; color: #aaa; }
                .preview-content { flex: 1; overflow: auto; padding: 10px; }
                .preview-content img { max-width: 100%; height: auto; }
                .preview-content pre { width: 100%; white-space: pre-wrap; word-break: break-all; margin: 0; color: #ce9178; font-size: 11px; }
                #${this.LAUNCHER_ID} { position: fixed; bottom: 20px; right: 20px; width: 56px; height: 56px; border-radius: 50%; background: #0078d4; color: white; box-shadow: 0 4px 12px rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; cursor: pointer; z-index: 100000; font-size: 24px; }
                #${this.LAUNCHER_ID}.hidden { opacity: 0; pointer-events: none; }
            `;
            const domStyle = document.createElement('style');
            domStyle.id = this.STYLE_ID;
            domStyle.textContent = css;
            document.head.appendChild(domStyle);
        }

        createUI() {
            /* Launcher */
            this.domLauncher = document.createElement('div');
            this.domLauncher.id = this.LAUNCHER_ID;
            this.domLauncher.textContent = '📂';
            this.domLauncher.className = 'hidden';
            this.domLauncher.onclick = () => this.restoreSidebar();
            document.body.appendChild(this.domLauncher);

            /* Container */
            this.domContainer = document.createElement('div');
            this.domContainer.id = this.CONTAINER_ID;

            /* Header */
            const domHeader = document.createElement('div');
            domHeader.className = 'header';
            const domTitle = document.createElement('span');
            domTitle.textContent = '📂 OPFS Explorer';
            domHeader.appendChild(domTitle);
            
            const domControls = document.createElement('div');
            domControls.className = 'window-controls';

            const btnData = [
                { icon: '➕', title: 'Add Files', click: () => this.uploadFile() },
                { icon: '↻', title: 'Refresh', click: () => this.refreshList() },
                { icon: '_', title: 'Minimize', click: () => this.minimizeSidebar() },
                { icon: '✖', title: 'Close', click: () => { this.domContainer.remove(); this.domLauncher.remove(); } }
            ];

            btnData.forEach(btn => {
                const domBtn = document.createElement('span');
                domBtn.className = 'btn-ctrl';
                domBtn.textContent = btn.icon;
                domBtn.title = btn.title;
                domBtn.onclick = btn.click;
                domControls.appendChild(domBtn);
            });
            domHeader.appendChild(domControls);

            /* List Area */
            const domList = document.createElement('div');
            domList.className = 'list-container';
            domList.id = 'opfs-list';

            /* Preview Area */
            const domPreview = document.createElement('div');
            domPreview.className = 'preview-container';
            const domPreviewHeader = document.createElement('div');
            domPreviewHeader.className = 'preview-header';
            this.domPreviewTitle = document.createElement('span');
            this.domPreviewTitle.textContent = 'Preview';
            domPreviewHeader.appendChild(this.domPreviewTitle);
            
            this.domPreviewPane = document.createElement('div');
            this.domPreviewPane.className = 'preview-content';

            domPreview.appendChild(domPreviewHeader);
            domPreview.appendChild(this.domPreviewPane);

            this.domContainer.appendChild(domHeader);
            this.domContainer.appendChild(domList);
            this.domContainer.appendChild(domPreview);
            document.body.appendChild(this.domContainer);
        }

        async uploadFile() {
            const domInput = document.createElement('input');
            domInput.type = 'file';
            domInput.multiple = true;
            domInput.onchange = async () => {
                const hdlCurrent = this.stkHistory[this.stkHistory.length - 1];
                for (const file of domInput.files) {
                    const hdlFile = await hdlCurrent.getFileHandle(file.name, { create: true });
                    const writable = await hdlFile.createWritable();
                    await writable.write(file);
                    await writable.close();
                }
                this.refreshList();
            };
            domInput.click();
        }

        async downloadFile(hdlFile, strName) {
            const file = await hdlFile.getFile();
            const url = URL.createObjectURL(file);
            const domLink = document.createElement('a');
            domLink.href = url;
            domLink.download = strName;
            domLink.click();
            URL.revokeObjectURL(url);
        }

        minimizeSidebar() { this.domContainer.classList.add('hidden'); this.domLauncher.classList.remove('hidden'); }
        restoreSidebar() { this.domLauncher.classList.add('hidden'); this.domContainer.classList.remove('hidden'); }

        async refreshList() {
            const domList = this.domContainer.querySelector('#opfs-list');
            while (domList.firstChild) domList.removeChild(domList.firstChild);
            this.renderEmptyPreview();

            const hdlCurrent = this.stkHistory[this.stkHistory.length - 1];
            if (this.stkHistory.length > 1) this.renderItem(domList, { name: '..', kind: 'parent' });

            const arrEntries = [];
            for await (const [strName, hdlEntry] of hdlCurrent.entries()) {
                const item = { name: strName, handle: hdlEntry, kind: hdlEntry.kind };
                if (item.kind === 'file') {
                    const file = await hdlEntry.getFile();
                    item.size = file.size;
                }
                arrEntries.push(item);
            }

            arrEntries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
                      .forEach(item => this.renderItem(domList, item));
        }

        renderItem(domParent, item) {
            const domItem = document.createElement('div');
            domItem.className = 'item';

            const iconMap = { parent: '⬆️', directory: '📁', file: '📄' };
            const domIcon = document.createElement('span');
            domIcon.className = 'icon';
            domIcon.textContent = iconMap[item.kind];

            const domDetails = document.createElement('div');
            domDetails.className = 'details';
            const domName = document.createElement('span');
            domName.className = 'name';
            domName.textContent = item.name;
            domDetails.appendChild(domName);

            if (item.kind === 'file') {
                const domMeta = document.createElement('span');
                domMeta.className = 'meta';
                domMeta.textContent = this.formatSize(item.size);
                domDetails.appendChild(domMeta);
            }

            const fnClick = async () => {
                const domActive = domParent.querySelector('.active');
                if (domActive) domActive.classList.remove('active');
                domItem.classList.add('active');
                if (item.kind === 'parent') this.navigateUp();
                else if (item.kind === 'directory') this.navigateDown(item.handle);
                else await this.updatePreview(item.handle, item.name);
            };
            domIcon.onclick = domDetails.onclick = fnClick;

            domItem.appendChild(domIcon);
            domItem.appendChild(domDetails);

            if (item.kind !== 'parent') {
                const domActions = document.createElement('div');
                if (item.kind === 'file') {
                    const domDlBtn = document.createElement('span');
                    domDlBtn.className = 'action-btn';
                    domDlBtn.textContent = '📥';
                    domDlBtn.onclick = (e) => { e.stopPropagation(); this.downloadFile(item.handle, item.name); };
                    domActions.appendChild(domDlBtn);
                }
                const domDelBtn = document.createElement('span');
                domDelBtn.className = 'action-btn';
                domDelBtn.textContent = '🗑️';
                domDelBtn.onclick = (e) => { e.stopPropagation(); this.deleteEntry(item.name); };
                domActions.appendChild(domDelBtn);
                domItem.appendChild(domActions);
            }
            domParent.appendChild(domItem);
        }

        async updatePreview(hdlFile, strName) {
            this.domPreviewTitle.textContent = `Preview: ${strName}`;
            this.domPreviewPane.textContent = 'Loading...';
            try {
                const file = await hdlFile.getFile();
                while (this.domPreviewPane.firstChild) this.domPreviewPane.removeChild(this.domPreviewPane.firstChild);
                if (file.type.startsWith('image/')) {
                    const domImg = document.createElement('img');
                    domImg.src = URL.createObjectURL(file);
                    this.domPreviewPane.appendChild(domImg);
                } else {
                    const text = await file.text();
                    const domPre = document.createElement('pre');
                    domPre.textContent = text.slice(0, 10000);
                    this.domPreviewPane.appendChild(domPre);
                }
            } catch (e) { this.domPreviewPane.textContent = `Error: ${e.message}`; }
        }

        renderEmptyPreview() {
            if (!this.domPreviewTitle) return;
            this.domPreviewTitle.textContent = 'Preview';
            while (this.domPreviewPane.firstChild) this.domPreviewPane.removeChild(this.domPreviewPane.firstChild);
            const domEmpty = document.createElement('div');
            domEmpty.className = 'preview-empty';
            domEmpty.textContent = 'Select a file to preview';
            this.domPreviewPane.appendChild(domEmpty);
        }

        navigateDown(hdl) { this.stkHistory.push(hdl); this.refreshList(); }
        navigateUp() { if (this.stkHistory.length > 1) { this.stkHistory.pop(); this.refreshList(); } }

        async deleteEntry(strName) {
            if (!confirm(`"${strName}" を削除しますか？`)) return;
            const hdlCurrent = this.stkHistory[this.stkHistory.length - 1];
            await hdlCurrent.removeEntry(strName, { recursive: true });
            this.refreshList();
        }

        formatSize(bytes) {
            if (bytes === 0) return '0 B';
            const i = Math.floor(Math.log(bytes) / Math.log(1024));
            return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + ['B', 'KB', 'MB', 'GB'][i];
        }
    }
    new OpfsExplorer().init();
})();